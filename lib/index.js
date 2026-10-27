/**
 * dsh-boot-resume — 宿主重启后，自动把“你正在聊的那一轮”接着跑完。
 *
 * 背景：DSH 重启后会话历史从磁盘恢复，但一轮没跑完的对话不会自己续上 ——
 * resume 时 `interruptedTurnClosers()` 会给开放轮次补一条
 * `turn/end { reason: { kind: 'interrupted' } }` 关闭，然后等用户下一条消息。
 * 所以每次重启都得手动回一句“继续”。
 *
 * 判定就是“尾部异常”，只看最后一轮，看两种痕迹：
 *   a. 最后一个事件是 `turn/start`（没有 turn/end）→ 进程消失时这一轮还在跑；
 *   b. 最后一条 `turn/end` 的 reason.kind === 'interrupted'
 *      → resume 补的“被打断”标记，且之后没有新的 turn/start。
 *   用户点停止写的是 `reason: { kind: 'user' }`，正常跑完是 `completed`，
 *   都不会命中，所以不会把手动停止/已完成的一轮再跑一遍。
 *   不看消息来源、不猜哪个是主对话：凡是上一轮没正常收尾的都算，
 *   按最后一次活动时间从新到旧续。
 *
 * 其它约束：只考虑 `session-` 开头、登记在 workspace.json、未归档、最后活动
 * 在 maxAgeHours 内的会话；一次启动最多续 maxResumePerBoot 个、彼此间隔
 * staggerMs；同一会话有冷却与 24 小时次数上限，兜住“崩溃 → 续跑 → 再崩”的
 * 死循环；已有实例在跑就跳过。
 *
 * 续跑 = `agents.resume()`（或复用已注册实例）+ `agent.followup(一条用户消息)`，
 * 默认内容「继续」。
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import Schema from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { interruptedTurnOf, quotaState, readWorkspaceIndex } from './detect.js';

export const name = 'dsh-boot-resume';

/** 需要 agents 服务来 resume + followup；持久化与模型选择在运行时按需 ctx.get()。 */
export const inject = ['agents'];

export const Config = Schema.object({
  /** 总开关。 */
  enabled: Schema.boolean().default(true),
  /** 启动后等多久再动作，给宿主与界面留出恢复时间。 */
  delayMs: Schema.number().default(8000),
  /** 续跑时投递的消息内容。 */
  message: Schema.string().default('继续'),
  /** 只考虑这么久之内被改动过的会话日志。 */
  maxAgeHours: Schema.number().default(12),
  /** 同一个会话两次自动续跑的最小间隔（分钟）。 */
  cooldownMinutes: Schema.number().default(30),
  /** 同一个会话 24 小时内最多自动续跑几次。 */
  maxPerDay: Schema.number().default(3),
  /** 最多检查几个候选会话（按日志 mtime 从新到旧）。 */
  maxCandidates: Schema.number().default(8),
  /** 一次启动最多续跑几个会话。 */
  maxResumePerBoot: Schema.number().default(5),
  /** 多个会话续跑之间的间隔，避免同时打满模型配额。 */
  staggerMs: Schema.number().default(1500),
});

const DSH_HOME = path.join(homedir(), '.dsh');
const STATE_DIR = path.join(DSH_HOME, 'auto-continue');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_FILE = path.join(STATE_DIR, 'auto-continue.log');
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');
const PROJ_CACHE = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const WORKSPACE_FILE = path.join(DSH_HOME, 'storages', 'workspace.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const TAIL_EVENTS = 1000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    delayMs: num(config.delayMs, 8000),
    message: typeof config.message === 'string' && config.message.trim() !== '' ? config.message : '继续',
    maxAgeHours: num(config.maxAgeHours, 12),
    cooldownMinutes: num(config.cooldownMinutes, 30),
    maxPerDay: num(config.maxPerDay, 3),
    maxCandidates: Math.max(1, num(config.maxCandidates, 8)),
    maxResumePerBoot: Math.max(1, num(config.maxResumePerBoot, 5)),
    staggerMs: num(config.staggerMs, 1500),
  };
  if (!cfg.enabled) return;

  let disposed = false;
  let timer;

  const log = (line) => {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    void (async () => {
      try {
        await mkdir(STATE_DIR, { recursive: true });
        await writeFile(LOG_FILE, text, { flag: 'a' });
      } catch {
        /* logging never breaks startup */
      }
    })();
  };

  const readState = async () => {
    try {
      const doc = JSON.parse(await readFile(STATE_FILE, 'utf8'));
      if (doc && typeof doc === 'object') return { history: {}, ...doc };
    } catch {
      /* first run */
    }
    return { history: {} };
  };

  const writeState = async (state) => {
    try {
      await mkdir(STATE_DIR, { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {
      /* best effort */
    }
  };

  /** 一次遍历拿到所有会话日志：id → mtime。 */
  const sessionLogs = async () => {
    const logs = new Map();
    let workspaces;
    try {
      workspaces = await listDirs(SESSIONS_ROOT);
    } catch {
      return logs;
    }
    for (const workspace of workspaces) {
      const dir = path.join(SESSIONS_ROOT, workspace);
      let entries;
      try {
        entries = await listDirs(dir);
      } catch {
        continue;
      }
      for (const id of entries) {
        if (!id.startsWith('session-')) continue;
        if (logs.has(id)) continue;
        try {
          const info = await stat(path.join(dir, id, 'session.v4.jsonl.zstd'));
          logs.set(id, info.mtimeMs);
        } catch {
          /* no readable log in this workspace copy */
        }
      }
    }
    return logs;
  };

  /** workspace.json 里的在册会话与归档会话。 */
  const workspaceIndex = async () => {
    try {
      const doc = JSON.parse(await readFile(WORKSPACE_FILE, 'utf8'));
      return readWorkspaceIndex(doc);
    } catch {
      /* no workspace document: fall back to "everything is a candidate" */
    }
    return { members: undefined, archived: new Set() };
  };

  /** 投影缓存里最后一个已知 seq，用来只读日志尾部。 */
  const projectedSeq = async (sessionId) => {
    try {
      const doc = JSON.parse(await readFile(path.join(PROJ_CACHE, `${sessionId}.json`), 'utf8'));
      const rows = doc?.record?.rows ?? {};
      let max = 0;
      for (const row of Object.values(rows)) {
        const seq = row?.seq;
        if (typeof seq === 'number' && seq > max) max = seq;
      }
      return max > 0 ? max : undefined;
    } catch {
      return undefined;
    }
  };

  /** 只读打开会话读事件；优先从投影 seq 往回读一段，不够再读全量。 */
  const readEvents = async (sessionId) => {
    const persistence = ctx.get('sessionPersistence');
    if (!persistence || typeof persistence.open !== 'function') return undefined;
    let handle;
    try {
      handle = await persistence.open(sessionId, 'read');
      const asOf = await projectedSeq(sessionId);
      if (asOf !== undefined) {
        try {
          const tail = await handle.read(Math.max(0, asOf - TAIL_EVENTS), void 0);
          const events = Array.isArray(tail?.events) ? tail.events : undefined;
          if (events !== undefined && events.some((e) => e?.type === 'turn/start' || e?.type === 'turn/end')) {
            return events;
          }
        } catch {
          /* fall back to a full read */
        }
      }
      const full = await handle.read(0, void 0);
      return Array.isArray(full?.events) ? full.events : undefined;
    } catch (error) {
      log(`${sessionId}: 读取会话日志失败（${error && error.message ? error.message : String(error)}）`);
      return undefined;
    } finally {
      try {
        await handle?.close?.();
      } catch {
        /* read handle close is best effort */
      }
    }
  };

  /**
   * 最后一轮是不是“被进程消失打断”的。
   * @returns 命中时 { turn, kind: 'open' | 'interrupted' }，否则 undefined。
   */
  const interruptedTurn = (events) => interruptedTurnOf(events);

  const allowedByQuota = (state, sessionId) => {
    const verdict = quotaState(state.history?.[sessionId], Date.now(), cfg.maxPerDay, cfg.cooldownMinutes);
    if (!verdict.ok) {
      log(verdict.reason === 'quota'
        ? `${sessionId}: 24h 内已自动续跑 ${verdict.recent} 次，跳过`
        : `${sessionId}: 冷却中，跳过`);
      return false;
    }
    return true;
  };

  const resumeSession = async (sessionId) => {
    const getAgent = (id) => (typeof ctx.agents.get === 'function' ? ctx.agents.get(id) : undefined);
    const live = getAgent(sessionId);
    if (live && live.status === 'running') {
      log(`${sessionId}: 已有实例在跑，跳过`);
      return false;
    }

    let agent = live;
    if (!agent) {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(selection === undefined ? {} : { agentOptions: { ...selection } }),
        });
        agent = handle.agent;
      } catch (error) {
        // 界面可能在同一时刻把会话打开了：退回到已注册的实例。
        agent = getAgent(sessionId);
        if (!agent) throw error;
        log(`${sessionId}: resume 冲突，改用已注册实例（${error && error.message ? error.message : String(error)}）`);
      }
    }
    if (!agent) throw new Error('resume 没有返回可用的 agent');

    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: cfg.message }],
        source: { kind: 'user' },
      }),
    );
    log(`${sessionId}: 已投递「${cfg.message}」`);
    return true;
  };

  const run = async () => {
    try {
      if (disposed) return;
      const { members, archived } = await workspaceIndex();
      const logs = await sessionLogs();
      const now = Date.now();
      const maxAgeMs = cfg.maxAgeHours * 60 * 60 * 1000;

      const candidates = [...logs.entries()]
        .filter(([id, mtimeMs]) => {
          if (members !== undefined && !members.has(id)) return false;
          if (archived.has(id)) return false;
          return now - mtimeMs <= maxAgeMs;
        })
        .sort((a, b) => b[1] - a[1])
        .slice(0, cfg.maxCandidates);

      const interrupted = [];
      for (const [id] of candidates) {
        const events = await readEvents(id);
        const turn = interruptedTurn(events);
        if (turn === undefined) continue;
        const last = events[events.length - 1];
        const lastEventTime = typeof last?.time === 'number' ? last.time : 0;
        if (now - lastEventTime > maxAgeMs) continue;
        interrupted.push({ id, turn, lastEventTime });
      }

      if (interrupted.length === 0) {
        log('启动检查：没有找到被中断的会话');
        return;
      }

      // 最近还在活动的先续；同一会话受冷却与每日上限约束。
      interrupted.sort((a, b) => b.lastEventTime - a.lastEventTime);
      const state = await readState();
      let resumedCount = 0;

      for (const item of interrupted) {
        if (resumedCount >= cfg.maxResumePerBoot) break;
        if (!allowedByQuota(state, item.id)) continue;

        log(
          `发现未完成轮次 ${item.id}（turn=${item.turn.turn}, 判定=${item.turn.kind},` +
            ` 最后事件 ${new Date(item.lastEventTime).toISOString()}）`,
        );

        const resumed = await resumeSession(item.id);
        if (resumed) {
          resumedCount += 1;
          // 只有真正投递成功才记入冷却；失败的下次还能重试。
          state.history = state.history ?? {};
          const history = (state.history[item.id] ?? []).filter((t) => typeof t === 'number');
          history.push(Date.now());
          state.history[item.id] = history.slice(-50);
          await writeState(state);
        }

        if (cfg.staggerMs > 0) await sleep(cfg.staggerMs);
      }

      log(`启动检查完成：续跑 ${resumedCount} 个会话`);
    } catch (error) {
      log(`自动续跑失败：${error && error.message ? error.message : String(error)}`);
    }
  };

  ctx.effect(() => {
    timer = setTimeout(() => {
      void run();
    }, cfg.delayMs);
    timer.unref?.();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * dsh-boot-resume 的判定逻辑（纯函数，无宿主依赖）。
 *
 * 单独成文件的原因：`lib/index.js` 顶部 import 了 `@deepseek-ai/dsh-llm`，
 * 那是宿主运行时注入的 peer 依赖，本地没有副本——测试进程一 import 主文件就
 * ERR_MODULE_NOT_FOUND。判定逻辑本身不需要任何宿主能力，拆出来后可以直接单测。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 判断最后一轮是否被“进程消失”打断。
 *
 * 只看尾部两种痕迹：
 *   a. 最后一个事件是 turn/start（后面没有 turn/end）→ 这轮还在跑，进程没了；
 *   b. 最后一条 turn/end 的 reason.kind === 'interrupted'，且之后没有新 turn/start
 *      → resume 时补的“被打断”标记。
 * 用户点停止写的是 reason.kind === 'user'，正常跑完是 'completed'，都不命中，
 * 所以不会把手动停止或已完成的一轮再跑一遍。
 *
 * @param {Array<{type?: string, data?: object}>|undefined} events
 * @returns {{turn: unknown, kind: 'open'|'interrupted'}|undefined}
 */
export function interruptedTurnOf(events) {
  if (!Array.isArray(events) || events.length === 0) return undefined;
  let lastStart;
  let lastEnd;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (lastEnd === undefined && event?.type === 'turn/end') lastEnd = { index, data: event.data ?? {} };
    if (lastStart === undefined && event?.type === 'turn/start') lastStart = { index, data: event.data ?? {} };
    if (lastStart !== undefined && lastEnd !== undefined) break;
  }
  if (lastStart !== undefined && (lastEnd === undefined || lastStart.index > lastEnd.index)) {
    return { turn: lastStart.data.turn ?? null, kind: 'open' };
  }
  if (lastEnd !== undefined && lastEnd.data?.reason?.kind === 'interrupted') {
    return { turn: lastEnd.data.turn ?? null, kind: 'interrupted' };
  }
  return undefined;
}

/**
 * 会话是否还在冷却 / 已超每日上限。
 *
 * @param {number[]|undefined} history 该会话历次续跑的时间戳
 * @param {number} now
 * @param {number} maxPerDay 24h 内最多几次
 * @param {number} cooldownMinutes 两次之间的最小间隔
 * @returns {{ok: boolean, reason?: 'quota'|'cooldown', recent: number}}
 */
export function quotaState(history, now, maxPerDay, cooldownMinutes) {
  const stamps = (Array.isArray(history) ? history : []).filter((t) => typeof t === 'number');
  const recent = stamps.filter((t) => now - t < DAY_MS);
  if (recent.length >= maxPerDay) return { ok: false, reason: 'quota', recent: recent.length };
  const cooldownMs = cooldownMinutes * 60 * 1000;
  if (recent.some((t) => now - t < cooldownMs)) return { ok: false, reason: 'cooldown', recent: recent.length };
  return { ok: true, recent: recent.length };
}

/**
 * 从 workspace.json 文档里抽出在册会话与归档会话。
 * 宿主数据结构变了能立刻在测试里发现。
 *
 * members 为 undefined 表示文档里没有会话表——调用方应退回“全部都是候选”。
 */
export function readWorkspaceIndex(doc) {
  const members = new Set();
  const archived = new Set();
  for (const workspace of Object.values(doc?.tables?.workspaces ?? {})) {
    for (const id of workspace?.sessionIds ?? []) members.add(String(id));
  }
  for (const id of doc?.global?.archivedSessionIds ?? []) archived.add(String(id));
  return { members: members.size > 0 ? members : undefined, archived };
}

# dsh-auto-continue

Resume the conversation a DSH restart interrupted — so you never have to type "继续" again.

[中文说明](./README.zh.md)

## The problem

DeepSeek Harness persists every session to disk, so the conversation history survives a restart. The **turn that was running** does not: on resume, `interruptedTurnClosers()` appends a synthetic `turn/end { reason: { kind: 'interrupted' } }` that closes the open turn, and the session then waits for your next message. Restart during work and the agent simply stops mid-thought.

## What this does

One check, once per host boot (`delayMs` after activation):

1. List the stored sessions of every workspace.
2. Read the tail of each one and look for an *unfinished turn*:
   - the last event is `turn/start` with no `turn/end` — the process died mid-turn, or
   - the last `turn/end` carries `reason.kind === 'interrupted'` — the marker a later resume wrote.
3. For every session that matches, `agents.resume()` it (or reuse the already-registered agent) and `agent.followup()` a short user message — `继续` by default.

Nothing else in DSH is touched: no schema, no patch to core, no extra process.

### What it deliberately does NOT resume

| Last turn ended with | Why it is skipped |
| --- | --- |
| `reason.kind === 'user'` | you pressed Stop — resuming would fight you |
| `reason.kind === 'completed'` | the turn finished normally |
| a turn older than `maxAgeHours` | stale, likely abandoned on purpose |

An agent instance that is already `running` for that session is also skipped, so a UI that reopened the conversation first always wins.

### Guards against a crash loop

If the resumed turn crashes the host again, the next boot would resume it again — forever. Two limits stop that:

- `cooldownMinutes` — at most one automatic resume per session in that window;
- `maxPerDay` — a hard cap per session per 24 hours.

`maxResumePerBoot` and `staggerMs` keep a busy machine from starting five model turns at the same instant.

## Install

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add link:/path/to/dsh-auto-continue
```

then add the package name to `dsh.profile.bundles` in that profile's `package.json` and restart the host.

## Configuration

All keys are optional; the defaults are shown.

```yaml
- insert:
    - id: auto-continue
      name: dsh-auto-continue
      inject: [agents]
      config:
        enabled: true
        delayMs: 8000            # wait after boot before checking
        message: 继续             # the follow-up text
        maxAgeHours: 12          # ignore sessions older than this
        cooldownMinutes: 30      # per-session cooldown between resumes
        maxPerDay: 3             # per-session resumes per 24h
        maxCandidates: 8         # newest sessions to inspect
        maxResumePerBoot: 5      # how many sessions may be resumed per boot
        staggerMs: 1500          # spacing between resumes
```

## Observability

Every boot writes one block to `$DSH_HOME/auto-continue/auto-continue.log`:

```
[2026-10-21T02:50:55.275Z] 发现未完成轮次 session-9ba505ca…（turn=47, 判定=open, 最后事件 …）
[2026-10-21T02:50:55.383Z] session-9ba505ca…: 已投递「继续」
[2026-10-21T02:51:00.290Z] 启动检查完成：续跑 3 个会话
```

`state.json` in the same directory holds the per-session cooldown history (delete it to clear).

## How the tail is read

`sessionPersistence.open(id, 'read')` + a bounded `read()` starting from the last projected seq (up to 1000 events back), falling back to a full read when the projection cache is missing or the window holds no turn boundary. Sessions are resolved from the workspace registry, so subagent and archived sessions never become candidates.

## Requirements

- DSH host `>= 0.2.0-rc.2`
- Host services: `agents`, plus `sessionPersistence` and `agentDefaultModel` when present

## License

MIT

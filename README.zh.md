# dsh-auto-continue

重启后自动续跑被中断的那一轮对话——不用再手动回一句「继续」。

[English](./README.md)

## 问题

DeepSeek Harness 会把每个会话持久化到磁盘，所以重启后历史还在。但**正在跑的那一轮**不会继续：resume 时 `interruptedTurnClosers()` 会补一条
`turn/end { reason: { kind: 'interrupted' } }` 把开放轮次关掉，然后等用户下一条消息。工作到一半重启，agent 就停在半句话上。

## 做了什么

宿主每次启动后（激活后延迟 `delayMs`）做一次检查：

1. 列出所有 workspace 的已存会话；
2. 读每个会话的日志尾部，找“没跑完的轮次”：
   - 最后事件是 `turn/start`、没有 `turn/end` —— 进程在轮次中途消失；
   - 或者最后一条 `turn/end` 的 `reason.kind === 'interrupted'` —— 之后某次 resume 留下的标记。
3. 命中的会话：`agents.resume()`（或复用已注册实例）后用 `agent.followup()` 投一条用户消息，默认就是「继续」。

不改 DSH 内核、不改 schema、不起额外进程。

### 什么情况不会续

| 最后一轮的结束方式 | 为什么不续 |
| --- | --- |
| `reason.kind === 'user'` | 你点了停止——再续跑就是跟你对着干 |
| `reason.kind === 'completed'` | 这一轮本来就跑完了 |
| 最后活动早于 `maxAgeHours` | 太旧了，大概率是故意放着的 |

会话已经有实例在跑（说明界面先打开了、或你已经在打字）时也会跳过。

### 防崩溃循环

如果续跑又让宿主崩了，下次启动会再续——死循环。两道闸：

- `cooldownMinutes`：同一会话在该时间窗内最多自动续一次；
- `maxPerDay`：同一会话 24 小时的硬上限。

`maxResumePerBoot` 与 `staggerMs` 避免一台忙机器在同一秒里同时起五个模型轮次。

## 安装

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add link:/path/to/dsh-auto-continue
```

然后把包名加进该 profile `package.json` 的 `dsh.profile.bundles`，重启宿主。

## 配置

全部可省略，下面是默认值。

```yaml
- insert:
    - id: auto-continue
      name: dsh-auto-continue
      inject: [agents]
      config:
        enabled: true
        delayMs: 8000            # 启动后等多久再检查
        message: 继续             # 续跑时投递的消息
        maxAgeHours: 12          # 更久没动过的会话不碰
        cooldownMinutes: 30      # 同一会话的续跑冷却
        maxPerDay: 3             # 同一会话 24h 内最多续几次
        maxCandidates: 8         # 最多检查几个最近的会话
        maxResumePerBoot: 5      # 一次启动最多续几个
        staggerMs: 1500          # 多个会话之间的间隔
```

## 可观测性

每次启动都会往 `$DSH_HOME/auto-continue/auto-continue.log` 写一段：

```
[2026-10-21T02:50:55.275Z] 发现未完成轮次 session-9ba505ca…（turn=47, 判定=open, 最后事件 …）
[2026-10-21T02:50:55.383Z] session-9ba505ca…: 已投递「继续」
[2026-10-21T02:51:00.290Z] 启动检查完成：续跑 3 个会话
```

同目录的 `state.json` 保存每个会话的冷却历史（删掉即清空）。

## 尾部是怎么读的

`sessionPersistence.open(id, 'read')` 之后，从投影缓存的最后一个 seq 往回读最多 1000 条事件；缓存缺失或窗口里没有轮次边界时退回全量读。候选会话来自 workspace 注册表，所以子代理会话和已归档会话不会被选中。

## 要求

- DSH 宿主 `>= 0.2.0-rc.2`
- 宿主服务：`agents`；`sessionPersistence` 与 `agentDefaultModel` 存在时会用到

## License

MIT

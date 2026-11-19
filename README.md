# dsh-cortex-agency

`dsh-cortex` 的伴生层：**驱力、空闲沉思、元认知目标**。

它不是意识，也不假装是。它是一台很小的、可审计的调度器：决定「什么时候值得花一点 token，让角色独自想一想」，以及想出来的东西放在哪里。

## 安装

需要先有 `dsh-cortex`。然后：

```powershell
dsh plugin --profile desktop add dsh-cortex-agency@0.1.7
```

默认关闭（`enabled: false`）；在 profile 配置里打开后由 cortex 的心跳驱动。数据在 `~/.dsh/cortex-agency`，与 cortex 的库分开，删掉这个目录就彻底清除。

## 三条硬规则

1. **默认关闭。** `enabled: false` 时 `apply` 不写任何东西、不调任何 LLM。
2. **由宿主心跳驱动。** 通过 `cortex.onTick()` 挂到 dsh-cortex 的 scheduler 上；只有老宿主没有 tick 钩子时才退回到自带的 `setInterval`（unref，dispose 时清掉）。
3. **写入分区。** 所有沉思都走 `cortex.write({ scopeId: 'agency', facts: [] })`：
   - scope 是 `agency`，与用户记忆的 `global` 分开，召回不会把独白当成用户说过的话；
   - `facts: []` 让自动事实抽取不跑，独白不会变成事实；
   - 它**永远不发消息**，也不改提示词。

## 它做什么

每个心跳，如果已经空闲超过 `idleMinutes`：

1. 驱力按空闲时长累积（好奇 / 联结 / 安定 / 表达）；
2. 越过阈值的驱力生成一条**目标**（模板，不花 token），24 小时过期；
3. 满足日预算时，挑压力最大的驱力，**先只读地取几条最近的真实记忆**，再让 LLM 写一段 60–120 字的内心独白；每个驱力有自己的间隔：说得越多，下次等得越久（60 分钟起、翻倍、上限 6 小时），所以一个驱力刚说完，另一个可以接手；
4. 写入 cortex（`kind: reflection`, `source: agency:inner`），释放该驱力。

没有 LLM 时**直接跳过**，不编造文本。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `scope` | `agency` | 写入 cortex 的分区 |
| `idleMinutes` | `30` | 空闲多久才进入内在循环 |
| `maxThoughtsPerDay` | `12` | 每天条数上限（token 预算） |
| `minGapMinutes` | `60` | 每个驱力的基础间隔；每说一次翻倍 |
| `globalGapMinutes` | `25` | 任意两条沉思之间的全局硬间隔（0.1.5 起） |
| `similarityThreshold` | `0.35` | 与最近几条的二gram相似度上限，超了先重写（0.1.6 起） |
| `maxAttempts` | `1` | 相似度超限后的重写次数 |
| `maxCatchUpMinutes` | `30` | 单次 tick 最多补算多少分钟驱力，防止空档一次灌满 |
| `maxGapHours` | `6` | 间隔翻倍后的上限 |
| `maxTokens` | `220` | 单条上限 |
| `recallMemory` | `true` | 沉思前是否只读取记忆做素材 |
| `memoryScope` | `global` | 读记忆的 scope（只读） |
| `memoryLimit` | `3` | 每次读几条 |
| `dataRoot` | `~/.dsh/cortex-agency` | 自己的 SQLite 目录 |

数据表：`drives` / `thoughts` / `goals` / `meta`，与 cortex 的库完全分开，升级或恢复 cortex 不会碰到它。

## 查看

```bash
node bin/agency.mjs status
node bin/agency.mjs thoughts --limit 10
```

对话里也能查（0.1.1 起）：工具 `cortex_agency`，`action` 取 `status` / `thoughts` / `step`。

## 边界

- 不产生主观体验；「驱力」是一组数字，「沉思」是一段文本。
- 不联网（除非 cortex 的 LLM 适配器本身联网）。
- 不在 `session/event` 活跃时运行。

## 前提与许可

- 需要先装 `dsh-cortex`：本插件通过 `cortex.onTick()` 挂到它的调度器上。
- DSH `>=0.2.1-rc.2 <0.5.0`、Node `>=24`（见 `package.json` 的 `engines` / `dsh.compatibility`）。
- 默认关闭（`enabled: false`）：不开启时不写任何东西、不调 LLM。
- **MIT**，见 [LICENSE](LICENSE)。数据在 `~/.dsh/cortex-agency`，删掉该目录即彻底清除。

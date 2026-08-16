# v0.0.361 Change Log — Session States 三层结构 + Reminder Queue 双模式 + cache_control 三断点

> 需求：老板 session states + reminder 大改（拍板链：900d04540 方案终版 10 点 → 5db2d725f 终版修正 → 8310b5fca v2 重拆 → 4fa873ad0 v2.1 三断点补丁，老板 20:21/20:34 终版）。
> 契约：`change_plan.md`（frozen，v2.1）。
> 实现 commit 链（新→旧）：c3a12d648（T4 review）→ 396b2e528（T4）→ 7db696ead（T3 review）→ a112107d6（T3）→ 78ee60b0a（T1 review）→ 3a1c02605（T2 review）→ 171b3be4b（T2 Minor）→ e8b72af30（T2）→ 28328d235（T1... 见 task.json：T1=e8b72af30 基建、T2=28328d235 mapper、T3=a112107d6 injector、T5=0227a1ead encode）→ 0227a1ead（T5）→ a50063e6d（T5 Minor）→ 982ebe189（T5 review）。

## 1. 变更摘要（决策表）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 三层结构 | 静态半（env/工作目录/团队盘路径）→ system prompt `session_states` mapper（stable，priority 810）；动态半（todo/squad 状态/task）→ reminder provider 链；增量变化行 → reminder queue 写侧投递 |
| D2 | 双模式 | `RunState.useFullReminder`（undefined=true）：full 轮（run 首轮/summary version 变）= 时间固定段 + 动态链全量 + `queueClearAll` + 置 false；incremental 轮 = 时间固定段 + `queueDrain` |
| D3 | queue 开放通道 | `ReminderQueueStore`（`{DATA_DIR}/sessions/{sid}/reminder_queue.json`）：有序 entries + Map 去重；write 同 key 删旧追加尾；drain 拿锁按序读+清空；**非注册制**（任何写方直接 new，临界区纯同步 JS 多实例不交错） |
| D4 | wire 裁决 B' | 历史 reminder 块 append-only **全保留进 wire**（删 drop + 删避让扫描 `injectLastNonReminderCacheControl`） |
| D5 | 三断点 | bp#1 system 末（既有）+ **bp#T tools 末**（v2.1 补丁新增，`encodeTools` 末位注入）+ bp#2 **固定打最末 message 最末 block**（不再避让）；前缀命中 = 稳定历史 + 本轮新块 |
| D6 | time 退役 | time provider 五链退役（plugin.json EP + scopes 6 yaml + i18n 双 locale + 计数断言 ×2）；逻辑平移 injector 内时间固定段（tz/分钟级语义不变） |
| D7 | squad_agents_status 拆半 | 名单（name+role+sessionId）归 `team_roster` mapper；provider 只出状态行（`- {name} · {running|idle} · presence`）；a2a 寻址 sessionId 由 roster 提供 |
| D8 | fanout | `squad-states-fanout.ts`：`fanoutStates`（presence 工具，key `presence:{memberId}`，全员+squadChat）/ `notifyMemberState`（state machine，key `member_state:{sid}`）/ `notifyTaskTransition`（panorama tool+http 两入口同调，key `task:{id}`，audience=leader∪owner∪dep owners）；逐 session 失败隔离 |

## 2. 实现核对表（T1-T5 全 review 完结）

| 任务 | 实现 | review | 验证 |
|---|---|---|---|
| T1 queue 基建 + useFullReminder + summary 触发 | e8b72af30 | **PASS**（78ee60b0a） | UT |
| T2 session_states mapper + 静态三 provider 退役 + 拆半 | 28328d235 | **CONDITIONAL PASS**（3a1c02605；Minor 171b3be4b：头注释「name+sessionId 仍输出」过时矛盾更正） | UT（manifest 计数断言按四退役+一新增同步，详见 T2/T3 review 报告） |
| T3 injector 双模式 + time 退役 + context-engine 接线 | a112107d6 | **PASS**（7db696ead：六面全过 + 独立验证 46/46 + 全量 10892 绿 + tsc 0；观察点×2 见 §5 备注） | 全量 UT |
| T4 五写点接线 + fanout helper | 396b2e528 | **CONDITIONAL PASS**（c3a12d648：并发安全实证 + 定向 97/97 + 全量 2/3 次绿；Minor coversFiles 笔误已修） | UT |
| T5 encode 三断点（删 drop+避让，bp#T 新增） | 0227a1ead | **CONDITIONAL PASS**（982ebe189；Minor a50063e6d：两处过时「2bp」注释同步三断点） | UT |

## 3. 实现偏差（以代码为准）

1. **queue 实例 per-call new**（非单例注入工具层）：T4 写点全部 `new ReminderQueueStore({fsRoot}).write(...)`——设计注释实证 write 临界区纯同步 JS，事件循环串行，多实例并发写不交错；`ContextEngine.getReminderQueueStore()` 单例保留给消费侧。change_plan §1.5 表述为「共享单例」，实现按临界区论证放宽（语义等价）。
2. **fanout audience 口径**：task transition 不含 squadChat（写侧过滤 leader∪owner∪dep owners）；presence/member_state 含全员+squadChat。以 `squad-states-fanout.ts` 注释为准。
3. **squad_agents_status SquadChat 行**保留 `(squad, sessionId)` 完整格式（门控行自身即名单例外），仅成员行拆半去 role/sessionId。

## 4. 标准沉淀（本版进入 tech KB 的新口径）

- reminder 双模式 + queue 开放通道：`specs/tech/agent/context/[P0]system_reminder.md`（§3/§4）
- `session_states` mapper（承接退役静态半）：`[P0]system_prompt.md §4` + `[P0]extension point and implementations.md §3.4`
- 三断点体系（bp#1/bp#T/bp#2 + 历史块全保留）：`[P0]cache_control.md §3` + `anthropic_impl.md §4`
- squad 拆半 + fanout 三入口接线表：`specs/tech/squad/[P1]squad_reminder_providers.md §7b`
- todo 工具 queue 接线：`specs/tech/agent/tools/[P1]todo_tools.md §6`

## 5. review 备注观察点（T3，leader 指示不入 spec）

- ① incremental 轮 `buildReminderExtras` 每轮构建但无消费（语义零影响）——后续版本可清理。
- ② `agent-loop-lifecycle.ingestAndAssemble` 系 pre-existing 死 export——建议后续版本清理。

## 6. 文档同步清单（本 commit，doc-modifier）

| 文件 | 同步内容 |
|---|---|
| context/[P0]system_reminder.md | 双模式全文改写：§3 provider 表 8→4 + time 退役注记；§4 injector 伪码（useFullReminder/queueClearAll/queueDrain）；§5 wire 段三断点引用；§5.1 拆半 |
| context/[P0]system_prompt.md | §4 mapper 表 +`session_states` 行（登记序 12，stable，priority 810） |
| context/[P0]context_ingest_detail.md | §3 injector 行改双模式 + 触发条件现状对齐 |
| context/[P0]extension point and implementations.md | 计数 57→53；§3.4 表 +session_states；§3.6 表 8→4 + 退役注记；合计行 + manifest 样例 |
| context/index.md | 计数 + system_reminder 概念行 + 边界表行 |
| providers_and_models/[P0]cache_control.md | 三断点全文改写（§1/§2/§3.2/§3.3/§3.4/§4.1/§5/§6/§7/§8） |
| providers_and_models/anthropic_impl.md | §4 落地细节三断点（2→3 bp + tools JSON 示例 + 实现清单） |
| tools/[P1]todo_tools.md | §6 queue 接线段 |
| squad/[P1]squad_reminder_providers.md | 标题/定位 2 provider；§2 退役注记；§3 拆半；§5 矩阵；§7 双模式；新 §7b fanout 接线表；§8 边界 |
| squad/[P1]prompt_sections.md | §1 总表 +session_states/−squad_workspace；§4 表 2 provider；§5 格式行；§6 生命周期 |
| squad/index.md | reminder/presence 概念行 |
| 4 × KB log.md（context/providers_and_models/tools/squad） | v0.0.361 条目（倒序顶部） |
| 本 change_log.md | 新建 |

> API 面零影响（无 HTTP 契约变更；SSE/端点不变）。

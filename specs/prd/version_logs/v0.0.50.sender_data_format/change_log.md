# v0.0.50 PRD 变更日志 — sender/reminder 数据形态修正 + langfuse 物理层双打点

## 概述

从 langfuse 拉到的 message 记录暴露两个数据形态问题（reqs/v0.0.50.sender_data_format/req.md）：

1. **`sender` 与 `content` 并列于 message 顶层**——一条 message 混含多来源 block（如 user 正文 + system reminder text）时，消息级 `sender` 无法描述"某一块是谁贴的"。
2. **`metadata.isSystemReminder` 挂在 message 最外层**——同一诟病：只能表达"这条 message 含 reminder"，不能表达"哪一块是 reminder"，v0.0.39 已经用块级 `TextBlock.isSystemReminder` 兜住前端渲染，但消息级冗余标记仍在。

另发现：**发给 LLM 的物理 wire body 从未上报 langfuse**。当前 langfuse 的 generation `input` 是**业务层 `Message[]`**（sender 结构化、reminder 块单独一块），与真正打到 HTTP 上的**物理 wire body**（sender 已展平到 text 前缀 / role tool→user / 相邻同 role 合并 / cache_control）差别显著。用户"以为发了什么"和"实际发了什么"之间存在盲区，出锅无法定位。

用户判定：
- reminder 追加到 last user message 的既有逻辑**保留**（最小化「逻辑存储」与「物理传输」的 gap；绝大多数场景一条 message 只有一个来源，混块只在 reminder 注入场景出现，可控）。
- 但**要把「sender/reminder → LLM 视图文本」的转换抽成 protocol 无关的公共层**，避免每种 protocol（anthropic/openai/gemini/...）各自实现一遍 `[Message from ...]` 前缀塞入。
- **langfuse 追加物理层 generation 独立打点**（`llm-N-physical`，与 `llm-N-logical` 挨着），方便对账；受 dev config 开关控制，**不带 usage**（避免污染总量统计）。

**一句话定位**：不动业务 Message 存储结构，抽出"业务 Message → LLM 视图"的公共 encoder（sender/reminder 展平）作为各 protocol 的上游；同时让 langfuse 能同时记「业务视图」与「物理 wire」两份 input，靠 dev 开关按需启用物理层。

**父版本**：v0.0.49；**直接地基**：v0.0.39（reminder 块级标记落地）+ v0.0.31（MessageSender 判别联合）+ v0.0.25（langfuse metadata `physicalWireBody` 已预留，未启用为独立 generation）。

**权威输入**：`reqs/v0.0.50.sender_data_format/req.md`（用户诉求 3 点 + 归属讨论 + 澄清 3 轮）；本 PRD 是其产品化表达，不发明新概念。

---

## 1. 版本目标 [v0.0.50]

1. **消息级 `metadata.isSystemReminder` 明确废止**：块级 `TextBlock.isSystemReminder`（v0.0.39）为唯一权威；injector 不再写消息级 `metadata.isSystemReminder`；旧 transcript 记录不做迁移（读取时忽略消息级字段，前端 flatten 只看块级）。
2. **`sender` 保持消息级不变**：每条 inbox drain 出的 message 有且仅有一个来源（drain 已按 entry 分条，v0.0.31 判别联合已足够）；文档说明"一条 message 一个 sender"的结构不变量，reminder 场景的 mixed-block 用块级 `isSystemReminder` 描述而非再叠一层块级 sender。
3. **抽公共 LLM 视图 encoder（protocol 无关）**：把「业务 `Message[]` → LLM 视图 `Message[]`」的转换（sender → 首个 TextBlock 前缀塞入）从 `agent-loop-stage-llm` / `message-prefix-renderer` 独立成公共层，`llm/` 下新增 `logical-view.ts`；各 protocol.encode 收到的入参已是"视图后 Message"，protocol 只做**自身必要的转换**（如 anthropic 的 role tool→user、相邻同 role 合并、cache_control）。
4. **langfuse 追加物理层独立 generation**：一次 LLM 调用打**两条紧邻的 generation**（`llm-N-logical` + `llm-N-physical`），同一 step span 下。`logical` = 现有 GenInput（业务视图 Message[]），`physical` = protocol.encode 后的 wire body（`llm_caller.invoke` 内的调用点附近）。**物理层不带 usage**（`endGeneration` 时 usage 传空/0，只写 name 区分 + input wire body + endTime + metadata.physicalWire=true），保证 langfuse 项目总 token 统计只被 `logical` 贡献一次。
5. **物理层由 dev config 开关**：`dev_config.runtime.observability` 每项新增 `logPhysical?: boolean`（默认 false，向后兼容）；仅 true 的 backend 收到 `startGeneration(physical)`。**改动不热更新**（与 observability 列表本身的热更新语义一致）。
6. **旧 `GenMetadata.physicalWireBody` 字段废弃**：物理 wire body 不再塞到 `logical` generation 的 metadata；改为**独立 generation** 承载。字段声明层保留 optional 兼容旧读；写路径不再填。

---

## 2. 范围（IN / OUT）

### 2.1 IN SCOPE

| 编号 | 模块 | 权威 spec |
|---|---|---|
| **A** | 块级唯一权威：injector 不写消息级 `metadata.isSystemReminder`；agent_message_interface 明确「消息级已废止，块级唯一」 | `[P0]agent_message_interface.md §4.1`（更新）+ `[P0]system_reminder.md §4`（更新） |
| **B** | 公共 LLM 视图 encoder（`llm/logical-view.ts`）：sender → 首个 TextBlock 前缀塞入（复用 `renderSenderPrefix` 表）；输出 `Message[]`（视图形态，sender 已展平入 content，其他字段保留）；纯函数无副作用 | `[P0]llm_logical_view.md`（新增） |
| **C** | Protocol encode 契约调整：`encode(request)` 的 `request.messages` **假定已是视图形态**（sender 已展平），protocol 只做协议本身的合并/映射；`renderMessageContentWithPrefix` 从 `agent/message-prefix-renderer.ts` 迁到公共层（用途/位置调整，函数签名保留） | `[P0]llm_protocol_interface.md`（更新）+ `[P0]llm_logical_view.md §3` |
| **D** | Langfuse 物理层独立 generation：一次 LLM 调用产两条 generation（`llm-N-logical` + `llm-N-physical`，name 后缀区分），parent 同一 step span，`physical` 不带 usage（`Usage` 全 0） | `[P0]observability_interface.md §5.2/§4`（更新）+ `[P0]llm_caller.md`（更新） |
| **E** | dev config 开关：`ObservabilityConfigItem.logPhysical?: boolean`（默认 false）；启用后该 backend 才收到物理层 generation；关闭时零开销（不构造 wire body 二次 serialize 也可，但 encode 本就要跑，直接把已有结果传埋点即可） | `[P0]dev_config.md §3.4.1`（更新）+ `[P0]observability_manager.md`（更新） |
| **F** | 迁移与兼容：`GenMetadata.physicalWireBody` 字段保留声明但停止写入（v0.0.25 未落地为独立 generation 的过渡产物，本版落地为独立 generation 后废弃写路径） | `[P0]observability_interface.md §5.2` metadata 注释 |

### 2.2 OUT OF SCOPE

- **块级 `sender`**：不引入。一条 message 一个 sender 的结构不变量沿用；reminder 场景的 mixed-block 用块级 `isSystemReminder` 已足够（前端过滤不误伤 user 正文，LLM 送出 sender 已展平入前缀）。
- **Reminder 存独立 message**：不改。追加到 last user/a2a message content 末尾的既有逻辑保留；这样能最小化「存储」和「wire」的 gap。
- **旧数据迁移**：不写迁移脚本。老 transcript 里遗留的消息级 `metadata.isSystemReminder=true` 记录读取时**被忽略**（前端块级过滤不看它，injector 也不再写）；不引起观感变化。
- **物理层默认开启**：dev 开关默认 false，避免全项目 langfuse 用量翻倍。
- **物理层带 usage**：明确不带；避免污染 token/cost 汇总。
- **多 protocol 支持**：本版本仍只 `anthropic_messages`；`logical-view` 抽公共层是为未来 protocol 铺路，本版本不新增 protocol。

---

## 3. 关键用户路径（测试最低覆盖要求）

| 路径 | 描述 | 断言 oracle |
|---|---|---|
| **路径 1** | 用户发消息 → agent 干活 → langfuse 有 `llm-1-logical` generation | langfuse trace 该 generation.input.messages 是业务视图（含 sender 结构化）、name 后缀 `-logical` |
| **路径 2** | 开启 `logPhysical=true` 后跑同流程 → langfuse 有并列 `llm-1-physical` generation | 同 step span 下两条 generation，`physical` name 后缀 `-physical`；`physical.input` = wire body（含 anthropic role/content 结构、system 顶层、`tool_use`/`tool_result` block、`cache_control`）；**`physical` usage 全 0**（total_tokens=0/cost=0） |
| **路径 3** | 关闭 `logPhysical=false`（默认）→ 只有 `logical` generation | langfuse 每轮只有一条 generation；trace 树深度不变 |
| **路径 4** | reminder 注入后送 LLM → LLM 视图（logical generation input）**没有** `[system_reminder]` 前缀被再包一层；只有 sender 前缀展平（`[User]:` / `[Message from ...]`）；块级 `isSystemReminder` 不进 wire | logical input 中最后一条 user message 首个 text 是 `[User]: <正文>`，之后追加 reminder text block（原样 `[system_reminder]\n- ...`，无 sender 前缀）；physical wire body 同 |
| **路径 5** | 新写入的 message 从 injector 出来 → 消息级 `metadata.isSystemReminder` **不存在** | 读 session store transcript：最后一条 user message `metadata` 中不含 `isSystemReminder` 字段；块级 reminder block 仍有 `isSystemReminder:true` |
| **路径 6** | 一次 LLM 调用错误路径（invoke throw）→ `logical.endGeneration({status:'error'})` 正常写；`physical` 若已 start 则同步 endGeneration（无 usage）；两条 generation 都出现在 trace | trace 观察两条 generation 都 endTime 有值，`logical` level=ERROR，`physical` 不带 usage 不带 output |

---

## 4. 影响面

| 层 | 影响 |
|---|---|
| **业务 message 存储** | 只减字段：injector 不再写 `metadata.isSystemReminder`。老数据不迁移，读取时忽略。 |
| **业务 message 送 LLM** | 抽公共 logical-view 层，调用点从 `agent-loop-stage-llm` / protocol.encode 内部迁到入口处；`message-prefix-renderer` 从 `agent/` 迁到 `llm/logical-view.ts`（模块位置调整，签名不变）。 |
| **Protocol encoder** | `encode(request)` 语义澄清：入参 `messages` 已是视图形态；文档更新一句「sender 已展平入 content，encode 不再管 sender」；实现不需要改 anthropic_messages（它当前就没读 sender，行为等价）。 |
| **Observability adapter 接口** | `startGeneration` 增加语义：一次 LLM 调用可产 2 条 generation（`logical` + `physical`），parent 同 step；`GenInput` 支持两种 input 载荷（业务 Message[] / wire body raw）——通过 `name` 后缀区分，metadata 加 `physicalWire?: boolean` 便于查询过滤。 |
| **LangfuseAdapter** | 沿用 SDK 的 generation 概念，逻辑层 name=`llm-N-logical`、物理层 name=`llm-N-physical`；`physical` 时 `input` 传 wire body（unknown/object），不传 usage/output（或 usage 全 0，避免统计污染）。 |
| **LLM Caller** | `invoke` 内在真调 HTTP 前若 `logPhysical` 开启，调 `startGeneration(physical)` + endGeneration（无 usage）；成功/失败都收尾。 |
| **DevConfig** | `ObservabilityConfigItem` 增字段 `logPhysical?: boolean`（默认 false）；前端 dev 配置页展示新字段（开关）。 |
| **前端渲染** | 无影响（块级 filter 早已生效；消息级不再写不改变前端行为）。 |

---

## 5. 验收标准

- **AT-1**：langfuse `logPhysical=true` 场景 → 每轮 LLM 调用两条 generation，`logical` + `physical`，name 后缀正确；`physical` usage 全 0；trace 树 parent 相同 step span。
- **AT-2**：langfuse `logPhysical=false`（默认）→ 只有 `logical`；trace 深度/事件数与 v0.0.49 一致。
- **AT-3**：新写入 message 的 `metadata` 不含 `isSystemReminder`；块级 reminder block 仍有 `isSystemReminder:true`。
- **AT-4**：现有 API/E2E 测试全 pass（reminder 注入 / a2a 前缀渲染 / anthropic wire body 结构均不变化）。
- **AT-5**：dev 配置页新增字段 `logPhysical` 可读写，改动经列表 PUT 后重启 session 生效。

---

## 6. 版本

> 变更历史见 [`log.md`](../../../tech/agent/observability/log.md) / [`log.md`](../../../tech/agent/message/log.md)（子系统位置轴）。

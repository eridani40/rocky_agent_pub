# v0.0.50 技术变更日志 — sender/reminder 数据形态修正 + langfuse 物理层双打点

> 范围红线：本版**不引入块级 sender**、**不改变 reminder 追加到 last user message 的存储逻辑**、**不动业务 Message 存储 schema**（只废字段写入）；差异集中在 3 个子系统：
> - **message 子系统**：injector 停写消息级 `metadata.isSystemReminder`；块级 `TextBlock.isSystemReminder` 为唯一权威。
> - **llm 子系统**：新增 `llm/logical-view.ts`（业务 `Message[]` → LLM 视图 `Message[]` 公共 encoder），`agent/message-prefix-renderer.ts` 内容迁入本层（agent 侧调用点从 stage-llm 提前到入口处）。
> - **observability 子系统**：一次 LLM 调用打两条 generation（`llm-N-logical` + `llm-N-physical`），受 `ObservabilityConfigItem.logPhysical` 开关控制，物理层不带 usage。

> 权威输入：`specs/prd/version_logs/v0.0.50.sender_data_format/change_log.md`（6 用户路径）+ `reqs/v0.0.50.sender_data_format/req.md`（澄清 3 轮）。

---

## 0. 现状确认（澄清结论 · 代码证据）

> 本节记录需求澄清期间用代码验证的现状事实，作为 §1-§9 改动设计的依据。coder 实现前必读。

### 0.1 drain 不合并跨 sender message

`drainAndPartition` (`agent-loop-stage-pre.ts:46-101`) 每个 inbox entry 产出**独立 `MessageInput`**，push 到 `newMessages`，**不合并**。2 个 entry（如 1 a2a + 1 user）→ 2 条独立 Message，各按入队时 content 形态（通常 1 个 TextBlock，但可以是多个）。`sender` 是每条 Message 的消息级字段，描述整条来源。

→ **结论**：存储层"一条 message 一个 sender"的结构不变量成立，不需要块级 sender。

### 0.2 结构化 sender 字段不进 LLM wire

`encodeMessage` (`protocol-encode.ts:149-154`) 只读 `m.role` + `m.content`，**不读 `m.sender`**：

```typescript
function encodeMessage(m: Message): Record<string, unknown> {
  return {
    role: m.role === 'tool' ? 'user' : m.role,
    content: m.content.map(encodeContentBlock),
  };
}
```

`encodeContentBlock` 对 TextBlock 只读 `b.text`（`protocol-encode.ts:186-187`），不读 `isSystemReminder` 或其他业务字段。

→ **结论**：结构化 `sender` 字段从未进过 wire body；LLM 不认识 sender 是结构化概念。

### 0.3 sender 通过文本前缀塞进 content（LLM 唯一可见路径）

调用链（`agent-loop-stage-llm.ts:108` / `agent-loop-call-main.ts:98`）：

```
snapshotMessages.map(toProtocolMessage)         ← agent-loop-helpers.ts:82
  └→ renderMessageContentWithPrefix(m)         ← message-prefix-renderer.ts:69
       └→ renderSenderPrefix(m.sender)         ← sender → '[User]: ' / '[Message from ...]: '
       └→ 前缀拼进首个 TextBlock.text 前
→ protocolMessages 传给 client.call / protocol.encode
→ wire body                                         ← sender 字段从未出现，只有文本前缀
```

前缀表（`message-prefix-renderer.ts:31-56`）：

| sender.source | 前缀 |
|---|---|
| `agent` | `[Message from <ref.name> (<ref.type>, needReply=<bool>)]: ` |
| `user` | `[User]: ` |
| `system` kind=`heartbeat` | `[System (heartbeat tick)]: ` |
| `system` kind=`reminder` | `[System reminder]: ` |
| `system` 其他 | `[System (<kind>)]: ` |
| `approval` | `[Approval result]: ` |
| 无 sender | 空串（原样返回 content） |

→ **结论**：LLM 通过自然语言前缀知道"这条谁发的"，但看不到结构化 sender。这个转换目前绑在 agent-loop 侧的 `toProtocolMessage`，不在 protocol 层——正是 v0.0.50 抽 `llm/logical-view.ts` 公共层的原因。

### 0.4 langfuse 记的是业务视图，非 LLM 实际收到的 wire body

`LoopObservability.startGeneration` (`agent-loop-observability.ts:175-198`) 传给 langfuse 的 `input.messages` = `snapshotMessages`（业务 Message 原始形态，**未经 `toProtocolMessage` 展平**）：

```typescript
const input: GenInput = {
  system: snapshotSystem,
  messages: snapshotMessages,    // ← 业务 Message[]，sender 结构化、content 原始
  ...
};
```

而真正发给 LLM 的是 `snapshotMessages.map(toProtocolMessage)` → `protocol.encode` 后的 wire body（`agent-loop-stage-llm.ts:108`），sender 已变成文本前缀。

→ **结论**：langfuse `generation.input` ≠ LLM 实际收到的 input。langfuse 记的是"业务视图"（符合 `Message` 类型定义），不是"LLM 视图"（sender 已展平成前缀）。这就是 v0.0.50 physical generation 要解决的盲区——加 `llm-N-physical` 独立 generation 记 wire body，对账两份 input 差异。

### 0.5 reminder 块级标记已是 v0.0.39 既有

`TextBlock.isSystemReminder` (`message/types.ts:42`) 在 v0.0.39 已落地；`system_reminder_injector.ts:70` 注入时设块级 `isSystemReminder=true` + 消息级 `metadata.isSystemReminder=true`（双标记）。前端 `DEFAULT_BLOCK_FILTER` (`message-flatten.ts:34`) 早已只读块级过滤。

→ **结论**：本版停写消息级 `metadata.isSystemReminder` 不影响前端行为；块级已是唯一权威路径。

---

## 1. 改动总览

| # | 子系统 | 改动核心 | 权威 spec |
|---|---|---|---|
| **A** | message | injector 停写消息级 `metadata.isSystemReminder`；块级 `TextBlock.isSystemReminder` 明确为唯一权威。老数据读时忽略（不迁移） | `[P0]agent_message_interface.md §4.1` + `[P0]system_reminder.md §4`（更新版本注释） |
| **B** | llm | 新增 `llm/logical-view.ts` — `toLogicalMessages(messages: Message[]): Message[]` 公共 encoder（sender → 首个 TextBlock 前缀塞入；纯函数、零副作用）；agent 侧 stageLLMRequest 在调 protocol 前先调本函数 | `[P0]llm_logical_view.md`（新增） |
| **C** | llm | `agent/message-prefix-renderer.ts` 内容迁入 `llm/logical-view.ts`（`renderSenderPrefix` / `renderMessageContentWithPrefix` 保留签名，位置调整）；agent 侧原直调点改经 logical-view 入口 | `[P0]llm_logical_view.md §3` |
| **D** | llm/protocol | `LlmProtocol.encode(request)` 契约文档更新：`request.messages` 假定**已是 logical 视图**（sender 已展平进 content）；encode 不再需要感知 sender。anthropic_messages 实现零改（本来就没读 sender） | `[P0]llm_protocol_interface.md §3.5`（更新） |
| **E** | observability | `startGeneration` 支持一次 LLM 调用产两条 generation：`logical`（既有）+ `physical`（新，wire body 载荷）；同一 step span parent；name 后缀 `-logical` / `-physical` 区分；`physical` 不带 usage/output | `[P0]observability_interface.md §4/§5.2`（更新） |
| **F** | observability | `GenStart` 加字段 `kind: 'logical' \| 'physical'`（默认 `logical`，向后兼容）+ `physicalInput?: unknown`（wire body 载荷载体）；`GenMetadata.physicalWireBody` 停止写入（保留声明兼容旧读） | `[P0]observability_interface.md §5.2`（更新） |
| **G** | observability | `LangfuseAdapter` 处理 `physical` kind：name 后缀替换 `-physical`；`input` 用 `physicalInput`；不调 `mapUsage`（usage 空对象或 `{ total: 0, unit: 'TOKENS' }`）；不写 `endTime.output` | `[P0]langfuse_adapter.md`（更新） |
| **H** | observability | `ObservabilityManager` fan-out 时按 child.`logPhysical`（来自 `ObservabilityConfigItem.logPhysical`）过滤：`kind='physical'` 时只发给启用项 | `[P0]observability_manager.md §5`（更新） |
| **I** | config | `dev_config.runtime.observability[i]` 加字段 `logPhysical?: boolean`（默认 false）；bootstrap 构造 `LangfuseAdapter` 时透传给 child 元数据；改动不热更新（重启/下 session 生效） | `[P0]dev_config.md §3.4.1`（更新） |
| **J** | agent loop | `LoopObservability.startGeneration` 保持既有语义（只发 logical）；`stageLLMRequest` / `llm_caller.invoke` 在拿到 wire body 后（若任一 child 启用 physical）另调一次 `adapter.startGeneration({kind:'physical', ...})` → 同步 endGeneration（无 usage） | `[P0]agent_loop_llm_call.md` / `[P0]llm_caller.md`（更新） |

**核心不变量**（MUST NOT violate）：
1. **业务 Message 存储 schema 不变**：`Message.sender` 消息级；`Message.metadata` 仍在（其他 kv 未受影响）；本版仅停写 `metadata.isSystemReminder`。
2. **前端 flatten 行为不变**：v0.0.39 起 `DEFAULT_BLOCK_FILTER` 只读块级 `isSystemReminder`；本版消息级停写不影响它。
3. **LLM wire body 不变**：`toLogicalMessages` 语义 = 现在 `renderMessageContentWithPrefix` + protocol.encode 组合；抽公共层是位置调整，anthropic wire body byte-level 一致（除 cache_control 时序前后无关外）。
4. **物理层默认关闭**：`logPhysical` 缺省 false，v0.0.49 行为等价，langfuse 项目 token 统计不受污染。
5. **物理层不带 usage**：`physical` generation 的 usage 必须为空/0，避免 langfuse cost dashboard 双计。

---

## 2. 改动文件清单（A/M，按子系统）

> 字段 / 签名 / 时序细节以下方 §3-§6 spec 章节为权威。

### 2.1 message 子系统

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/plugins/builtins/rocky_context/ingest/system_reminder_injector.ts` | 修改 | 删除 `metadata: { ...(last.metadata ?? {}), isSystemReminder: true }` 的写入分支；只保留块级 `TextBlock.isSystemReminder=true`；保留 `newLast.metadata` 字段本身（其他 kv 存活） | `[P0]system_reminder.md §4` |
| `app/server/src/message/types.ts` | 修改（注释） | `Message.metadata` 字段注释更新："消息级 `isSystemReminder` 已废止（v0.0.50）；块级 `TextBlock.isSystemReminder` 唯一"；`TextBlock.isSystemReminder` 注释去掉「双标记共存」措辞 | `[P0]agent_message_interface.md §4.1` |
| `app/web/src/components/chat-page/message-flatten.ts` | 无需改 | `DEFAULT_BLOCK_FILTER` 早已块级；老数据消息级字段被前端忽略（无迁移） | — |

### 2.2 llm 子系统

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/server/src/llm/logical-view.ts` | 新增 | 导出 `renderSenderPrefix(sender)` / `renderMessageContentWithPrefix(message)` / `toLogicalMessages(messages)`；纯函数；`toLogicalMessages` = `messages.map(m => ({ ...m, content: renderMessageContentWithPrefix(m) }))`（不动 sender/metadata/其他字段） | `[P0]llm_logical_view.md §2/§3` |
| `app/server/src/agent/message-prefix-renderer.ts` | 删除 | 内容迁 `llm/logical-view.ts`；agent 内所有 `import` 改指新位置 | — |
| `app/server/src/agent/agent-loop-stage-llm.ts` / `llm/caller/build_invoke_context.ts` | 修改 | 调 `client.call` / `protocol.encode` 前先 `toLogicalMessages(snapshot.messages)`；同时把 logical 视图产物同时喂 observability logical generation 的 input | `[P0]llm_logical_view.md §4`（调用点表） |
| `app/server/src/llm/protocol-encode.ts`（`anthropic_messages`） | 无需改 | 当前 encode 就没读 `Message.sender`；语义澄清后一致；文档补一句「入参已 logical 展平」 | `[P0]llm_protocol_interface.md §3.5` |
| `app/server/src/llm/__tests__/protocol-encode-*.test.ts` | 修改 | fixture 输入改为「已 logical 展平」形态（TextBlock 首块含 `[User]:` 前缀）；断言 wire body 一致 | — |
| `app/server/src/agent/__tests__/message-prefix-renderer.test.ts` | 迁移 | 迁到 `app/server/src/llm/__tests__/logical-view.test.ts`；case 覆盖 4 类 source（agent/user/system-kind×3/approval）+ 空 content 兜底 | — |

### 2.3 observability 子系统

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/server/src/observability/types.ts` | 修改 | `GenStart` 增字段 `kind?: 'logical' \| 'physical'`（默认 `logical`）+ `physicalInput?: unknown`（kind=physical 时的 wire body 载荷）；`GenMetadata.physicalWireBody` 注释标 deprecated（保留 optional，只读，不再写路径） | `[P0]observability_interface.md §5.2` |
| `app/server/src/observability/adapter.ts` | 修改（文档） | 接口注释：`startGeneration` 可被同一 step 内调用两次（logical + physical）；`physical` 的 `endGeneration` 传空 usage | 同上 |
| `app/server/src/observability/langfuse-adapter.ts` | 修改 | `startGeneration` 按 `kind` 分支：logical 沿用；physical → name 后缀 `-physical`、input=`physicalInput`、`metadata.physicalWire=true`；`endGeneration` 若 kind=physical 则 `mapUsage` 传 `{}`（结果 total=0），不传 output；language: **不影响其他 SDK 调用**（try/catch 兜底不变） | `[P0]langfuse_adapter.md`（更新） |
| `app/server/src/observability/observability-manager.ts` | 修改 | 每 child 记录 `logPhysical` bool（构造时透传）；`startGeneration({kind:'physical'})` 时只 fan-out 到 `logPhysical=true` 的 child；`kind='logical'` 时 fan-out 到所有 child（既有） | `[P0]observability_manager.md §5.3`（新增小节） |
| `app/server/src/observability/index.ts`（bootstrap） | 修改 | 从 `ObservabilityConfigItem.logPhysical` 读值构造 `LangfuseAdapter` + manager 的 child 元数据 | 同上 |

### 2.4 agent loop / llm caller

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/server/src/agent/agent-loop-observability.ts` | 修改 | `startGeneration` 保持既有语义（logical only，name=`llm-N-logical`）；`recordLastAssistant` 不变；**仅暴露** `currentGenIteration(): number`（physical name 拼接用，避免物理方法挂本类——见下方归属说明）。**物理埋点方法不在此类**（T4 review 删死代码：LoopObservability 版零 caller）。 | `[P0]observability_interface.md §4` 时序 |
| `app/server/src/llm/caller/langfuse_observability_port.ts` | 修改 | **物理方法归属点**（避免 `llm/caller→agent` 依赖循环）：`hasPhysicalChild()` + `startPhysicalGeneration(wireBody, startTime)` + `endPhysicalGeneration(handle, endTime)` 在 `LangfuseObservabilityPort` 内实现，直接调 `adapter.startGeneration({kind:'physical', physicalInput, name:`llm-N-physical`, ...})`（safe 包裹由 adapter 自身保证）。`llm_caller.invoke` 通过注入的 `ObservabilityPort` 调用，不经 agent 层。 | `[P0]observability_interface.md §4` 时序 + `[P0]llm_caller.md §6`（物理埋点） |
| `app/server/src/llm/caller/llm_caller.ts` / `build_invoke_context.ts` | 修改 | invoke 内在 protocol.encode 得到 wire body 后（进 HTTP 前），若 `obs.hasPhysicalChild()` 为真则调 `obs.startPhysicalGeneration(wireBody, now)`；invoke 收尾（成功/失败）调 `endPhysicalGeneration(now)`。**不带 usage/output** | `[P0]llm_caller.md`（更新，物理埋点章节） |
| `app/server/src/agent/agent-loop-stage-llm.ts` | 修改 | 已在 §2.2 提及：先 `toLogicalMessages` → 送 observability.startGeneration(logical) → 调 client.invoke（内部触发 physical 埋点） | — |

> **★ 物理方法归属说明（doc 阶段订正，T4 review 发现）**：原 §2.4 row 把物理方法（`startPhysicalGeneration`/`endPhysicalGeneration`）列在 `agent-loop-observability.ts`，是过度规约——实际代码这些方法在 `LangfuseObservabilityPort`（`app/server/src/llm/caller/langfuse_observability_port.ts`）。理由：物理埋点点位在 `llm_caller.invoke` 内（encode 后 HTTP 前），若方法挂 agent 层的 `LoopObservability`，则 `llm/caller` 需 import agent 模块，形成 `llm/caller → agent` 依赖循环（agent 层已 import llm/caller）。解法：物理方法挂在 `LangfuseObservabilityPort`（`llm/caller/` 内，已是 `ObservabilityPort` 接口实现），`LoopObservability` 仅暴露 `currentGenIteration(): number` 供 port 拼 `llm-N-physical` 的 N（同 logical 的 N，成对）。`hasPhysicalChild()` 也归 port（能力探测 ObservabilityManager.hasPhysicalChild）。本订正不影响 AT case（断言基于 langfuse trace 的 name 字符串，不依赖代码归属）。

### 2.5 config

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/web/src/components/app-dev-config-page/observability-config/types.ts` | 修改 | `ObservabilityConfigItem` 加 `logPhysical?: boolean` | `[P0]dev_config.md §3.4.1` |
| `app/web/src/components/app-dev-config-page/observability-config/*.tsx` | 修改 | 编辑对话框加 `logPhysical` 开关（默认 off）；说明「记录发给 LLM 的物理请求体（不含 usage）；改动重启生效」 | 同上 |
| `app/server/src/config/observability-config.ts`（schema/parse） | 修改 | 增字段解析（optional，缺省 false）；secret 处理不受影响 | 同上 |

---

## 3. 公共 logical-view（新 spec 章节 `[P0]llm_logical_view.md`）

### 3.1 定位

`llm/logical-view.ts` = **业务 `Message[]` → LLM 视图 `Message[]`** 的**protocol 无关**公共 encoder。职责单一：把结构化 `sender` 信封**展平**到首个 TextBlock 文本前缀（`[User]:` / `[Message from ...]` / `[System (...)]:` / `[Approval result]:`），供任意 protocol.encode 消费。

### 3.2 为什么抽公共层

`sender` 是结构化字段，LLM 不能理解结构；进 wire 前必须变成人类可读文本前缀（防幻觉、指示 a2a 回复方向）。若每 protocol 各做一遍此转换：
- 逻辑重复：`[User]:` / `[Message from ...]:` 表要复刻 N 份。
- 不一致风险：某 protocol 忘转 sender → LLM 看不到"这条谁发的"，导致行为漂移。
- observability 打点困难：想让 langfuse 记「LLM 真正看到什么」，必须先展平，抽公共层后 logical generation input 天然就是"LLM 视角"。

故抽为一层：所有 protocol.encode 上游统一调 `toLogicalMessages`；protocol 自身只做**协议本身的合并/映射**（role tool→user、相邻同 role 合并、system 顶层、cache_control 等）。

### 3.3 接口

```typescript
// 输入：业务 Message[]（sender 结构化，可能混块含 reminder）
// 输出：Message[]（sender 已展平入首个 TextBlock 前缀，结构其他字段保留）
export function toLogicalMessages(messages: Message[]): Message[];

// 单条：sender → 首个 TextBlock 前缀
export function renderMessageContentWithPrefix(message: Message): ContentBlock[];

// sender → prefix 字符串（无 sender/未知 source → 空串）
export function renderSenderPrefix(sender: MessageSender | undefined): string;
```

**前缀表**（与既有 `message-prefix-renderer` 完全一致，不变）：

| sender.source | prefix |
|---|---|
| `agent` | `[Message from <ref.name> (<ref.type>, needReply=<bool>)]: ` |
| `user` | `[User]: ` |
| `system` kind=`heartbeat` | `[System (heartbeat tick)]: ` |
| `system` kind=`reminder` | `[System reminder]: ` |
| `system` 其他 kind | `[System (<kind>)]: ` |
| `approval` | `[Approval result]: ` |
| 无 sender | 空串 |

**注入策略**：
- 前缀空 → 原样返回 content 引用。
- 首个 block 是 TextBlock → 前缀拼到其 text 前（返回新 TextBlock，不改原）。
- 首个 block 非 TextBlock 或 empty → prepend 一个新 TextBlock 承载前缀。

### 3.4 调用点（agent 侧）

`agent-loop-stage-llm.ts` 在拿到 assemble 后的 snapshot.messages 后、调 `client.call` / `protocol.encode` 前：

```
const logicalMessages = toLogicalMessages(snapshot.messages);
// logicalMessages 同时喂给：
//   1) observability.startGeneration(logical).input.messages
//   2) client.call({ messages: logicalMessages, ... })
//      → protocol.encode 拿到的就是视图形态
```

**不变量**：`snapshot.messages` **不被** mutate；`logicalMessages` 是新数组，元素浅拷贝 + 首块 TextBlock 新对象。

### 3.5 与 reminder 的关系

Reminder 已由 injector 追加到 last user/a2a message 的 content 末尾作为 **独立块级 TextBlock**（`isSystemReminder=true`）。经 `toLogicalMessages` 后：
- 该 message 的 `sender.source='user'`（或 `'agent'`），前缀 `[User]:` 拼进首个 TextBlock（业务正文）前。
- reminder block 是**后续**的 TextBlock，不受前缀影响；仍原样 `[system_reminder]\n- ...`。
- LLM 看到：`[User]: 请列出目录\n... reminder text ...`（首块前缀 + 尾块 reminder）。

块级 `isSystemReminder` 标记**不进 wire**：`protocol-encode.encodeContentBlock(text)` 只读 `b.text`（既有语义，见 `protocol-encode.ts:184`）。

### 3.6 边界

| 管 | 不管 |
|---|---|
| sender 展平（→ 首个 TextBlock 前缀） | tool→user role 映射（→ protocol.encode） |
| 保持其他字段（role/id/metadata/tool block 等）原样 | 相邻同 role 合并（→ protocol.encode） |
| ContentBlock 类型联合完整性 | cache_control / system 顶层 / tools wire 字段映射（→ anthropic_impl） |

---

## 4. Observability 双 generation（`[P0]observability_interface.md §4/§5.2` 更新）

### 4.1 时序（本版新增下划线时刻）

```
run_start ──→ startTrace
while iteration N:
  startSpan(stepSpanInput)
  ② LLM 通过:
     callLLM 前 ─→ startGeneration({kind:'logical', input:GenInput})  ← 既有
                  ↓ toLogicalMessages 已跑完，input.messages 是视图形态
     protocol.encode → wireBody
     ┌── 若任一 child logPhysical=true：
     │    startGeneration({kind:'physical', physicalInput: wireBody})  ← 新增
     ├── HTTP 请求发起 → 完成
     │    endGeneration(physical, endTime, usage={})  ← 新增（no usage）
     └── endGeneration(logical, output, usage, ...)  ← 既有
  ③ tool（不变）
  endSpan(step)
run_end ──→ endTrace
```

### 4.2 GenStart 字段扩展

```typescript
interface GenStart {
  parent: SpanHandle | TraceHandle;
  model: string;

  // 判别字段：logical（默认）| physical
  kind?: 'logical' | 'physical';

  // logical 用（既有）：业务视图 messages + system + tools + params
  input?: GenInput;

  // physical 用（新）：protocol.encode 后的 wire body（任意形状）
  physicalInput?: unknown;

  // 起始时间（既有）
  startTime?: Date;
}
```

`endGeneration`：
- logical：保持既有（usage 全字段 + output + metadata）
- physical：`usage` 传空对象（映射后 langfuse 收到 `{input:0, output:0, total:0, totalCost:0}`）、`output` 省略、`metadata.physicalWire=true`

### 4.3 Name 规则

- logical: `llm-N-logical`（N = iteration，由 LoopObservability.genIteration 递增）
- physical: `llm-N-physical`（**同一 N**，成对紧邻）

adapter 内可将 name 生成集中到一处；本 spec 只规约命名格式，不强制实现位置。

### 4.4 与 `GenMetadata.physicalWireBody` 的关系

v0.0.25 时曾在 `GenMetadata` 预留 `physicalWireBody`（把 wire body 塞进 logical 的 metadata），未真正启用。本版明确：
- **停止**在 logical.metadata 中填 `physicalWireBody`。
- 字段声明保留（optional，兼容旧 trace/旧读取代码），但**写路径**全部走独立 physical generation。

### 4.5 双层容错沿用

`safe()` 兜底：physical 埋点失败绝不影响 loop、不影响 logical 埋点（两次 startGeneration 调用互相独立 try/catch）。

---

## 5. Observability Manager fan-out 调整（`[P0]observability_manager.md` 新增 §5.3）

### 5.1 每 child 携带元数据

manager 构造时把每个 `ObservabilityConfigItem` 的 `logPhysical` bool 与 child adapter 绑定：

```typescript
interface ChildEntry {
  adapter: ObservabilityAdapter;
  logPhysical: boolean;   // 来自 dev_config item
}
```

### 5.2 fan-out 规则

- `startTrace` / `endTrace` / `startSpan` / `endSpan` / `startGeneration(kind='logical')` / `endGeneration(logical)` → **全部 child** fan-out（既有）。
- `startGeneration(kind='physical')` / `endGeneration(physical)` → **仅** `logPhysical=true` 的 child。
- 若所有 child 都 `logPhysical=false` → 上游可通过 `manager.hasPhysicalChild()` 快速判定，跳过 encode 后的 physical 埋点分支（零开销）。

### 5.3 handle 空间

physical generation 的 handle 独立于 logical；resolveParentPerChild 逻辑不变（每 child 独立 handle 空间）。

---

## 6. LLM Caller 物理埋点点位（`[P0]llm_caller.md` 新增章节）

### 6.1 调用点

在 `invoke` 内、调 HTTP 之前、`protocol.encode(request)` 之后：

```
const wireBody = protocol.encode(canonicalRequest);
const physicalGen =
  obs.hasPhysicalChild()
    ? obs.startPhysicalGeneration(wireBody, new Date())
    : null;
try {
  await httpClient.post(url, wireBody);
  ...
} finally {
  if (physicalGen) obs.endPhysicalGeneration(physicalGen, new Date());
}
```

- **不带 usage**：`endPhysicalGeneration` 内部调 `adapter.endGeneration({ gen, usage: {}, endTime, metadata: { physicalWire: true } })`；`langfuse-adapter.mapUsage({})` 结果 total=0 且不写 cost。
- **失败路径**：httpClient throw → finally 里 endPhysicalGeneration 照样调（不带 status='error'，因为物理层不承载错误语义，错误由 logical 承担）。
- **无重试放大**：invoke 的重试链在**上层** llm_caller 循环——physical 埋点只包**单次真实 HTTP 请求**；重试触发下一次 encode+startPhysicalGeneration，所以 physical generation 数量 = 真实 wire 尝试数。

### 6.2 hasPhysicalChild() 快速判定

`LoopObservability` / manager 提供 `hasPhysicalChild(): boolean`；bootstrap 时算好（child 列表不热更新）。关闭态下 invoke 完全跳过 physical 分支，零开销。

---

## 7. DevConfig 变更（`[P0]dev_config.md §3.4.1` 更新）

`ObservabilityConfigItem` schema：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| （既有 8 字段） | ... | ... | ... | ... |
| `logPhysical` | boolean | 否 | `false` | **v0.0.50 新增**：记录发给 LLM 的物理 wire body（独立 generation，不带 usage）；默认关闭。改动不热更新（重启 / 下 session 生效） |

前端 dev 配置页 observability-config 编辑对话框加开关（`section-observability` 特化路由自管），文案说明「不带 usage，不污染 token/cost 统计」。

---

## 8. 测试计划（AT 覆盖）

### 8.1 API 测试新增

| case_id | 断言 |
|---|---|
| `observability/langfuse_physical_generation_tc1` | dev_config 设 `logPhysical=true` → 发一次 chat → langfuse trace 查到并列 `llm-1-logical` + `llm-1-physical`；`physical.input` = 完整 anthropic wire body（含 `system`/`messages`/`max_tokens`/`tools`/`cache_control`）；`physical` usage.total=0；两者 parent = 同 step span |
| `observability/langfuse_physical_disabled_tc1` | dev_config `logPhysical=false`（默认）→ 只有 `llm-1-logical`；trace 深度 / 事件数与 v0.0.49 一致 |
| `context/system_reminder_metadata_removed_tc1` | 用户发消息触发 reminder → 读 session store transcript：最后一条 user message `metadata.isSystemReminder` **不存在**；块级 reminder block `isSystemReminder:true` 存在 |
| `llm/logical_view_prefix_tc1` | multi-agent a2a 场景：mate 发消息到 leader → langfuse `logical.input.messages` 中该条 message 首个 text block 有 `[Message from <name> (mate, needReply=true)]: ` 前缀；`physical.input` 中 anthropic wire body 同 message 也有前缀 |

### 8.2 单元测试

- `logical-view.test.ts`：`toLogicalMessages` 覆盖 4 类 sender source + 无 sender + 空 content + 首块非 text 兜底。
- `system_reminder_injector.test.ts`：断言 injector 产出的 message `metadata` 不含 `isSystemReminder`；块级 reminder block 有 `isSystemReminder:true`。
- `observability-manager.test.ts`：`kind='physical'` fan-out 只到 `logPhysical=true` child；`hasPhysicalChild()` 反映 child 列表。
- `langfuse-adapter.test.ts`：physical kind → name 后缀 `-physical`、input=wireBody、usage total=0。

### 8.3 E2E

无 UI 影响，不新增 e2e（dev 配置页 observability 编辑对话框加字段属于既有 e2e 覆盖范围，若新增 case 只加一条"新字段可读写"覆盖）。

---

## 9. 迁移与兼容

- **老 trace（v0.0.49 及以前）**：只有 `llm-N` 一条 generation（无 `-logical` 后缀），metadata 可能含 `physicalWireBody` string。本版本代码不读该字段（新代码走独立 generation）；langfuse UI 侧兼容。
- **老 transcript（含消息级 `metadata.isSystemReminder`）**：读取时前端块级 filter 忽略消息级；不做数据迁移。
- **dev config 老配置项（无 `logPhysical`）**：parse 时缺省 false；用户从配置页勾选后重启生效。
- **`agent/message-prefix-renderer.ts` 迁到 `llm/logical-view.ts`**：agent 内所有 import 改写；老引用编译报错，一次性改完即 OK；没有 runtime hotpath 依赖 module path。

---

## 10. 版本

> 变更历史见对应子系统的 `log.md`（本版本会在 `message` / `llm` / `observability` / `config` 四个 KB 的 log.md 追加一行）。

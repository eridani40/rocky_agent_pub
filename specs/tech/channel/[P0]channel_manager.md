---
type: interface
title: ChannelManager (EP 消费方 + 组合器 + config/binding/outbound 管家)
priority: P0
status: active
updated: 2026-07-26
since: v0.0.103
related:
  - "[[P0]channel_extension_point.md]"
  - "[[P0]channel_impl_interface.md]"
  - "../config/[P1]connectors.md"
  - "../config/[P0]plugin_config_service.md"
  - "../agent/index.md"
---

# ChannelManager

## 1. 概述

**ChannelManager** = channel EP 的消费方 + **组合器** + 全套管家：`ensureImpls()` 经 `pluginManager.getExtensionImpls(ChannelPoint, 'default')` resolve 出无状态 impl map（**scope 门物化点**）→ bootstrap 扫 channel_config 按每份 config `impl.connect(config, backend)` **动态组合**出 per-config 句柄 ChannelHandle、config 管理（CRUD + connect/disconnect 生命周期）、binding（双向唯一）、outbound 累积管线（subscribe agent_loop → 消费 loop 分发 block → per-session SendQueue 串行发送 → handle.sendOutbound）、loop 生命周期管理 + 死亡自愈、状态推前端（HTTP 轮询）。

**不管**：channel EP 定义（→ `[P0]channel_extension_point.md`）、impl 内部 IM 协议（→ `[P0]channel_impl_interface.md` + 各 impl）、agent 执行（→ `../agent/`）。

## 2. 接口签名

```typescript
// app/server/src/channel/channel-manager.ts
export interface ChannelManager {
  // ===== bootstrap（启动恢复） =====
  bootstrap(): Promise<void>;

  // ===== config 管理（CRUD + connect/disconnect；v0.0.206 原 registerInstance 等改名） =====
  registerConfig(config: ChannelConfig): Promise<void>;                // 落 configs/runtime + enabled→spawnConnect（fire-and-forget）
  unregisterConfig(configId: string): Promise<void>;                    // handle?.disconnect + 删 binding + 删订阅
  setEnabled(configId: string, enabled: boolean): Promise<void>;        // toggle（on→spawnConnect fresh handle / off→abort retry + handle?.disconnect）
  updateConfig(configId: string, patch: { name?: string; config?: Record<string, unknown>; enabled?: boolean }): void;  // 同步内存 configs Map（PUT 落盘后调，mutate 同一引用，undefined 跳过，不 connect/disconnect，§3.10）

  // ===== impl 查询（scope 激活集合驱动） =====
  listActiveImpls(): Channel[];                                         // = [...ensureImpls().values()]；impl-types 端点 + POST 激活校验消费

  // ===== 状态查询（推前端用） =====
  getAllStates(): ChannelState[];                                       // GET /config/channels
  getState(configId: string): ChannelState | undefined;

  // ===== binding（双向唯一 channel D6） =====
  getBinding(configId, conversationId): Promise<string | null>;
  bind(configId, conversationId, sessionId, by): Promise<void>;         // 含双向唯一检查
  unbind(configId, conversationId): Promise<void>;
  deleteBindingsBySession(sessionId: string): Promise<void>;            // session 删除兜底（孤儿清理）
  deleteBindingsByInstance(configId: string): Promise<void>;            // config 删除兜底

  // ===== outbound 累积 =====
  subscribeOutbound(sessionId: string, handle: ChannelHandle): void;    // 建立累积管线
  unsubscribeOutbound(sessionId: string, handle: ChannelHandle): void;  // 解绑时清（防泄漏）

  // ===== 通用 helper（句柄经 ChannelHandleBase 调） =====
  deliverTo(sessionId: string, message: Message): Promise<AgentRun>;    // = agentManager.deliverTo 透传
  listSessions(opts?: { biz?, role? }): Promise<Session[]>;              // /listp/lists 用
  findConversationBySession(configId: string, sessionId: string): Promise<string | null>;  // 反查（sendOutbound 用，限定本 config 防互窜）
}
```

## 3. 设计决策

### 3.1 启动时序：agent_loop bus 就绪后 + connect fire-and-forget

**结论**：bootstrap.ts 经 `bootstrapConnectorsPhase` 调 `createAndBootstrapChannelManager({dataDir, agentManager, sessionStore, registry, pluginManager})`，调用时机 = **agentManager 实例化后 + agent_loop bus 就绪后**（早于 server.listen）。
- `bootstrap()` 内部：rebuildReverseIndex（从 channel_bindings 建反向索引）→ `ensureImpls()`（lazy 建 impl map，见 §3.11）→ 扫 `channel_config` 全部 config 逐份 `configs.set + runtime.set`，对 `enabled=true` 的 `void this.spawnConnect(cfg).catch(() => {})`。
- **connect fire-and-forget**：不 `await connect()`，立即返回让 server 启动不阻塞。connect 失败（含 scope 门拒绝）→ 该 config `connection='error'`（状态推前端）。
- 与 connector 的对比：connector bootstrap 只读 intent 不 connect（lazy，首次 tool.run 才连）；channel bootstrap **直接 connect**（IM 必须常连）。

**理由**：IM 长连接必须启动即建立（用户随时可能发消息，不像 browser attach 等用户触发）；但不能阻塞 server.listen（飞书 SDK 慢启动/超时不能拖死整个进程）。

### 3.2 agent loop 本体零改（D5 对等的核心）

**结论**：ChannelManager 只通过两个公开入口与 agent loop 交互：
- **inbound**：`agentManager.deliverTo(sid, msg)`（与 web client 完全相同的入口）
- **outbound**：`agentManager.subscribe(sid, 'current')`（与 web SseChannel 完全相同的订阅）

agent loop / agentManager / bus 任何代码不感知 channel 存在；channel 只是「又一条 inbound 路径 + 又一个 outbound 订阅者」。

**联动天然成立**（UC-E1/E2）：同一 session 被 web SseChannel + ChannelManager 双订阅 → agent loop bus 单源多消费 → web 用户看见「飞书用户 X 说了 Y」、飞书用户收到 agent 回复 → 无需额外同步代码。

### 3.3 双状态机（switch+connection，与 connector 同构但 connect 时机不同）

| 状态 | 取值 | 持久化 | 说明 |
|---|---|---|---|
| switch | on/off | ✅（channel_config `ChannelConfig.enabled`） | 用户启用意图（config 级开关，⊥ impl 级 scope 门 §3.11） |
| connection | disconnected/connecting/connected/error | ❌（运行时派生） | 连接实况 |

**channel 状态机迁移**（与 connector 的关键差异 → 本版 channel）：

| 触发 | switch | connection | 动作 |
|---|---|---|---|
| 新建 config（POST，enabled=true） | on | disconnected → connecting → connected/error | spawnConnect（gate → impl.connect）；fire-and-forget |
| toggle on（PUT enabled=true） | on | disconnected → connecting → connected/error | spawnConnect（fresh handle，gate 重过） |
| toggle off（PUT enabled=false） | off | connected → disconnected | abort retry + handle?.disconnect；不重连 |
| 运行中断连（switch 仍 on） | on（保持） | connected → connecting → 重试 3 次 × 5s → connected/error | WSClient close 事件触发 |
| 3 次重连失败 | on（保持） | error | 不再自动重连，等用户 off→on 重置 |
| scope 门拒绝（impl 未在 default.yaml 激活） | on（保持） | error（gate 在 retry 外，不重试） | 等 default.yaml 配回后 off→on 重置 |
| bootstrap（启动恢复） | =config.enabled | disconnected → connecting（fire-and-forget） | 不阻塞 server |

**重连策略**：3 次 × 每次 5s（req 上限，避免刷日志；openclaw 用指数退避无限重连本版不要）。3 次仍失败 → `connection=error`，等用户 toggle off→on 重置（off→on 算重试计数清零）。

### 3.4 binding 双向唯一（channel D6 — 与 plugin scope D6 无关）

> **消歧**：channel 子系统自有「D6 = binding 双向唯一」与 plugin_system 的「D6 = default 短路」（v0.0.206 已删）无关——本节不变量**仍然成立**，严禁误删。

**数据结构**（`channel_bindings/<configId>__<conversationId>.json`）：
```typescript
interface ChannelBinding {
  configId: string;         // ChannelConfig.id（v0.0.206 原 instanceId 改名；落盘字段走 MigrationManager handler channel-binding-config-id 一次性迁移）
  conversationId: string;   // 群=chatId / 私聊=openId（无 scope 编码，D2）
  sessionId: string;        // 绑定的 agent session
  boundBy: 'slash' | 'manual';
  boundAt: number;
}
```
**唯一键**：
- `(configId, conversationId)` → sessionId（一对一覆盖，/bindp·/binds 覆盖旧绑定）
- `sessionId` → `(configId, conversationId)`（反向唯一，channel D6 不变量）

**bind 操作（含双向唯一检查）**：
1. 查 sessionId 是否已被其他 (config, conversation) 占用 → 占用则抛 `'SESSION_ALREADY_BOUND'`（UC-C3/C4 报错「该 session 已被绑定」）。
2. upsert binding（覆盖该 (config, conversation) 旧绑定）。
3. 若有旧 sessionId（被覆盖）→ 旧 sessionId 的 outbound 订阅 unsubscribe（防泄漏）。
4. `manager.subscribeOutbound(sessionId, this)` 建立累积管线。

**孤儿清理**：
- session 删除钩子（agent DELETE）→ `deleteBindingsBySession(sid)` → 删 binding + unsubscribe。
- config 删除 → `deleteBindingsByInstance(configId)` → 删全部该 config 的 binding + 对应 handle unsubscribe。

### 3.5 outbound 累积（D3，channel 不感知累积）

**发送粒度 = content block（block 级实时发送）**：每 block 结束即发一条飞书消息（非「run_end 组装一条完整 Message」）。累积 loop（`channel-accumulator.ts` `runChannelAccumulator`）纯分发事件、入队发送任务；实际发送由 per-session **SendQueue**（`channel-send-queue.ts`）串行异步执行——消费与发送解耦，消费永不被发送阻塞。

**block 分流规则**（消费 loop 内）：

| 事件 | 动作 |
|---|---|
| `text_block_start/delta/end` | 累积 answer 文本，end 时 `queue.enqueue(text)`（echo 屏蔽/跨渠道分流见 §3.5.1） |
| `tool_call_start/end` | start 记 toolName；end 概括入队 `🔧 调用工具：${toolName}`（缺 start 则丢弃） |
| `tool_result_end` | 概括入队 `📋 工具回复：成功`（`isError` 则 `失败`） |
| `reasoning_block_*` | 忽略（思考过程不发 IM） |
| `run_start/run_end` | 仅 typing indicator 切换（`onUpdateInputState('typing'/'idle')`），不发内容 |
| `error` | error 日志（agent/LLM 失败，飞书无内容可发），不发 |
| `message_start(role=user)/message_end` | 记/清 origin（§3.5.1），不发 |
| 其余（`tool_call_delta` / `tool_result_start,delta` / `usage` / `llm_attempt` / `custom` 等） | 忽略 |

**关键不变量**：
- **block 级发送**（v0.0.103 起）：`handle.sendOutbound` 收**单 block 的一条文本 Message**（每 block 一条飞书消息，实时），非「一 run 一条完整 Message」。tool 过程以**概括文本**发送（`🔧 调用工具：X` / `📋 工具回复：成功/失败`），非发全部工具参数/结果。channel impl 仍不感知累积——只收拼好的文本 Message。
- **消费与发送解耦**（v0.0.118）：消费 loop 只 `enqueue`（立即返回）不 `await sendOutbound`，一次发送挂死不再冻结整条消费 loop。发送保序由 SendQueue 的 promise-chain 串行器保证（同 session 事件按顺序发出）。
- **单事件 try/catch 防连累**（v0.0.118）：消费 loop 每事件处理包 try/catch，单事件抛错 → error 日志 + 丢弃该事件，loop 不退出。
- **生命周期可观测**（v0.0.118）：loop 启动/退出（`aborted` / `iterator done`）/异常退出各一行日志（含 sessionId、configId、已消费事件数 `eventCount`、队列剩余 `queue.pending`）。异常退出 rethrow 给 caller（subscribeOutbound 的 `.catch` 记日志 + 触发自愈，见 §3.5.2）。
- **stale block 回收**（v0.0.118）：`setInterval` 60s（`SWEEP_INTERVAL_MS`）sweep，清理 5 分钟（`BLOCK_STALE_MS`）无活动的 `textBuffers`/`toolCallNames`/`userOrigins` 槽（每槽带 `lastAt` 时间戳）——防 block 无 `end` 事件时累积 Map 永久泄漏。sweep timer `unref()` + loop `finally` `clearInterval`。
- **unsubscribe 必须取消订阅**（防泄漏）：`unsubscribeOutbound` 置 `controller.aborted=true`，loop 下次迭代 break 退出；SendQueue 剩余任务 abort 后跳过。

#### 3.5.0 SendQueue（per-session 有序发送队列，`channel-send-queue.ts`）

**结论**：每个 accumulator 实例持一个 `SendQueue`，`enqueue(text, runId)` 立即返回、串行异步执行 `handle.sendOutbound`（promise-chain `tail` 串行器）。

| 常量 | 值 | 语义 |
|---|---|---|
| `SEND_QUEUE_WARN_DEPTH` | 10 | 积压 depth > 10 打 warn（发送变慢提示） |
| `SEND_QUEUE_MAX` | 100 | 队列上限，depth ≥ 100 时新任务丢弃 + error 日志（不阻塞消费） |
| `SEND_MAX_ATTEMPTS` | 3 | 每条最多 3 次尝试（1 次 + 2 次重试） |
| `RETRY_DELAYS_MS` | [2000, 5000] | 第 1 次失败退避 2s，第 2 次退避 5s |

- **保序**：同 session 的 answer/tool 摘要按入队（= 事件）顺序发出（tail promise 链）。
- **有界**：`depth ≥ SEND_QUEUE_MAX` 丢弃新任务 + error 日志（不阻塞消费 loop）；`depth > SEND_QUEUE_WARN_DEPTH` 打 warn。
- **重试**：发送抛错 → 退避后重试；`SEND_MAX_ATTEMPTS` 次耗尽 → 丢弃该条 + error 日志，继续下一条（队列不卡死）。每次失败打 attempt/耗时日志。
- **abort 感知**：`controller.aborted` 后队列任务与重试中止（打 log 后跳过），不再发送。
- **构造 Message**：`{ id: ulid(), sessionId, role: 'assistant', content: [{type:'text', text}], runId }`——跨渠道 user 文本前缀已由 caller 拼好，仍以 assistant 出站信封发（IM 侧零改，不落库为 user 消息）。

#### 3.5.1 [v0.0.107] user message echo 屏蔽 + 跨渠道渲染

**约束**：agent loop 对 user 自己的消息也 emit `text_block_*`（供 client 渲染 user 气泡），故 `text_block_*` 同时承载 user 消息与 assistant 回复，仅凭事件类型无法区分。若不区分，用户在飞书发的文本会被当 answer 发回飞书 = **echo 回环**（用户先收到自己的输入再收到回复）。故 accumulator 必须按来源分流：self DROP（echo 屏蔽）。详见 `../version_logs/v0.0.107/change_log.md`。

**修复**：accumulator 按 `message_start` 事件 `origin` 字段识别 user message 来源（`message_start(role=user)` 记 `userOrigins: Map<messageId, origin>`；`message_end` 清该项，见下方不变量。origin 字段详见 `../agent/agent_interface_and_loop/[P0]agent_event.md §4.2`），在 `text_block_end` 处查表分流：

```typescript
// runChannelAccumulator 内 text_block_end 分流（v0.0.118 起 sendOutbound → queue.enqueue，发送解耦）
if (ev.type === 'text_block_end') {
  const slot = textBuffers.get(ev.blockId);
  if (!slot) continue;              // 错过 start → 丢弃
  const text = slot.text;
  textBuffers.delete(ev.blockId);
  if (!text) continue;
  const origin = ev.messageId ? userOrigins.get(ev.messageId)?.val : undefined;
  if (origin) {
    // 是 user 消息文本（不是 assistant answer）
    if (origin.configId === handle.configId) continue;  // ★ self：DROP（IM 已本地渲染）= echo 屏蔽
    queue.enqueue(`User (from ${origin.type}): ${text}`, currentRunId);  // 跨渠道
  } else {
    queue.enqueue(text, currentRunId);  // 正常 assistant answer
  }
}
```

**关键不变量**（v0.0.107 新增，v0.0.118 发送路径改 enqueue）：
- **self 判定按 `configId` 非 `type`**：同一 implId（如 feishu）可有多份 config，必须按 configId 精确判定本渠道，否则跨配置串扰（A config 用户消息被 B config 当 self DROP）。DROP 即 continue（不入队、不留 buffer，`textBuffers.delete` 已在分流前执行防泄漏）。
- **跨渠道前缀**：`User (from ${origin.type}): ${text}`（如 `User (from client): 123`）——accumulator 拼好文本走 `queue.enqueue`（SendQueue 内构造 role='assistant' 出站信封，IM 侧零改，formatFeishuOutbound 按纯文本发）。
- **client 类型不 DROP**：client origin `{type:'client', configId:'0'}`，任何 IM config 的 configId !== '0' → 一律渲染「User (from client)」，正确（IM 想知道用户在 client 说了什么）。
- **userOrigins 资源卫生**：`message_end` 清该 messageId 的 origin 项（顺序契约 `message_start → text_block_* → message_end` 保证 end 时 text block 已全部分流完毕，删除安全），避免 map 随会话内 user 消息数无界增长；stale sweep（§3.5）兜底 loop 意外无 end 的槽。

详见 `../../../version_logs/v0.0.107/change_plan.md` 模块 E + `specs/research/v0.0.107.channel_user_mesage/research.md §5`。（伪代码省略时间戳；实际各 Map 槽带 `lastAt` 供 §3.5 stale sweep 回收。）

#### 3.5.2 [v0.0.118] loop 生命周期管理 + 死亡自愈（subscribeOutbound）

**根因**（本版本修复的停发 bug）：`subscribeOutbound` 原用静默 `.catch(() => {})` 吞 loop 异常——loop 死亡无日志、controller 残留 `accumulators` Map → 幂等检查（`existing.size > 0` 跳过）误判「已有活跃 loop」而不重建 → outbound 永久停发。

**修复三件套**（`subscribeOutbound` 的 `.catch`/`.finally`）：
1. **异常可见 + 死亡摘除**：`.catch` 打 error 日志替换静默吞错；`.finally` 从 `accumulators` Map 删除本 controller（空则删 session 键）——修「死亡尸体阻塞幂等检查」的误判，让下次 subscribeOutbound 能重建。
2. **条件自愈重建**（三门槛**同时满足**才重建）：`.finally` 中 **非 abort 退出**（`!controller.aborted`）+ **binding 仍存在**（`bindingStore.findBySession`）+ **对应 channel `connection === 'connected'`** → `setTimeout(() => this.subscribeOutbound(sessionId, channel), 5000)`（5s 后重建，timer `unref()`，打日志）。任一不满足不重建：**abort 退出**（`unsubscribeOutbound` 置 `aborted=true`——unbind/off/session 删，用户主动解绑不该被自愈拉回）；binding 已删（无对象可重建）；channel 断连（等 `connectWithRetry` 成功后统一重建）。

**与 connect 重建互补**：`connectWithRetry` 成功（`connection === 'connected'`）后遍历该 config 全部 binding `subscribeChannel`——重启恢复 / 断线重连的重建入口；§3.5.2 的 loop 死亡自愈覆盖「连接正常但 loop 单独崩」。

### 3.6 运行时不写 policy（memory `runtime-no-ext-policy-write`）

**结论**：ChannelManager 不调 `PluginConfigService.setImplEnabled` / `setImplConfig`（那是用户配置面，由 HTTP handlers 落盘）。ChannelManager 只读 `channel_config` 域（独立域，类比 connector_config）+ 写 `channel_bindings` 域。
**反例**：v0.0.66 env_start 清 policy 被定性「流氓逻辑」——运行时绝不写用户配置面。

### 3.9 反查 conversation：findConversationBySession（sendOutbound 用）

**结论**：ChannelManager 暴露 `findConversationBySession(configId, sessionId)`，返该 session 在该 config 下绑定的 conversationId（无返 null）。binding 双向唯一下每 (config, session) 至多 1 个 conversation。
**config 归属限定**：内部检查 `bindingStore.findBySession(sessionId).configId === configId`，跨 config 查询返 null（防 config 间互窜，即 config A 的句柄不能拿 config B 的 binding 把消息发到 B 的 conversation）。
**理由**：`handle.sendOutbound(msg)` 签名只收 `Message`（msg 含 sessionId 但不含 conversationId）；句柄必须反查才能发飞书 → 必须经此方法。反查走 bindingStore 双向索引（O(1)，与 `bind` 的反向唯一检查共享数据结构）。实现：`ChannelManagerImpl.findConversationBySession()` + `ChannelHandleBase.findConversationBySession()` 透传。

### 3.7 ChannelConfigService（channel_config 域，仿 connector_config）

```typescript
// app/server/src/channel/channel-config-service.ts
export class ChannelConfigService {
  constructor(opts: { root: string });            // FsCrudStore mount channel_config
  list(): ChannelConfig[];                         // 全部 config（appSecret redact '***'）
  get(id: string): ChannelConfig | undefined;      // 单个（redact）
  getRaw(id: string): ChannelConfig | undefined;   // 原始未 redact（connect 读凭证 / PUT·DELETE existing 校验用）
  create(input: { implId, name, config, enabled? }): ChannelConfig;  // ulid + enabled 默认 true
  update(id: string, patch: Partial<Omit<ChannelConfig, 'id'>>): ChannelConfig | undefined;  // config 整体替换（非深 merge）
  delete(id: string): boolean;
  setEnabled(id: string, enabled: boolean): void;  // = update(id, { enabled })
}
```

- **存储**：`{dataDir}/channel_config/<id>.json`（list 形态，FsCrudStore upsert）。
- **多 config**：一个 implId（feishu）可有多份 config（每份独立 credentials/connect/binding），存储是 list 而非 id 寻址（与 connector 单份不同）。**ChannelConfig = 纯数据**（v0.0.206 原 ChannelInstance 改名，字段全不变 → 磁盘记录全兼容）。
- **redact**：list/get 返回前 `appSecret` redact 为 `'***'`（web-config-redact 同款套路，helper `redactChannelSecret`）。

### 3.8 ChannelBindingStore（channel_bindings 域）

```typescript
// app/server/src/channel/channel-binding-store.ts
export class ChannelBindingStore {
  constructor(opts: { root: string });
  get(configId, conversationId): ChannelBinding | null;
  upsert(b: ChannelBinding): void;                 // 覆盖该 (configId, conversationId) 旧值
  delete(configId, conversationId): void;
  deleteBySession(sessionId: string): string[];    // 返被清的 (configId, conversationId) 列表
  deleteByInstance(configId: string): string[];    // 返被清的 sessionId 列表
  findBySession(sessionId: string): ChannelBinding | null;  // 反向唯一检查
}
```

- **存储**：`{dataDir}/channel_bindings/<configId>__<conversationId>.json`（KV，FsCrudStore）。落盘记录字段 `configId`（v0.0.206 原 `instanceId` 改名，SchemaDef 同步；存量记录经 MigrationManager handler `channel-binding-config-id` 一次性迁移，启动期先于 store 使用）。
- **双向索引**：正键 `(configId, conversationId)`；反键 `sessionId` —— `findBySession` 反向唯一检查用。

### 3.10 内存态同步：updateConfig（GET 权威源是内存 configs Map）

**结论**：`GET /config/channels` 的 `name` 与 `switch`（enabled）取自 ChannelManager **内存态**（`getState() → this.configs.get(id).name / .enabled`），非直接读落盘。故任何「更新落盘」的写路径必须同步内存态，否则 GET 返回 stale —— 旧值一直到重启 `bootstrap()` 从盘重载才刷新。

**`updateConfig(configId, patch)` 行为**（v0.0.206 原 `updateInstance` 改名）：
- mutate **同一 config 对象引用**的 `name`/`config`/`enabled`（运行中 handle 持同一 `config` 引用（`ChannelHandleBase.config`）→ 内存改后运行中的句柄也见新 config）。
- `undefined` 字段跳过（partial patch）；config 不存在则 no-op（bootstrap 未恢复 / 已删）。
- **不触发 connect/disconnect**：纯内存字段同步；`enabled` 切换引发的重连仍由 `setEnabled` 负责（职责分离，避免 double-connect）。

**PUT 写路径**（`handlers/channel.ts`）：`configService.update`（落盘）→ `cm.updateConfig`（同步内存）→ 若 `enabled` 改则 `cm.setEnabled`（fire-and-forget connect/disconnect）。

**理由 / 反例（v0.0.106 bug 根因）**：修复前 PUT 只 `configService.update` 落盘、不碰内存，GET 走 `getState().name`（内存 `inst.name`）→ 编辑 channel 后返回旧 name，仅重启才刷新。config 在 list handler 从盘读（`configService.list`）故 list 响应当时不 stale，但运行中的句柄持内存 config 引用，改配置后句柄需见新 config → 一并纳入 `updateConfig`。

### 3.11 impl 组合器：ensureImpls / resolveImpl / listActiveImpls（v0.0.206 scope 门物化）

**结论**：ChannelManager 不再直接持 Registry 反射 `new`（T4 旧决策作废，见 §4），改为**注入 `pluginManager` 经 `getExtensionImpls(ChannelPoint, 'default')` 取无状态 impl**（scope 解析单源；`registry` 保留作管理面：configSchema 校验 + impl-types label 反查）。
- `ensureImpls()`（private lazy）：`this.impls ??= new Map(pluginManager.getExtensionImpls<Channel>(ChannelPoint as ExtensionPoint<Channel>, 'default').map(c => [c.type, c]))`（yaml 静态，缓存安全）。
- `resolveImpl(implId)`（private）：`ensureImpls().get(implId) ?? throw Error('ChannelManager: implId "x" 未在 scope \'default\' 激活（default.yaml 未配置 channel impl）')`——**scope 门在此物化**：feishu 不配 default.yaml → map miss → throw。
- `spawnConnect(cfg)`：**gate 在 retry 外**——先 `resolveImpl(cfg.implId)`（失败 → error 态立即返回，不进 retry：确定性失败重试无意义）→ `connectWithRetry(cfg.id, () => impl.connect(cfg, this))`；每 attempt 产 fresh handle（`rt.handle = await connectFn()`）。
- `listActiveImpls()`：`[...ensureImpls().values()]`——handler `GET /config/channels/impl-types` 与 POST 激活校验（双段 400，见 `../../../specs/api/overall/17-channel.md §3/§4`）消费。

**两级开关正交**：impl 级 = scope membership（default.yaml 配了才可用，不配 = 关——v0.0.206 删 plugin scope D6 后成立）；config 级 = `channel_config.enabled`（这份 config 要不要连）。
**理由**：旧 `(instance, manager)` 构造焊死与 EP 标准 `(implId, cfg)` 投影不兼容，channel EP 只能绕过 scope 模型；impl 无状态化后构造签名天然兼容，激活语义归一到 default.yaml 唯一事实源。
**off 路径安全**：gate 失败的 config 无 handle（`rt.handle` undefined）——toggle off 走 `rt.handle?.disconnect()` 可选链（不崩）。

## 4. 启动注入（bootstrap.ts）

```typescript
// bootstrap.ts（v0.0.103 加，agentManager 实例化后；v0.0.206 起经 bootstrapConnectorsPhase 传 pluginManager）
import { createAndBootstrapChannelManager } from './channel/channel-bootstrap';

// ... new AgentManagerImpl({...}) 完成后
const channelManager = createAndBootstrapChannelManager({
  dataDir,
  agentManager,           // 注入：inbound deliverTo + outbound subscribe
  sessionStore,           // 注入：listSessions（/listp/lists）
  registry,               // 注入：管理面（configSchema 校验 + impl-types label 反查）
  pluginManager,          // 注入：getExtensionImpls 供无状态 impl（scope 解析单源，§3.11）
});
// bootstrap fire-and-forget（内部 void connect，不 await）
// 注入 router/handlers/deps 供 /config/channels 路由用
```

- **agentManager.subscribe 已可用**（agentManager 实例化后即可订阅 bus）。
- **bootstrap fire-and-forget**：`createAndBootstrapChannelManager` 内部 `void cm.bootstrap().catch(err => log)`。
- **T4 决策修订（v0.0.206）**：原「直接持 Registry，`registry.getImplById(implId).implClass` 反射 `new`」作废——ChannelManagerImpl 改注入 `pluginManager`（type-only import），`ensureImpls()` 经 `getExtensionImpls(ChannelPoint, 'default')` 取无状态 impl（旧 `(instance, manager)` 构造与 EP 标准 `(implId, cfg)` 投影不兼容，channel EP 借此才接入 scope 激活模型）；`registry` 保留仅作管理面用途（POST 的 configSchema 校验 + impl-types 端点 label 反查），**不再用于实例化**。

## 5. 边界

| 零件 | 归属 |
|---|---|
| ChannelManager 接口（组合器 ensureImpls/resolveImpl/listActiveImpls + bootstrap/config/binding/outbound 累积/状态） + ChannelConfigService + ChannelBindingStore + 双状态机 + 启动恢复 + 重连策略 + loop 生命周期/自愈 | 本文件 ✅ |
| outbound 累积 loop（`channel-accumulator.ts` `runChannelAccumulator`：分发/echo 屏蔽/stale sweep）+ 发送队列（`channel-send-queue.ts` `SendQueue`：保序/有界/重试/abort） | 本文件 §3.5 ✅ |
| channel EP 定义 + groups.json | `[P0]channel_extension_point.md` |
| Channel/ChannelHandle/ChannelConfig 契约 + ChannelHandleBase + FeishuChannel/FeishuConnection | `[P0]channel_impl_interface.md` |
| scope 激活模型（getExtensionImpls 解析规则 + default 无特权） | `../config/[P0]ext_impl_scope.md` + `../plugin_system/[P0]plugin_manager_interface.md §3.6` |
| channel_bindings 落盘字段迁移（instanceId→configId） | `../migration/[P0]migration_manager.md`（handler `channel-binding-config-id`） |
| AgentEvent 类型（text_block_delta/run_end 等） | `../agent/agent_interface_and_loop/[P0]agent_event.md` |
| connector 双状态机（同构参考） | `../config/[P1]connectors.md` |
| HTTP facade（GET/POST/PUT/DELETE /config/channels + impl-types） | `../../../specs/api/overall/17-channel.md` |

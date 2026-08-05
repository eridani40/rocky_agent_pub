---
type: log
title: Channel 子系统变更日志
priority: P0
updated: 2026-07-26
---

# Channel 子系统变更日志

## v0.0.206（2026-07-26）— channel 接入 scope 激活模型（删 plugin scope D6）+ 无状态 impl/config 动态组合 + instanceId→configId 全链改名

### 核心重构（D3/D4/D5）

- **Channel impl 无状态化**：旧「impl 持 instance 的 5 方法契约」作废（构造 `(instance, manager)` 焊死，与 EP 标准 `(implId, cfg)` 投影不兼容）。新契约 = `readonly type` + `connect(config, backend) → ChannelHandle`（`types.ts`）；**ChannelConfig（原 ChannelInstance 改名）= 纯数据**（字段全不变 → 磁盘 channel_config 零迁移）；**ChannelHandle = per-config 连接句柄**（configId + disconnect/handleInbound/sendOutbound/updateInputState，连接态全挂句柄）。`ChannelBase` → `ChannelHandleBase` 整文件重写（构造 `(config, backend)`，helper `this.config/this.backend`）。
- **FeishuChannel 拆分**：无状态 impl（构造 `(implId?, _cfg?, genMessageId?)`，前两参兼容 EP 投影供 getExtensionImpls 直供，第三参 UT 注入）+ 新增 `feishu-connection.ts` `FeishuConnection extends ChannelHandleBase`（原 per-instance 逻辑逐行等价搬迁，零逻辑改）。
- **ChannelManager = 组合器**：`ensureImpls()` lazy 经 `pluginManager.getExtensionImpls(ChannelPoint,'default')` 建 impl map（**scope 门物化点**——T4 决策修订：不再直接持 Registry 反射 new；registry 保留管理面 configSchema 校验 + label 反查）；`resolveImpl` map miss → throw「未在 scope 'default' 激活」；`spawnConnect` gate 在 retry 外（确定性失败不重试不崩 server）；新增 `listActiveImpls()`。方法改名 `registerInstance→registerConfig` / `unregisterInstance→unregisterConfig` / `updateInstance→updateConfig`；`subscribeOutbound(sessionId, handle)`。
- **两级开关正交**：impl 级 = scope membership（default.yaml 配了才可用，不配 = 关——删 plugin scope D6 后成立，见 `../config/log.md`）；config 级 = `channel_config.enabled`（保留）。

### wire + 落盘改名（instanceId → configId）

- **wire 字段**：`sender.channel.instanceId→configId`（`message/types.ts`）、`origin.instanceId→configId`（`agent-event-types.ts`，client 缺省 `{type:'client', configId:'0'}`；前端 reducer 镜像同步）。
- **channel_bindings 落盘字段**：走 MigrationManager handler `channel-binding-config-id`（versionRange `<0.0.207`，幂等字段级 marker + 备份 `.pre-configid.bak`，见 `../migration/log.md`）。**历史 transcript 的 sender.channel 不迁**（append-only 不可变历史，origin 只对新消息实时派生，运行时消费零影响）；**SSE origin 无数据可迁**（运行时派生不落盘）。
- **echo self 判定**：`origin.configId === handle.configId`（语义不变）。
- **channel D6（binding 双向唯一）仍成立**——与删除的 plugin scope D6 无关，§3.4 已加消歧注。

### spec 重写/修订

- **`[P0]channel_impl_interface.md`**：§1/§2 契约重写（ChannelConfig + Channel 无状态 + ChannelHandle）；§3 ChannelHandleBase；§4 FeishuChannel 无状态 + FeishuConnection 拆分；§5.1 sender.channel.configId；§5.4 实例化重写（getExtensionImpls 直供 + connect 动态组合）。
- **`[P0]channel_manager.md`**：§1/§2 接口重写（registerConfig 等改名 + listActiveImpls + handle 参数）；§3.1 bootstrap（ensureImpls → spawnConnect）；§3.3 状态机表加 scope 门拒绝行；§3.4 binding configId + D6 消歧；§3.5/§3.5.0/§3.5.1/§3.9/§3.7/§3.8/§3.10 instance→config；§3.11 新增（组合器 + scope 门 + 两级开关）；§4 T4 决策修订（注入 pluginManager）。
- **`[P0]channel_extension_point.md`**：§2 EP 注释 + cardinality config 级多份；§3.2 两级 enabled 改「scope membership（impl 级）+ config.enabled（config 级）」。
- **`index.md`**：① 概念表（ChannelHandle/ChannelConfig/组合器）；③ 关系图（PluginManager scope 解析 → 组合器）；④ 原则 6/9/10 改名适配 + 新增原则 12（无状态 + 动态组合 + scope membership 即启用）。

### 权威文档

- 变更计划书：`specs/tech/version_logs/v0.0.206/change_plan.md`（模块一~九）
- 迁移 handler：`app/server/src/migration/handlers/channel-binding-config-id.ts`

---

## v0.0.118（2026-07-11）— feishu outbound 停发修复（发送超时 + SendQueue 解耦 + loop 自愈 + 全链路日志）

### 根因（停发 bug）

feishu channel 运行一段时间后 outbound 停发。两层根因叠加：
1. **发送无超时**：Lark SDK `defaultHttpInstance = axios.create()`（无参）→ axios 默认 `timeout=0` 永不超时。一次 HTTP 挂死（休眠 half-open TCP / 切网 / 代理丢包）→ `await` 永不返回。
2. **消费与发送耦合 + loop 死亡不可见/不重建**：消费 loop 内串行 `await sendOutbound` → 一次挂死冻结整条 loop；`subscribeOutbound` 用静默 `.catch(() => {})` 吞异常 → loop 死亡无日志、controller 残留 `accumulators` Map → 幂等检查（`existing.size > 0`）误判「已有活跃 loop」不重建 → 永久停发。inbound 独立（带 30s withTimeout）故 agent 照跑 = 「会话继续但消息没了」。

### 修复三件套

- **发送有超时**（`feishu-client.ts` + `feishu-helpers.ts`）：`FeishuClient.sendMessage` 用 `withTimeout(promise, 30000, label)` 包住 `im.message.create`；`withTimeout` 加可选 `label`（超时 Error 含来源，如 `feishu sendMessage receiveId=X`）；发送 start/success(耗时+message_id)/fail(耗时+错误)/API错误(code) 全链路日志；`onOutBoundMessage` 空 payload 从静默 return 改 warn（含 blockTypes）。→ `[P0]channel_impl_interface.md §5.7`
- **消费与发送解耦**（新增 `channel-send-queue.ts` `SendQueue`）：消费 loop 只 `queue.enqueue` 不 await → 一次挂死不冻结消费。SendQueue 保序（promise-chain）+ 有界 100（溢出丢弃+error）+ 积压>10 warn + 重试 3 次（退避 2s/5s，耗尽丢弃放行）+ abort 感知。消费 loop 每事件 try/catch 防连累；block 缓冲槽 5min stale 回收（60s sweep）防泄漏；loop 启动/退出/异常生命周期日志。→ `[P0]channel_manager.md §3.5/§3.5.0`
- **loop 死亡自愈**（`channel-manager.ts` `subscribeOutbound`）：`.catch` 打 error 替换静默吞错；`.finally` 从 `accumulators` Map 摘除死亡 controller（修幂等误判）；非 abort 退出 + binding 存在 + connected → 5s 后条件重建。→ `[P0]channel_manager.md §3.5.2`

### spec 既有偏离修正（本次 review 发现，非本版本引入）

- **`[P0]channel_manager.md §3.5` + `index.md` ④原则5 + ①概念表**：spec 原写「channel 收完整 Message / tool 过程不发 IM / run_end 组装一条」，但代码**自 v0.0.103 起就是 block 级发送**（每 block 一条飞书消息 + tool_call/tool_result 概括发送 `🔧 调用工具：X` / `📋 工具回复：成功/失败`）。以**代码为准**修正 spec 描述（run_end 仅切 typing indicator，不组装 Message）。
- **`[P0]channel_manager.md §3.5.1`**：伪代码 `sendOutbound(...)` → `queue.enqueue(...)`（v0.0.118 发送解耦后 accumulator 无 `sendOutbound` 函数）；leaned 历史叙述，slot 时间戳/资源卫生对齐代码。

### 新增 invariant

- **`index.md` ④原则 11**：outbound 管线三层健壮性——发送有超时（30s）、消费与发送解耦（SendQueue 保序）、loop 死亡可见且自愈（日志 + 摘除 + 条件重建）；任何 IO 不允许无超时挂死整条管线。

### code↔spec 一致性核实

| 项 | spec 契约 | 代码实现 | 一致 |
|---|---|---|---|
| sendMessage 30s 超时 + 日志 | §5.7（`SEND_TIMEOUT_MS=30000` + withTimeout label + start/success/fail 日志） | `feishu-client.ts` `sendMessage` | ✅ |
| withTimeout label 参数 | §5.7（可选 label，超时 msg 含来源） | `feishu-helpers.ts` `withTimeout` | ✅ |
| 空 payload warn | §5.7（blockTypes） | `feishu-channel.ts` `onOutBoundMessage` | ✅ |
| SendQueue 常量 | §3.5.0（WARN_DEPTH=10 / MAX=100 / ATTEMPTS=3 / RETRY=[2000,5000]） | `channel-send-queue.ts` | ✅ |
| block 级发送 + tool 概括 | §3.5（每 block 一条 + `🔧 调用工具` / `📋 工具回复`） | `channel-accumulator.ts` `runChannelAccumulator` | ✅ |
| stale sweep | §3.5（60s sweep / 5min stale / 3 Map 槽带 lastAt / unref+clearInterval） | `channel-accumulator.ts`（`SWEEP_INTERVAL_MS`/`BLOCK_STALE_MS`） | ✅ |
| 单事件 try/catch + 生命周期日志 | §3.5（每事件 try/catch，启动/退出/异常日志 + rethrow） | `channel-accumulator.ts` | ✅ |
| loop 自愈三门槛 | §3.5.2（非 abort + binding 存在 + connected → 5s 重建；abort 不重建） | `channel-manager.ts` `subscribeOutbound` `.catch/.finally` | ✅ |

**结论**：代码实现 == spec 契约，无静默偏离；既有 block 级发送偏离已修正对齐。

### 权威文档

- 根因与方案：`reqs/[working] v0.0.118/analysis.md` + `states/v0.0.118/task.json`
- 变更 commit：`4ffbf719`（主）+ `634490b9`（stale sweep 注释修正）

---

## v0.0.106（2026-07-10）— updateInstance 内存态同步（编辑 channel 后 GET 不刷新 bug 修复）

- **`[P0]channel_manager.md` §2 + §3.10**：接口签名加 `updateInstance(instanceId, patch)`（同步内存 instances Map 的 name/config/enabled）；§3.10 新增「内存态同步」设计决策——GET 权威源是内存态 + updateInstance 三条行为（mutate 同一引用 / undefined 跳过 / 不 connect-disconnect）+ PUT 写路径 + bug 根因。
- **`index.md` ④核心设计原则**：加原则 9（内存态是 GET 权威源，写盘须同步内存 → §3.10）。
- **`[P0]channel_manager.md` §3.7**：修既有 drift（v0.0.103 遗漏）—— 补 `getRaw(id)`（handler 实际用）、`create` 加 `enabled?`、`update` 返回 `| undefined` + patch `Omit<'id'>`、`delete` 返 boolean。
- **根因**：GET `state.name` 取自内存 `inst.name`（`getState`），PUT 旧实现只 `configService.update` 落盘、未同步内存 → 编辑后返旧值，重启 bootstrap 从盘重载才刷新。修复 = PUT 落盘后调 `cm.updateInstance` 同步内存。

### code↔spec 一致性核实

| 项 | spec 契约 | 代码实现 | 一致 |
|---|---|---|---|
| updateInstance 行为 | §3.10（mutate 同一引用 / undefined 跳过 / no-op 不存在 / 不 reconnect） | `channel-manager.ts:143-149` | ✅ |
| PUT 写路径顺序 | §3.10（update 落盘 → updateInstance 同步内存 → 若 enabled 改 setEnabled） | `handlers/channel.ts:225-233` | ✅ |
| GET name 来源 | §3.10（内存 getState → inst.name） | `channel-manager.ts:157-166` + `handlers/channel.ts:82,136-142` | ✅ |
| ChannelConfigService 签名 | §3.7（含 getRaw / create enabled? / update 返 undefined） | `channel-config-service.ts:55-116` | ✅ |

**结论**：代码实现 == spec 契约，updateInstance 无静默偏离。

---

## v0.0.107（2026-07-10）— user message 跨渠道来源标识 + echo 屏蔽（编码 + 验证 + doc-sync 完成）

### 变更要点

- **`MessageSenderChannel` 加 `type` 字段**（`message/types.ts:308`）：implId 如 `'feishu'`。兑现 `feishu-channel.ts:8` 遗留 TODO「channel 字段 type 由 T4 落」。
- **`Channel` interface 加 `readonly instanceId`**（`channel/types.ts:29`）：accumulator self 判定用（按 instanceId 非 type，防多实例串扰）；`ChannelBase` 加 getter 透出 `this.instance.id`（`channel-base.ts:57`）。
- **`MessageStartEvent` 加 `origin?: {type, instanceId}`**（仅 role=user，派生自 sender.channel）：见 `../agent/agent_interface_and_loop/[P0]agent_event.md §4.2`。
- **accumulator echo 屏蔽**（`channel-accumulator.ts`）：`message_start(role=user)` 记 `userOrigins: Map<messageId, origin>`；`text_block_end` 查表：`origin.instanceId === channel.instanceId` → DROP（echo 屏蔽）；不同 → 文本前缀 `User (from ${type}): ` 走 sendOutbound；`message_end` 清 `userOrigins` 项（资源卫生，防无界增长——code-review Minor 修）。详见 `[P0]channel_manager.md §3.5.1`。
- **feishu `deliverUserMessage` 填 `type: this.instance.implId`**：`feishu-channel.ts:270-276`。
- **client（web）渲染**：`MessageSender` user 变体加 channel slim 子集 `{type, instanceId}`（不透 PII）；`chat-slice-reducer` message_start 读 evt.origin 写 sender.channel；`message-flatten` user-text name 从 sender.channel.type 派生原始 type，`component-message-stream` user 侧渲「来自 {type}」徽标（testid `msg-user-{id}-origin`，client 不显示）。

### doc-sync（阶段 5 落实）

- **`[P0]channel_manager.md §3.5.1`**：伪代码补 `message_end` 清 userOrigins 分支 + 「关键不变量」修正（原写「message_end 忽略」→ 改为「message_end 清 origin 项」，对齐 code-review 加的资源卫生）。
- **`[P0]channel_impl_interface.md §2 + §5.1`**（架构期已落）：Channel.instanceId + MessageSenderChannel.type + client 缺省。
- **`../agent/message/[P0]agent_message_interface.md §5`**：user 变体加 `channel?` 子结构（含 type，类型权威指向 channel_impl_interface §5.1）。
- **`specs/api/overall/04-agent-session.md §3.1/§3.2`**：GET /messages user 消息 sender 可含 channel（带 type）；POST /messages **不接受** sender.channel（唯一构造点=飞书 WS 入站）。
- **`specs/api/overall/10-multi-agent.md §4.1`**（编码期已落）+ **`specs/ui/components/chat-page/_overview.md §2/§4.6`**：user-text 来源徽标规则 + testid。

### code↔spec 一致性核实

15 符号逐项核对 == spec 契约，无静默偏离：MessageSenderChannel.type / MessageStartEvent.origin / emitMessageStart(origin 末参) / deriveUserOrigin（gate=source==='user'）/ emitUserMessageBlocks / Channel.instanceId / ChannelBase getter / accumulator echo self→DROP + 跨渠道前缀 + message_end 清理 / feishu type=implId / web 4 段（types/reducer/flatten/component-message-stream）。

### 权威文档

- 变更计划书：`specs/tech/version_logs/v0.0.107/change_plan.md` + 发布说明 `specs/tech/version_logs/v0.0.107/change_log.md`
- 调研：`specs/research/v0.0.107.channel_user_mesage/research.md`

## v0.0.103（2026-07-10）— 编码 + 验证完成（doc-sync 阶段5 落实）

### 编码波 1-3 + AT/ET 验证全绿（合并前门禁满足）

- **波1 T1+T2**：channel EP 注册 + 框架 9 文件（types/channel-base/channel-manager/channel-accumulator/channel-retry/channel-config-service/channel-binding-store/channel-bootstrap/handlers/channel-redact + feishu-channel.ts stub）。48/48 channel UT 通过。
- **波2 T3**：飞书 impl 5 文件（feishu-channel 298/feishu-client/feishu-protocol/feishu-slash/feishu-helpers）。**Bun+@larksuiteoapi/node-sdk@1.70.0 兼容冒烟通过**（WSClient start resolved + onReady 15s 内触发，**不需 node 子进程兜底**）。UT 86/86。
- **波3 T4+T5 并行**：T4 后端集成（handlers/channel.ts + bootstrap 注入 + MessageSender channel? + session-store role? + router 分发）+ T5 前端（channel-page 3 组件 + channel-api + nav-rail + view-store + i18n 双 locale + 组件 spec 先行 4 份 + UI overall 06-channel）。
- **AT** 2/2 全绿（channel_crud + channel_toggle）；**ET** 3/3 全绿（channel_page_list/new_instance/toggle，dom_asserts 全过 hard=0）。全量 5520 pass / 2 范围外 pre-existing scope-config-loader role_merge。

### doc-sync 落实（本日新增到 spec）

- **`[P0]channel_impl_interface.md` §3 + §5.3**：加 `findConversationBySession(sessionId)` protected helper（T3 偏离1：onOutBoundMessage(msg) 只接 msg，channel 需 sessionId 反查 conversationId 才能发飞书；manager 限定本 instance 防互窜）。
- **`[P0]channel_manager.md` §2 + §3.9 + §4**：接口签名加 `findConversationBySession`；§3.9 加反查设计决策；§4 factory 签名 `pluginManager` → `registry: Registry`（T4 偏离1：wave1/2 ChannelManagerImpl 实际用 registry 底层存储按 implId 取 impl 类，registry.getImplById(implId).implClass 反射 new）。
- **`[P0]channel_impl_interface.md` §5.4 / §5.5 / §5.6**：原 5.3 后下沉重编号（新 5.3 = onOutBoundMessage 反查）。
- **appSecret 双形态**（T5 偏离4）：`specs/ui/components/channel-page/section-channel-form.md §「appSecret 字段实现」` 已记（新建 password input / 编辑 SecretInput，E2E type action page.fill 要 input 元素 + 新建态无值可 mask + 编辑态 SecretInput 保 mask 既有 secret 语义）。
- **feishu-channel.ts stub**（wave1 产 extends ChannelBase，T3 替换方法体）：归 T1 covers 说明（BuiltinLoader.scan 启动 await import 需 impl 路径存在，故 wave1 先 stub 占位）。

### code↔spec 一致性核实结果

| 项 | spec 契约 | 代码实现 | 一致 |
|---|---|---|---|
| ChannelPoint 定义 | `[P0]channel_extension_point.md §2`（id='channel', cardinality='list', description i18n 占位符） | `extension-point.ts:214-218`（ChannelPoint 常量 + 数组追加 :244） | ✅ |
| groups.json channel group | `[P0]channel_extension_point.md §3.3`（extPoints:['channel'], 位置 provider 之后） | `app/plugins/groups.json:40-43` | ✅ |
| feishu manifest | `[P0]channel_impl_interface.md §4.1`（implId:'feishu' + configSchema required [appId, appSecret] + format:secret） | `app/plugins/builtins/feishu/plugin.json`（完全一致） | ✅ |
| Channel interface 5 方法 | `[P0]channel_impl_interface.md §2` | `app/server/src/channel/types.ts:22-35` + `channel-base.ts` abstract | ✅ |
| ChannelBase 7 helper（含 findConversationBySession） | `[P0]channel_impl_interface.md §3`（本日加 findConversationBySession） | `channel-base.ts:53-116`（7 protected helper 全在） | ✅ |
| ChannelManager 接口 | `[P0]channel_manager.md §2`（含 findConversationBySession） | `channel-manager.ts:22-35`（interface 全对齐） | ✅ |
| ChannelManagerOptions registry | `[P0]channel_manager.md §4`（本日改 pluginManager → registry） | `channel-manager.ts:50-58`（registry: Registry） | ✅ |
| 反查 instance 限定 | `[P0]channel_manager.md §3.9`（防互窜） | `channel-manager.ts:196-200`（instanceId 不匹配返 null） | ✅ |
| GET /config/channels 响应 | `specs/api/overall/17-channel.md §2`（enabled bool + config redact + connection + errorDetail + lastConnectedAt + bindingCount + createdAt/updatedAt） | `handlers/channel.ts:45-91`（ChannelApiResponse + toApiResponse 完全对齐） | ✅ |
| UI testid 契约（16 项） | `specs/ui/components/channel-page/_overview.md` + `specs/ui/overall/06-channel.md §4` | 3 组件实现 + ET 3 case checkpoint 全对齐 | ✅ |

**结论**：代码实现 == spec 契约，无静默偏离（所有偏离已记 log + decisions + spec 对齐）。

---

## v0.0.103（2026-07-09）— 新增 channel 子系统（IM 渠道接入层 + 飞书 ExtImpl）

### 范围

新增 `specs/tech/channel/` 子系统 OKF KB（4 份文档）：channel EP 定义 + Channel interface + ChannelBase abstract + FeishuChannel ExtImpl + ChannelManager（EP 消费方 + instance/binding/outbound 累积管线 + 双状态机 + 启动恢复）。

### 决策来源

`reqs/[done] v0.0.103.channel/design.md`（静态权威）+ `design-usecases.md`（动态链路 UC）+ `design-feishu.md`（飞书协议）+ `states/v0.0.103.channel/task.json` D1-D7 锁定决策。

### 核心设计

1. **channel = EP（和 provider 同构）**：id='channel' / cardinality='list'；飞书是 channel EP 的 ExtImpl（manifest 落 `app/plugins/builtins/feishu/plugin.json`，configSchema `{appId, appSecret}`）。
2. **复用 plugin_system 全套**：EP/ExtImpl/Registry/PluginManager/groups.json/configSchema 单一源/两级 enabled 全复用，不重新发明。
3. **channel = client 对等（D5）**：channel 不创建专属 session，IM 用户 sender = `{source:'user', channel:{...}}`（不扩 source 枚举）；agent loop 本体零改（只是又一条 inbound + 又一个 outbound 订阅者）。
4. **outbound 累积在 ChannelManager（D3）**：Manager subscribe agent_loop → 拼 text delta → run_end 组装完整 Message → channel.onOutBoundMessage（channel 不感知累积，工具过程不发）。
5. **binding 双向唯一（D6）**：(instance, conversation) ↔ sessionId 一对一覆盖 + sessionId 反向唯一（违反报错），简化 outbound 无 fan-out。
6. **双状态机（switch+connection）**：channel switch=on 立即 connect（与 connector lazy 不同），重连 3 次 × 5s 上限，失败转 error 等用户 off→on 重置。
7. **Bun+飞书 SDK 兼容风险**（编码期冒烟门禁）：`@larksuiteoapi/node-sdk` 在 Bun 下可能 hang，编码期必须冒烟（能连+能收+不 hang），中招则 feishu-client 走 node 子进程。

### 文档清单

- `index.md`（总起：①是什么 ②边界 ③关系 ④核心原则 ⑤目录导航）
- `[P0]channel_extension_point.md`（channel EP 定义 + groups.json 登记约定 + 与 provider EP 同构性证明）
- `[P0]channel_impl_interface.md`（Channel interface 5 方法 + ChannelBase abstract + FeishuChannel ExtImpl + configSchema + Bun 兼容风险）
- `[P0]channel_manager.md`（ChannelManager + ChannelConfigService + ChannelBindingStore + 双状态机 + outbound 累积 + 启动恢复）

### 关联变更

- `specs/tech/plugin_system/`：channel EP 登记 groups.json（新 group「渠道」），plugin_system 自身零改动（只是新增一个 EP）。
- `specs/api/overall/17-channel.md`：新增 channel HTTP facade。
- `specs/ui/components/channel-page/`：新增渠道配置页组件 spec（由 coder 编码前置产出）。
- `specs/prd/version_logs/v0.0.103.channel.md`：PRD（7 关键路径）。

### 风险与待编码期对照

- 飞书 SDK 事件字段精确名 / 发送 API 签名 / @bot mention 格式 / reaction API：编码期对照飞书官方文档（`design-feishu.md §9` 已列清单）。
- Bun+飞书 SDK 兼容性：编码期冒烟门禁（必跑）。
- MessageSender user 变体加 `channel?` 字段：需向后兼容（仅加可选字段，老消息无 channel 仍合法）。

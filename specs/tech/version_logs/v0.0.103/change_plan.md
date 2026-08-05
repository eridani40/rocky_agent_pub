# v0.0.103 变更计划书 — channel 子系统（IM 渠道接入层 + 飞书 ExtImpl）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威基线：PRD `specs/prd/version_logs/v0.0.103.channel.md`；reqs design 三份；task.json D1-D7 决策。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（channel_ep / channel_manager / channel_impl_feishu / channel_config / channel_binding / bootstrap / agent_message / session_store / handlers / router / fe_nav / fe_view / groups / i18n） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名/类名/interface 名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 / 项目原则 |
| 预计影响行 | +N / -M |

## 符号核对结论（arch 落表前 grep 核实）

| 符号 | 真实状态 | 备注 |
|---|---|---|
| `BUILTIN_EXTENSION_POINTS`（extension-point.ts:205） | ✓ 存在，数组 | append ChannelPoint |
| `ExtensionPoint` interface（extension-point.ts:21） | ✓ 存在 | ChannelPoint 用同款 |
| `app/plugins/groups.json` | ✓ 存在（7 group） | 新增第 8 group「channel」 |
| `bootstrap.ts:467` `new AgentManagerImpl` | ✓ 存在 | 之后注入 ChannelManager |
| `bootstrap.ts:785` `createAndBootstrapConnectorManager` | ✓ 存在（factory pattern） | channel 同款 `createAndBootstrapChannelManager` |
| `AgentManagerImpl.deliverTo`（agent-manager.ts:476） | ✓ `deliverTo(sessionId, message): Promise<AgentRun & {enqueueId}>` | channel 透传调 |
| `AgentManagerImpl.subscribe`（agent-manager.ts:497） | ✓ `subscribe(sessionId, modeKey='current'): AsyncIterable<AgentEvent>` | channel outbound 订阅 |
| `SessionStore.listSessions`（session-store.ts:229） | ✓ `{biz?: BizType}` —— **未支持 role 过滤** | 本版扩 `{role?: Role}` 参数 |
| `MessageSender` user variant（message/types.ts:247） | ✓ `{ source: 'user' }`（无 channel 字段） | 加可选 `channel?` 字段 |
| `handlers/connector.ts`（pattern） | ✓ 存在 | channel handlers 仿同款 |
| `router.ts:465` `path.startsWith('/config/connectors')` | ✓ 存在 | 加 `/config/channels` 同款分支 |
| `ConnectorConfigService`（config/connector-config-service.ts） | ✓ 存在 | ChannelConfigService 仿同款 |
| `ExtImpl.configSchema`（manifest.ts:61） | ✓ `JsonSchema`（可选） | feishu manifest 用 |
| `nav-rail.tsx:43` `NAV_BOTTOM` | ✓ 存在（skill/connector/settings-app） | 插 channel（skill↔connector 之间） |
| `view-store.ts:21` `ViewId` | ✓ `'skill' \| 'connector' \| ...` | 加 `\| 'channel'` |
| `app-shell.tsx:61` `renderView(view)` | ✓ switch case | 加 `case 'channel'` |
| `app/web/src/i18n/locales/{zh-CN,en}/` | ✓ 存在 | 加 channel.json + plugin-config.json 扩展 |
| `FeishuClient/WSClient`（@larksuiteoapi/node-sdk） | ✗ **新依赖** | 编码期 `bun add`，冒烟门禁（Bun 兼容） |
| `redactChannelSecret` | ✗ 不存在（仿 web-config-redact 套路新建） | 新增 helper |
| `ChannelPoint` / `Channel` interface / `ChannelBase` / `ChannelManager` / `ChannelInstance` / `ChannelBinding` / `ChannelState` / `ChannelConfigService` / `ChannelBindingStore` | ✗ 全新（本版新建） | 全部 type=新增 |

## 变更清单

### 模块 1：channel EP 注册（复用 plugin_system）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel_ep | app/server/src/plugin/extension-point.ts | ChannelPoint | 新增 | `export const ChannelPoint: ExtensionPoint = { id:'channel', cardinality:'list', description:'__MSG_extpoint.channel.description__' }` | MUST id 用 snake_case；MUST 用 i18n 占位符；MUST NOT 加 group 字段（已删 v0.0.71） | channel/[P0]channel_extension_point §2；plugin_system §3.4 | +8 |
| channel_ep | app/server/src/plugin/extension-point.ts | BUILTIN_EXTENSION_POINTS | 修改 | 数组追加 `ChannelPoint`（保持其他 13 EP 不动） | MUST 只 append 不重排 | extension-point.ts:205 | +1 |
| groups | app/plugins/groups.json | groups[] | 修改 | 加 group「channel」（label/description/extPoints:['channel']）；位置 = provider 之后或 web 之后（UI 显示序由数组位置定，最终视觉位置由 nav-rail 控制） | MUST extPoints 长度=1；MUST 启动校验 registry↔groups.json 双向一致（D6 第 5 条硬失败） | plugin_system/[P1]groups_meta_decl.md；channel/[P0]channel_extension_point §3.3 | +6 |

### 模块 2：channel 框架（app/server/src/channel/，全新）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel_types | app/server/src/channel/types.ts | Channel (interface) | 新增 | `interface Channel { type, connect(), disconnect(), onInboundMessage(raw), onOutBoundMessage(msg), onUpdateInputState(state) }` | MUST 5 方法签名严格对齐 design §2；MUST onOutBoundMessage 收**完整 Message**（非事件流） | channel/[P0]channel_impl_interface §2；design.md §2 | +18 |
| channel_types | app/server/src/channel/types.ts | ChannelInstance (interface) | 新增 | `{ id, implId, name, enabled, config, createdAt, updatedAt }`；config 形态由 impl configSchema 决定（feishu: `{appId, appSecret}`） | MUST id 用 ulid；MUST implId 必填 | channel/[P0]channel_manager §3.7；design.md §3.1 | +12 |
| channel_types | app/server/src/channel/types.ts | ChannelBinding (interface) | 新增 | `{ instanceId, conversationId, sessionId, boundBy:'slash'\|'manual', boundAt }` | MUST conversationId=chatId(群)/openId(私聊) 无 scope 编码（D2） | channel/[P0]channel_manager §3.4；design.md §3.2 | +8 |
| channel_types | app/server/src/channel/types.ts | ChannelState (interface) | 新增 | `{ id, implId, name, switch:'on'\|'off', connection:'disconnected'\|'connecting'\|'connected'\|'error', errorDetail?, lastConnectedAt?, bindingCount? }` | MUST switch 字段名（不是 enabled，UI 已对齐 connector）；MUST connection 4 态闭合 | channel/[P0]channel_manager §3.3；design.md §3.3 | +10 |
| channel_base | app/server/src/channel/channel-base.ts | ChannelBase (abstract class) | 新增 | abstract class implements Channel：6 个 protected helper（getBindedSession/deliverTo/bind/unbind/listPlaygroundSessions/listStudioLeaders）+ 持 instance/manager；5 方法 abstract 留 impl 实现 | MUST helper 全部走 manager 透传（不在 base 写业务逻辑）；MUST NOT impl 类重复写通用方法 | channel/[P0]channel_impl_interface §3；design.md §2 | +60 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManager (interface) | 新增 | `interface ChannelManager { bootstrap, registerInstance, unregisterInstance, setEnabled, getAllStates, getState, getBinding, bind, unbind, deleteBindingsBySession, deleteBindingsByInstance, subscribeOutbound, unsubscribeOutbound, deliverTo, listSessions }` | MUST 接口与 impl 分离（便于 mock 测试） | channel/[P0]channel_manager §2 | +25 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl (class) | 新增 | implements ChannelManager：持 instances Map / configService / bindingStore / agentManager / sessionStore / pluginManager；各方法实现见下多行 | MUST 单文件 ≤300 行（超出拆 channel-manager-lifecycle.ts/accumulator.ts） | channel/[P0]channel_manager §3 | +200 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.bootstrap() | 新增 | 扫 channel_config 全部 instance → 对 enabled=true 的 new impl + connect（fire-and-forget）；agent_loop bus 必须就绪 | MUST fire-and-forget 不阻塞 server；MUST connect 失败转 connection='error' 不抛出；MUST 在 agentManager 实例化后调 | channel/[P0]channel_manager §3.1；design.md §4 | +20 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.registerInstance() | 新增 | new impl(instance, this) + 存 instances Map；若 instance.enabled → void connect()（fire-and-forget） | MUST impl 类按 instance.implId 从 Registry 取（plugin_manager.getExtensionImpls 或直访 registry） | channel/[P0]channel_impl_interface §5.3 | +15 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.unregisterInstance() | 新增 | channel.disconnect() + bindingStore.deleteByInstance + 对每被清 sessionId unsubscribeOutbound + configService.delete | MUST idempotent；MUST 清订阅防泄漏 | channel/[P0]channel_manager §3.4 | +12 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.setEnabled() | 新增 | 持久化 intent（configService.setEnabled）+ enabled?channel.connect():channel.disconnect()；状态机迁移（switch+connection） | MUST 持久化 intent 与 connect 解耦（intent 写盘即使 connect 失败也保留）；MUST off→on 重置重试计数 | channel/[P0]channel_manager §3.3；design.md §5 | +18 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.bind() | 新增 | 双向唯一检查：查 sessionId 是否已被其他 (instance,conv) 占用 → 抛 'SESSION_ALREADY_BOUND'；否则 upsert binding + 旧 sessionId unsubscribe + 新 sessionId subscribeOutbound | MUST 双向唯一（D6）；MUST 占用时报错不静默覆盖 | channel/[P0]channel_manager §3.4；design.md §3.2 | +20 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.unbind() | 新增 | bindingStore.delete + unsubscribeOutbound（防泄漏） | MUST 删订阅防泄漏 | channel/[P0]channel_manager §3.4 | +8 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.subscribeOutbound() | 新增 | agentManager.subscribe(sid,'current') → 起累积 loop（fire-and-forget）；存 cancel handle 到 Map<sessionId, Set<channel>> | MUST 多 channel 订阅同 session 支持（但 binding 双向唯一下实际 ≤1） | channel/[P0]channel_manager §3.5 | +10 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.runAccumulator()（private） | 新增 | subscribe 迭代：run_start→开 buffer+typing / text_block_delta→拼 / text_block_end→push / tool_call_*→忽略 / run_end→组装完整 Message+onOutBoundMessage+idle+清 buffer | MUST tool 过程不发飞书（D3）；MUST 每 run 一条 Message；MUST unsubscribe 时 break loop 防泄漏 | channel/[P0]channel_manager §3.5；design-usecases UC-D2 | +40 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.getAllStates() | 新增 | 遍历 instances Map + 聚合 bindingStore.countByInstance → 返 ChannelState[] | MUST appSecret redact 不在此层（在 handler/configService） | channel/[P0]channel_manager §2 | +10 |
| channel_manager | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.connectWithRetry()（private） | 新增 | connect 失败 → 重试 3 次 × 每次 5s → 仍失败 connection='error' + errorDetail；switch off 时不重试 | MUST 重试上限 3 次（req）；MUST NOT 指数退避无限重连（openclaw 路线不要） | channel/[P0]channel_manager §3.3；design-feishu §7 | +20 |
| channel_config | app/server/src/channel/channel-config-service.ts | ChannelConfigService (class) | 新增 | list/get/create/update/delete/setEnabled；FsCrudStore mount `channel_config`；list/get 返前 appSecret redact 为 '***' | MUST 仿 ConnectorConfigService 同款（CompositeStore+FsCrudStore）；MUST redact 在 service 层做透传 | channel/[P0]channel_manager §3.7；config/connector-config-service.ts | +60 |
| channel_config | app/server/src/channel/channel-config-service.ts | ChannelConfigSchema | 新增 | `{ entity:'channel_config', engine:'file', fs:{sharding:{shardKeyField:'id'}, format:'json'}, fields:{id,implId,name,enabled,config,createdAt,updatedAt} }` | MUST 落 schema_defs/ 目录（与 connector_config 同款） | persistence/[P0]crud_store_interface.md | +15 |
| channel_config | app/server/src/handlers/channel-redact.ts | redactChannelSecret() | 新增 | `redactChannelSecret(instance|list)`：appSecret 字段 redact 为 '***'；mergeChannelSecret(input, existing)：input='***' 时保 existing 原值 | MUST 与 web-config-redact 同款占位字面量 '***'；MUST NOT 在日志/响应泄原值 | handlers/web-config-redact.ts（同套路） | +30 |
| channel_binding | app/server/src/channel/channel-binding-store.ts | ChannelBindingStore (class) | 新增 | get/upsert/delete/deleteBySession/deleteByInstance/findBySession；FsCrudStore mount `channel_bindings`；file key `<instanceId>__<conversationId>` | MUST 双向索引（正键 (iid,conv) + 反键 sessionId）；MUST findBySession 反向唯一检查 | channel/[P0]channel_manager §3.8 | +70 |
| channel_binding | app/server/src/channel/channel-binding-store.ts | ChannelBindingSchema | 新增 | `{ entity:'channel_bindings', engine:'file', fs:{sharding:{shardKeyField:'id'}, format:'json'}, fields:{instanceId,conversationId,sessionId,boundBy,boundAt} }`；id=`<instanceId>__<conversationId>` | MUST id 复合键拼接（file 命名约定） | persistence/[P0]crud_store_interface.md | +12 |
| channel_bootstrap | app/server/src/channel/channel-bootstrap.ts | createAndBootstrapChannelManager() | 新增 | factory：new ChannelManagerImpl + configService + bindingStore + void bootstrap().catch(log)；返回 cm | MUST 仿 createAndBootstrapConnectorManager 同款（fail-safe 不抛错阻塞 server） | bootstrap.ts:785（connector 同款）；channel/[P0]channel_manager §4 | +30 |

### 模块 3：飞书 impl（app/plugins/builtins/feishu/，全新）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| feishu_manifest | app/plugins/builtins/feishu/plugin.json | manifest | 新增 | `{id:'feishu', label, description, extImpls:[{implId:'feishu', point:'channel', impl:'./feishu-channel.ts', description, configSchema:{appId,appSecret(format:secret)}}]}` | MUST configSchema required:[appId,appSecret]；MUST impl 路径相对 plugin 目录；MUST i18n 占位符 `__MSG_*__` | channel/[P0]channel_impl_interface §4.1；plugin_system 不变量 8 | +20 |
| feishu_impl | app/plugins/builtins/feishu/feishu-channel.ts | FeishuChannel (default export class) | 新增 | `export default class FeishuChannel extends ChannelBase`；实现 Channel 5 方法 + 入站三件套（去重/去抖/顺序队列）+ 斜杠识别 | MUST extends ChannelBase 不重复写通用方法；MUST 单文件 ≤300 行（超出拆 protocol/slash/client） | channel/[P0]channel_impl_interface §4.2；design-feishu §3/§4 | +150 |
| feishu_impl | app/plugins/builtins/feishu/feishu-channel.ts | FeishuChannel.connect() | 新增 | new WSClient({appId, appSecret}) + start + 注册 im.message.receive_v1 回调（→ onInboundMessage） | MUST 凭证从 instance.config 读；MUST 注册失败转 connection='error'；**编码期冒烟门禁**：能连+收事件+不 hang | channel/[P0]channel_impl_interface §5.5；design-feishu §1 | +20 |
| feishu_impl | app/plugins/builtins/feishu/feishu-channel.ts | FeishuChannel.disconnect() | 新增 | WSClient.close + abortSignal + 注销回调；idempotent | MUST idempotent | channel/[P0]channel_impl_interface §2 | +8 |
| feishu_impl | app/plugins/builtins/feishu/feishu-channel.ts | FeishuChannel.onInboundMessage() | 新增 | 1) parse event(message_id/chat_id/open_id/chat_type/content/mentions) 2) tryBeginProcessing(message_id) 去重 3) 剥离 @bot 4) startsWith('/')→派发斜杠 5) 否则去抖+顺序队列→deliverTo | MUST message_id 幂等（UC-G1）；MUST 命令消息立即派发（跳过去抖）；MUST 构造 Message.sender={source:'user', channel:{...}}（D5） | channel/[P0]channel_impl_interface §2；design-feishu §2/§3/§4；design-usecases UC-D1 | +60 |
| feishu_impl | app/plugins/builtins/feishu/feishu-channel.ts | FeishuChannel.onOutBoundMessage() | 新增 | content blocks → 飞书文本/图片（im.message.create）；超长分块（~4000 字符按 markdown 边界） | MUST msg_type 编码期对照飞书文档；MUST image block 先上传 media 拿 media_id | channel/[P0]channel_impl_interface §2；design-feishu §5 | +30 |
| feishu_impl | app/plugins/builtins/feishu/feishu-channel.ts | FeishuChannel.onUpdateInputState() | 新增 | run_start→'typing' / run_end→'idle'；飞书无原生 typing API → reaction emoji hack 或 no-op | MUST 接口保留（hack 实现可选）；MUST NOT 强依赖 reaction API | channel/[P0]channel_impl_interface §2；design-feishu §6 | +12 |
| feishu_client | app/plugins/builtins/feishu/feishu-client.ts | FeishuClient (class) | 新增 | WSClient 封装（connect/disconnect/sendMessage/sendImage/onEvent）；处理重连 3 次 × 5s | MUST 单文件 ≤300 行；MUST 重连按 req 上限（非指数退避）；**编码期 Bun 兼容冒烟门禁**（中招走 node 子进程） | design-feishu §1/§7；channel/[P0]channel_impl_interface §5.5 | +120 |
| feishu_protocol | app/plugins/builtins/feishu/feishu-protocol.ts | parseFeishuMessage() | 新增 | 解析飞书 event JSON → {conversationId, text, imUserId, imUserName}；剥离 @bot mention | **编码期对照飞书官方文档**字段精确名（design-feishu §9） | design-feishu §2/§3 | +40 |
| feishu_protocol | app/plugins/builtins/feishu/feishu-protocol.ts | formatFeishuOutbound() | 新增 | Message content blocks → 飞书 text/image payload；超长 chunkTextForOutbound() | **编码期对照飞书官方文档** msg_type | design-feishu §5 | +30 |
| feishu_slash | app/plugins/builtins/feishu/feishu-slash.ts | dispatchSlash() | 新增 | 识别 `/listp`/`/bindp N`/`/lists`/`/binds N`/`/unbind`/`/status`；派发到 base.listPlaygroundSessions/listStudioLeaders/bind/unbind/getBindedSession；回飞书格式化文本 | MUST /bindp /binds 都是绑定（p=playground / s=studio）；MUST /bindp N 取第 N 个 session；MUST session 已被占用报错 | design.md §7 D1/D2；design-usecases UC-C1-C6 | +80 |

### 模块 4：bootstrap 注入（app/server/src/bootstrap.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap.ts | import createAndBootstrapChannelManager | 新增 | `import { createAndBootstrapChannelManager } from './channel/channel-bootstrap';` | | | +1 |
| bootstrap | app/server/src/bootstrap.ts | BootstrapResult.channelManager | 新增 | interface 字段：`channelManager: ChannelManager;` | | bootstrap.ts:115 | +1 |
| bootstrap | app/server/src/bootstrap.ts | bootstrapBuiltinPlugins() 内部 | 修改 | 在 `new AgentManagerImpl({...})`（:467）之后调 `const channelManager = createAndBootstrapChannelManager({dataDir, agentManager, sessionStore, pluginManager});` + 注入 BootstrapResult | MUST 在 agentManager 之后（subscribe/deliverTo 必须就绪）；MUST 在 server.listen 之前；MUST fire-and-forget 不阻塞 | channel/[P0]channel_manager §4 | +8 |
| bootstrap | app/server/src/bootstrap.ts | router deps 透传 | 修改 | router 入参加 `channelManager: bs.channelManager`（供 /config/channels 路由） | | router.ts:143 | +1 |

### 模块 5：扩展 Message sender（agent/message，D5 不扩 source 枚举）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent_message | app/server/src/message/types.ts | MessageSender user variant | 修改 | `{ source: 'user' }` → `{ source: 'user'; channel?: { instanceId: string; conversationId: string; imUserId: string; imUserName: string } }`（仅加可选字段，向后兼容） | MUST NOT 新建 source 类型（不加 'channel' source）；MUST 老消息无 channel 字段仍合法 | channel/[P0]channel_impl_interface §5.1；design.md §3.4 D5 | +5/-1 |
| agent_message | specs/tech/agent/message/[P0]agent_message_interface.md | §5 MessageSender user variant | 修改 | 文档同步：user 变体加可选 channel 字段（D5） | MUST 标 [v0.0.103] | doc-modifier 阶段 5 | +3 |

### 模块 6：session-store listSessions 加 role 过滤（/lists 用）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_store | app/server/src/agent/session-store.ts | SessionStore.listSessions() | 修改 | 签名 `{biz?: BizType}` → `{biz?: BizType, role?: Role}`；filter 逻辑加 role（无 role 字段历史 session 视为 'rocky'） | MUST 向后兼容（缺省/未指定 role 返全部该 biz）；MUST role 字段闭合（'rocky'\|'leader'\|'mate'\|'squad'） | session-store.ts:229；/lists 用 | +6/-2 |

### 模块 7：handlers + router（HTTP facade）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| handlers | app/server/src/handlers/channel.ts | handleChannelList() | 新增 | GET /config/channels：`cm.getAllStates()` → 200 `{items}`（每 item appSecret redact 已在 service 层做） | MUST 单文件 ≤300 行（含 4 handler 共存则拆 channel-list/channel-form） | api/overall/17-channel.md §2；handlers/connector.ts（同款） | +12 |
| handlers | app/server/src/handlers/channel.ts | handleChannelCreate() | 新增 | POST /config/channels：校验 implId 在 Registry + configSchema 校验 → configService.create → cm.registerInstance → 201 返 ChannelState | MUST implId 非法 400；MUST schema 校验失败 400 | api/overall/17-channel.md §3 | +25 |
| handlers | app/server/src/handlers/channel.ts | handleChannelUpdate() | 新增 | PUT /config/channels/:id：mergeChannelSecret（appSecret '***' 保原值）→ configService.update + 若 enabled 改 → cm.setEnabled → 202 `{ok:true}` | MUST fire-and-forget（不 await connect 完成）；MUST '***' 占位约定 | api/overall/17-channel.md §4 | +20 |
| handlers | app/server/src/handlers/channel.ts | handleChannelDelete() | 新增 | DELETE /config/channels/:id：cm.unregisterInstance（含 disconnect + 清 binding + 清订阅 + 落盘删）→ 200 `{ok:true}` | MUST orphan 清理（binding + 订阅） | api/overall/17-channel.md §5 | +12 |
| handlers | app/server/src/handlers/channel.ts | handleChannelRoute() | 新增 | 路由分发：path 匹配 GET/POST/PUT/DELETE + :id 提取 → 派发到上述 4 handler | MUST 非法 method 返 405 + Allow 头 | handlers/connector.ts（同款） | +25 |
| router | app/server/src/router.ts | import handleChannelRoute | 新增 | `import { handleChannelRoute } from './handlers/channel';` | | | +1 |
| router | app/server/src/router.ts | path 分发 | 修改 | 加分支：`if (path === '/config/channels' \|\| path.startsWith('/config/channels/')) return handleChannelRoute(req, method, path, body, bs.channelManager);`（位置：connector 分支之后） | MUST 在 session 路由之前（防 /session/:id 截胡） | router.ts:465 | +3 |

### 模块 8：前端 nav + view（app/web/src/）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| fe_nav | app/web/src/components/framework/nav-rail/nav-rail.tsx | NAV_BOTTOM | 修改 | 数组插 `{ view:'channel', testid:'nav-channel', labelKey:'nav.channel', icon:<ChannelIcon /> }`（位置：skill 之后、connector 之前） | MUST testid 唯一；MUST 顺序 = 技能↔渠道↔连接器↔应用设置 | design.md §6；nav-rail.tsx:43 | +1 |
| fe_nav | app/web/src/components/framework/nav-rail/nav-rail.tsx | ChannelIcon | 新增 | 渠道图标组件（仿 SkillIcon 风格，自选 4 角星/对话气泡 svg） | MUST 与现有 icon 风格一致 | nav-rail.tsx:156（SkillIcon 同款） | +8 |
| fe_nav | app/web/src/components/framework/nav-rail/__tests__/nav-rail.test.tsx | nav 几何顺序断言 | 修改 | 加 channel 入口断言（顺序：skill→channel→connector→settings-app） | MUST 改既有断言（顺序变了） | memory locale-group-keys-drift | +3/-1 |
| fe_view | app/web/src/store/view-store.ts | ViewId | 修改 | `'skill' \| 'connector'` → `'skill' \| 'channel' \| 'connector'` | MUST 加在 skill 之后保持视觉序 | view-store.ts:21 | +1 |
| fe_view | app/web/src/components/framework/app-shell/app-shell.tsx | renderView() | 修改 | switch 加 `case 'channel': return <PageChannel />;`（import + case） | | app-shell.tsx:61 | +3 |
| fe_page | app/web/src/components/channel-page/page-channel.tsx | PageChannel | 新增 | 渠道配置页主组件（列表 + 新建表单 + 编辑表单）；5s 轮询 GET /config/channels；状态展示（switch/connection/errorDetail/bindingCount） | MUST 类型列表从 inventory getExtensionImpls('channel') 来（当前只飞书）；MUST appSecret 字段用 primitive-secret-input；MUST 删除二次确认 | design.md §6；primitive-secret-input.md | +150 |
| fe_page | app/web/src/components/channel-page/section-channel-list.tsx | SectionChannelList | 新增 | 渠道列表 section（名称/implId/switch/connection/errorDetail/bindingCount/编辑删除） | MUST testid 契约 `channel-item-<id>`/`channel-switch-<id>`/`channel-edit-<id>`/`channel-delete-<id>` | specs/ui/components/channel-page/（coder 编码前置产出） | +80 |
| fe_page | app/web/src/components/channel-page/section-channel-form.tsx | SectionChannelForm | 新增 | 渠道表单 section（类型选择 + name + appId + appSecret）；新建/编辑同款 | MUST 类型列表从 EP inventory；MUST appSecret primitive-secret-input | design.md §6 | +100 |
| fe_api | app/web/src/lib/channel-api.ts | listChannels/createChannel/updateChannel/deleteChannel | 新增 | 4 个 fetch wrapper（GET/POST/PUT/DELETE /config/channels） | MUST 与 chat-api/connector-api 同款 req<>() 封装风格 | api/overall/17-channel.md | +40 |

### 模块 9：i18n（新增 channel.json + 扩展 plugin-config.json）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n | app/web/src/i18n/locales/zh-CN/channel.json | 新增 | 新增 | `{nav:{channel}, channel:{title, list:{...}, form:{...}, state:{...}}}` 中文文案 | MUST 与 connector.json 同结构 | i18n/[P1] | +30 |
| i18n | app/web/src/i18n/locales/en/channel.json | 新增 | 新增 | 英文版（同 zh-CN 结构） | MUST 与 zh-CN key 一一对应 | i18n/[P1] | +30 |
| i18n | app/web/src/i18n/index.ts | import channel.json | 新增 | import zhCNChannel + enChannel + 注册 ns 'channel' | MUST 注册 ns 才能用 useTranslation('channel') | i18n/index.ts:26 | +3 |
| i18n | app/web/src/i18n/locales/zh-CN/plugin-config.json | extpoint.channel.description + group.channel.{label,description} + plugin.builtin.feishu.* | 新增 | EP description + group meta + feishu impl label/description + config.appId/appSecret.description i18n 键 | MUST 与 manifest `__MSG_*__` 占位符一一对应 | plugin_system/[P1]groups_meta_decl.md | +10 |
| i18n | app/web/src/i18n/locales/en/plugin-config.json | (同上) | 新增 | 英文版 | MUST key 一一对应 | | +10 |

### 模块 10：组件 spec（coder 编码前置产出，arch 只列清单）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_spec | specs/ui/components/channel-page/_overview.md | 新增 | 新增 | 组件总览（page-channel + section-channel-list + section-channel-form）+ testid 契约 + 数据 hook 契约 | MUST coder 编码前置产出（先 spec 后实现） | _conventions.md | +60 |
| ui_spec | specs/ui/components/channel-page/page-channel.md | 新增 | 新增 | page-channel spec（布局 + 子 section 组合 + 5s 轮询 + 路由） | | _conventions.md | +40 |
| ui_spec | specs/ui/components/channel-page/section-channel-list.md | 新增 | 新增 | 列表 section spec（字段/testid/状态展示/编辑删除交互） | | | +50 |
| ui_spec | specs/ui/components/channel-page/section-channel-form.md | 新增 | 新增 | 表单 section spec（类型选择/name/appId/appSecret secret-input/保存） | | | +40 |
| ui_overall | specs/ui/overall/0X-channel.md | 新增 | 新增 | UI 契约：渠道页用户路径 + nav-rail 入口 + 状态字段语义 | | specs/ui/overall/05-connectors.md（同款） | +50 |

## 关键架构决策（编码期需 coder 注意）

1. **channel EP 注册**：BUILTIN_EXTENSION_POINTS append `ChannelPoint`；groups.json 加 group「channel」；启动校验第 5 条不变量（registry ↔ groups.json 双向一致）必须通过。
2. **bootstrap 时序**：在 `new AgentManagerImpl`（bootstrap.ts:467）**之后**注入 ChannelManager，否则 subscribe/deliverTo 未就绪；connect 必须 fire-and-forget（void 不 await）。
3. **outbound 累积**：ChannelManager.runAccumulator 是 fire-and-forget 异步 loop，必须在 unsubscribeOutbound 时 break loop（否则订阅泄漏）。
4. **binding 双向唯一**：bind() 必须查反向（sessionId 是否已被占用），占用抛 'SESSION_ALREADY_BOUND'。
5. **重连策略**：3 次 × 5s 上限（不是 openclaw 指数退避），3 次失败转 error 等用户 off→on 重置（重试计数清零）。
6. **运行时不写 policy**：ChannelManager 不调 PluginConfigService.setImplEnabled/setImplConfig（那是用户配置面）；channel 只读 channel_config + 写 channel_bindings。

## 编码期对照点（architect 标注，coder 落实）

| 对照点 | 来源 | 处理 |
|---|---|---|
| 飞书 `im.message.receive_v1` 事件 JSON 精确字段（content/mentions/chat_type） | design-feishu §9 | coder 对照飞书官方文档（refs/openclaw/extensions/feishu/src/ 可参考），调整 parseFeishuMessage 实现 |
| 飞书 `im.message.create` API 签名 + msg_type（text/image/post） | design-feishu §9 | coder 对照官方文档，调整 formatFeishuOutbound |
| 飞书 @bot mention 字段格式 + 剥离逻辑 | design-feishu §9 | coder 实现 parseFeishuMessage 时验证 |
| 飞书 reaction API（typing hack） | design-feishu §9 | coder 决定启用/no-op（先 no-op 保守） |
| **Bun+飞书 SDK 兼容风险（MANDATORY 冒烟门禁）** | channel/[P0]channel_impl_interface §5.5 | coder 必须冒烟：`bun add @larksuiteoapi/node-sdk` + 用 feishu.env 真凭证跑 minimal connect 脚本（能连+能收事件+不 hang）；中招则 feishu-client.ts 改走 node 子进程（spawn node + IPC），主进程不直 import SDK |
| `format: "secret"` configSchema 字段是否被前端 inventory 识别 | design.md §6 | coder 验证 section-channel-form 渲染 secret-input；若 inventory 不透传 format 则用约定（appId→input, appSecret→secret-input by field name 约定） |
| session-store role 过滤：无 role 历史数据兜底 | 本表模块 6 | 无 role 字段历史 session 视为 'rocky'（与 biz 缺省视为 playground 同款） |

## spec↔code 漂移兜底

- 若发现 `MessageSender` user variant 扩字段方式与实际代码不符（如已用其他形态）：coder 按代码实际调整 + 汇报偏离，doc-modifier 阶段 5 同步 spec。
- 若 `inventory` 不透传 `ExtImpl.configSchema.properties.<key>.format`：coder 在前端按字段名约定（`appId`→input / `appSecret`→secret-input）路由控件 + 汇报。
- 若 `agentManager.subscribe` 签名与本表描述不同（如返 cancel handle 而非纯 AsyncIterable）：coder 按实际 API 调整 runAccumulator 的取消机制 + 汇报。

---

**汇总**：新增文件 ~28 份（channel 框架 8 + 飞书 impl 5 + handlers 1 + bootstrap 1 + UI 3 + i18n 5 + spec 文档 7）；修改文件 ~14 份。总预计影响行 +1800 / -10。

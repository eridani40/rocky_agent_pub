# v0.0.103 channel 调研归档（IM 渠道接入 / 飞书 ExtImpl）

- **调研范围**: IM 渠道接入层（channel = Extension Point）的两路事实依据——openclaw 飞书实证 + 项目现有可复用机制
- **调研对象**: `refs/openclaw/extensions/feishu/`（A 路）；本项目 `app/server/src` + `specs/tech/plugin_system/`（B 路）
- **调研日期**: 2026-07-09
- **归档定位**: 本文**只归档调研事实 + 决策依据**，不重复设计内容。设计产出见 req 目录三份 design 文件。

---

## 1. 调研对象 + 方法

两路并行调研（见 task.json decisions[5]/[6]）：

- **A 路（openclaw 飞书实证）**：深度阅读 `refs/openclaw/extensions/feishu/src/`，提取飞书 IM 接入的通用模式（连接/事件/入站三件套/出站/重连/凭证/插件注册）。openclaw 是成熟的多 channel 平台（feishu/telegram/discord 等），其 feishu 扩展是飞书协议的权威实证源。
- **B 路（现有机制可复用性）**：审视本项目 `app/server/src/` + `specs/tech/plugin_system/`，盘点接入新 channel 时哪些机制可直接复用、哪些需新建。核心判断：channel 接入不需要新造核心环，只需做 channel-specific 协议适配 + 一个消费 EP 的 ChannelManager。

**两路交汇结论**：channel = EP（和 provider 同构），飞书 = channel EP 的 ExtImpl。channel-specific（消息格式/conversationId/凭证/连接）落在 impl；agent-generic（run/session/routing）复用现有核心环。

---

## 2. A 路：openclaw 飞书实证

### 2.1 连接（WS 优先 / webhook 兜底）

- **WSClient 长连接**：bot 主动连飞书服务器，`appId`/`appSecret` 鉴权，**无需公网入口**（本地/内网可跑 → AT/ET 可测）。
  - 证据：`refs/openclaw/extensions/feishu/src/client.ts:205-227` `createFeishuWSClient()` → `new feishuClientSdk.WSClient({appId, appSecret, domain, wsConfig: FEISHU_WS_CONFIG, ...callbacks})`。
  - WS 心跳配置：`client.ts:25-28` `FEISHU_WS_CONFIG = { PingInterval: 30, PingTimeout: 3 }`（SDK 内置，单位秒）。
  - 回调钩子：`client.ts:196-199` `FeishuWsClientCallbacks = Pick<..., 'onError'|'onReady'|'onReconnected'|'onReconnecting'>`。
- **webhook 兜底**：需公网入口，`encryptKey`（SHA256 签名校验）+ `verificationToken`。
  - 证据：`refs/openclaw/extensions/feishu/src/client.ts:232-237` `createEventDispatcher()` 注入 `encryptKey`+`verificationToken`；`secret-contract.ts:102-140` `resolveAccountMode` 判 `connectionMode==='webhook'` 才激活 `encryptKey`/`verificationToken`。
  - **本版本 D4 简化**：只 WS，凭证仅 `appId`+`appSecret`，整条 webhook 路径砍掉。

### 2.2 事件（`im.message.receive_v1`）

- **事件分发器**：`EventDispatcher.register({ 'im.message.receive_v1': handler })`。
  - 证据：`refs/openclaw/extensions/feishu/src/monitor.account.ts:291-307` 注册 `im.message.receive_v1` → `createFeishuMessageReceiveHandler({...})`，同时注册 `im.message.message_read_v1`（已读回执，忽略）。
- **事件 payload 解析**：`monitor.message-handler.ts:64-86` `parseFeishuMessageEventPayload()` 提取 `message.message_id` / `message.chat_id` / `message.chat_type` / `message.message_type` / `message.content`；`chat_type` 归一为 `group|topic_group|private|p2p`（`monitor.message-handler.ts:58-62`）。
- **自回环过滤**：`monitor.message-handler.ts:328-334` bot 自己发的消息（`senderOpenId === botOpenId`）直接 drop，避免 consume claim/debounce slot。

### 2.3 入站三件套（去重 + 去抖 + 顺序队列，IM 通用痛点）

入口位于 `monitor.message-handler.ts:320-356` 的返回 handler，顺序执行：

1. **去重（message_id 幂等）**：`tryBeginFeishuMessageProcessing(messageId, namespace)` 内存 LRU + TTL。
   - 证据：`refs/openclaw/extensions/feishu/src/processing-claims.ts:1-60`：`EVENT_DEDUP_TTL_MS = 5*60*1000`（5 分钟），`EVENT_MEMORY_MAX_SIZE = 2_000`；`pruneProcessingClaims` 双重淘汰（TTL + 容量）。命中已处理 key 返回 `false` → `monitor.message-handler.ts:336-339` 直接 drop。
2. **去抖（per conversation debounce）**：同对话连发短文本合并。
   - 证据：`monitor.message-handler.ts:246-318` `inboundDebouncer = channelRuntime.debounce.createInboundDebouncer(...)`；`buildKey`=`feishu:${accountId}:${chatId}:${threadKey}:${senderId}`（`message-handler.ts:248-257`）；`shouldDebounce` 排除命令（`isControlCommandMessage`，`message-handler.ts:258-264`）；`onFlush` 合并多条文本 `join('\n')`（`message-handler.ts:287-290`）。
3. **顺序队列（per conversationId 串行）**：保序，避免并发乱序。
   - 证据：`monitor.message-handler.ts:180-186` `enqueue = createSequentialQueue({onTaskTimeout: ...})`；`message-handler.ts:188-209` `dispatchFeishuMessage` 按 `sequentialKey`（默认 `feishu:${accountId}:${chat_id}`）入队串行执行。

### 2.4 conversationId 编码（session 粒度）

- **openclaw 用 scope 编码自动路由**：`refs/openclaw/extensions/feishu/src/conversation-id.ts:18-44` `buildFeishuConversationId({chatId, scope, senderOpenId, topicId})`，scope ∈ `group|group_sender|group_topic|group_topic_sender`；带 sender/topic 时拼 `${chatId}:sender:${openId}` / `${chatId}:topic:${topicId}`。
- **本版本 D2 简化**：去掉 scope 自动路由，`conversationId = chatId`（群）/ `openId`（私聊），只显式 `/bindp`/`/binds` 绑定。

### 2.5 reply 分段 deliver（流式卡片 + 分块）

- **chunk limit**：`refs/openclaw/extensions/feishu/src/reply-dispatcher.ts:252-254` `textChunkLimit = resolveTextChunkLimit(..., {fallbackLimit: 4000})`。
- **renderMode 三态**：`reply-dispatcher.ts:257` `renderMode = account.config?.renderMode ?? 'auto'`（`auto|raw|card`）；`streamingEnabled = streaming !== false && renderMode !== 'raw'`（`reply-dispatcher.ts:258`）。
- **流式卡片**：`reply-dispatcher.ts:370-413` `startStreaming()` → `new FeishuStreamingSession(...)`，patch 卡片实时刷新；失败退 60s backoff（`reply-dispatcher.ts:75-79`）。
- **deliver 分支**：`reply-dispatcher.ts:644-803` 按 `info.kind`（`final|block|partial`）+ `useStaticCard|useStreamingCard` 分派 `sendStructuredCardFeishu` / `sendMessageFeishu` / `sendMediaFeishu`。
- **本版本 D3 简化**：不做流式卡片，累积到 `run_end` 发完整 assistant Message（channel 不感知累积）。

### 2.6 重连（指数退避，无限重试）

- **openclaw 策略**：`refs/openclaw/extensions/feishu/src/monitor.transport.ts:35-36` `FEISHU_WS_RECONNECT_INITIAL_DELAY_MS=1_000` / `MAX_DELAY_MS=30_000`；`monitor.transport.ts:117-122` `getFeishuWsReconnectDelayMs(attempt) = Math.min(1000 * 2 ** max(0, attempt-1), 30000)`（指数退避，上限 30s）；`monitor.transport.ts:269-289` 每次 cycle `attempt += 1` → `waitForAbortableDelay(delayMs)` → 重建 WSClient，**无限重试**（除非命中 terminal error：`monitor.transport.ts:150-156`）。
- **本版本 D4 简化**：req 指定 **3 次 × 5s 上限**，仍失败转 `connection=error` 不再自动重连，等 switch off→on 重置。避免刷日志 + 简化状态机。

### 2.7 凭证（appId + appSecret required）

- **硬校验**：`refs/openclaw/extensions/feishu/src/client.ts:162-164` `if (!appId || !appSecret) throw new Error('Feishu credentials not configured...')`（`createFeishuClient`）；`client.ts:211-213` `createFeishuWSClient` 同样硬校验。
- **secret 形态**：`secret-contract.ts:13-80` 所有 `appSecret`/`encryptKey`/`verificationToken` 声明 `secretShape: 'secret_input'`（即 mask 显示）。
- **本版本 D4 凭证**：仅 `appId`（普通）+ `appSecret`（secret-input 组件，v0.0.90 已有），去 `encryptKey`/`verificationToken`（webhook 专用）。

### 2.8 命令处理（斜杠拦截，不进 agent）

- **剥离 @bot mention**（保留 `/` 前缀，修复 #35994）：design-feishu.md §3 引 openclaw 修复。
- **命令跳过去抖**：`monitor.message-handler.ts:258-264` `shouldDebounce` 调 `channelRuntime.commands.isControlCommandMessage(text, cfg)`，命令返回 false 不入 debouncer。
- **本版本命令集**（D1/D2）：`/listp` `/bindp N` `/lists` `/binds N` `/unbind` `/status`，命令拦截不进 agent。

### 2.9 插件注册两层（channel entry + EventDispatcher register）

- **第一层 channel entry 声明**：`refs/openclaw/extensions/feishu/channel-entry.ts:4-21` `defineBundledChannelEntry({id:'feishu', name, plugin:{specifier,exportName}, secrets, runtime})` —— 声明 channel 插件身份 + 指向 plugin 模块 + secret 契约 + runtime setter。
- **第二层 EventDispatcher register**：`monitor.account.ts:291-307` 运行时把 `im.message.receive_v1` handler 注册到 dispatcher。
- **manifest**：`refs/openclaw/extensions/feishu/openclaw.plugin.json`（7435 字节，含 plugin metadata）。
- **本版本对应**：复用项目 plugin_system（见 §3）——`app/plugins/builtins/feishu/plugin.json` manifest 声明 feishu impl → channel EP；`FeishuChannel` impl 类 connect 时注册事件回调。

---

## 3. B 路：现有机制可复用清单

接入 channel 不需要新造核心环，以下机制直接复用：

| 机制 | 位置 | 复用方式 |
|------|------|----------|
| **deliverTo 投递入口** | `app/server/src/agent/agent-manager-children.ts:107`（derivation §4.1 统一投递） | `base.deliverTo(sid,msg)` = `agentManager.deliverTo(sid,msg)` → inbox.append + activate，只需 sessionId 不碰 config |
| **agent_loop replayable pub-sub** | `app/server/src/agent/__tests__/agent-interface.test.ts:398` `manager.subscribe(sid,'current')[Symbol.asyncIterator]()` | ChannelManager 订阅 `subscribe(sid,'current')` 拿 AgentEvent 流；web SseChannel 也订阅同 session → **单源多消费天然联动**（D5 对等的直接体现） |
| **connector 双状态机（同构）** | `app/server/src/tools/browser/connector-types.ts:13-30`：`ConnectorSwitch='on'|'off'`（持久化 intent）+ `ConnectorConnection='disconnected'|'connecting'|'connected'|'error'`（运行时派生，不持久化） | channel 直接复用同构双状态：`switch`=instance.enabled / `connection`=运行时 |
| **ConnectorConfigService 持久化** | `app/server/src/config/connector-config-service.ts` + `schema_defs/connector_config.ts` | 仿造 `ChannelConfigService` → `FsCrudStore {dataDir}/channel_config/<id>.json`（list 形态，多 instance） |
| **SseChannel ≠ IM channel（辨析）** | `app/server/src/sse/sse-channel.ts` + `http-server.ts` | web 推送桥（server→browser SSE），方向=server→web；IM channel 方向=IM↔agent。命名用 `FeishuChannel` 避免混淆 |
| **plugin_system EP 机制** | `specs/tech/plugin_system/`（OKF KB：`[P0]extension_point_interface.md` / `[P0]ext_impl_and_manifest_interface.md` / `[P0]plugin_manager_interface.md` / `[P1]groups_meta_decl.md`） | channel 复用全套：EP 定义（`extension-point.ts`，cardinality=list）/ ExtImpl / Registry / PluginManager / groups.json 登记 / configSchema 单一源 / 两级 enabled（plugin.enabled ∧ impl.enabled + instance.enabled） |
| **provider EP 同构** | `app/server/src/plugin/extension-point.ts:40-43` `llm_provider`（cardinality='list'） | channel EP 与 provider EP 完全同构：provider 多 LLM 厂商 / channel 多 IM 平台，新增渠道=加 impl 不动核心 |
| **session list / squad leader** | `sessionStore.listSessions`（store 需加 role 过滤参数，见 design.md §8） | `listPlaygroundSessions` / `listStudioLeaders` 复用 store list + biz/role 过滤 |
| **plugin-manager getExtensionImpls** | `app/server/src/plugin/plugin-manager.ts:63-131`（`getExtensionImpls(point)` 按 cardinality 解析 + 实例化） | 配置页「类型列表」从 `getExtensionImpls('channel')` 来（当前只飞书 1 项） |

**需新建**：`ChannelManager`（消费 EP + instance/binding/连接管家 + outbound accumulator）/ `ChannelBase`（EP 契约）/ `ChannelConfigService`（独立域 `channel_config`）/ `ChannelBindingStore` / 飞书 protocol adapter / 配置页（nav-rail skill↔connector 间）。

---

## 4. 关键决策依据（D1-D7 + ext point 架构）

每条决策都引用调研事实说明「为什么这么定」：

| # | 决策 | 定论 | 调研依据 |
|---|------|------|----------|
| **D7** | **架构形态** | channel = EP（和 provider 同构）；飞书 = channel EP 的 ExtImpl | B 路：`extension-point.ts:40-43` provider 是 cardinality='list' 的 EP；`plugin-manager.ts:63-131` 已有 EP 解析+实例化机制。用户原话「和 provider 一样是可扩展的」。新增微信/钉钉=加 impl 不动核心 |
| **D1** | /listp /lists 全给 | 无过滤无映射（信任模型先简化） | 调研未发现 openclaw 做飞书用户↔系统用户映射（它用 conversationId scope 自动路由，D2 已砍）。简化优先 |
| **D2** | binding 只显式 /bindp /binds | conversationId=chatId/openId，无 scope 编码 | A 路：`conversation-id.ts:18-44` scope 编码是 openclaw 的复杂自动路由（group_sender/group_topic/...）。砍掉简化，用户显式绑定 |
| **D3** | outbound 累积在 ChannelManager | channel.onOutBoundMessage 收完整 assistant Message，工具过程不发 | A 路：`reply-dispatcher.ts` 流式卡片 + 分段 deliver（final/block/partial）复杂度高（900+ 行）。本版本先累积到 `run_end` 发完整，流式卡片留未来增强 |
| **D4** | 只 WS，凭证仅 appId/appSecret | 去 webhook 整条 | A 路：`client.ts:205-227` WSClient 无需公网入口本地可测；`client.ts:162-164` appId+appSecret 硬校验 required；`secret-contract.ts:102-140` encryptKey/verificationToken 是 webhook 专用。用户原话「飞书 only ws 也可以只要 work」 |
| **D5** | channel=client 对等，sender=user | 不扩 session 枚举 | B 路：agent_loop replayable pub-sub（`subscribe(sid,'current')`）支持多订阅者 → web + channel 共享单源天然联动。channel 就是又一条 inbound 路径 + 又一个 outbound 订阅者，agent loop 本体零改 |
| **D6** | binding 双向唯一 | 一个 session 只被一个 (instance,conv) 绑定，违反报错；无 fan-out | 简化 outbound（channel 收到完整 msg 直接发对应 conversation，无需 fan-out 判断）。用户指定 |
| **测试** | mock SDK 边界 + feishu.env 真飞书冒烟 | UT 测 ChannelManager/base/binding/累积 mock 飞书 SDK；真飞书冒烟靠 feishu.env | 调研发现 SDK 边界清晰（createFeishuWSClient/createEventDispatcher 可注入），适合 mock 边界测框架逻辑 |

---

## 5. 风险

### 5.1 Bun + 飞书 SDK 兼容（类 bun-playwright hang bug）

- **风险**：`@larksuiteoapi/node-sdk` 未在 Bun 下广泛验证。memory `bun-playwright-connectovercdp-bug` 记录 Bun 下 `playwright.connectOverCDP` 永久 hang（已知 bug #9357），Node 正常。飞书 SDK 的 WSClient（长连接 + 心跳）有类似 hang 风险。
- **缓解**：**编码期冒烟**（connect/start/收一条事件/disconnect）优先验证；若 hang 走 node 子进程方案（browser 类工具已有先例）。
- **证据**：SDK WSClient 创建见 `refs/openclaw/extensions/feishu/src/client.ts:205-227`；openclaw 用纯 Node 22.19+/24（`refs/openclaw/CLAUDE.md` Commands），未在 Bun 验证。

### 5.2 测试策略

- **UT（mock SDK 边界）**：测 ChannelManager（bootstrap/subscribeOutbound/累积到 run_end）/ ChannelBase（bind/unbind/getBindedSession）/ ChannelBindingStore（双向唯一校验）/ 斜杠指令拦截 —— 全部 mock 飞书 SDK（`createFeishuWSClient`/`createEventDispatcher`/`im.message.create`）。
- **真飞书冒烟**：`feishu.env`（appId/appSecret）手动验证 connect→/bindp→发消息→收回复→/unbind 全链路；不进 run_all（需真凭证+外部 IM）。
- **配置页 ET**：dom_asserts 主判定（nav-rail 顺序/类型列表/secret-input mask/switch 状态），纯功能可测不依赖真飞书。

### 5.3 其他边界

- **自回环过滤**（A 路 `monitor.message-handler.ts:328-334`）：bot 自己发的消息不能 consume claim/debounce slot —— 本版本 outbound 走 ChannelManager 独立通道，inbound 过滤 sender=open_id==bot_open_id。
- **消息去重 TTL**（A 路 `processing-claims.ts:3`）：5 分钟 + 2000 条上限双重淘汰 —— 本版本按需取（飞书 at-least-once 重发）。
- **typing hack**：飞书无原生 typing API，openclaw 用 reaction emoji（`reply-dispatcher.ts:216-221` addTypingIndicator，2 分钟超时 `reply-dispatcher.ts:56`）。本版本 `onUpdateInputState` 接口保留，实现用 reaction hack 或先 no-op。

---

## 6. 调研完整性自检

| 调研项 | 证据来源 | 状态 |
|--------|----------|------|
| 连接（WS/webhook/心跳/回调） | `client.ts:25-28,196-199,205-227,232-237` | ✅ |
| 事件（receive_v1/解析/自回环） | `monitor.account.ts:291-307` + `monitor.message-handler.ts:58-86,320-356` | ✅ |
| 入站三件套（去重/去抖/顺序队列） | `processing-claims.ts:1-60` + `monitor.message-handler.ts:180-318` | ✅ |
| conversationId 编码 | `conversation-id.ts:18-44` | ✅ |
| reply 分段 deliver | `reply-dispatcher.ts:252-258,370-413,644-803` | ✅ |
| 重连指数退避 | `monitor.transport.ts:35-36,117-122,269-289` | ✅ |
| 凭证 required | `client.ts:162-164,211-213` + `secret-contract.ts:13-80` | ✅ |
| 命令拦截 | `monitor.message-handler.ts:258-264`（isControlCommandMessage） | ✅ |
| 插件注册两层 | `channel-entry.ts:4-21` + `monitor.account.ts:291-307` + `openclaw.plugin.json` | ✅ |
| B 路 deliverTo/subscribe/EP/connector | `agent-manager-children.ts:107` + `extension-point.ts:40-43` + `connector-types.ts:13-30` + `plugin-manager.ts:63-131` | ✅ |

所有调研结论均有 `refs/` 或 `app/` 文件:行号证据，未超出 v0.0.103 channel feature 范围。

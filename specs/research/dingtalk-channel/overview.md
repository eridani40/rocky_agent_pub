---
type: research
title: 钉钉渠道接入调研 — 飞书现状总结 + 钉钉能力盘点
feature: dingtalk-channel
status: complete
updated: 2026-08-11
author: researcher
related:
  - "implementation.md"
  - "recommendations.md"
  - "../../tech/channel/[P0]channel_impl_interface.md"
  - "../../tech/channel/[P0]channel_extension_point.md"
---

# 钉钉渠道接入调研 — 总览

## 1. 飞书渠道现状总结（对照基线）

### 1.1 架构定位

飞书渠道 = channel EP（扩展点 `id='channel'`, `cardinality='list'`）的一个 **ExtImpl**（无状态协议行为类）。channel 不是硬编码 if/else，而是与 `llm_provider` / `web_search_provider` 同构的可扩展机制。

| 概念 | 作用 | 代码位置 |
|---|---|---|
| **Channel EP** | id='channel' / cardinality='list' 契约 | `app/server/src/plugin/extension-point.ts` |
| **Channel interface** | 无状态协议行为：`readonly type` + `connect(config, backend) → ChannelHandle` | `app/server/src/channel/types.ts` |
| **ChannelHandle** | per-config 连接句柄：`disconnect/handleInbound/sendOutbound/updateInputState` | 同上 |
| **ChannelHandleBase** | abstract base 提供 deliverTo/bind/unbind/listSessions 等通用方法 | `app/server/src/channel/channel-base.ts` |
| **ChannelManager** | 组合器 + 消费方：ensureImpls scope 门 → 按 config connect → binding/outbound 管家 | `app/server/src/channel/channel-manager.ts` |
| **FeishuChannel** | 无状态 ExtImpl（本期唯一 impl） | `app/plugins/builtins/feishu/feishu-channel.ts` |

### 1.2 飞书消息流（端到端）

```
入站（IM → Agent）:
  飞书用户发消息 → 钉钉 SDK WSClient 长连接
    → FeishuClient.connect() 注册 im.message.receive_v1 回调
    → FeishuConnection.handleInbound(raw)
      → parseFeishuMessage(raw): 解析 message_id/chat_id/chat_type/content/mentions
      → 去重（message_id 幂等 Set≤5000）
      → 斜杠指令(/listp 等) → 立即派发
      → 普通消息 → 去抖 600ms 合并连发 → 顺序队列
      → base.deliverTo(sessionId, Message)
      → agentManager.deliverTo → agent loop

出站（Agent → IM）:
  agent loop emit text_block
    → ChannelManager subscribe agent_loop bus → 消费 loop 分发 block
    → per-session SendQueue（保序 + 有界 100 + 重试 3 次）
    → FeishuConnection.sendOutbound(Message)
      → findConversationBySession 反查 conversationId
      → formatFeishuOutbound: content blocks → 飞书 {text:"..."} JSON
      → FeishuClient.sendMessage → httpClient.im.message.create（30s 超时）
```

### 1.3 飞书凭证与鉴权

| 项 | 飞书 |
|---|---|
| 应用类型 | 企业自建应用（SelfBuild） |
| 凭证字段 | `appId` (AppKey/cli_xxx) + `appSecret`（secret format） |
| 鉴权方式 | SDK 内部用 appId/appSecret 获取 tenant_access_token，自动缓存 |
| 消息接收 | WSClient WebSocket 长连接（非 webhook，不需要公网回调地址） |
| 事件订阅 | `im.message.receive_v1`（SDK EventDispatcher register） |
| 消息发送 | `httpClient.im.message.create({receive_id, msg_type, content})` |
| 消息格式 | text 消息 = JSON 字符串 `{"text":"..."}`；receive_id_type: `chat_id`(群)/`open_id`(私聊) |

### 1.4 飞书关键模块清单

| 文件 | 职责 | 行数 |
|---|---|---|
| `feishu-channel.ts` | 无状态 ExtImpl：connect(config) → FeishuConnection | ~49 |
| `feishu-connection.ts` | per-config 句柄：handleInbound 三件套(去重/去抖/顺序) + sendOutbound | ~312 |
| `feishu-client.ts` | SDK 封装：WSClient 连接 + httpClient.im.message.create 发送 | ~200 |
| `feishu-protocol.ts` | 协议适配：parseFeishuMessage 入站解析 + formatFeishuOutbound 出站格式化 | ~244 |
| `feishu-slash.ts` | 斜杠指令：/listp /bindp /lists /binds /unbind /status | ~213 |
| `feishu-helpers.ts` | readCredentials + withTimeout + defaultMessageIdGenerator | ~54 |
| `__tests__/` | UT 6 套（protocol/channel/client-timeout/slash/outbound-warn） | — |

### 1.5 飞书设计模式（钉钉可复用的不变量）

1. **channel = EP**：新 IM 平台 = 加 `app/plugins/builtins/<im>/plugin.json` + impl 类，不动核心
2. **无状态 impl + per-config 句柄**：connect(config, backend) 动态组合，同 impl 多 config 并行
3. **agent loop 零改**：channel 只是 deliverTo 入口 + subscribe 订阅者
4. **outbound 累积在 ChannelManager**：impl 只收拼好的 block 级文本
5. **binding 双向唯一**：(configId, conversationId) ↔ sessionId
6. **入站三件套**：去重 message_id + 去抖 600ms + 顺序队列 per conversationId
7. **发送 30s 超时**：防 SDK axios 默认无超时永久冻结
8. **configSchema 单一源**：`{appId, appSecret}` 驱动配置页表单

---

## 2. 钉钉开放平台能力盘点

### 2.1 应用类型

钉钉开放平台支持三种应用类型接入机器人能力：

| 类型 | 说明 | 适用 |
|---|---|---|
| **企业内部应用（H5/小程序）** | 企业自建，添加「机器人」能力 | ✅ **最佳选择**（与飞书自建应用对等） |
| **第三方企业应用（ISV）** | 服务商开发，上架应用市场 | 不适用（我们是自用） |
| **群自定义机器人** | 群里「智能群助手」加自定义机器人 | ❌ 功能受限（仅 webhook 发送，无法接收消息做双向通道） |

**推荐**：企业内部应用 + 机器人能力（Stream 模式），与飞书自建应用架构对等。

### 2.2 机器人消息接收模式（入站）

钉钉提供**两种**消息接收模式（企业内部应用机器人）：

| 模式 | 机制 | 需要公网地址 | 对比飞书 |
|---|---|---|---|
| **Stream 模式** | WebSocket 长连接，钉钉推送 | ❌ 不需要 | ✅ 与飞书 WSClient **完全对等** |
| **HTTP 模式** | 钉钉 POST 到开发者回调地址 | ✅ 需要公网回调 URL | 飞书无此模式（SDK 默认 WS） |

**结论**：选 **Stream 模式**（WebSocket 反向连接），原因：
1. 与飞书 WSClient 架构完全对等，无需改 ChannelManager 连接模型
2. 不需要公网回调地址（桌面端应用无固定公网 IP）
3. 不需要加解密密钥配置（Stream 模式免加解密）
4. 官方提供 Node.js SDK：[`dingtalk-stream`](https://www.npmjs.com/package/dingtalk-stream)

### 2.3 Stream 模式协议详解

来源：[Stream模式协议接入说明](https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description)

**连接流程**（3 步）：
1. **注册连接凭证**：POST 注册 → 用 `clientId`(=AppKey) + `clientSecret`(=AppSecret) 换取 `endpoint`（WS 地址）+ `ticket`（身份票据，90s 有效）
2. **建立 WebSocket 连接**：用 endpoint + ticket 建 WS 连接
3. **接收推送数据**：WS 连接后接收钉钉推送，需正确响应 ACK

**推送数据类型**：
| type | 说明 | topic |
|---|---|---|
| `SYSTEM` | 系统管理（探活 ping / 断连 disconnect） | `ping` / `disconnect` |
| `EVENT` | 事件订阅推送 | `*` |
| `CALLBACK` | 回调推送（**机器人消息**在此） | `/v1.0/im/bot/messages/get` |

**探活机制**：钉钉定期推送 `ping`，客户端必须完整回传 `opaque` 值 + 相同 `messageId`。
**断连机制**：钉钉推送 `disconnect` 后 10s 主动断 TCP，客户端需重新注册建连。

### 2.4 钉钉凭证与鉴权

| 项 | 钉钉 |
|---|---|
| 应用类型 | 企业内部应用 |
| 凭证字段 | `clientId`(=AppKey) + `clientSecret`(=AppSecret) |
| 鉴权方式 | clientId/clientSecret 注册 Stream 凭证 → WS ticket；OpenAPI 发消息用 AccessToken |
| AccessToken 获取 | `POST /v1.0/oauth2/accessToken`（body: appKey + appSecret）→ 2h 有效，需缓存刷新 |
| 消息接收 | Stream 模式 WebSocket（ticket 90s 有效，断连需重注册） |

**与飞书差异**：飞书 SDK 内部全包鉴权（WSClient + httpClient 统一用 appId/appSecret）；钉钉的 Stream SDK 和 OpenAPI 发消息是**两套鉴权链**——Stream 用 clientId/clientSecret 换 ticket，发消息用 AccessToken（需要单独获取+缓存）。

### 2.5 钉钉机器人消息格式

#### 入站消息（机器人回调 `/v1.0/im/bot/messages/get`）

钉钉 Stream 回调的机器人消息 JSON 结构（字段名与飞书不同）：

| 字段 | 说明 | 飞书对应 |
|---|---|---|
| `conversationId` | 会话 ID（加密） | `chat_id` |
| `senderId` | 发送者 ID（加密 staffId） | `sender.sender_id.open_id` |
| `senderNick` | 发送者昵称 | mentions[].name |
| `msgId` | 消息 ID（幂等去重用） | `message_id` |
| `text.content` | 文本内容（含 @robot 前缀） | `content {"text":"..."}` |
| `msgtype` | 消息类型（text/markdown 等） | `message_type` |
| `conversationType` | `1`=单聊 / `2`=群聊 | `chat_type`(p2p/group) |
| `sessionWebhook` | **临时 webhook**（可直接回复） | 无（飞书用 im.message.create） |
| `sessionWebhookExpiredTime` | sessionWebhook 过期时间戳 | — |
| `isAdmin` / `isInAtList` | 权限标记 | — |

**关键差异**：钉钉入站消息携带 `sessionWebhook`（临时回执 URL），可以直接 POST 回复，无需走 AccessToken+OpenAPI。但**过期后**需走 OpenAPI 发送。

#### 出站消息（发送）

钉钉机器人发消息有**两条路径**（来源：[机器人回复/发送消息](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply)）：

| 方式 | 机制 | 消息类型 | 需 AccessToken |
|---|---|---|---|
| **SessionWebhook** | 入站消息携带的临时 URL，直接 POST | text / markdown | ❌ 不需要 |
| **OpenAPI** | `POST /robot/sendToConversation`（群消息）/ `POST /v1.0/robot/oToMessages/batchSend`（单聊批量） | text / markdown / actionCard / link | ✅ 需要 |

**飞书对比**：飞书只有一条路径（`im.message.create`），钉钉有两条（临时 webhook + OpenAPI），且 **Stream 通道不能发消息**（只能接收）。

### 2.6 官方 Node.js SDK

| SDK | 包名 | 用途 | Bun 兼容性 |
|---|---|---|---|
| **dingtalk-stream** | `dingtalk-stream` (npm) | Stream 模式 WS 连接 + 事件/回调订阅 | ⚠️ 需冒烟验证（同飞书 SDK 风险） |
| **dingtalk OpenAPI** | 无官方独立 SDK（HTTP REST 直调） | AccessToken 获取 + 消息发送 | ✅ 纯 HTTP 无风险 |

> [钉钉 Stream SDK Node.js 源码](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)：`DWClient` 类构造 `{clientId, clientSecret}`，register callback listener 即可收消息。

### 2.7 钉钉 vs 飞书关键差异总表

| 维度 | 飞书 | 钉钉 | 影响 |
|---|---|---|---|
| **消息接收** | WSClient 长连接 | Stream 模式 WS（ticket 90s 有效） | 钉钉需处理 ticket 刷新 + 断连重注册 |
| **凭证字段** | appId + appSecret | clientId(AppKey) + clientSecret(AppSecret) | 仅命名差异，configSchema 结构相同 |
| **鉴权链** | SDK 统一（token 内部缓存） | Stream 用 ticket + 发消息用 AccessToken（双链） | 钉钉 impl 需额外维护 AccessToken 缓存 |
| **消息发送** | `im.message.create` 单一路径 | SessionWebhook(临时) + OpenAPI(持久) 双路径 | 钉钉 sendOutbound 需选路径策略 |
| **入站 conversationId** | `chat_id`(群) / `open_id`(私聊) | `conversationId`(加密串，群/单聊统一) | conversationId 逻辑不同 |
| **单聊/群聊判定** | `chat_type` 字段 | `conversationType`: 1=单聊 2=群聊 | 字段名+值域不同 |
| **@bot 剥离** | content.text 中 `@_user_N` 占位符 | text.content 中 `@robotName` 前缀 | 剥离逻辑不同 |
| **Stream 发消息** | ✅ httpClient 统一 | ❌ Stream 不能发，只能收 | 钉钉发消息必须走 HTTP |
| **消息格式** | `{"text":"..."}` JSON 字符串 | msgKey=sampleText + `{"content":"..."}` | 格式化逻辑不同 |
| **markdown 支持** | 需单独 msg_type=markdown | OpenAPI 支持 msgKey=sampleMarkdown | 钉钉 markdown 更原生 |
| **事件类型** | `im.message.receive_v1` | `/v1.0/im/bot/messages/get` CALLBACK | topic 不同 |
| **探活机制** | SDK 内部 | 显式 ping 回传 opaque | 钉钉需处理 SYSTEM 推送 |
| **断连恢复** | SDK autoReconnect | 显式 disconnect 通知 + 重注册 | 钉钉需显式重连逻辑 |

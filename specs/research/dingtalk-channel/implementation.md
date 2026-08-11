---
type: research
title: 钉钉渠道接入调研 — 接入方案（模块改动 + 新增 + 复用）
feature: dingtalk-channel
status: complete
updated: 2026-08-11
author: researcher
related:
  - "overview.md"
  - "recommendations.md"
  - "../../tech/channel/[P0]channel_impl_interface.md"
---

# 钉钉渠道接入方案

基于现有 channel EP 架构（specs/tech/channel/），接入钉钉遵循飞书同构模式。核心结论：**ChannelManager / agent loop / 配置页 / HTTP API 零改，只新增钉钉 impl 插件目录**。

## 1. 架构对齐（为什么改动极小）

channel EP 的设计前提就是「新 IM 平台 = 加 impl，不动核心」（`[P0]channel_extension_point.md §3.1`）。钉钉接入完全符合此模型：

```
app/plugins/builtins/
├── feishu/          ← 现有（飞书）
│   ├── plugin.json
│   ├── feishu-channel.ts
│   ├── feishu-connection.ts
│   ├── feishu-client.ts
│   ├── feishu-protocol.ts
│   ├── feishu-slash.ts
│   └── feishu-helpers.ts
└── dingtalk/        ← 新增（钉钉）
    ├── plugin.json
    ├── dingtalk-channel.ts
    ├── dingtalk-connection.ts
    ├── dingtalk-client.ts
    ├── dingtalk-protocol.ts
    ├── dingtalk-slash.ts
    └── dingtalk-helpers.ts
```

ChannelManager 的 `ensureImpls()` → `getExtensionImpls(ChannelPoint, 'default')` 自动发现 dingtalk impl；用户在配置页选「钉钉」类型即可新建 config。

## 2. 新增模块（钉钉 impl，7 文件）

### 2.1 plugin.json（manifest + configSchema）

```json
{
  "id": "dingtalk",
  "label": "__MSG_plugin.builtin.dingtalk.label__",
  "description": "__MSG_plugin.builtin.dingtalk.description__",
  "extImpls": [{
    "implId": "dingtalk",
    "point": "channel",
    "impl": "./dingtalk-channel.ts",
    "configSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "clientId": { "type": "string", "minLength": 1 },
        "clientSecret": { "type": "string", "minLength": 1, "format": "secret" }
      },
      "required": ["clientId", "clientSecret"]
    }
  }]
}
```

**与飞书差异**：字段名 `appId`→`clientId`、`appSecret`→`clientSecret`（钉钉术语）。结构完全一致（2 字段 + secret format），配置页 UI 组件**零改可复用**。

### 2.2 dingtalk-channel.ts（无状态 ExtImpl）

结构与飞书完全同构（~49 行）：

```typescript
export default class DingtalkChannel implements Channel {
  readonly type = 'dingtalk';
  constructor(implId?: string, _cfg?: unknown, genMessageId?: MessageIdGenerator) { ... }

  async connect(config: ChannelConfig, backend: ChannelManagerBackend): Promise<ChannelHandle> {
    const conn = new DingtalkConnection(config, backend, this.genMessageId);
    await conn.open();
    return conn;
  }
}
```

### 2.3 dingtalk-connection.ts（per-config 句柄）

**extends ChannelHandleBase，实现 4 方法**。入站三件套（去重/去抖/顺序）逻辑与飞书等价搬迁。

核心差异点（相对飞书）：

| 方法 | 飞书 | 钉钉差异 |
|---|---|---|
| `open()` | new FeishuClient + WSClient.start() | new DingtalkClient + DWClient.start()（dingtalk-stream SDK） |
| `handleInbound()` | parseFeishuMessage → 去重/去抖/顺序 | parseDingtalkMessage → 同三件套（msgId 去重，钉钉也叫 msgId） |
| `sendOutbound()` | httpClient.im.message.create | **双路径**：优先用 sessionWebhook（临时回执 URL）→ fallback OpenAPI（AccessToken） |
| `updateInputState()` | no-op | no-op（钉钉也无原生 typing） |

**sendOutbound 双路径策略**（钉钉独有）：
```
sendOutbound(msg):
  1. findConversationBySession → conversationId
  2. 若 conversationId 有缓存的 sessionWebhook 且未过期 → POST sessionWebhook（免 AccessToken）
  3. 否则 → 获取/刷新 AccessToken → POST OpenAPI（/robot/sendToConversation 或 oToMessages/batchSend）
```

入站时收到消息缓存 `{conversationId → {sessionWebhook, expiredTime}}`，供出站优先使用（减少 AccessToken 依赖 + 更快）。

### 2.4 dingtalk-client.ts（SDK 封装）

**职责**：Stream WS 连接 + AccessToken 管理 + HTTP 消息发送。这是与飞书差异最大的文件。

```
DingtalkClient:
  - dwClient: dingtalk-stream DWClient（WS 长连接 + 回调订阅）
  - accessToken: string | null（缓存 + 2h 刷新）
  - connect(): new DWClient({clientId, clientSecret}) + register bot callback → start
  - disconnect(): dwClient.stop()
  - sendMessage(viaSessionWebhook | viaOpenAPI): 两条发送路径
  - getAccessToken(): POST /v1.0/oauth2/accessToken → 缓存
```

### 2.5 dingtalk-protocol.ts（协议适配）

| 函数 | 飞书 | 钉钉 |
|---|---|---|
| 入站解析 | parseFeishuMessage | parseDingtalkMessage |
| conversationId | 群=chat_id / 私聊=open_id | 统一 `conversationId`（加密串） |
| 单聊/群聊 | chat_type: p2p/group | conversationType: 1(单聊)/2(群聊) |
| @bot 剥离 | `@_user_N` 占位符替换 | text.content 去除 `@机器人名` 前缀 |
| 出站格式 | formatFeishuOutbound → `{text:"..."}` | formatDingtalkOutbound → `msgKey=sampleText` + `{content:"..."}` |
| 消息分块 | 4000 字符切 | 同（钉钉文本上限 ~20000，保守 4000） |

### 2.6 dingtalk-slash.ts（斜杠指令）

**完全复用飞书斜杠指令集**（/listp /bindp /lists /binds /unbind /status）——因为斜杠派发依赖的是 `SlashDeps`（base helper 注入），与 IM 平台无关。唯一差异是回执发送走 dingtalk-client。

### 2.7 dingtalk-helpers.ts

readCredentials（读 config.config 的 clientId/clientSecret）+ withTimeout（复用）+ defaultMessageIdGenerator（复用 ulid）。

## 3. 需要改动的现有文件（极小改动）

### 3.1 scope 激活配置

`default.yaml`（plugin scope 配置）需加 dingtalk 到 channel point 激活列表，否则 `listActiveImpls()` 不含 dingtalk（scope 门）。

```yaml
# default.yaml channel point 激活
channel:
  - feishu
  - dingtalk    # ← 新增
```

### 3.2 i18n 文案

`app/web/src/i18n/locales/{zh-CN,en-US}/plugin-config.json` 加钉钉相关 key：
```json
{
  "plugin.builtin.dingtalk.label": "钉钉",
  "plugin.builtin.dingtalk.description": "钉钉企业自建应用机器人渠道"
}
```

### 3.3 依赖安装

`package.json` 加 `dingtalk-stream` 依赖（npm 包）。

### 3.4 冒烟脚本

参照 `scripts/feishu-smoke.ts` 新增 `scripts/dingtalk-smoke.ts`（编码期 Bun 兼容性验证）。

## 4. 零改动模块（完全复用）

| 模块 | 复用原因 |
|---|---|
| **ChannelManager** | 组合器/消费方/binding/outbound 管家——全部与 IM 平台无关 |
| **Channel EP 定义** | id='channel' cardinality='list' 已支持多 IM 并存 |
| **ChannelHandleBase** | abstract base 通用方法（deliverTo/bind/listSessions）——钉钉句柄 extends 即可 |
| **ChannelConfigService** | channel_config 域 CRUD——纯数据存储，与 IM 无关 |
| **ChannelBindingStore** | channel_bindings 域——双向唯一映射与 IM 无关 |
| **HTTP API**（17-channel.md） | GET/POST/PUT/DELETE /config/channels + impl-types——全复用 |
| **配置页 UI**（06-channel.md） | 类型下拉 + 表单 + 状态行——configSchema 驱动，自动适配 |
| **agent loop** | 零改（channel 只是 deliverTo + subscribe） |
| **SendQueue** | per-session 有序发送队列——与 IM 无关 |
| **channel-retry.ts** | 重连 3 次/5s——与 IM 无关 |

## 5. 钉钉接入特有的技术挑战

### 5.1 ticket 90s 有效 + 断连重注册（中风险）

钉钉 Stream 模式的 ticket 只有 90s 有效期，且钉钉会主动推送 `disconnect` 通知（10s 后断 TCP）。飞书 WSClient 的 autoReconnect 是 SDK 内部的，钉钉需**显式处理**：

**方案**：dingtalk-client.ts 注册 `disconnect` SYSTEM 推送回调 → 触发重注册 → 新 ticket → 重连。复用 ChannelManager 的 `reconnectWithRetry`（3 次/5s）上层框架。

**如果 `dingtalk-stream` npm 包内部已处理**（SDK DWClient 自带重连），则只需暴露 onError 让上层裁决（同飞书策略）。需编码期验证 SDK 行为。

### 5.2 双鉴权链（中风险）

飞书 SDK 内部统一鉴权；钉钉 Stream 用 ticket + 发消息用 AccessToken（独立获取缓存）。dingtalk-client.ts 需维护：
- AccessToken 缓存 + 2h 过期刷新
- SessionWebhook 优先策略（入站缓存 → 出站优先用临时 webhook，免 AccessToken）

### 5.3 dingtalk-stream SDK Bun 兼容性（需验证）

同飞书 `@larksuiteoapi/node-sdk` 的 Bun 兼容风险（specs `[P0]channel_impl_interface.md §5.6`）。

**门禁**：编码期冒烟脚本验证（import + new DWClient + connect + 收事件 + 不 hang）。若中招 → 走 node 子进程兜底（spawn node 跑独立 SDK 进程，IPC 传事件）。

### 5.4 conversationId 语义差异（低风险）

飞书的 conversationId = chat_id(群)/open_id(私聊)，有前缀 `oc_`/`ou_` 可判 chatType。钉钉 conversationId 是加密串（无前缀规律），需用 `conversationType` 字段（1=单聊/2=群聊）判定。dingtalk-protocol.ts 的 parseDingtalkMessage 直接取 conversationType 即可。

### 5.5 @bot 剥离逻辑差异（低风险）

飞书用 `@_user_N` 占位符（需找 mention.key 替换）；钉钉直接在 text.content 里是 `@机器人名 ` 文本前缀。剥离策略：找 `@` + botNick + 空格，正则去除。

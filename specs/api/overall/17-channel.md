---
type: api
title: Channel API（IM 渠道接入层 HTTP facade）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.103
related:
  - "../../tech/channel/[P0]channel_manager.md"
  - "../../tech/channel/[P0]channel_impl_interface.md"
---

# Channel API

> **范围**：渠道配置页的 HTTP facade（CRUD channel config + 列状态 + toggle 开关 + impl 类型列表）。
> **不在本 API 范围**：飞书斜杠指令（`/listp`/`/bindp`/`/lists`/`/binds`/`/unbind`/`/status`）—— 这是**飞书 inbound**（IM 事件 → `FeishuConnection.handleInbound` 派发），**不走 HTTP API**。本 API 只管配置面（建/改/删/开关 channel config）。

## 1. 端点总览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/config/channels` | 列出所有 channel config + 实时状态（switch/connection） |
| GET | `/config/channels/impl-types` | 列出 scope 激活的 channel impl 类型（v0.0.206 新增，表单类型下拉数据源） |
| POST | `/config/channels` | 新建 channel config（指定 implId + name + config） |
| PUT | `/config/channels/:id` | 修改 config（toggle enabled / 改 name/config）→ 202 异步 |
| DELETE | `/config/channels/:id` | 删除 config（disconnect + 清 binding + 清订阅） |

**约定**：
- 所有响应 `content-type: application/json`。
- 所有错误响应：`{ error: string }`，HTTP 状态码 4xx/5xx。
- secret 字段（`appSecret`）：GET 响应 redact 为占位 `'***'`；POST/PUT 时 `'***'` 表示「未改」，后端 merge 原值（仿 web-config-redact 套路）。

## 2. GET /config/channels

**用途**：列出全部 channel config + 实时状态（前端 5s 轮询）。

**响应**：`200 OK`
```json
{
  "items": [
    {
      "id": "01HX...",
      "implId": "feishu",
      "name": "公司飞书机器人",
      "enabled": true,
      "config": { "appId": "cli_xxx", "appSecret": "***" },
      "connection": "connected",
      "errorDetail": null,
      "lastConnectedAt": "2026-07-09T08:00:00.000Z",
      "bindingCount": 3,
      "createdAt": "2026-07-09T07:00:00.000Z",
      "updatedAt": "2026-07-09T08:00:00.000Z"
    }
  ]
}
```

**字段**：
- `enabled`（bool）= switch 持久化 intent（内部 ChannelState.switch 'on'|'off' 映射到 enabled bool；spec 出参用 enabled，对齐前端 UI 字段语义）。
- `connection`（'disconnected'|'connecting'|'connected'|'error'）= 运行时连接实况。
- `errorDetail`（string|null）= connection='error' 时原因（含 scope 门拒绝文案「未在 scope 'default' 激活」）；无错显式 null。
- `lastConnectedAt`（string|null）= 上次 connected 时间（isoDate，与 createdAt/updatedAt 同款）；未连过显式 null。
- `bindingCount`（number）= 该 config 当前 binding 数。
- `config.appSecret` 永远 redact 为 `'***'`（不返原值）。
- `createdAt`/`updatedAt`（string）= store 信封注入的 isoDate（list/get 透传）。

**handler 实现**（`app/server/src/handlers/channel.ts`）：`toApiResponse(state, config)` JOIN `ChannelState`（cm.getAllStates）+ `ChannelConfig`（configService.list 已 redact）；缺省字段（errorDetail/lastConnectedAt）显式补 null（非 undefined）。

## 3. GET /config/channels/impl-types（v0.0.206 新增）

**用途**：列出当前 scope（default）激活的 channel impl 类型——渠道表单「类型下拉」的数据源（原前端硬编码 `[{implId:'feishu'}]` 已删，改由后端 scope 激活集合派生）。

**响应**：`200 OK`
```json
{
  "items": [
    { "implId": "feishu", "label": "__MSG_plugin.builtin.feishu.label__" }
  ]
}
```

**字段**：
- `implId`（string）= impl 类型标识（= `Channel.type`）。
- `label`（string）= manifest `label` **原始 `__MSG_` 占位符**（后端不解析 i18n；前端渲染期 `resolveI18nField(label, t)` 用 plugin-config ns 解析；反查失败兜底 implId 本身）。

**派生规则**：`channelManager.listActiveImpls()`（= `getExtensionImpls(ChannelPoint, 'default')` 的 scope 激活集合，scope 解析单源 = PluginManager 经 manager 物化）。**default.yaml 未配置 channel impl → items 为空数组**（200 非错误；前端空态禁用类型下拉 + 提交）。
**路由约束**：字面分支 `/config/channels/impl-types` 必须位于 `/config/channels/:id` 正则**之前**（否则 'impl-types' 被 :id 吞）；非 GET → 405。

## 4. POST /config/channels

**用途**：新建 channel config（建完即连：enabled 默认 true → 立即 connect）。

**请求体**：
```json
{
  "implId": "feishu",
  "name": "公司飞书机器人",
  "config": { "appId": "cli_xxx", "appSecret": "real_secret_here" },
  "enabled": true
}
```

**字段约束**：
- `implId`（string, required）：双段校验（`lookupChannelImpl`）——①**已注册** = Registry `getByPoint('channel')` 登记（管理面）；②**已激活** = `channelManager.listActiveImpls()` 含此 implId（scope 解析单源 = PluginManager 经 manager 物化，**不用 registry 判激活**）。任一段失败 → 400（文案区分，见响应）。
- `name`（string, required, 非空）：用户起的名。
- `config`（object, required）：必须满足该 impl 的 `configSchema`（feishu: `{appId:string, appSecret:string}`），缺字段/类型错 → 400。
- `enabled`（bool, optional, 默认 true）：建完即连。

**响应**：
- `201 Created` + 返回新建的 `ChannelState`（含 id、connection='connecting'）。
- `400 Bad Request`（双段文案区分，v0.0.206 起）：
  - 未注册：`{error: "implId 'xxx' not registered as channel EP"}`
  - 已注册未激活：`{error: "implId 'xxx' is registered but not activated in scope 'default'（default.yaml 未配置 channel impl）"}`
  - config schema 校验失败。
- **副作用**：fire-and-forget `impl.connect(config, backend)`，前端轮询 GET 看 connection 迁移到 connected/error。

## 5. PUT /config/channels/:id

**用途**：修改 config（toggle enabled / 改 name / 改 config）。**异步语义**：返 202 后 ChannelManager 在后台迁移状态机，前端轮询 GET 看终态。

**请求体**（任选字段 patch）：
```json
{
  "enabled": false,
  "name": "新名字（可选）",
  "config": { "appId": "cli_yyy", "appSecret": "***" }
}
```

**字段语义**：
- `enabled`（bool）：on → connect（connecting → connected/error）；off → disconnect。
- `name`（string）：改名。
- `config`（object）：改凭证。**`appSecret: "***"` 表示「未改」**（merge 原值）；其他值表示新 secret（覆盖）。

**响应**：
- `202 Accepted` + `{ok: true}`（fire-and-forget，状态机后台迁移）。
- `400 Bad Request`：`:id` 不存在 / config schema 校验失败。
- `405 Method Not Allowed`（非 PUT）。

**与 connector PUT 的对比**：connector 只支持 `{enable: boolean}`（无 name/config）；channel 因多份 config + 凭证可改，支持完整 patch。

## 6. DELETE /config/channels/:id

**用途**：删除 config（disconnect + 清全部该 config 的 binding + 清订阅）。

**响应**：
- `200 OK` + `{ok: true}`（删除完成，含 disconnect + 清 binding）。
- `404 Not Found`：`:id` 不存在。

**副作用**（ChannelManager.unregisterConfig）：
1. `handle?.disconnect()`（idempotent，未连接也安全；scope 门拒绝无 handle 时不崩）。
2. `ChannelBindingStore.deleteByInstance(id)` → 清该 config 所有 binding。
3. 对每个被清的 sessionId → `unsubscribeOutbound(sessionId, handle)`（防泄漏）。
4. `ChannelConfigService.delete(id)` → 落盘删 `channel_config/<id>.json`。

## 7. 错误码汇总

| 状态 | 场景 |
|---|---|
| 400 | `implId` 未注册 / 已注册未激活（双段文案，§4）/ `config` schema 校验失败 / 请求体非法 JSON |
| 404 | `:id` 不存在（PUT/DELETE） |
| 405 | 非 GET/POST/PUT/DELETE |
| 500 | ChannelManager 未注入 / 内部异常（带 `error` 字段） |

## 8. 不走本 API 的链路

### 8.1 飞书 inbound 事件（不走 HTTP）

飞书用户消息、斜杠指令（`/listp`/`/bindp`/`/lists`/`/binds`/`/unbind`/`/status`）全部经 `FeishuConnection.handleInbound` 处理：
- 普通消息 → `base.deliverTo(sid, msg)` → `agentManager.deliverTo` → agent loop。
- 斜杠指令 → 派发到 base helper（listPlaygroundSessions/listStudioLeaders/bind/unbind）→ 回飞书文本。

**不走 HTTP API**（没有 `/channel/inbound` 之类的端点）—— 飞书经 WSClient 长连接收事件，不经 HTTP 入口。

### 8.2 agent → channel outbound（不走 HTTP）

ChannelManager subscribe agent_loop bus → 累积分发 block → per-session SendQueue → `handle.sendOutbound(msg)` → 飞书 `im.message.create` 发 IM。**不经 HTTP**（agent loop pub-sub bus 直订阅）。

## 9. 与现有 API 的关系

- **`03-config-center.md §3.x`（连接器）**：channel API 是连接器 API 的扩展版（多份 config + 凭证字段），路径风格 `/config/channels` 对齐 `/config/connectors`。
- **`04-agent-session.md`（session）**：channel 不创建专属 session，复用现有 `POST /session` 创建的 session（通过 `/bindp` 绑定）。
- **`16-cron.md`**：channel 与 cron 都是「外部触发 agent run 的接入层」，但 channel 是双向（inbound+outbound），cron 是单向（inbound only）。

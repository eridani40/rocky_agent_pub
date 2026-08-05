# IM 核心架构调研 — 从读写扩散到最简模型

## 1. 核心问题

IM 单聊/群聊的本质架构是什么？剥离已读回执、办公功能、文档协作后，核心链路如何设计？

## 2. 连接层

```
Client ←── 长连接（SSE / WebSocket / 私有 TCP）──→ Gateway / Access Server
```

- 每个在线用户维持一条长连接到接入层
- Gateway 无状态：协议转换 + 鉴权 + 连接管理
- 用户 → Gateway 映射注册到路由表（Redis），key = userId，value = gatewayId

## 3. 消息存储模型

```
Message 表（全局唯一，按 msgId）
  msgId | conversationId | senderId | content | seqId | timestamp

Conversation Timeline（每会话一条链）
  convId | seqId | msgId

Cursor 表（每人每会话一个已读位点）
  userId | convId | lastReadSeqId
```

关键设计：
- **seqId**：conversation 内单调递增，排序 + 增量同步 + 已读位点的核心锚点
- **msgId**：全局唯一（雪花 ID），去重和定位
- 消息内容只存一份，Timeline 只存引用

## 4. 写扩散 vs 读扩散

### 4.1 定义

| 模型 | 写入 | 读取 | 存储 |
|------|------|------|------|
| 写扩散 | 消息写入每个成员的 Inbox（N 份） | 每人只读自己的箱 | O(N×M) |
| 读扩散 | 消息只写群 Timeline（1 份） | 每人读 Timeline + 自己的 cursor | O(M) |

### 4.2 本质

- 写扩散 = **写时物化**（write-time materialization）：服务端预生成 per-user 视图
- 读扩散 = **读时计算**（read-time resolution）：共享源 + per-user cursor，读时截取

类比：写扩散 ≈ 物化视图/反范式；读扩散 ≈ 范式存储 + 查询时 join。

### 4.3 具体例子（A B 单聊，发 a b a b a a b）

**写扩散**：B 发 m7 时 → 写 Message 表 + 写 A 的 Inbox + 写 B 的 Inbox（2 次额外写）
**读扩散**：B 发 m7 时 → 写 Timeline 1 行（就这一次）

500 人群发 1000 条消息：
- 写扩散 Inbox：500 × 1000 = 50 万行
- 读扩散 Timeline：1000 行
- Cursor 表（两种模型都要）：500 行（固定，O(成员数)）

### 4.4 写扩散的唯一逻辑正当性 = per-user view divergence

写扩散有意义的场景（每人的副本**不再相同**）：
1. "仅删除自己这边的消息" → A 的 Inbox 删了 m3，B 的还在
2. 中途加群不可见历史 → C 的 Inbox 从 joinSeq 开始
3. 撤回差异化 → 不同人看到不同撤回状态
4. 读热点分散（工程优化，非逻辑必要）

### 4.5 关键结论

> **如果产品上不允许视图分叉（不支持仅自己删除、加群可见全部历史、撤回全局生效），写扩散在逻辑上完全无意义。** 存 N 份 identical 副本 = 纯冗余。选它唯一原因是代码路径统一（单聊当 2 人群处理），是工程偷懒，不是架构 necessity。

## 5. Cursor vs 本地同步位点（两个正交问题）

| | Cursor（lastReadSeqId） | 本地同步位点（localMaxSeqId） |
|--|------------------------|-------------------------------|
| 回答什么 | 我**读到**哪了 | 我**拉到**哪了 |
| 用途 | 算红点：`timeline.maxSeq - cursor = unread` | 算增量：`GET /sync?afterSeq=localMaxSeqId` |
| 存在哪 | 服务端（跨设备共享） | 每台设备本地 |
| 变化时机 | 用户看了消息 → 上报 | 客户端拉到了消息 → 更新本地 |

两者独立：手机全拉了全看了（localMax=7, cursor=7）；电脑只拉到 3 但手机上全看了（localMax=3, cursor=7）。

## 6. 最简 IM 架构（本次调研核心结论）

### 6.1 前提约束

- 多人统一 view（无 per-user 内容分叉）
- 不支持"仅删除自己这边"
- 加群可见全部历史
- 撤回全局生效
- 端不持久化数据（无本地 DB）

### 6.2 架构

```
服务端：
  - 1 份 timeline / conversation（消息唯一存储）
  - 1 个 cursor / user / conv（已读位点，算红点）
  - SSE 推在线用户（实时性）

客户端（无状态渲染层）：
  - 打开会话 → GET /messages?convId=X&limit=50 → 渲染
  - 上翻 → GET /messages?convId=X&beforeSeq=Y → 追加
  - 收到 SSE 推送 → 追加到当前渲染
  - 关掉 → 丢，不存
```

### 6.3 API 设计

```
POST   /conv/:id/messages              ← 发消息
GET    /conv/:id/messages?before=&limit= ← 拉历史（分页）
POST   /conv/:id/cursor                ← 更新已读位点
GET    /events                         ← SSE 长连接，收实时推送
GET    /conversations                  ← 会话列表（或 SSE 推送增量更新）
```

### 6.4 传输层选择：HTTP API + SSE（优于 WebSocket）

| | SSE | WebSocket |
|--|-----|-----------|
| 方向 | 单向（server→client），上行走 HTTP | 双向 |
| 重连 | EventSource 内置自动重连 | 自己写 |
| 基础设施 | 普通 HTTP，LB/CDN/代理零配置 | 需 upgrade 支持 |
| 服务端复杂度 | 不关闭的 HTTP response | 连接管理 + 心跳 + 状态机 |
| 调试 | curl 可看 | 需专门工具 |

IM 消息是 JSON 文本（不需二进制），上行频率极低（发消息 + 更新 cursor），HTTP POST 足够。

### 6.5 HTTP/2 注意

- SSE 在 HTTP/1.1 下浏览器同域限 6 连接（多 tab 占满）
- HTTP/2 多路复用解决此问题
- 协商机制：TLS 握手时 ALPN，浏览器带 ["h2", "http/1.1"]，服务器选
- 前提：必须 HTTPS（浏览器只在 TLS 上跑 h2）
- 服务端配置：nginx `listen 443 ssl http2;` 即可，应用层无感

### 6.6 代价与收益

**代价**：依赖网络、打开有 loading（100-300ms）、不能离线看
**收益**：端零复杂度（无本地 DB、无 sync 逻辑、无冲突处理），服务端逻辑极简（写 1 行 + 广播），开发维护成本低一个量级

**适用场景**：内部工具、Web 端、永远在线的场景

## 7. 消息流转全链路（最简模型）

```
发送端
  │ POST /conv/:id/messages {content}
  ▼
服务端
  │ 1. 分配 seqId（conversation 维度，Redis INCR）
  │ 2. 写 Timeline（1 行）
  │ 3. 查在线成员 → SSE 推送
  ▼
接收端（在线）
  │ SSE 收到 → 追加渲染
  │ POST /conv/:id/cursor {seqId} → 更新已读
  ▼
接收端（离线）
  │ 下次打开 → GET /conv/:id/messages → 拉全量/增量
  │ 红点 = timeline.maxSeq - cursor（登录时算）
```

## 8. 与钉钉/飞书的对比

| 维度 | 钉钉/飞书 | 最简模型 |
|------|-----------|----------|
| 扩散模型 | 小群写扩散 + 大群读扩散 | 纯读扩散 |
| 端存储 | 本地 DB 全量缓存（离线可看） | 无持久化 |
| 传输层 | 私有二进制协议 / WebSocket | HTTP + SSE |
| per-user 视图 | 支持（仅删除、joinSeq） | 不支持（统一 view） |
| 复杂度 | 高（sync 引擎 + 冲突 + 离线队列） | 极低 |
| 适用 | 消费级 IM（离线、秒开、多端） | 内部工具 / Web 端 / 永远在线 |

## 9. 一句话总结

> IM 核心 = conversation 维度 seqId 排序 + 读扩散（1 份 timeline + per-user cursor）+ SSE 实时推送 + HTTP 拉历史。在「统一 view + 端无状态」约束下，写扩散无逻辑意义，整个系统简化为：服务端写 1 行 + 广播，客户端拉 + 渲染 + 丢掉。

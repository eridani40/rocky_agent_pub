---
type: research
title: 钉钉渠道接入调研 — 竞品对比 + 建议 + 工作量风险
feature: dingtalk-channel
status: complete
updated: 2026-08-11
author: researcher
related:
  - "overview.md"
  - "implementation.md"
---

# 钉钉接入：对比建议 + 工作量风险

## 1. 钉钉 vs 飞书：接入复杂度对比

| 维度 | 飞书（已实现） | 钉钉（待接入） | 难度评级 |
|---|---|---|---|
| 消息接收模式 | WSClient 长连接 | Stream WS（ticket 90s + 断连重注册） | ⭐⭐ 中 |
| 鉴权 | SDK 统一 | 双链（ticket + AccessToken） | ⭐⭐ 中 |
| 消息发送 | im.message.create 单路径 | SessionWebhook + OpenAPI 双路径 | ⭐⭐ 中 |
| 消息格式 | `{"text":"..."}` | msgKey + `{content}` | ⭐ 低 |
| @bot 剥离 | `@_user_N` 占位符 | `@机器人名` 文本前缀 | ⭐ 低 |
| conversationId | chat_id/open_id（有前缀判类型） | 加密串（用 conversationType 判类型） | ⭐ 低 |
| SDK Bun 兼容 | 已验证通过 | 需冒烟验证 | ⭐⭐⭐ 高风险 |
| 斜杠指令 | 6 条（/listp 等） | 完全复用 | ⭐ 零 |
| ChannelManager/agent loop | — | 完全复用 | ⭐ 零 |

**总结**：架构层零改（EP 设计的价值），差异全在 impl 内部（7 文件），且大部分差异是字段名/值域映射（低难度），真正需注意的是 **SDK Bun 兼容性** 和 **ticket/AccessToken 生命周期管理**。

## 2. 实现建议

### 2.1 推荐 Stream 模式（不用 HTTP 回调模式）

| 方案 | 优势 | 劣势 |
|---|---|---|
| ✅ **Stream 模式** | 无需公网回调地址；与飞书 WSClient 架构对等；免加解密 | ticket 90s + 断连重注册；SDK Bun 需验证 |
| ❌ HTTP 模式 | 无 ticket 问题 | 需公网回调地址（桌面端无固定 IP）；需加解密密钥；需 HTTP server 监听 |

桌面应用没有固定公网 IP，HTTP 回调模式不适合。Stream 模式是唯一可行方案。

### 2.2 推荐 SessionWebhook 优先 + OpenAPI 兜底

出站消息发送策略（dingtalk-connection.ts sendOutbound）：

```
优先级：
  1. sessionWebhook（入站缓存，未过期）→ 免 AccessToken，延迟低
  2. OpenAPI（AccessToken + /robot/sendToConversation）→ 持久可靠，sessionWebhook 过期后用
```

**理由**：sessionWebhook 是入站消息自带的临时回执 URL（钉钉特有），有效期通常 30min+，正常对话场景下可覆盖绝大部分出站消息，减少 AccessToken 获取频次。

### 2.3 推荐分阶段实现

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0：冒烟验证** | 安装 dingtalk-stream + 编码期冒烟脚本（真凭证） | 确认 Bun 兼容性 → 决定是否需 node 子进程兜底 |
| **P1：核心 impl** | dingtalk-channel + connection + client + protocol（入站接收 + 出站发送） | 基础双向消息跑通 |
| **P2：三件套+斜杠** | 去重/去抖/顺序队列 + 斜杠指令复用 + sessionWebhook 缓存 | 生产健壮性 |
| **P3：配置+文档** | plugin.json + configSchema + i18n + default.yaml + 冒烟脚本 | 用户可配置可使用 |

## 3. 凭证与配置

### 3.1 用户侧配置步骤

1. 登录[钉钉开发者后台](https://open.dingtalk.com) → 创建企业内部应用
2. 应用能力 → 添加「机器人」能力 → 消息接收模式选 **Stream 模式** → 发布
3. 获取 `Client ID`(AppKey) + `Client Secret`(AppSecret)
4. 在 Rocky 渠道配置页新建「钉钉」类型渠道 → 填入 clientId + clientSecret → 启用
5. 在钉钉群里 @机器人 或私聊机器人即可开始对话

### 3.2 需申请的权限

钉钉企业内部应用机器人需要的接口权限（开发者后台「接口权限」页面申请）：

| 权限 | 用途 |
|---|---|
| 企业内机器人发送消息 | 发送群/单聊消息（OpenAPI 路径） |
| 通讯录只读权限（可选） | 查询用户详情（显示真实姓名而非加密 ID） |

> Stream 模式的消息接收**不需要额外权限申请**——创建机器人能力时默认开通。

### 3.3 configSchema（配置页表单）

```json
{
  "clientId": { "type": "string", "minLength": 1 },
  "clientSecret": { "type": "string", "minLength": 1, "format": "secret" }
}
```

与飞书 `{appId, appSecret}` 结构完全一致（2 字段 + secret format mask），配置页 UI 组件**零改复用**。

## 4. 工作量估算

### 4.1 新增代码（7 文件，估 ~1100 行含测试）

| 文件 | 估算行数 | 难点 |
|---|---|---|
| `plugin.json` | ~25 | 无 |
| `dingtalk-channel.ts` | ~50 | 无（同构飞书） |
| `dingtalk-connection.ts` | ~300 | sessionWebhook 缓存 + 双路径 sendOutbound |
| `dingtalk-client.ts` | ~200 | DWClient + AccessToken 管理 + 双路径发送 |
| `dingtalk-protocol.ts` | ~200 | 钉钉消息格式解析 + 格式化 |
| `dingtalk-slash.ts` | ~210 | 无（复用飞书逻辑） |
| `dingtalk-helpers.ts` | ~55 | 无（复用飞书） |
| `__tests__/` (4~6 套) | ~500 | protocol/client/connection/channel |
| **合计** | **~1540 行** | — |

### 4.2 改动现有代码（极小）

| 文件 | 改动 | 行数 |
|---|---|---|
| `default.yaml`（scope 激活） | 加 `dingtalk` 到 channel list | 1 行 |
| `plugin-config.json`（i18n × 2 语言） | 加钉钉 label/description | ~6 行 |
| `package.json` | 加 `dingtalk-stream` 依赖 | 1 行 |
| `scripts/dingtalk-smoke.ts` | 冒烟脚本（参照 feishu-smoke） | ~80 行 |

### 4.3 工时估算（开发者视角）

| 阶段 | 工时 | 说明 |
|---|---|---|
| 调研 + 冒烟 | 0.5d | dingtalk-stream Bun 兼容验证 |
| 核心 impl 编码 | 2d | channel/connection/client/protocol 4 文件 |
| 斜杠 + helpers + 三件套 | 0.5d | 复用飞书逻辑，改字段名 |
| UT 编写 | 1d | 4~6 套测试 |
| 配置 + i18n + 集成 | 0.5d | plugin.json + scope + i18n |
| 冒烟 + 联调 | 0.5d | 真凭证端到端验证 |
| **合计** | **~5 人日** | — |

## 5. 风险评估

| 风险 | 级别 | 影响 | 缓解措施 |
|---|---|---|---|
| **dingtalk-stream SDK Bun 不兼容** | 🔴 高 | 阻塞（SDK hang） | 冒烟脚本先行验证；中招走 node 子进程兜底（feishu §5.6 已有方案） |
| **ticket 90s 过期 + 断连重注册** | 🟡 中 | 消息丢失（重注册间隔） | dingtalk-stream SDK 内部可能已处理重连（需验证）；上层 ChannelManager.reconnectWithRetry 兜底 |
| **AccessToken 并发刷新** | 🟡 中 | 重复请求 / token 失效 | dingtalk-client 单例 + 缓存 + mutex 防并发刷新 |
| **钉钉 API 限流** | 🟢 低 | 发送延迟 | 企业内部应用默认额度充足；SendQueue 天然限速 |
| **钉钉 API 版本变更** | 🟢 低 | 接口失效 | 钉钉有 API change log，关注版本更新 |
| **@bot 剥离不准（昵称含特殊字符）** | 🟢 低 | 消息带前缀 | 用 conversationType + isAtAll 标记辅助判定 |

## 6. 总结

| 项 | 结论 |
|---|---|
| **可行性** | ✅ 高度可行——channel EP 架构天然支持，架构层零改 |
| **工作量** | ~5 人日（新增 ~1540 行 + 改动 ~10 行） |
| **核心风险** | dingtalk-stream SDK Bun 兼容性（需冒烟先行） |
| **最大差异** | 双鉴权链（ticket + AccessToken）+ 双发送路径（sessionWebhook + OpenAPI） |
| **复用率** | 极高——ChannelManager/agent loop/HTTP API/配置页 UI/SendQueue/binding 全复用 |
| **推荐方案** | Stream 模式 + SessionWebhook 优先 + 企业内部应用 |

> 架构设计的红利：飞书渠道落地时建立的 channel EP 模型（无状态 impl + per-config 句柄 + EP 注册 + scope 门），让钉钉接入成本压缩到「只写 7 个 impl 文件」。这正是 EP 可扩展架构的核心价值验证。

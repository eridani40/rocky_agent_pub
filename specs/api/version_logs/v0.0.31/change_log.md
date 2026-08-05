# v0.0.31 API Change Log — a2a 协议对齐（HTTP surface 增量）

> version: 1.0 · 2026-06-28
> 范围红线（严守）：**只 multi_agent a2a 协议对齐**（parent↔subagent）。严禁碰 squad 层。
> 权威输入：PRD `specs/prd/version_logs/v0.0.31/change_log.md`；tech `specs/tech/version_logs/v0.0.31/change_log.md`。
> 主 spec 文件：`specs/api/overall/04-agent-session.md`（POST /messages v0.0.31 注）+ `specs/api/overall/10a-multi-agent-tool-ref.md`（§3 deliverTo 去 config spec 已落地）。

---

## 1. 概述

本版本 **HTTP surface 无新增端点、无请求/响应 schema 变更**——所有改动是**内部实现收敛 + sender 落库形态对齐判别联合 + enum 对齐**。HTTP 契约（路径/方法/请求体/响应体/状态码）保持不变。本 change log 记录 API spec 文档层面的增量标注（让 api-verifier 与前端知道落库 message 形态变化）。

---

## 2. 文件变更清单

| 文件 | 操作 | 核心变更 |
|------|------|---------|
| `specs/api/overall/04-agent-session.md` | 修改 | §3.2 POST /messages 步骤 1-4 加 v0.0.31 注：内部从「裸 enqueue(config)+activate(config) + 自行 buildSessionConfigFromDeps」收敛为 `manager.deliverTo(sessionId, userMsg)`；sender 形态对齐判别联合（`{source:'user'}`，无 agentName/agentId 残留）；HTTP 契约不变（仅内部实现收敛） |
| `specs/api/overall/10a-multi-agent-tool-ref.md` | 修改 | §3 从「deliverTo 旧签名问题（spec 待同步）」更新为「deliverTo 去 config 重构（v0.0.31 spec 已落地）」——列 agent_manager §2-§2.4 同步内容（新签名 + 方案 A resolveConfigBySid + 调用方清单）+ 代码待同步点；§4 版本 bump 1.1 |
| `specs/api/version_logs/v0.0.31/change_log.md` | 新增 | 本文件 |

---

## 3. HTTP 接口契约变更

### 3.1 无 schema 变更（仅内部实现）

| 接口 | HTTP 契约 | 内部实现 |
|------|----------|---------|
| `POST /session/:id/messages` | **不变**（请求体 `PostMessageBody` / 响应 `{ runId, enqueueId }` / 状态码 202/400/404） | 内部从「裸 enqueue(config)+activate(config) + 自行 buildSessionConfigFromDeps」收敛为 `manager.deliverTo(sessionId, userMsg)`（manager 内部 resolveConfigBySid 获取 config；enrich 跳过 user 变体原样透传） |

### 3.2 落库 message 形态变更（sender 判别联合）

**变更前**（v0.0.28 代码现状）：user POST 落库的 message.sender = `{ source: 'user', agentName?: ..., agentId?: ..., agent?: ... }`（扁平 optional）。

**变更后**（v0.0.31 spec 权威）：user POST 落库的 message.sender = `{ source: 'user' }`（**判别联合 user 变体，只有 source 字段，无 agentName/agentId/agent 子结构**）。

**api-verifier 影响**：AT 路径 4（user_post_via_deliverto）断言 `GET /session/:id/messages` 返回的 user message `sender = { source: 'user' }`（无其他字段）；a2a 消息（路径 1/3）断言 `sender.source === 'agent'` + `sender.agent.ref.{type,sessionId,name}` + `sender.agent.needReply` 落库（判别联合 agent 变体）。

### 3.3 MessageSource enum 落库值变更

**变更前**：emit message_enqueued 处 + 落库 sender.source 可能含 `'scheduled'`。

**变更后**：`MessageSource = 'user' | 'agent' | 'approval' | 'system'`（`'scheduled'` 并入 `'system'`，heartbeat/cron/reminder 由 `sender.system.kind` 承载）。

**api-verifier 影响**：本版 heartbeat/cron/reminder 入口未实现（仅 enum 对齐），AT 不覆盖；但全局验收点断言「全代码无 `'scheduled'` 字符串」（grep + 落库 sender.source 不含 scheduled）。

---

## 4. 与 PRD 用户路径映射（API 验证角度）

| PRD 路径 | API 验证方式 | 断言要点 |
|---------|------------|---------|
| 路径 1（async spawn 回报渲染） | `GET /session/<parentSid>/messages` 查 parent transcript | 含 `sender.source='agent'` + `sender.agent.ref.{type:'subagent',name:'explorer',sessionId:<childSid>}` + `needReply=false` 的 message |
| 路径 2（sync spawn 取 answer） | `GET /session/<childSid>/messages` 查首任务 | 首任务 `sender.agent.needReply=false`（系统硬填）；child 全程不 send_message 回（parent transcript 无 child 来源的 a2a 消息） |
| 路径 3（a2a 提问 + 回复） | `GET /session/<childSid>/messages` + `GET /session/<parentSid>/messages` | child transcript 含 `sender.source='agent'` + `sender.agent.ref.type='session'`（parent 顶层 standalone）+ `needReply=true`；parent transcript 含 child 回的 a2a 消息 |
| 路径 4（user 入口收敛） | `POST /session/:id/messages` + `GET /session/:id/messages` | user message `sender = {source:'user'}`（判别联合，无 agent 字段）；POST 内部走 deliverTo（trace 不见裸 enqueue+activate，AT 黑盒不直接验，靠落库形态 + assemble 渲染间接验） |

> **AT 不验内部 enqueue/activate 签名**（PRD §9 不覆盖项）——黑盒只验落库 message 形态（sender 判别联合）+ deliverTo 行为正确（消息确实入队 + 激活 + 渲染前缀）。

---

## 5. 版本

version: 1.0（v0.0.31 首版：HTTP surface 无新增端点 / 无 schema 变更。①`04-agent-session.md §3.2` POST /messages 加 v0.0.31 注（内部收敛 deliverTo + sender 判别联合，HTTP 契约不变）；②`10a-multi-agent-tool-ref.md §3` 从「deliverTo 旧签名问题」更新为「v0.0.31 spec 已落地」+ 代码待同步点；③本文档记录 sender 落库形态变更（user 变体 `{source:'user'}` / agent 变体含 ref+needReply）+ MessageSource enum `'scheduled'`→`'system'` 对 api-verifier 的影响。严守范围：只 multi_agent parent↔subagent，不碰 squad）。

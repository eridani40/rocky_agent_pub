# PRD Change Log — v0.0.3

> 版本：v0.0.3 · 日期：2026-06-20
> 增量记录 v0.0.3 相对 v0.0.2 引入的产品需求变更。全量产品定义见 `specs/prd/overall/03-llm-chat.md` + `03-llm-chat-features.md`。

## 摘要

v0.0.3 在 v0.0.1（脚手架）+ v0.0.2（persistence CrudStore）之上，引入 **config 三域 + plugin 静态内核 + provider/protocol/model 三件套 + 简单 chat UI**，交付一条最小可用的 LLM 链路作为配置验证切片。

## 新增文档

| 文件 | 行数 | 内容 |
|------|------|------|
| `specs/prd/overall/03-llm-chat.md` | 258 | v0.0.3 全量主文件：产品概述 / 2 栏布局 / chat 流式（§3.1）/ plugin 内核（§3.4）/ 关键用户路径 6 条 / 设计决策 6 项 / 范围边界 / 验收口径 |
| `specs/prd/overall/03-llm-chat-features.md` | ~135 | 功能详拆：Provider/Model 管理（§3.5）/ Config 三域 Service（§3.6）/ 设置 UI（§3.7） |

## 功能新增

| § | 功能 | 优先级 |
|---|------|--------|
| §3.1 | Chat 流式对话（SSE，thinking/answer 分段，前端记 10 条不持久化） | P0 |
| §3.4 | Plugin 静态内核（ExtensionPoint + Registry + PluginManager，内置 llm_anthropic） | P0 |
| §3.5 | Provider / Model 管理（app_config 数据，UI 添加，chat 可选） | P0 |
| §3.6 | Config 三域 Service（App/Dev/Plugin，底经 CrudStore，overlay 增量模型） | P0 |
| §3.7 | 设置 UI（app/plugin/dev 三页，2 栏布局 + 3 设置按钮下对齐） | P0 |
| §2.2 | 2 栏布局（左窄菜单会话区+3 按钮；右主区） | P0 |
| §2.1 | theme dark/light 切换（app_config appearance.theme） | P0 |

## 关键用户路径（6 条 — 测试最低覆盖）

1. chat 流式：选 provider/model → 发 query → server SSE → thinking + answer 分段流式
2. 配置聚合：LlmClient 组装（代码默认 ⊕ app_config，app 最高级）
3. app 设置：theme dark/light 切换 → 持久化 → 全局生效
4. provider 管理：插件设置页添加 provider + model → chat 可选
5. dev 设置：llm request 两 key 存配置（chat 不消费）
6. config 三域 overlay：未配置走默认，配置覆盖，删 delta 回默认

## 关键设计决策（task.json keyDecisions）

1. **chatRoute**：chat 经 server `/chat` SSE，API key 不暴露前端；前端记 10 条不持久化。
2. **configAggregation**：多级 overlay 聚合；聚合者 = LlmClient 组装层；config service 只存稀疏 delta；app_config 最高级。
3. **apiKeyStorage**：明文存 app_config file（v0.0.3 临时妥协，标注安全限制，生产走钥匙串）。
4. **anthropicApi**：Messages API `/v1/messages` SSE，protocol=anthropic_messages；thinking block + text block 分段显示。
5. **devConfigKeys**：stall timeout + max retry 存 DevConfig，chat 简化不消费（YAGNI）。
6. **layout**：2 栏（左窄菜单=会话区+3 设置按钮下对齐；右主区）。

## 范围排除（OUT OF SCOPE）

agent loop / session 持久化 / context engine 压缩 / 工具调用 tool use / 外部插件发现安装 / tokenizer / API key 加密存储。

## 给 arch 的 spec 缺口提示（PRD 不修改 tech/，仅记录）

- **`[P0]llm_protocol_interface.md` `StreamEvent` 缺 `thinking_delta` 变体**（researcher 已发现，见 `specs/research/v0.0.3-llm-plugin-chat.md` §2.4 + `v0.0.3-anthropic-protocol.md` §4）。anthropic SSE 有独立 thinking block（与 text_delta 平行），req 要求展示 thinking，`parseStream` 必须能区分。建议补 `{ type: "thinking_delta"; thinking: string }` 或更通用的 `block_delta` 变体。
- **内置 plugin 目录约定**：spec 未明确内置 plugin 放哪个目录、manifest 文件名（discovery 扫描点）。建议 arch 在 `[P0]plugin_manager_interface.md` 或新文档约定（如 `src/plugins/builtins/<id>/plugin.json`）。
- **chat wire event 协议**：server → 前端的 SSE event 是复用 `StreamEvent`（protocol 层）还是另定义 wire event，需 arch 明确。若复用，`thinking_delta` 必须补进 `StreamEvent`。
- **chat API 无 session 形态**：建议 arch 在 chat API spec 明确 v0.0.3 chat 是无 session / 无持久化 / 带最近 10 条 message 的简单形态。

## 实现一致性确认（doc-modifier 阶段5 同步）

v0.0.3 三层验证全通过（UT 386 / AT 6 / ET 4 + BUG-001 closed）后，doc-modifier 核对 PRD 与实现：

- **6 关键路径**：全部由 AT + ET 覆盖并通过（见 `states/v0.0.3/verify/{api,e2e}-test/report.md`）。
- **6 keyDecisions**：全部落地，无产品偏离（chatRoute / configAggregation / apiKeyStorage 明文妥协 / anthropicApi Messages SSE / devConfigKeys 不消费 / layout 2 栏）。
- **scope.out**：agent loop / session 持久化 / context engine / tool use / 外部插件 / tokenizer / key 加密 — 实现均未触碰，符合预期。
- **产品级偏离**：**无**。实现层面的妥协（provider DELETE tombstone、config 落盘多一层、builtin re-export 静态 import）均为技术细节，不影响产品语义，记录于 `specs/tech/version_logs/v0.0.3/change_log.md` 第三批，PRD 无需改。

> 结论：PRD 与实现一致，PRD 文档无需修改。

## 版本

version: 1.0

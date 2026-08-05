# v0.0.126.history_search — PRD 变更日志

> 日期：2026-07-12
> 类型：新增（new feature）
> 对应 overall：`specs/prd/overall/11-history-search.md`（新增章节）
> 概念权威源：`reqs/[working] v0.0.126.history_search/proposal_history_search.md` + `specs/research/`（调研报告）

## 变更摘要

新增 **History Search（历史会话检索）** 子系统：给「一句话 + 关键词」检索历史会话消息内容（transcript 级），返回命中片段 + session/message 锚点。

**一期**（v0.0.126）：纯 BM25（SQLite FTS5 单表 trigram），零模型、零 native 依赖（目标）、全离线、可调试。
**二期**（预留）：+ sqlite-vec + embedding + RRF 混合 RAG（接口预留，不实现）。

## 新增章节

### §11 History Search（整体新增）

- **§11.1 产品概述**：定位（检索历史消息内容，非 session item/memory/RAG）、目标用户（agent 主、用户调试、verifier）、核心价值（超越上下文窗口 / agent 自查 / 纯本地 / 派生可重建）。
- **§11.2 功能需求**（6 项）：
  - §11.2.1 `history_search` 工具（LLM tool，read-only，query/keywords/scope/time_range/top_k → hits[]）
  - §11.2.2 `history_get_context` 工具（按 message_id 回 transcript 取上下文窗，对齐 search_engine 边界）
  - §11.2.3 `search_indexing` ingest handler（order 5 旁路 sink，role∈{user,assistant}，派生索引）
  - §11.2.4 `GET /history/search` endpoint（含 debug=1 打分明细）
  - §11.2.5 兜底（reconcile / deleteSession cascade / rebuild）
- **§11.3 关键用户路径**（4 条 MANDATORY）：
  - 路径 1：检索回答（agent 检索 → 引用历史）
  - 路径 2：写入索引（ingest → 派生索引）
  - 路径 3：无命中/降级（一期纯 BM25）
  - 路径 4：兜底（reconcile / rebuild）
- **§11.4 范围边界**：一期 IN（FTS5/单表 trigram/派生索引/2 工具/endpoint/兜底/独立 search.sqlite/打包护栏）+ 二期 OUT 预留（sqlite-vec/embedding/RRF/摘要第二路/分块/model 指纹）+ 显式不做（UI/schema 双写/索引 tool/raw/summary/subagent/forked/studio）。
- **§11.5 设计决策**（6 项）：派生索引不双写 / order 5 失败一致性 / message_id 全链路锚点 / 单表 trigram / sqlite 驱动选型 / 副本 vs 锚点。
- **§11.6 测试范围**：UT-now / AT-later（用户裁决豁免）/ ET n/a（无 UI）。

## 概念对齐（PRD ↔ specs）

本 PRD 引用的概念全部对齐已有 specs，无新发明：

| PRD 概念 | 对齐 spec | 关系 |
|---------|----------|------|
| SearchEngine 边界（召回 recordId → 回 CrudStore.get） | `specs/tech/persistence/[P1]search_engine.md` §3 | 占位转正式设计（本需求 = 占位转正式） |
| `search_indexing` handler 挂点 | `specs/tech/agent/context/[P0]context_ingest_detail.md` §1 第 30 行（已预留） | ext impl 登记 |
| ingest handler chain（order 1-5） | 同上 + `[P0]extension point and implementations.md` §3.1 | order 5 紧随 store_sink(4) |
| message_id ULID 业务生成 | `specs/tech/agent/message/[P0]agent_message_interface.md` + `context_ingest_detail.md` §7 | 全链路锚点 |
| SessionStore.getMessages 取上下文 | `specs/tech/agent/session/[P0]session_store.md` | history_get_context 回 transcript |
| tool 命名/契约 | `specs/tech/agent/tools/`（各 tool spec） | 新增 history_search / history_get_context |
| endpoint 契约 | `specs/api/overall/` | 新增 GET /history/search |

## 待用户确认项（架构期前裁决）

- 本 PRD 的范围/路径/决策与 proposal + task.json `decisions`（9 条）完全一致，无新决策点。
- PRD 确认后进入架构期，产出：
  - `specs/tech/persistence/[P1]search_engine.md` 占位转正式（含驱动抽象 / handler 旁路 / trigram / 触发模型）
  - `specs/tech/agent/tools/history_search_tool.md` + `history_get_context_tool.md` 新增 tool spec
  - `specs/tech/agent/context/[P0]extension point and implementations.md` 登记 `search_indexing` impl（order 5，default scope active）
  - `specs/api/overall/19-history-search.md` 新增 endpoint 契约
  - `specs/tech/version_logs/v0.0.126/change_plan.md` method 级变更契约

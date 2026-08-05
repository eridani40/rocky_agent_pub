# History Search（历史会话检索）— 产品需求文档 [v0.0.126]

> version: 1.0 · 引入版本 v0.0.126 · 最后更新：2026-07-12
> 本文承载 History Search 子系统全量产品定义。增量见 `specs/prd/version_logs/v0.0.126.history_search/change_log.md`。
>
> **概念权威源**（本 PRD 不发明概念，只引用对齐）：
> - 设计/架构：`reqs/[working] v0.0.126.history_search/proposal_history_search.md`（具体设计方案）+ `specs/research/`（调研报告，同名目录下）
> - 检索引擎边界：`specs/tech/persistence/[P1]search_engine.md`（SearchEngine 占位 → 本需求转正式设计）
> - 写入挂点：`specs/tech/agent/context/[P0]context_ingest_detail.md` §1（handler chain 已预留 `search_indexing` 挂点）+ `[P0]extension point and implementations.md`
> - Tool 惯例：`specs/tech/agent/tools/`（新增 history_search / history_get_context 对齐其惯例）
> - Transcript 锚点：`specs/tech/agent/session/[P0]session_store.md`（message_id 主键 + getMessages）
> - API 契约：`specs/api/overall/`（新增 `GET /history/search` endpoint 对齐其惯例）

## 目录

| 章节 | 说明 |
|------|------|
| §11.1 产品概述 | history_search 定位、目标用户、核心价值 |
| §11.2 功能需求 | 一期功能：history_search / history_get_context / search_indexing handler / GET endpoint / 兜底 |
| §11.3 关键用户路径（MANDATORY） | 4 条核心路径（测试最低覆盖） |
| §11.4 范围边界（IN / OUT） | 一期范围 vs 二期（RAG）预留 |
| §11.5 设计决策 | 派生索引、message_id 锚点、单表 trigram、driver 选型 |
| §11.6 测试范围 | UT-now / AT-later / ET n/a |

---

## 11.1 产品概述

### 11.1.1 定位

**history_search** = 给「一句话 + 几个关键词」检索**历史会话消息内容**（transcript 级），返回命中片段 + 所属 session/message 锚点（可跳转、可取上下文窗）。

一句话：**超出上下文窗口的历史消息，agent 能自己查回来用。**

**不是**：
- 不是 session item / 列表检索（不查 session 元数据）
- 不是 memory 检索（memory 是结构化沉淀；history_search 检索原始对话流）
- 不是 RAG（一期纯 BM25；二期才加向量）

### 11.1.2 目标用户

- **agent（LLM）**：会话中用户提及历史内容、当前上下文找不到所指时，主动调 `history_search` 工具自查历史。
- **用户（调试/未来 UI）**：通过 HTTP endpoint 或（未来）UI 搜索框检索历史。**一期不做 UI**，仅 endpoint。
- **自动化（verifier）**：curl `/history/search` endpoint、跑 golden query eval 集验证召回质量。

### 11.1.3 核心价值

1. **超越上下文窗口**：被 compact / 推出窗口的历史消息不再丢失，可主动检索。
2. **agent 自查、零人工**：LLM 自己判断何时查、怎么查，不打断用户。
3. **纯本地、零模型、零外部依赖（一期）**：FTS5 BM25，全离线、零费用、可调试。
4. **派生数据可重建**：索引是 transcript 的派生副本，丢了能 rebuild，不影响主存。

---

## 11.2 功能需求

### 11.2.1 `history_search` 工具（LLM tool，read-only）[v0.0.126]

**描述**：LLM 在会话中按一句话/关键词检索历史消息内容，返回命中片段 + 锚点。
**优先级**：P0
**用户故事**：作为 agent，当用户提及历史/更早聊过的内容、当前上下文找不到所指时，我希望检索历史消息以便引用回答。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 二选一 | 自然语言一句话 |
| `keywords` | string[] | 二选一 | 关键词数组（OR boost） |
| `scope` | `"all"` \| `"exclude_current"` \| `{session_ids: [...]}` | 否 | 默认 `all`；当前会话也索（可找回 compact 内容），agent 排除当前用 `exclude_current` |
| `time_range` | `{after?, before?}` | 否 | ULID/ISO 时间区间过滤 |
| `top_k` | number | 否 | 默认 8 |

**返回**：`hits[]` 数组，每项含 `{ sessionId, sessionTitle, messageId, role, timestamp, snippet, score }`。

**行为细节**：
- query 经 `_sanitize`（剥 FTS5 控制字符防注入）→ 分词 → OR 召回；`keywords` 拼 OR 表达式作 boost。
- snippet 由 FTS5 `snippet(fts, 0, '«', '»', ' … ', 12)` 生成（副本库内、不回读 transcript）。
- 排序：`bm25(fts)` + recency 半衰期后置重排（`ts = message_id` ULID，字典序=时间序）。
- **tool_policy 免审批**（read-only，对齐其他 read-only tool）。
- **tool description 写清触发时机**：用户提及历史/「之前聊过」/当前上下文找不到所指时。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 用户问「上周我们讨论的打包方案是什么」→ agent 调 history_search(query="打包方案") → 命中历史消息 → 引用 snippet 回答 | agent 回答中引用历史内容，snippet 透出给用户 |
| UC-2 | 用户问「之前提到 electron 怎么处理」→ agent 调 history_search(keywords=["electron","处理"]) → OR boost 召回 | 多关键词命中正确消息 |
| UC-3 | agent 调 history_search 未命中（query 过偏） → 返回空 hits → agent 提示用户「历史中未找到」 | 优雅降级，不阻塞对话 |

### 11.2.2 `history_get_context` 工具（LLM tool，read-only）[v0.0.126]

**描述**：LLM 按 message_id 锚点取该消息前后的 transcript 上下文窗（结构化 ContentBlock[]）。
**优先级**：P0
**用户故事**：作为 agent，命中一条历史消息后我希望看其前后文（图片/tool_call/tool_result 结构化内容），以便完整理解上下文。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | 是 | 目标 session |
| `messageId` | string | 是 | history_search 返回的锚点 |
| `before` | number | 否 | 前置消息数（默认 5） |
| `after` | number | 否 | 后置消息数（默认 5） |

**返回**：完整 ContentBlock[]（包含图片 block / tool_call / tool_result 等结构化内容，副本没有的部分）。

**实现路径**（对齐 search_engine 边界 §3）：
```
history_get_context(sessionId, messageId, before, after)
  → SessionStore.getMessages(sessionId, { around: messageId, window })
  → 完整 ContentBlock[]
```

**为何独立于 history_search**：副本只存纯文本，召回/snippet 用副本（零 IO、快）；取详情/结构化内容必须回 transcript——这正是 search_engine.md 边界「召回 recordId → 回 CrudStore.get 取详情」。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4 | agent 调 history_search 命中 → 调 history_get_context(messageId, before=5, after=5) → 取回完整上下文 | agent 看到结构化内容（图片/tool_call），完整理解历史 |
| UC-5 | agent 取回上下文发现无关 → 重新 refine query 检索 | 多轮检索收敛到正确消息 |

### 11.2.3 `search_indexing` ingest handler（写入路径）[v0.0.126]

**描述**：新增 ingest handler 作为 `context_ingest_handler` 扩展点的 ext impl，在 chain 中作为派生索引 sink（旁路），把 messages 投递给 HistoryIndexer 建 SQLite 索引。
**优先级**：P0
**用户故事**：作为系统，新消息写入主存后自动进索引，以便后续可检索；索引失败不影响主存写入。

**挂点契约**（对齐 `context_ingest_detail.md §1` + §3）：
- point=`context_ingest_handler`，order=**5**（在 `store_sink` order 4 之后）
- 归 `rocky_context` builtin plugin（manifest 登记 impl）
- **只在 default scope active**；forked scope disable（forked 是临时派生会话，不进历史索引；手法同 v0.0.49 store_sink 的 scope 配置）
- 契约：`handle(messages, ctx) → messages`（透传，不 transform）

**处理逻辑**：
```
for m in messages:
  if m.role ∉ {user, assistant}: skip       // tool/raw/summary 不索引
  text = extractPlainText(m.content)         // type=text part 拼纯文本
  indexerQueue.push({ messageId: m.id, sessionId, role, ts: m.id, text })
return messages                              // 透传不阻塞 ingest
```

**索引对象**：`role ∈ {user, assistant}`，从 `content` ContentBlock[] 取 `type=text` part 拼纯文本。
**不索引**（一期）：`role=tool`（hermes 经验「usually noise」）、raw、summary（二期第二路召回）、subagent/forked/studio 会话。

**关键不变量**：
- **失败一致性**：放 `store_sink` 之后 = 主存写失败 → chain 中断 → `search_indexing` 不执行 → 永不出现「索引有、主存没有」的孤儿记录（派生跟随权威，顺序由 chain order 硬保证）。
- **message_id 全链路锚点**：`Message.id` 是业务生成 ULID（agent loop 首次分配，进入 ingest 之前就在消息对象上），`store_sink` 写库主键=`m.id`，`search_indexing` 用同一 `m.id` 作 `chunks.message_id`——store 不需要返回 ID，handler 协议不改。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-6 | 用户发消息 → agent 回复 → ingest chain 跑 → store_sink 写 transcript → search_indexing 投递队列 → HistoryIndexer 写索引 | 新消息可被后续 history_search 召回 |
| UC-7 | store_sink 抛错（主存写失败） → chain 中断 → search_indexing 不执行 | 索引无孤儿记录，主存/索引一致 |
| UC-8 | search_indexing 自身失败（吞异常） → ingest 不受影响 → reconcile 启动时补索 | 索引最终一致，写入路径不受索引故障拖累 |

### 11.2.4 `GET /history/search` HTTP endpoint [v0.0.126]

**描述**：与 tool 同引擎的 HTTP endpoint，供调试/未来 UI 共用；`debug=1` 返回打分明细。
**优先级**：P1（一期调试用）
**用户故事**：作为开发者/verifier，我希望用 curl 直接检索验证召回质量，不必走 LLM。

**契约**（对齐 `specs/api/overall/` 惯例）：
```
GET /history/search?q=...&keywords=...&top_k=...&debug=0|1
→ { hits: [{ sessionId, sessionTitle, messageId, role, timestamp, snippet, score, debug? }] }
```

- `debug=1`：每 hit 返回 `{ bm25_score, matched_terms, fts_route }`。
- 一期不做 UI（endpoint 纯调试/verifier 用）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-9 | curl GET /history/search?q=electron → 返回 hits 数组 | 命中消息按 bm25 排序 |
| UC-10 | curl GET /history/search?q=...&debug=1 → 返回打分明细 | 每 hit 含 matched_terms / bm25_score |

### 11.2.5 兜底机制（reconcile / delete / rebuild）[v0.0.126]

**描述**：保证索引最终一致的三种维护路径。
**优先级**：P0

| 机制 | 触发 | 行为 |
|------|------|------|
| **启动 reconcile** | 后端启动 | 读 `idx_meta.last_ulid`，扫所有 `sessions/*/transcript/*.jsonl` 里 `id > last_ulid` 的 record 补索（防丢事件/上次崩溃）；session 维度并行（天然分片） |
| **deleteSession 级联** | session.destroyed 事件 | session-store 已级联 `rm -rf sessions/{sid}/`；索引器监听事件 → `DELETE FROM chunks WHERE session_id=?`（FTS external-content 级联删） |
| **rebuild 命令** | 手动 / schema 升级 / 首次启用历史回填 | 清库 → 全扫 jsonl 重建；进度写 `idx_meta` |

**文本来源时序**（对齐 proposal §3.3）：
| 场景 | 文本来源 | 理由 |
|---|---|---|
| 增量（ingest 时） | 内存 messages（handler 提取） | ingest 流经过，对象在手，零 IO |
| reconcile / rebuild | 落盘 jsonl | 无 ingest 流，只能读文件 |

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-11 | 后端崩溃重启 → 启动 reconcile 扫 last_ulid 之后的 jsonl 补索 | 索引恢复一致，无丢消息 |
| UC-12 | 用户删 session → session.destroyed → DELETE FROM chunks WHERE session_id | 索引与主存同步删除，无悬挂记录 |
| UC-13 | schema 升级 → rebuild 命令清库重建 | 索引按新 schema 全量重建 |

---

## 11.3 关键用户路径（MANDATORY）

> 每条路径至少一个 UT/AT case 覆盖（测试范围见 §11.6）。一期 AT 豁免（用户裁决），UT 覆盖路径核心行为。

### 路径 1：检索回答（agent 检索 → 引用历史回答）

```
用户问及历史内容（"上周聊的打包方案"）
  → agent 判断当前上下文找不到 → 调 history_search(query, scope=exclude_current)
  → FTS5 召回 + bm25 打分 + recency 重排
  → 命中 hits[]（含 snippet + messageId）
  → agent 调 history_get_context(messageId) 取上下文窗（结构化内容）
  → agent 引用历史内容回答用户
```

**断言**：agent 回答包含历史内容；snippet 透出；messageId 可锚定回 transcript。

### 路径 2：写入索引（新消息 ingest → 派生索引）

```
用户发消息 / agent 回复
  → agent_loop 分配 message id（ULID）
  → ingest(config, messages)
  → chain: query_truncate(1) → tool_result_truncate(2) → reminder_injector(3) → store_sink(4) → search_indexing(5)
  → store_sink 写 transcript（主存权威）
  → search_indexing 提取 type=text part → 投递 HistoryIndexer 队列
  → HistoryIndexer worker 批量 INSERT chunks + fts
```

**断言**：新消息落库后可被 history_search 召回；store_sink 失败时 search_indexing 不执行（无孤儿）。

### 路径 3：无命中 / 降级（一期纯 BM25）

```
agent 调 history_search(query="...")
  → FTS5 MATCH 未命中（query 过偏 / 拼写错误 / 历史无此内容）
  → 返回 hits=[]（空）
  → agent 降级：提示用户「历史中未找到」或 refine query 重试
```

**断言**：无命中时优雅返回空数组；agent 不报错、不阻塞对话；二期 embedding 接入后此路径变为「BM25 无命中 → fallback 向量召回」（二期范围）。

### 路径 4：兜底（启动 reconcile / rebuild 重建）

```
后端启动（或手动 rebuild）
  → 读 idx_meta.last_ulid
  → 扫 sessions/*/transcript/*.jsonl 里 id > last_ulid 的 record
  → 提取 text → INSERT chunks + fts
  → 更新 idx_meta.last_ulid
（或 rebuild：清库 → 全扫重建）
```

**断言**：崩溃/丢事件后索引恢复一致；rebuild 产出全量索引且与 transcript 一致。

---

## 11.4 范围边界（IN / OUT）

### 11.4.1 一期 IN（v0.0.126）

- **检索引擎**：SQLite FTS5，单表 trigram tokenizer（中英文统一切 3-gram），纯本地、零模型、零 native 依赖（目标）。
- **索引对象**：`role ∈ {user, assistant}` 的 transcript 文本（`type=text` part）。
- **写入路径**：`search_indexing` ingest handler（order 5，旁路 sink），HistoryIndexer 串行队列。
- **检索工具**：`history_search`（召回 + snippet）、`history_get_context`（回 transcript 取上下文）。
- **HTTP endpoint**：`GET /history/search`（含 `debug=1` 打分明细）。
- **兜底**：启动 reconcile + deleteSession 级联 + rebuild 命令。
- **存储**：独立 `search.sqlite`（路径走 `resolveDataDir`），schema = `chunks` + `fts`(external-content) + `idx_meta`。
- **可调试性**：打分透明（bm25_score + matched_terms）、stats/dump/rebuild 维护命令、golden query eval 集（30~50 条）。
- **打包护栏**：packaged 实测 FTS5 可用性（node:sqlite go/no-go，fallback better-sqlite3）。

### 11.4.2 二期 OUT（RAG 预留，不实现）

- sqlite-vec 向量索引（loadable ext，asarUnpack）。
- embedding 通道（llm_caller 新增 `/embeddings` provider → transformers.js + multilingual-e5-small 本地保底）。
- RRF(k=60) 混合融合 + recency 后置重排。
- session 摘要第二路召回（两级检索）。
- 长输出分块（~1.5k chars，`chunk_id = message_id:idx`，顶层锚点仍 message_id）。
- 索引存 embedding model 指纹（换模型全量重嵌）。

> **边界声明**：一期接口（tool schema / endpoint / handler 契约）**预留二期扩展点**，但二期实现不在 v0.0.126 范围。

### 11.4.3 显式不做（一期 + 二期之外）

- 不做 UI 搜索框（一期纯 endpoint/tool）。
- 不改 `MessageSchema` 双 engine 声明、不改 `CompositeStore`（派生索引走 ingest handler 旁路，不双写 schema）。
- 不索引 `role=tool` / raw / summary / subagent / forked / studio 会话。

---

## 11.5 设计决策

> 完整决策依据见 `proposal_history_search.md` + `research_00_summary_and_review.md`。本节列产品层关键决策。

### 11.5.1 派生索引，不双写 schema（ingest handler 旁路）

**决策**：不改 `MessageSchema` 声明双 engine，不改 `CompositeStore`。改走 ingest handler 旁路——`store_sink` 写主存（读路径不变），`search_indexing` 旁路派生索引。

**理由**：
1. 存储抽象代价大、破坏 `search_engine.md` 边界（SearchEngine 只读消费、不接管写路径）。
2. `context_ingest_detail.md §1` handler chain 已预留 `search_indexing` 挂点——概念先行已满足。
3. 语义等价于「写 2 份、读走 1 份」，但零侵入存储抽象。

### 11.5.2 `search_indexing` 放 `store_sink` 之后（order 5）

**决策**：chain order = query_truncate(1) → tool_result_truncate(2) → reminder_injector(3) → store_sink(4) → **search_indexing(5)**。

**理由**：失败一致性——`store_sink` 抛错 → chain 中断 → `search_indexing` 不执行 → 永不出现「索引有、主存没有」的孤儿记录。派生永远跟随权威，顺序由 chain order 硬保证，不靠额外协调逻辑。附带：拿到的是 reminder 注入后落库的最终形态，索引文本与主存 100% 一致。

### 11.5.3 message ID 全链路锚点（业务生成，无需 store 返回）

**决策**：`Message.id`（业务生成 ULID，agent loop 首次分配）贯穿「生成 → 落库 → 索引 → 检索回原文」全链路。

**理由**：
- `MessageInput = Omit<Message,'createdAt'|'updatedAt'|'version'>` 只剥信封，**保留 id**。
- ingest handler 契约 `handle(messages, ctx)` 入参 messages 自带 `.id` → 协议不用改。
- `store_sink` 写库主键=`m.id`；`search_indexing` 用同一 `m.id` 作 `chunks.message_id` → 同一对象同一字段，天然对齐。
- store 不需要返回 ID；handler 透传 messages，`search_indexing` 从入参读 id。

### 11.5.4 单表 trigram（不分中英文）

**决策**：一张 FTS5 表 + `tokenize='trigram'`，中英文统一切 3-gram。

**理由**：都能子串召回（中文「打包」、英文「electron」命中「lect」）。取消 hermes 双表路由。代价：BM25 词义略弱于 unicode61、索引体积略大——本地量级（万~十万 message）无所谓。

### 11.5.5 sqlite 驱动（跨 Bun/Node）

**决策**：

| 环境 | 驱动 | 说明 |
|---|---|---|
| dev (Bun) | `bun:sqlite` | 已有，FTS5 内置，零依赖 |
| packaged (Node/Electron 42) | `node:sqlite` 优先（Node 22+ 内置，零依赖） | **FTS5 是否编译进去须实测**（架构期第一个 spike，go/no-go） |
| fallback | `better-sqlite3` | 仅当 node:sqlite 缺 FTS5；native prebuilt，吃打包护栏 |

**理由**：驱动层复用 `SqliteCrudStore` 同源 `bun:sqlite` 调用模式 + packaged 降级，不重新发明。

### 11.5.6 索引库与主存的关系（副本 vs 锚点）

- **派生副本**（`text` / `role` / `ts`）：可丢可重建（rebuild 从 jsonl 重派生），丢了不影响主存。
- **锚点**（`message_id`）：必须对齐 transcript record id，检索结果靠它回原文。
- 「不依赖原文」**仅指**：① 召回/打分阶段用副本不回读；② indexer worker 吃 payload 不回读 jsonl。建索引（提取自原文）和取详情（回 transcript）都依赖原文。

---

## 11.6 测试范围

> 用户裁决（task.json `testScope`）：本期 **UT-now / AT-later / ET n/a**。

| 层 | 范围 | 说明 |
|----|------|------|
| **UT（now）** | 必做 | 覆盖 §11.3 四条路径核心行为：handler 投递 / queue 串行 / FTS5 召回 + bm25 + recency / snippet / sanitize / reconcile / delete cascade / rebuild |
| **AT（later）** | 豁免 | 用户裁决：API 测试本期豁免，后续指示再补；合并门禁豁免 AT ≥90% 条款 |
| **ET（n/a）** | 不适用 | 无 UI 变更（一期纯 tool + endpoint），ET 无对象 |

**UT 关键覆盖点**：
- `search_indexing` handler：role 过滤 / text 提取 / 投递 queue / 透传 / scope disable
- HistoryIndexer queue：串行保序 / 批量 INSERT / 失败重试 / 吞异常不影响 ingest
- 检索：sanitize 防注入 / MATCH + bm25 / recency 半衰期重排 / snippet 截取
- 兜底：reconcile 扫 last_ulid / deleteSession cascade delete / rebuild 清库重建
- message_id 锚点：handler 投递 id = chunks.message_id = transcript record id

**golden query eval**（可调试性验收项）：30~50 条「query → 期望命中 message」小集 + recall@k / MRR 脚本（架构期产出，作为 UT 之外的回归基线）。

---

## 11.7 版本

> 增量变更见 `specs/prd/version_logs/v0.0.126.history_search/change_log.md`。
> 概念权威源更新（架构期产出）：`specs/tech/persistence/[P1]search_engine.md` 占位转正式 + `specs/tech/agent/context/[P0]extension point and implementations.md` 登记 `search_indexing` impl + `specs/tech/agent/tools/` 新增 tool spec + `specs/api/overall/` 新增 endpoint 契约。

# History Search HTTP API（GET /history/search）

> version: 1.0 `[v0.0.126 new]` · 引入版本 v0.0.126
> 上游：PRD `specs/prd/overall/11-history-search.md §11.2.4` · 引擎 `specs/tech/persistence/[P1]search_engine.md` · 同源工具 `specs/tech/agent/tools/[P1]history_search_tool.md`。
> 同族端点：与 `/session/:id/run`（test-only）等同级；归 `app/server/src/router.ts` 注册。

## 管什么

v0.0.126 server 经 `node:http` 暴露的 HTTP 检索端点契约——`GET /history/search`。**一期调试/verifier 用**（未来 UI 搜索框的共用后端，UI 不在本版本）。

## 不管什么

- LLM tool（`history_search` tool 内部调 `SearchEngine.search`，不走本端点）
- transcript 详情取回（→ 工具 `history_get_context` / 后续可能的 endpoint，本端点只返命中 + snippet）
- 索引写入/维护（→ ingest handler `search_indexing` + `HistoryIndexer`）

## 本文件是 AT（API Test）history-search 域的唯一依据

api-verifier 黑盒 curl，不读代码。一期 AT 豁免（用户裁决 UT-now / AT-later），但端点契约先冻结。

---

## 1. 端点契约

```
GET /history/search
   ?q=<自然语言一句话>
   &keywords=<逗号分隔关键词>          （可选，q 和 keywords 至少一个）
   &scope=all|exclude_current          （可选，default=all）
   &current_session=<sid>              （可选，scope=exclude_current 时指定当前 session）
   &after=<ISO 或 ULID>                （可选，时间下界）
   &before=<ISO 或 ULID>               （可选，时间上界）
   &top_k=<1..50>                      （可选，default=8）
   &debug=0|1                          （可选，default=0；1 返回打分明细）
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `q` | string | 二选一 | 自然语言一句话（走 FTS5 全文召回） |
| `keywords` | string (CSV) | 二选一 | 关键词逗号分隔（`electron,打包` → OR boost） |
| `scope` | enum | 否 | `all`（默认，也索当前 session）/ `exclude_current`（排除当前 session） |
| `current_session` | string | 条件必填 | `scope=exclude_current` 时必填；否则忽略 |
| `after` | string | 否 | ISO 时间或 ULID 下界（含） |
| `before` | string | 否 | ISO 时间或 ULID 上界（不含） |
| `top_k` | number | 否 | 1..50，default 8 |
| `debug` | 0\|1 | 否 | default 0；1 时每 hit 返回 `debug` 字段 |

### 响应（200）

```jsonc
{
  "hits": [
    {
      "sessionId":   "01HXXXXXXXXXXXXXXX",
      "sessionTitle": "session 标题（可能 null）",
      "messageId":   "01HYYYYYYYYYYYYYYY",   // 全链路锚点
      "role":        "user",                  // 'user' | 'assistant'
      "timestamp":   "01HYYYYYYYYYYYYYYY",    // = messageId（ULID 字典序=时间序）
      "snippet":     "«...包含 «关键词» 高亮的片段...»",
      "score":       0.847,
      "debug": {                             // 仅 debug=1 时出现
        "bm25_score":    -2.341,
        "matched_terms": ["打包", "lect"],
        "fts_route":     "trigram"
      }
    }
  ],
  "meta": {
    "total": 3,                  // 命中总数（分页前）
    "returned": 3,
    "query": "原始 q",
    "keywords": ["electron", "打包"],
    "elapsedMs": 12,
    "debug": false               // 是否开了 debug
  }
}
```

### 错误响应

| HTTP | code | 触发 |
|------|------|------|
| 400 | `BAD_REQUEST` | `q` 和 `keywords` 都缺 |
| 400 | `BAD_REQUEST` | `scope=exclude_current` 但 `current_session` 缺 |
| 400 | `BAD_REQUEST` | `top_k` 不在 1..50 |
| 500 | `INTERNAL` | search 执行抛错（FTS5 不可用 / search.sqlite 损坏致查询失败） |
| 503 | `SERVICE_UNAVAILABLE` | SearchEngine 未装配（bootstrap 失败 / `bs.searchEngine === undefined`） |

**500 vs 503 区分**（router.ts:593-599 实际逻辑）：
- **503**：bootstrap 阶段 SearchEngine 实例化失败（如 search.sqlite 损坏 / FTS5 选型 spike 失败）→ `BootstrapResult.searchEngine = undefined` → router 走 `if (!bs.searchEngine) return 503` 分支（请求未进 handler 就被拦）
- **500**：SearchEngine 已装配但 search 执行抛错（如 MATCH 语法异常 / fts 虚表损坏）→ handler 内 try/catch 捕获 → 500 INTERNAL

错误体：`{ "code": "BAD_REQUEST"|"INTERNAL"|"SERVICE_UNAVAILABLE", "message": "...", "detail": {...} }`（对齐 `04-agent-session.md` 错误体惯例；503 体 = `{ code: 'SERVICE_UNAVAILABLE', message: 'history search engine not initialized' }`）。

---

## 2. 行为细节

- **检索引擎**：与 `history_search` tool 同源（`SearchEngine.search()`，`specs/tech/persistence/[P1]search_engine.md §3.5`）
- **sanitize**：`q` 在 SearchEngine 内部剥 FTS5 控制字符（`"`/`*`/`:`/`(` 等）防注入；endpoint 层不做字符串清理
- **keywords CSV 解析**：`keywords=electron,打包` → `['electron', '打包']`；空字符串/重复值过滤
- **scope 语义**：
  - `all`：所有 session（含当前）
  - `exclude_current`：`current_session` 指定的 session 过滤掉（agent 自查历史场景）
- **time_range**：`after`/`before` 接受 ISO 时间或 ULID（ULID 字典序=时间序，直接对 `ts` 列比较）
- **debug=1 打分明细**：`bm25_score`（FTS5 原始 bm25，负值越小越好）+ `matched_terms`（trigram 命中的 token）+ `fts_route`（一期恒 `trigram`）

---

## 3. 路由注册

`app/server/src/router.ts` 新增 `GET /history/search` 分支，handler 委托 `SearchEngine.search()`（注入：bootstrap 时创建 SearchEngine 实例，传 `resolveDataDir()` 路径 + SessionStore 引用）。

```
if (method === 'GET' && path === '/history/search') {
  return handleHistorySearch(req, searchEngine);  // 新增 handler
}
```

**gate 策略**：一期无 gate（公开访问）。二期若加 auth/限额再补（对齐 `/session/:id/run` 的 test-gate pattern）。

---

## 4. AT case 设计（later，冻结契约供后续 designer）

| case_id | 场景 | 断言 |
|---------|------|------|
| `history_search/basic_query` | ingest 几条消息后 `?q=关键词` | 200 + hits[] 非空 + snippet 含高亮 + score 数值 |
| `history_search/keywords_boost` | `?keywords=a,b` | 200 + OR 召回 |
| `history_search/exclude_current` | `?scope=exclude_current&current_session=X` | 200 + hits 中无 sessionId=X |
| `history_search/empty_result` | `?q=不存在的奇怪词` | 200 + `hits:[]` + `meta.total:0` |
| `history_search/missing_params` | `?` （q/keywords 都缺） | 400 + `BAD_REQUEST` |
| `history_search/debug_flag` | `?q=...&debug=1` | 200 + 每 hit 含 `debug` 字段 |
| `history_search/time_range` | `?q=...&after=2026-01-01` | 200 + hits 均在时间窗内 |

---

## 5. 版本

> 变更历史见 `specs/api/version_logs/v0.0.126.history_search/change_log.md`。

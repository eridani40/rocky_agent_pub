# v0.0.126.history_search · API 变更（新增 GET /history/search 端点）

> 跨版本发布说明（版本轴）。位置轴见 `specs/api/overall/19-history-search.md`（全量文档）。

## 新增端点

### `GET /history/search`（一期调试/verifier 用）

历史检索 HTTP 端点，与 `history_search` LLM tool 同源（都调 `SearchEngine.search`）。一期无 gate（公开访问）；未来 UI 搜索框的共用后端（UI 不在本版本）。

**契约**（详见 `specs/api/overall/19-history-search.md`）：

```
GET /history/search
   ?q=<自然语言一句话>                   （q / keywords 至少一个）
   &keywords=<逗号分隔关键词>            （可选，OR boost）
   &scope=all|exclude_current            （可选，default=all）
   &current_session=<sid>                （scope=exclude_current 时必填）
   &after=<ISO 或 ULID>                  （可选，时间下界）
   &before=<ISO 或 ULID>                 （可选，时间上限）
   &top_k=<1..50>                        （可选，default=8）
   &debug=0|1                            （可选，default=0；1 返回打分明细）
```

**响应 200**：`{ hits: [{sessionId, sessionTitle, messageId, role, timestamp, snippet, score, debug?}], meta: {total, returned, query, keywords, elapsedMs, debug} }`

**错误表**：

| HTTP | code | 触发 |
|------|------|------|
| 400 | `BAD_REQUEST` | `q` 和 `keywords` 都缺 / `scope=exclude_current` 缺 `current_session` / `top_k` 不在 1..50 |
| 500 | `INTERNAL` | search 执行抛错（FTS5 不可用 / search.sqlite 损坏致查询失败） |
| 503 | `SERVICE_UNAVAILABLE` | SearchEngine 未装配（bootstrap 失败 / `bs.searchEngine === undefined`） |

**500 vs 503 区分**：
- **503**：bootstrap 阶段 SearchEngine 实例化失败 → `BootstrapResult.searchEngine = undefined` → router 走 `if (!bs.searchEngine) return 503`（请求未进 handler 就被拦）
- **500**：SearchEngine 已装配但 search 执行抛错 → handler 内 try/catch → 500 INTERNAL

## AT case（later）

一期 AT 豁免（用户裁决 UT-now / AT-later），但端点契约先冻结。case 设计见 `specs/api/overall/19-history-search.md §4`：basic_query / keywords_boost / exclude_current / empty_result / missing_params / debug_flag / time_range。

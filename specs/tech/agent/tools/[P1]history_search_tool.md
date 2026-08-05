---
type: spec
title: History Search Tool（LLM tool，read-only，FTS5 BM25 召回 + snippet）
priority: P1
status: active
updated: 2026-07-12
since: v0.0.126
---

# History Search Tool — LLM tool，read-only（FTS5 BM25）

> 上游：PRD `specs/prd/overall/11-history-search.md §11.2.1` · 引擎权威 `../../persistence/[P1]search_engine.md`。
> 同族：`[P1]history_get_context_tool.md`（按 messageId 回 transcript 取上下文窗）。
> Tool 框架：`[P0]tool_execution_engine.md` + `[P0]tool_policy.md` + `[P0]tool_permission.md`。

## 1. 概述

`history_search` = LLM 在会话中按一句话/关键词检索历史消息内容（transcript 级），返回命中片段 + session/message 锚点（可跳转、可取上下文窗）。

**触发时机**（tool description 必须写清，LLM 自学何时调）：
- 用户提及历史 / 「之前聊过」/「上周讨论的」
- 当前上下文窗口找不到所指内容（已被 compact / 推出窗口）
- 用户引用了无法在当前对话中找到的具体内容

**read-only / 免审批**：对齐其他 read-only tool（如 web_fetch 的无 HITL 路径）。tool_policy=`auto`（不进审批队列）。

## 2. Tool 契约（ToolDefinition）

```typescript
const historySearchTool: Tool = {
  definition: {
    name: 'history_search',
    description:
      'Search past conversation history (transcript-level) by a sentence and/or keywords. ' +
      'Use when the user mentions past discussions ("what we talked about last week", "previously discussed X") ' +
      'OR when you cannot find what they refer to in the current context window (it may have been compacted out). ' +
      'Returns matching snippets + session/message anchors you can resolve via history_get_context.',
    inputSchema: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: '自然语言一句话（推荐）' },
        keywords:  { type: 'array', items: { type: 'string' }, description: '关键词数组（OR boost）' },
        scope: {
          type: 'string',
          enum: ['all', 'exclude_current'],
          default: 'all',
          description: 'all=也索当前 session（可找回 compact 内容）；exclude_current=agent 自查历史时排除当前',
        },
        time_range: {
          type: 'object',
          properties: {
            after:  { type: 'string', description: 'ISO 时间或 ULID 下界（含）' },
            before: { type: 'string', description: 'ISO 时间或 ULID 上界（不含）' },
          },
        },
        top_k: { type: 'number', default: 8, minimum: 1, maximum: 50 },
      },
    },
    // query / keywords 至少一个（在 run 入口校验，不在 schema required）
  },
  policy: { kind: 'auto' },   // read-only 免审批
  async run(input, ctx) {
    if (!input.query && !(input.keywords?.length)) {
      return textResult('history_search: query 和 keywords 至少提供一个');
    }
    // SearchEngine.search 双参签名（query, opts）；tool 层把 schema 字段映射到 SearchOptions
    const hits = searchEngine.search(input.query ?? '', {
      keywords: input.keywords,
      ...(input.scope === 'exclude_current' && ctx.sessionId
        ? { scope: 'exclude_current', currentSession: ctx.sessionId }
        : {}),
      ...parseTimeRange(input.time_range),    // {after?, before?} 平铺到 opts
      topK: input.top_k ?? 8,
    });
    if (hits.length === 0) return textResult('历史会话中未找到匹配内容。可尝试更换关键词或 refine 查询。');
    return textResult(formatHits(hits));
  },
};
```

**调用约定**（对齐 search_engine.md §3.5）：
- **双参签名**：`search(query: string, opts: SearchOptions)`，**非**单参数对象；同步返回（SqlDriver.all 同步）
- **scope 映射**：tool schema 的 `scope=exclude_current` + `ctx.sessionId` → SearchOptions 的 `{ scope: 'exclude_current', currentSession }`；`scope=all` 不传 scope 字段（默认）
- **time_range 平铺**：tool schema 的 `time_range: {after, before}` → SearchOptions 的 `after` / `before`（去 nested 对象）
- **top_k → topK**：tool schema 用 snake_case `top_k`（LLM 友好），SearchOptions 用 camelCase `topK`
- **依赖注入**：tool 不直接 import SearchEngine 单例；从 `ctx.config.historyToolDeps.searchEngine` 取（bootstrap 注入 `HistoryToolDeps = { searchEngine, sessionStore }`，与 history_get_context 共用）

**query/keywords 二选一**：query 走全文召回；keywords 拼 OR 表达式作 boost；二者都传时合并。`scope` 一期只暴露 `all` / `exclude_current` 两个枚举（API 简化）。

## 3. 返回结构

```typescript
interface HistorySearchHit {
  sessionId: string;
  sessionTitle: string | null;
  messageId: string;        // 全链路锚点（= transcript record id）
  role: 'user' | 'assistant';
  timestamp: string;        // = messageId（ULID 字典序=时间序）
  snippet: string;          // FTS5 snippet(text, '«', '»', ' … ', 12)
  score: number;            // 最终综合分（bm25 + recency）
}
```

**tool 输出格式**（给 LLM 读的纯文本）：
```
找到 3 条匹配：
[1] session=01H...  msg=01H...  role=user  ts=2026-07-10
   «...上周讨论的打包方案是 dmg + asar...»
[2] ...
```

LLM 看到感兴趣的 messageId → 调 `history_get_context(sessionId, messageId)` 取完整上下文。

## 4. 边界（read-only，与引擎的关系）

- 调 `SearchEngine.search()` 拿 hits（见 `../../persistence/[P1]search_engine.md §3.5`）
- **不读** transcript（召回/snippet 全用副本）
- **不写** search.sqlite（read-only tool）
- sanitize 在 SearchEngine 内部（防 FTS5 控制字符注入）；tool 层不做字符串清理

## 5. 配置

tool_config 归属（`tool_policy.md §3` 调参组）：
- `top_k` default 8（代码默认，schema default）
- 无需 app_config group（一期）

## 6. 测试覆盖（UT）

- query 命中 / keywords OR boost / 二者合并
- scope=all vs exclude_current（当前 session 命中是否过滤）
- 无命中 → 空数组 + 友好提示（不抛错）
- query/keywords 都缺 → 错误提示（不抛错）
- top_k 上限保护

## 7. 版本

> 变更历史见 `log.md` + `specs/tech/version_logs/v0.0.126/change_log.md`。

---
type: spec
title: History Get Context Tool（LLM tool，read-only，按 messageId 回 transcript 取上下文窗）
priority: P1
status: active
updated: 2026-07-12
since: v0.0.126
---

# History Get Context Tool — LLM tool，read-only（回 transcript）

> 上游：PRD `specs/prd/overall/11-history-search.md §11.2.2` · 引擎边界 `../../persistence/[P1]search_engine.md §3.6`。
> 同族：`[P1]history_search_tool.md`（FTS5 召回 → 给出 messageId）。
> 回源 API：`../session/[P0]session_store.md`（`getMessages(range)` 分页）。

## 1. 概述

`history_get_context` = LLM 拿 `history_search` 返回的 `messageId` 锚点，取该消息前后的 transcript 上下文窗（结构化 ContentBlock[]，含 image / tool_use / tool_result 等副本没有的部分）。

**为何独立于 history_search**：
- 召回/snippet 用副本（零 IO、快，纯文本足够定位）
- 取详情/结构化内容必须回 transcript（副本没存这些）
- 这是 search_engine §3.6 边界：「召回 recordId → 回 CrudStore/SessionStore.get 取详情」

**read-only / 免审批**：仅读 transcript，不改任何状态。tool_policy=`auto`。

## 2. Tool 契约（ToolDefinition）

```typescript
const historyGetContextTool: Tool = {
  definition: {
    name: 'history_get_context',
    description:
      'Get the transcript context window around a specific message (by messageId anchor ' +
      'returned from history_search). Returns full structured ContentBlocks including images, ' +
      'tool_use, tool_result that the search index does not store. ' +
      'Use after history_search gave you a messageId you want to inspect in full.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'messageId'],
      properties: {
        sessionId: { type: 'string', description: '目标 session（来自 history_search hit.sessionId）' },
        messageId: { type: 'string', description: '锚点 messageId（来自 history_search hit.messageId）' },
        before:    { type: 'number', default: 5, minimum: 0, maximum: 50, description: '前置消息数' },
        after:     { type: 'number', default: 5, minimum: 0, maximum: 50, description: '后置消息数' },
      },
    },
  },
  policy: { kind: 'auto' },   // read-only 免审批
  async run(input, ctx) {
    // around 窗口语义用两次 getMessages 组合实现（不改 MessageRange）：
    //   before 段 = getMessages(beforeId=messageId, limit=before)   → messageId 字典序之前的 N 条（不含锚点）
    //   after 段  = getMessages(fromId=messageId, limit=after+1)    → 含锚点在内的后 N+1 条
    //   合并去重保 id 升序输出（ULID 字典序 = 时间序，旧→新）
    const [beforeRes, afterRes] = await Promise.all([
      sessionStore.getMessages(sessionId, { beforeId: messageId, limit: before }),
      sessionStore.getMessages(sessionId, { fromId: messageId, limit: after + 1 }),
    ]);
    const messages = mergeAroundWindow(beforeRes.items, afterRes.items);
    if (messages.length === 0) {
      return textResult(`history_get_context: session=${input.sessionId} 中未找到 messageId=${input.messageId}（可能已被删除或不在 transcript）`);
    }
    return textResult(formatContextWindow(messages, messageId));
  },
};
```

## 3. 回源实现路径（两次 getMessages 组合实现 around 窗口）

```
history_get_context(sessionId, messageId, before, after)
  → Promise.all([
      sessionStore.getMessages(sessionId, { beforeId: messageId, limit: before }),     // 前 N 条（不含锚点）
      sessionStore.getMessages(sessionId, { fromId: messageId, limit: after + 1 }),    // 含锚点的后 N+1 条
    ])
  → mergeAroundWindow(beforeItems, afterItems)   // 去重 + 按 id 升序
  → Message[] (含完整 content ContentBlock[])
```

**[设计决策：组合调用而非扩 MessageRange]**：`SessionStore.getMessages(sessionId, range?: MessageRange)` 的 `MessageRange` 当前支持 `{limit?, beforeId?, fromId?, upToId?}`（ULID 字典序分页）。本工具**不扩 MessageRange 加 `around` 字段**——对外语义「messageId 前后 N 条」用现有 `beforeId` + `fromId` 两次调用组合实现即可（更小改动面，不改 store 契约）。

- `beforeId=messageId` → 返回 messageId **之前**的 N 条（字典序 < messageId，不含锚点）
- `fromId=messageId` → 返回 messageId **起始含**的 N+1 条（字典序 ≥ messageId，含锚点 + 后 N 条）
- 合并去重：before 段 + after 段可能有边界重叠 → 用 `Set<id>` 去重 + 按 id 升序排（旧→新）
- 两次调用 `Promise.all` 并发（无依赖）

## 4. 返回结构

输出给 LLM 的纯文本格式（不直接返回 ContentBlock JSON，避免图片/大 tool_result 灌爆上下文）：
```
session=01H...  围绕 msg=01H...  前 5 条 + 本条 + 后 5 条：

[01H...role=user]
"...用户说的完整文本..."
[01H...role=assistant]
"...assistant 完整回复..."
[01H...role=assistant]
"<tool_use name=web_fetch>...</tool_use>"   ← 结构化内容透出
```

**截断策略**（一期简化）：
- 单 message 文本超 ~8k chars → 截断 + 记 offload 标记
- 图片 block → 输出 `[image: omitted]`（一期不返 image data，二期 tool reload 可扩展）
- tool_result block 超 ~25k chars → 截断 + 标记

## 5. 边界（read-only，回源语义）

- 调 `SessionStore.getMessages()` 读 transcript（**不读** search.sqlite）
- **不写**任何状态
- sessionId/messageId 不存在或不匹配 → 空数组 + 友好提示（不抛错）
- 结构化内容（image/tool_use/tool_result）依赖 transcript，副本无法替代

## 6. 测试覆盖（UT）

- 正常 around 窗口（before/after 各 N 条 + 本条）
- messageId 是最早消息（before=0）/ 最晚消息（after=0）边界
- messageId 不存在 → 空 + 提示
- 长文本截断 + offload 标记
- tool_use/tool_result 结构化内容透出

## 7. 版本

> 变更历史见 `log.md` + `specs/tech/version_logs/v0.0.126/change_log.md`。

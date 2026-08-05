---
type: spec
title: Mention Search API 设计
priority: P0
status: active
updated: 2026-07-15
since: v0.0.45
---

# Mention Search API 设计

> 管什么：server 端 mention search service 的设计——如何从 sessionId 解析 workspaceDir / memberId / squadId，路由到对应 provider 执行搜索。
> 不管什么：HTTP 端点契约（→ `specs/api/`）；provider 接口（→ `provider-interface.md`）；消息 content（→ `message-content.md`）。
> 消费者：`handlers/mention-search.ts`（HTTP handler）→ 本 service → `MentionProviderRegistry.search`。

## 1. 搜索流程

```
GET /mention/search?provider=file&query=foo&sessionId=xxx&limit=20
  │
  ▼
handler: mention-search.ts
  │  1. 解析 query 参数（provider / query / sessionId / limit / cursor）
  │  2. 参数校验（必填项 / limit 范围）
  │  3. 从 sessionId 查 session record
  │  4. 构造 SearchCtx（workspaceDir 解析 + bizType/sessionType 填充）
  ▼
service: MentionSearchService
  │  5. registry.search(providerName, ctx)
  │  6. provider 执行搜索（FileProvider / SkillProvider）
  ▼
返回 { items: MentionItem[], nextCursor?: string }
```

## 2. SearchCtx 构造逻辑

handler 从 `sessionId` 查 `Session` record，按以下规则构造 `SearchCtx`：

```typescript
/**
 * 从 session record 构造 SearchCtx。
 * 核心：解析 workspaceDir（不同 bizType/sessionType 来源不同）。
 */
async function buildSearchCtx(
  sessionId: string,
  query: string,
  limit: number,
  cursor?: string,
): Promise<SearchCtx> {
  const session = await store.getSession(sessionId);
  if (!session) throw new NotFoundError('session not found');

  // workspaceDir 解析（按 bizType + sessionType 分流）
  let workspaceDir: string;

  if (session.bizType === 'studio') {
    // studio session：按 sessionType 区分
    if (session.type === 'leader' || session.type === 'squad') {
      // leader/squad → 团队 workspace（从 squad entity 取）
      const squad = await squadStore.getSquad(session.squadId!);
      workspaceDir = squad.workspaceDir;
    } else if (session.type === 'mate') {
      // mate → member 个人 workspace
      const member = await memberStore.getMember(session.squadId!, session.memberId!);
      workspaceDir = member.workspaceDir;
    } else if (session.type === 'subagent') {
      // subagent → 继承 parent session workspaceDir
      workspaceDir = await resolveParentWorkspaceDir(session.parentSessionId!);
    } else {
      // 不应出现（studio session type 必为上述之一）
      workspaceDir = session.workspaceDir;
    }
  } else {
    // playground session：直接用 session.workspaceDir
    // rocky / subagent（playground 内 subagent）
    if (session.type === 'subagent' && session.parentSessionId) {
      workspaceDir = await resolveParentWorkspaceDir(session.parentSessionId);
    } else {
      workspaceDir = session.workspaceDir;
    }
  }

  return {
    query,
    limit,
    cursor,
    bizType: session.bizType ?? 'playground',
    sessionType: session.type ?? 'rocky',
    sessionId,
    workspaceDir,
    memberId: session.memberId,
    squadId: session.squadId,
    parentSessionId: session.parentSessionId,
  };
}

/** 递归取 parent session 的 workspaceDir */
async function resolveParentWorkspaceDir(parentId: string): Promise<string> {
  const parent = await store.getSession(parentId);
  return parent?.workspaceDir ?? '';
}
```

## 3. 参数校验

| 参数 | 必填 | 默认值 | 范围 |
|---|---|---|---|
| `provider` | 是 | — | 已注册的 provider name（'file' / 'skill'） |
| `query` | 是 | — | 非空字符串 |
| `sessionId` | 是 | — | 有效 session ULID |
| `limit` | 否 | 20 | 1-100 |
| `cursor` | 否 | undefined | provider 定义的游标字符串 |

**错误响应**：

| 错误 | HTTP 状态码 | 场景 |
|---|---|---|
| 参数缺失 / 非法 | 400 | provider / query / sessionId 缺失；limit 超范围 |
| session 不存在 | 404 | sessionId 无效 |
| provider 未注册 | 404 | provider name 不在 Registry 中 |
| 内部错误 | 500 | provider 搜索异常 |

## 4. 错误处理

```typescript
// handler 层错误处理（伪代码）
try {
  const ctx = await buildSearchCtx(sessionId, query, limit, cursor);
  const result = await registry.search(providerName, ctx);
  return json(200, result);
} catch (e) {
  if (e instanceof NotFoundError) return json(404, { error: e.message });
  if (e instanceof ValidationError) return json(400, { error: e.message });
  return json(500, { error: 'internal search error' });
}
```

## 5. 性能考量

- **FileProvider**：递归遍历 workspaceDir（排除 node_modules/.git），文件名包含匹配。预期 <10000 文件时延迟 <100ms。大 workspace 可通过 limit/cursor 分页控制单次返回量。
- **SkillProvider**：`SkillResolver.resolve()` 全量枚举 + 模糊匹配。skill 数量预期小（数十个），无性能问题。
- **Registry 实例复用**：Registry 在 bootstrap 阶段单例创建，handler 层共享引用，无重复初始化开销。

## 6. 未决事项

1. **workspace 文件搜索的 debounce**：前端输入每个字符都触发 search API，大 workspace 可能产生大量请求。后续可在前端加 200ms debounce 或在 server 加请求取消。
2. **搜索结果排序**：首版按文件名匹配顺序返回（无权重排序）。后续可加「最近使用」「收藏」等排序维度。
3. **SkillProvider workspace scope 过滤**：不同 sessionType 是否需要差异化 skill 可见集（如群聊只展示全局 skill）。首版返回全量可见 skill。

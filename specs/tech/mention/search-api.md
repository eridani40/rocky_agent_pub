---
type: spec
title: Mention Search API 设计
priority: P0
status: active
updated: 2026-08-15
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

- **FileProvider**：**v0.0.346 起收敛为 workspace-search-core 的适配层**——`search()` 调 `searchWorkspace(ctx.workspaceDir, ctx.query)`（`app/server/src/search/workspace-search-core.ts`），与工作区搜索端点（`GET /session/:id/workspace/search`）**共用同一遍历/排除/上限核心**（IGNORED_NAMES 单一源在 `session-workspace.ts`，排除仅 node_modules/.git）。**symlink 目录受控跟随（与树端点链式授权同模型）：workspace 内 symlink = 授权（目标可在 workspace 外，如 squad `project` 链接）；realpath visited 防循环；broken symlink 跳过；symlink→file 可命中**（契约见 `specs/api/overall/04-agent-session.md` §2.6.8 行为 6）。命中集合 = 文件 + 目录（目录命中不递归其下层），files+dirs ≥ 100 早停 → `truncated: true`；目录条目复用 `type='file'` + `path=目录相对路径`。**v0.0.346-2 起目录条目带 `isDir:true` + `listView.icon='folder'`**（文件条目 isDir 缺省 + `icon='file'`）；`subtitle` 根路径（dirname='.'）渲染 `'/'` 始终展示；`display.icon` 保持 `'file'`（pill 不区分，防历史消息不一致）。FileProvider 原 5s 超时兜底移除（100 早停保障），点开头不再排除（仅 IGNORED_NAMES）。
- **SkillProvider**：`SkillResolver.resolve()` 全量枚举 + 模糊匹配。skill 数量预期小（数十个），无性能问题。
- **Registry 实例复用**：Registry 在 bootstrap 阶段单例创建，handler 层共享引用，无重复初始化开销。

## 6. 未决事项

1. ~~**workspace 文件搜索的 debounce**~~（v0.0.346 决策：不强制统一，保持现状——@ 搜索 200ms 面板内实时反馈，工作区搜索 500ms（v0.0.328 已从 300 调 500）。场景不同，改工作区防抖有回归风险。）
2. **搜索结果排序**：首版按文件名匹配顺序返回（无权重排序）。后续可加「最近使用」「收藏」等排序维度。
3. **SkillProvider workspace scope 过滤**：不同 sessionType 是否需要差异化 skill 可见集（如群聊只展示全局 skill）。首版返回全量可见 skill。
4. **缓存索引不引入**（v0.0.346 决策）：实时遍历 + 100 上限早停已控成本（与工作区搜索现状一致，无索引）；共享索引需文件变更失效（watch 集成）复杂度高、收益低。

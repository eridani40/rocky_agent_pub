---
type: spec
title: MentionProvider 接口 + Registry + 内置 Provider
priority: P0
status: active
updated: 2026-08-14
since: v0.0.45
---

# MentionProvider 接口 + Registry + 内置 Provider

> 管什么：mention provider 的接口契约（`MentionProvider`）、搜索上下文（`SearchCtx`）、结果结构（`MentionItem`）、Registry 注册机制、内置 FileProvider / SkillProvider / WorkItemProvider / MemberProvider 实现要点。
> 不管什么：HTTP 端点（→ `GET-search.md`）；消息 content 编码（→ `message-content.md`）；前端组件（→ `specs/ui/components/chat-page/`）。
> 消费者：server `handlers/mention-search.ts`（调 Registry.search）；前端 MentionPopover（消费 MentionItem 渲染列表 + 透传整条 item 到 ChatComposer）。

## 1. MentionProvider 接口

```typescript
interface MentionProvider {
  /** provider 唯一标识（如 'file'、'skill'、'workitem'、'member'）；前端 tab 切换时传此值 */
  readonly name: string;
  /** provider 显示标签（如 'Files'、'Skills'）；前端 tab 标题 */
  readonly label: string;
  /**
   * 执行搜索。search 时构建完整 MentionItem（address + display 全字段）。
   * @param ctx 搜索上下文（handler 层从 sessionId 解析）
   * @returns 搜索结果列表（最多 ctx.limit 条）+ 可选分页游标
   */
  search(ctx: SearchCtx): Promise<SearchResult>;
}

interface SearchResult {
  items: MentionItem[];
  nextCursor?: string;
  /** [v0.0.346] 是否达搜索上限（files+dirs 合计 100）早停截断；handler 响应仅 true 时输出，缺省省略向后兼容 */
  truncated?: boolean;
}
```

**INV-1（v0.0.86）**：provider `search` 产出**即完整内容**——address + display 全在 search 时构建好。前端拿到什么存什么、渲染什么，不做推导/补全/二次查询。

## 2. SearchCtx（搜索上下文）

```typescript
interface SearchCtx {
  query: string;
  limit: number;
  cursor?: string;
  bizType: BizType;
  role: Role;
  derivation: Derivation;
  biz: BizType;
  sessionId: string;
  workspaceDir: string;
  memberId?: string;
  squadId?: string;
  parentSessionId?: string;
}
```

（字段语义同 v0.0.56 hotfix 后定义；workspaceDir 解析规则见 `GET-search.md §5`。）

## 3. MentionItem（搜索结果，v0.0.86 重构）

**核心 = address（稳定句柄）+ display（呈现快照）双关注点强制分离**。

```typescript
interface MentionItem {
  /** 类型标识（'file' | 'skill' | 'workitem' | 'member'，开放枚举） */
  type: string;
  /** [v0.0.346-2] 是否为目录条目（file provider 目录命中 true；缺省 = 文件，向后兼容；member/skill/workitem 不设） */
  isDir?: boolean;

  // ─── Address（语义/地址；按 type 不同字段不同） ───
  /**
   * file/skill: 工作路径（file=workspaceDir 下相对路径；skill=绝对目录）。
   * workitem/member: **不使用此字段**（address 走 `kind`+`id` / `id`）。
   */
  path?: string;
  /** workitem 专属：kind ∈ {goal, kr, requirement, task}（v0.0.86 拆出，不再塞 path） */
  kind?: string;
  /** workitem / member 专属：workitem=store 工作项 ID（G-0001/T-0001）；member=memberId ULID */
  id?: string;

  // ─── Display（呈现；前端 pill 唯一渲染依据） ───
  /**
   * 全类型统一闭集合 `{ icon, label, badge? }`。
   * provider search 时构建——前端零推导、零补全、零二次查询。
   */
  display: {
    /** glyph key（前端 Glyph registry 注册的 SVG key） */
    icon: string;
    /** 主文本（不含 @ 前缀；file=basename / skill=name / workitem=title / member=name） */
    label: string;
    /** 徽标（可空；member role==='leader' 时 'leader'，其余省略） */
    badge?: string;
  };

  /** 列表渲染视图（MentionPopover 结果列表用；v0.0.86 决策：并存，由 provider 同步构建） */
  listView: {
    title: string;
    subtitle?: string;
    icon?: string;
  };
}
```

**字段决策（v0.0.86）**：

| 字段 | 来源 | 用途 |
|---|---|---|
| `display`（新） | provider search 构建 | pill 渲染唯一权威源；序列化进 message tag flat 属性 |
| `listView`（保留） | provider search 构建 | popover 列表项渲染（title/subtitle/icon）；与 display 并存 |
| `path` | provider 构建 | file/skill 地址；workitem/member 不用 |
| `kind`（新） | WorkItemProvider 构建 | workitem 地址（拆出，不再塞 path） |
| `id`（新） | WorkItem/MemberProvider 构建 | workitem/member 地址 |
| `isDir`（v0.0.346-2 新） | FileProvider 构建 | file provider 目录命中 true；缺省 = 文件（向后兼容） |

**为什么 `display` 与 `listView` 并存**（v0.0.86 决策）：
- `display` 是 pill 渲染权威源（写入 message tag 持久化；3 字段闭集合）
- `listView` 是 popover 列表渲染源（运行时短暂消费，不持久化；含 subtitle 副标题如 `task · pending`）
- 二者字段集不同（listView 有 subtitle，display 没有）；强行合并会污染 message tag
- 由 provider 在 search 时**同步构建**（同一数据源派生两视图），保证一致

**删除的字段**：
- ~~`detail`~~：v0.0.86 删（用户判定冗余，workitem id 只留 address）
- ~~`id`（v0.0.45 旧）~~：与 path 冗余
- ~~`pillInfo.label` / `pillInfo.payload`（v0.0.45 旧）~~：display 取代

## 4. MentionProviderRegistry

```typescript
class MentionProviderRegistry {
  register(provider: MentionProvider): void;
  search(providerName: string, ctx: SearchCtx): Promise<SearchResult>;
  listProviders(): Array<{ name: string; label: string }>;
}
```

注册时机：`bootstrap-mention.ts` 启动时实例化 Registry 并注册 4 个内置 provider（File / Skill / WorkItem / Member）。

## 5. FileProvider 实现要点（v0.0.346 收敛为 workspace-search-core 适配层）

- **name** = `'file'` / **label** = `'Files'`
- **搜索范围**：`ctx.workspaceDir` 下递归遍历（含子目录）
- **共用后端（v0.0.346）**：`search()` 调 `searchWorkspace(ctx.workspaceDir, ctx.query)`（`app/server/src/search/workspace-search-core.ts`）——与工作区搜索端点（`GET /session/:id/workspace/search`）**共用同一遍历/排除/上限核心**（纯函数，同步 DFS：readdirSync/statSync/lstatSync；IGNORED_NAMES 单一源在 `session-workspace.ts`；symlink 目录不递归防越权/循环）
- **排除规则（v0.0.346 修订）**：仅 `IGNORED_NAMES`（`node_modules` + `.git`）；**点开头不再排除**（原隐藏文件 `.*` 排除移除，点开头目录/文件可命中）
- **搜索算法**：与工作区搜索一致——q 含 `/` → 完整相对路径包含匹配（pathMode），否则 basename 包含匹配；大小写不敏感；**目录命中推入结果但不递归其下层**；无索引，实时遍历
- **上限**：files+dirs 合计 ≥ **100** 早停 → `truncated: true`（v0.0.346 起，`SEARCH_LIMIT` 单一源在 workspace-search-core；原 5s 超时兜底移除）
- **分页**：`limit` + `cursor`（cursor = base64 编码的 offset；合并 files+dirs 按 relPath 排序后切片，dirs 在前）
- **MentionItem 构建**（`toMentionItem(relPath, isDir = false)`，目录条目复用 file 形态）：
  - `type` = `'file'`（**目录条目同样 type='file'**，选中/插入/pill 走既有路径）
  - **`isDir`**（v0.0.346-2 起）：目录命中 `isDir:true`；文件 isDir 缺省（向后兼容）
  - `path` = 相对 workspaceDir 的 POSIX 路径（如 `src/utils/helper.ts`；目录如 `src/components`）
  - `display.icon` = `'file'`（**目录同样 'file'，pill 不区分，防历史消息不一致**）；`display.label` = basename（文件或目录名）
  - `listView.title` = basename；`listView.subtitle` = 相对目录（`src/utils/`；**根路径 dirname='.' → `'/'` 始终展示**，v0.0.346-2）；`listView.icon` = 目录 `'folder'` / 文件 `'file'`（v0.0.346-2）

## 6. SkillProvider 实现要点

- **name** = `'skill'` / **label** = `'Skills'`
- **搜索范围**：`SkillResolver.resolve(workspaceDir)` 返回的全量 `SkillCatalog`（三层：builtin + app + workspace）
- **搜索算法**：skill name 包含匹配（仅 enabled 项）
- **MentionItem 构建**（`toMentionItem(entry: SkillEntry)`）：
  - `type` = `'skill'`
  - `path` = skill 绝对目录路径（`SkillEntry.skillDir`）
  - `display.icon` = `'skill'`
  - `display.label` = skill name
  - `listView.title` = skill name；`listView.subtitle` = description 截取前 60 字符；`listView.icon` = `'skill'`

## 7. WorkItemProvider 实现要点（v0.0.68 新增 / v0.0.86 改 kind+id 拆出）

- **name** = `'workitem'` / **label** = `'WorkItems'`
- **搜索范围**：当前 squad 的 board store 全集——goals（含嵌套 KR）/ requirements / tasks
- **数据来源**（实现权威，对齐 `app/server/src/mention/providers/workitem-provider.ts`）：
  - `boardStore.listGoals(squadId)` + `listRequirements(squadId)` + `listTasks(squadId)` 三次拉全集合视图层调 `buildAncestorView({goals, requirements, tasks})` 构造联合检查索引
  - 归档过滤走 `effectiveArchived(...)`（含 self archived + 被祖先拽入归档）
- **搜索算法**：title 模糊匹配（小写包含），无分页
- **MentionItem 构建**（`toMentionItem(kind, id, title, status)`）：
  - `type` = `'workitem'`
  - **`kind`** = `'goal'` / `'kr'` / `'requirement'` / `'task'`（**v0.0.86 拆出**，不再塞 path）
  - **`id`** = store 工作项 ID（G-0001 / KR-0001 / R-0001 / T-0001）
  - `display.icon` = kind（`'goal'` / `'kr'` / `'requirement'` / `'task'`）——前端 Glyph registry 注册 4 个 SVG
  - `display.label` = title
  - `listView.title` = title；`listView.subtitle` = `${kind} · ${status}`；`listView.icon` = kind
- **依赖注入**：构造函数接 `BoardStore`
- **约束**：
  - `SearchCtx.squadId` 缺失 → 返空数组
  - 不查归档区（`effectiveArchived=true` 不入结果）

## 8. MemberProvider 实现要点（v0.0.68 新增 / v0.0.86 改 display）

- **name** = `'member'` / **label** = `'Members'`
- **搜索范围**：当前 squad 的全体成员（leader + mate，不含 bench 状态）
- **数据来源**：`memberStore.listMembers(squadId)`（squad record 仅存 `memberIds[]`，member entity 在 `members/` 子目录分片存储，走 `MemberStore.listMembers`）
- **过滤**：`state === 'deployed'` + name 模糊匹配；`MemberSchema.role` 枚举 `['leader','mate']`——天然不含 subagent
- **MentionItem 构建**（`toMentionItem(memberId, name, role)`）：
  - `type` = `'member'`
  - **`id`** = memberId（ULID）
  - `display.icon` = `'member'`
  - `display.label` = member name
  - `display.badge` = `role === 'leader' ? 'leader' : undefined`（mate 省略 badge 字段）
  - `listView.title` = name；`listView.subtitle` = role；`listView.icon` = `'member'`
- **依赖注入**：构造函数接 `MemberStore`
- **约束**：
  - `SearchCtx.squadId` 缺失 → 返空数组
  - 仅 @member 一等引用，不暴露 subagent

## 9. 未决事项

1. **FileProvider 大 workspace 性能**：>10000 文件时实时遍历可能超时；后续可加索引或 debounce
2. **SkillProvider workspace scope 过滤**：不同 sessionType 是否需要差异化 skill 集合，首版返回全量
3. provider 可见性 per session kind：见 `resolver.md`（D8 抽象，按 session kind 派生）

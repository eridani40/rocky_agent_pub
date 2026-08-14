# GET /mention/search — Mention 搜索端点

> version: 1.4 · 引入版本 v0.0.45 · 修订 v0.0.86（MentionItem 加 `display` 分组；workitem address 拆 `kind`+`id`）· 修订 v0.0.346（响应加 `truncated?: boolean`；file provider 目录条目 type='file'）· 修订 v0.0.346-2（MentionItem 加 `isDir?: boolean`；目录条目 listView.icon='folder'）
> 管什么：mention 搜索 API 端点契约——前端传 provider + query + sessionId，server 路由到对应 provider 执行搜索并返回结果列表（含 address + display 完整字段）。
> 不管什么：provider 内部实现（→ `specs/tech/mention/provider-interface.md`）；消息 content 结构（→ `specs/tech/mention/message-content.md`）；前端 MentionPopover 组件（→ `specs/ui/components/chat-page/mention-popover.md`）。
> **本文件是 AT（API Test）mention search 域的唯一依据**：api-verifier 黑盒 curl，不读代码。

## 1. 端点

| 方法 | 路径 | 语义 | 认证 |
|------|------|------|------|
| `GET` | `/mention/search` | 按 provider 搜索 mention 候选项 | 无需（loopback only） |

## 2. 请求参数（query string）

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `provider` | string | 是 | — | provider 标识（`'file'` / `'skill'` / `'workitem'` / `'member'`，受 resolver D8 矩阵限制） |
| `query` | string | 是 | — | 搜索关键词（`@` 后输入文本） |
| `sessionId` | string | 是 | — | 当前会话 ULID（server 据此解析 workspaceDir / squadId） |
| `limit` | number | 否 | 20 | 每页返回条数（范围 1-100） |
| `cursor` | string | 否 | — | 分页游标（首次不传；后续传上一次响应的 `nextCursor`） |

**示例请求**：
```
GET /mention/search?provider=file&query=help&sessionId=01KVCA58G80Y54TTF2S8ZPFR5M&limit=20
```

## 3. 成功响应（v0.0.86 schema）

**状态码**：`200 OK`

```typescript
interface SearchResponse {
  items: MentionItem[];
  nextCursor?: string;
  /** [v0.0.346] 是否达搜索上限（files+dirs 合计 100）早停截断；仅 true 时输出，缺省省略（向后兼容） */
  truncated?: boolean;
}

interface MentionItem {
  /** 类型标识（'file' | 'skill' | 'workitem' | 'member'，开放枚举） */
  type: string;
  /** [v0.0.346-2] 是否为目录条目（file provider 目录命中 true；缺省 = 文件，向后兼容；member/skill/workitem 不设） */
  isDir?: boolean;

  // ─── Address（按 type 不同字段不同） ───
  /** file/skill: 路径（file=workspaceDir 下相对；skill=绝对目录）。workitem/member: 不使用 */
  path?: string;
  /** workitem: 'goal' | 'kr' | 'requirement' | 'task'（v0.0.86 拆出，不再塞 path） */
  kind?: string;
  /** workitem: store 工作项 ID（G-0001/T-0001）；member: memberId ULID */
  id?: string;

  // ─── Display（v0.0.86 新增；pill 渲染唯一权威源） ───
  display: {
    /** glyph key（前端 Glyph registry 已注册的 SVG key） */
    icon: string;
    /** 主文本（不含 @ 前缀） */
    label: string;
    /** 徽标（member role==='leader' 时 'leader'，其余省略） */
    badge?: string;
  };

  // ─── listView（popover 列表渲染；与 display 并存，由 provider 同步构建） ───
  listView: {
    title: string;
    subtitle?: string;
    icon?: string;
  };
}
```

> **对齐说明**：v0.0.86 MentionItem 加 `display` 分组（pill 持久化权威源）+ workitem address 拆 `kind`+`id`（不再塞 path）。`listView` 保留（popover 副标题如 `task · pending` 仍需要，与 display 字段集不同故并存）。详见 `specs/tech/mention/provider-interface.md §3`。

**响应示例（file provider）**：
```json
{
  "items": [
    {
      "type": "file",
      "path": "src/utils/helper.ts",
      "display": { "icon": "file", "label": "helper.ts" },
      "listView": { "title": "helper.ts", "subtitle": "src/utils/", "icon": "file" }
    }
  ]
}
```

**响应示例（file provider — 命中超 100 早停截断，v0.0.346）**：
```json
{
  "items": [
    { "type": "file", "path": "src/utils/helper.ts", "display": { "icon": "file", "label": "helper.ts" }, "listView": { "title": "helper.ts", "subtitle": "src/utils/", "icon": "file" } },
    { "type": "file", "isDir": true, "path": "src/components", "display": { "icon": "file", "label": "components" }, "listView": { "title": "components", "subtitle": "src/", "icon": "folder" } },
    { "type": "file", "path": "README.md", "display": { "icon": "file", "label": "README.md" }, "listView": { "title": "README.md", "subtitle": "/", "icon": "file" } }
  ],
  "nextCursor": "MjA=",
  "truncated": true
}
```
> 目录命中条目复用 `type='file'` + `path=目录相对路径` + `isDir:true`（v0.0.346-2 起），`listView.icon='folder'`、`display.icon` 保持 `'file'`（pill 不区分，防历史消息不一致）；根路径条目 `subtitle='/'` 始终展示。文件条目 isDir 缺省（向后兼容）。

**响应示例（skill provider）**：
```json
{
  "items": [
    {
      "type": "skill",
      "path": "/data/skills/drama-script-writer",
      "display": { "icon": "skill", "label": "drama-script-writer" },
      "listView": { "title": "drama-script-writer", "subtitle": "专业剧本创作助手", "icon": "skill" }
    }
  ]
}
```

**响应示例（workitem provider — kind/id 拆出）**：
```json
{
  "items": [
    {
      "type": "workitem",
      "kind": "task",
      "id": "T-0001",
      "display": { "icon": "task", "label": "接口联调" },
      "listView": { "title": "接口联调", "subtitle": "task · pending", "icon": "task" }
    },
    {
      "type": "workitem",
      "kind": "goal",
      "id": "G-0001",
      "display": { "icon": "goal", "label": "提升DAU" },
      "listView": { "title": "提升DAU", "subtitle": "goal · active", "icon": "goal" }
    }
  ]
}
```

**响应示例（member provider — leader + mate）**：
```json
{
  "items": [
    {
      "type": "member",
      "id": "01J...",
      "display": { "icon": "member", "label": "张三", "badge": "leader" },
      "listView": { "title": "张三", "subtitle": "leader", "icon": "member" }
    },
    {
      "type": "member",
      "id": "01HXYZ...",
      "display": { "icon": "member", "label": "李四" },
      "listView": { "title": "李四", "subtitle": "mate", "icon": "member" }
    }
  ]
}
```

## 4. 错误响应

| 状态码 | 场景 | body |
|--------|------|------|
| `400` | 参数缺失（provider / query / sessionId） | `{ "error": "missing required parameter: provider" }` |
| `400` | limit 超范围（< 1 或 > 100） | `{ "error": "limit must be between 1 and 100" }` |
| `404` | sessionId 无效（session 不存在） | `{ "error": "session not found" }` |
| `404` | provider 未注册 | `{ "error": "unknown provider: xxx" }` |
| `500` | provider 内部异常 | `{ "error": "internal search error" }` |

## 5. workspaceDir 解析规则

server 根据 sessionId 查 session record，按以下规则确定搜索范围：

| bizType | sessionType | 搜索目录来源 |
|---|---|---|
| playground | rocky（/ undefined） | `session.workspaceDir` |
| playground | subagent | `parentSession.workspaceDir` |
| studio | leader | `squad.workspaceDir`（团队 workspace） |
| studio | mate | `member.workspaceDir`（个人 workspace） |
| studio | squad | `squad.workspaceDir`（团队 workspace） |
| studio | subagent | `parentSession.workspaceDir` |

详见 `specs/tech/mention/search-api.md` §2。

## 6. 分页

- **cursor 语义**：由 provider 定义（file provider = 文件路径偏移；skill provider 无需分页）。
- **首次搜索**：不传 cursor。
- **翻页**：传上一次响应的 `nextCursor`。
- **终止条件**：响应中无 `nextCursor` 字段或缺失 = 无更多结果。
- **truncated 语义（v0.0.346）**：file provider 命中集合（files+dirs 合计）达 100 上限早停 → 响应带 `truncated: true`（仅 true 时输出，缺省省略向后兼容）。前端据此渲染超限提示（`mention.searchTooMany`，不阻塞「加载更多」滚动翻页）；翻页 append 时 truncated 保留透传。

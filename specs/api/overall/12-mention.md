# Mention HTTP API（v0.0.45 / v0.0.86 重构）

> version: 1.2 · 引入版本 v0.0.45 · 修订 v0.0.86（MentionItem 加 `display` 分组；workitem address 拆 `kind`+`id`）
> 管什么：@ mention 系统的 HTTP 端点契约——`GET /mention/search`（搜索候选项）。`POST /session/:id/messages` body 仍是 `string`（mention 内嵌 XML tag，详见 `04-agent-session.md`）。
> 不管什么：provider 内部实现（→ `specs/tech/mention/`）；前端 MentionPopover 组件（→ `specs/ui/components/chat-page/mention-popover.md`）。
> **本文件是 AT（API Test）mention 域的唯一依据**：api-verifier 黑盒 curl，不读代码。

## 1. 概述

mention 搜索端点，供前端 MentionPopover 获取候选项（含 address + display 完整字段，前端透传 + 直接渲染）。`POST /session/:id/messages` 的 body.content 仍是 `string`——mention 以单行 XML tag `<mention .../>` 内嵌（v0.0.86 全属性 flat：address + display 同串持久化）。

| 端点 | 方法 | 功能 | 增量文档 |
|---|---|---|---|
| `/mention/search` | GET | 按 provider 搜索 mention 候选项 | 本文件 §2 |
| `/session/:id/messages` | POST | 发消息（body content = string，mention 内嵌 tag） | `04-agent-session.md` §3.2 |

## 2. `GET /mention/search` — Mention 搜索

| 方法 | 路径 | 语义 |
|------|------|------|
| `GET` | `/mention/search` | 按 provider 搜索 mention 候选项 |

### 2.1 请求参数（query string）

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `provider` | string | 是 | — | `'file'` / `'skill'` / `'workitem'` / `'member'`（resolver D8 矩阵限制） |
| `query` | string | 是 | — | 搜索关键词 |
| `sessionId` | string | 是 | — | 会话 ULID |
| `limit` | number | 否 | 20 | 1-100 |
| `cursor` | string | 否 | — | 分页游标 |

### 2.2 成功响应（v0.0.86 schema）

**状态码**：`200 OK`

```typescript
{
  items: Array<{
    type: string;          // 'file' | 'skill' | 'workitem' | 'member'
    // Address（按 type 不同字段不同）
    path?: string;         // file/skill: 路径
    kind?: string;         // workitem: 'goal'|'kr'|'requirement'|'task'（v0.0.86 拆出）
    id?: string;           // workitem/member: store ID / memberId ULID
    // Display（v0.0.86 新增；pill 渲染唯一权威源）
    display: {
      icon: string;        // glyph key
      label: string;       // 主文本（不含 @ 前缀）
      badge?: string;      // 徽标（member leader）
    };
    // listView（popover 列表渲染；与 display 并存）
    listView: {
      title: string;
      subtitle?: string;
      icon?: string;
    };
  }>;
  nextCursor?: string;
}
```

### 2.3 错误响应

| 状态码 | 场景 |
|--------|------|
| `400` | 参数缺失 / limit 超范围 |
| `404` | session 不存在 / provider 未注册 / 未授权（resolver D8） |
| `500` | 内部异常 |

详细契约见 `specs/api/mention/GET-search.md`。

## 3. `POST /session/:id/messages` — body.content = string

既有端点完整契约见 `04-agent-session.md` §3.2。v0.0.86 关键点：

- `body.content` = `string`（不变；mention 以单行 XML tag 内嵌）
- mention tag = `<mention type=".." {address} {display}/>` flat 属性（address + display 同串持久化）
- server **零处理透传**：原样落库 / 发 SSE / 发 LLM / 回显同一份字符串
- 详见 `specs/tech/mention/message-content.md`

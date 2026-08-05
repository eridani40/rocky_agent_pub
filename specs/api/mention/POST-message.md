# POST /session/:id/messages — 消息 body 中 mention 编码说明

> version: 1.2 · 引入版本 v0.0.45 · 修订 v0.0.73（对齐 tech spec：content 回归纯 string，mention 走内嵌 XML tag）· 修订 v0.0.86（mention tag flat 全属性：address + display 同串持久化）
> 管什么：v0.0.45 对既有 `POST /session/:id/messages` 端点 body 中 mention 编码的说明——mention 以单行自闭合 XML tag 内嵌在 `content` 字符串里，server 不解析原样落库。
> 不管什么：既有端点的完整契约（→ `specs/api/overall/04-agent-session.md` §3.2）；mention search API（→ `GET-search.md`）；消息 content 内部实现（→ `specs/tech/mention/message-content.md`）。
> **增量文档**：本文件只描述 v0.0.45 起 mention 编码相关部分，完整契约仍见 `04-agent-session.md` §3.2。

## 1. 概述

既有 `POST /session/:id/messages` 的 body 是 `{ content: string }`（纯文本）。v0.0.45 引入 mention 后，mention 以**单行自闭合 XML tag 内嵌在 content 字符串**里，`content` 类型仍是纯 `string`，不引入结构化数组。v0.0.86 起 tag 改 flat 全属性（address + display 同串持久化），server 仍零处理透传。

| 维度 | v0.0.45 起 · v0.0.86 修订 |
|---|---|
| body.content 类型 | `string`（不变） |
| mention 编码 | 内嵌 `<mention type=".." {address} {display}/>` flat 全属性 tag（v0.0.86 起含 display） |
| 落库格式 | ContentBlock[] text（content 原样作为 text 文本） |
| LLM payload | content 原样字符串（含 `<mention .../>` tag） |

## 2. 请求体

```typescript
interface PostMessageBody {
  /**
   * 消息内容（纯字符串）。
   * mention 以内嵌单行自闭合 XML tag 编码：v0.0.86 起 flat 全属性
   *   <mention type=".." {address} {display}/>
   * server 不解析 tag、不拆分节点——原样作为一条 text 落库并传给 LLM。
   */
  content: string;

  /** 以下字段不变（见 04-agent-session.md §3.2） */
  providerId?: string;
  modelId?: string;
}
```

**mention tag 格式**（v0.0.86 flat 全属性；详见 `specs/tech/mention/message-content.md §3/§4`）：

```
<mention type="file"     path="src/utils/helper.ts"              icon="file" label="helper.ts"/>
<mention type="skill"    path="/data/skills/drama-script-writer" icon="skill" label="drama-script-writer"/>
<mention type="workitem" kind="task" id="T-0001"                 icon="task" label="接口联调"/>
<mention type="member"   id="01KVCA58G80Y54TTF2S8ZPFR5M"         icon="member" label="张三" badge="leader"/>
```

- tag 自闭合、单行、不嵌内容文本
- **属性 flat**（全部 `k="v"`），顺序无关；前端序列化时按 `type → address → display` 固定顺序输出（便于 diff/测试）
- **空属性省略**（不写 `badge=""`）；属性值用双引号包裹，**值做标准 XML 转义**（`"` → `&quot;`、`<` → `&lt;`、`>` → `&gt;`、`&` → `&amp;`）
- `type` 开放枚举（`file` / `skill` / `workitem` / `member` / 未来扩展），由 `specs/tech/mention/resolver.md` 派生可见集合
- address 按 type 不同字段不同：file/skill=path；workitem=kind+id（v0.0.86 拆出，不再塞 path）；member=id
- display 三字段（icon/label/badge?）= pill 渲染唯一权威源，与 address 同串持久化（INV-1）
- 多个 mention 直接拼接在 content 字符串里，前后可混任意文本

## 3. Server 处理逻辑

server 接收请求后：

1. **校验 content 是 string**：非 string 返回 `400 { error: "content must be a string" }`（`app/server/src/session/session-messages.ts:129-131`）
2. **落库**：`Message.content` = `[{ type: 'text', text: content }]`（content 原样作为一段 text，不解析 tag）
3. **LLM 拼接**：text block 原样输出（含内嵌 `<mention .../>` tag）

server **不解析、不拆分、不转换** mention tag——端到端零转换不变量（见 `specs/tech/mention/message-content.md §1`）。

**示例**：

```
// 客户端发送（v0.0.86 flat 全属性）
{ content: '请帮我看看 <mention type="file" path="src/utils/helper.ts" icon="file" label="helper.ts"/>' }

// 落库
Message.content = [{ type: 'text', text: '请帮我看看 <mention type="file" path="src/utils/helper.ts" icon="file" label="helper.ts"/>' }]

// 给 LLM 的文本（原样）
'请帮我看看 <mention type="file" path="src/utils/helper.ts" icon="file" label="helper.ts"/>'
```

## 4. 向后兼容

| 客户端形态 | server 处理 | 影响 |
|---|---|---|
| 旧客户端发 `{ content: "plain text" }` | 原样落库 | 零影响（无 mention tag） |
| 新客户端发含 `<mention .../>` 的 content | 原样落库 | 新增 mention 编码 |
| **v0.0.45/v0.0.68 旧格式 tag**（仅 type+path 两属性） | server 原样落库（透传不解释） | 新版前端 renderer 缺 display → 降级**纯文本显示**整段 tag 字符串（不 crash、不渲染 pill）；不做数据迁移 |

## 5. 错误响应（增量）

既有错误（400/404/500）不变。无新增错误码。

- **校验规则**：`content` 必须是 string（`session-messages.ts:129-131`）
- 校验失败返回 `400 { error: "content must be a string" }`

> **已删除的中间态校验**：v0.0.45 中间态曾定义 `MessageContent[]` 数组结构校验（`kind` / `type` / `id` / `label` / `payload` 等字段必填、`invalid message content structure` 错误）。该结构未落地，代码只接受 string——本 spec 已对齐代码，删除该数组校验段。

## 6. 对 GET /session/:id/messages 的影响

`GET /session/:id/messages` 返回的 `Message` 对象中：

- `content`（ContentBlock[]）：保持既有结构（text block = 原始 content 字符串，含内嵌 `<mention .../>` tag）
- 无 `metadata.structuredContent` 字段

> **已删除的中间态字段**：v0.0.45 中间态曾声明 `metadata.structuredContent`（存原始 `MessageContent[]` 数组、前端回放优先读它渲染 pill）。该结构未落地，tech spec `message-content.md §1` 已声明废弃——mention 现走 content 内嵌 tag，前端直接在 text 里渲染 `<mention .../>` 即可，无需独立 structuredContent 字段。

前端回放渲染（v0.0.86 类型无关）：扫描 text block 内的 `<mention .../>` tag，按 tag 整体匹配 + 属性扫描（顺序无关）抽取 icon/label/badge → 渲染 pill；缺 display 三字段的旧 tag → 降级纯文本显示整段 tag 字符串；无 tag 的 text 原样显示。


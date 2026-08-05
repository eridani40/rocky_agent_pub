---
type: spec
title: Mention 内嵌 XML tag 格式
priority: P0
status: active
updated: 2026-07-07
since: v0.0.45
---

# Mention 内嵌 XML tag 格式

> 管什么：mention 在消息 content 里的编码格式（内嵌单行 XML tag）、端到端零转换契约、客户端识别/渲染方式。
> 不管什么：mention provider 接口（→ `provider-interface.md`）；HTTP 端点（→ `GET-search.md`）；前端 pill 组件（→ `specs/ui/components/chat-page/mention-pill.md`）。
> 消费者：server `handlers/session-messages.ts`（原样落库）；LLM 层（原样发送）；前端消息渲染层（正则扫 tag 渲染 pill）。

## 1. 核心原则：一份 string，端到端零转换

**消息 content 保持 `string`**（既有 ContentBlock.text 契约不变）。mention 以内嵌单行 XML tag 的形式出现在字符串中，不引入结构化数组、不引入 metadata 冗余字段。

- POST body / DB 落库 / GET 返回 / SSE 事件 / LLM prompt **是同一份字符串**，中间零转换
- **只有客户端渲染时**扫一遍正则，把 mention tag 替换成 pill 组件
- **server 零处理透传**：handler 不识别、不解析、不重组 mention tag——拿到什么 string 就落库 / 发 SSE / 发 LLM / 回显什么 string

## 2. 设计原则（v0.0.86 重构）—— address / display 同串共存

**v0.0.86 翻转 v0.0.68「核心=地址，不嵌 name」决策**。新原则：

> **display 持久化自洽**——address 是稳定句柄（落库后不变化），display 是发送时刻快照（同串内嵌、随消息一起落库）。回显时 renderer 解析**同一字符串**取 display → pill，零 provider/store 调用、零重解析。

| 关注点 | 字段 | 消费者 | 前端是否解释 |
|---|---|---|---|
| **Address（语义/地址）** | `type` + 地址属性（`path` / `kind`+`id` / `id`） | LLM + 下游解析 | ❌ 透传不解释 |
| **Display（呈现）** | `icon` / `label` / `badge?`（flat 属性，不是子结构） | pill 渲染 | ✅ 唯一渲染依据 |

**为什么翻转 v0.0.68 决策**：v0.0.68「不嵌 name」是「名字易变，地址稳定」的合理主义，但落地为「pill 显示文本靠 path 末段推导」后产生连锁缺陷——workitem pill 显示裸 ID（`T-0001`）、member pill 显示裸 ULID（`01J...`）、LLM 收到无意义 ULID。**display 是发送时刻快照（实体改名后旧消息保留旧名）**——这是可接受代价，换来自洽回显 + 零运行时查询。address 仍留 tag 内作稳定句柄。

**硬约束（INV-1）**：**禁止 display 走 metadata 旁路存储**。整个 tag（address + display 全属性）作为 message content 字符串的一部分落库。`POST /messages` body、`Message.content`、SSE `delta`、LLM prompt、`GET /messages` 返回——五者同一份字符串。

## 3. Mention tag 格式（flat 属性，方案 A）

```
<mention type="<type>" {address-props} {display-props}/>
```

**规则**：
- 单行、self-closing（`/>` 结尾），无内部文本、无闭合形式
- 属性 flat（全部 `k="v"`），顺序无关；前端序列化时按 `type → address → display` 固定顺序输出（便于 diff/测试）
- 空属性省略（不写 `badge=""`）；如 `badge` 缺失即无徽标
- 属性值用双引号包裹，**值做标准 XML 转义**（`"` → `&quot;`、`<` → `&lt;`、`>` → `&gt;`、`&` → `&amp;`）——名字/title 可能含这些字符
- **无嵌套子结构**（不写 `<display .../>` 子标签，全部 flat）

### 3.1 Address 属性（按 type 拆开，不再往 path 塞复合值）

| type | address 属性 | 说明 |
|---|---|---|
| `file` | `path` | workspaceDir 下相对路径（POSIX 风格 `/` 分隔） |
| `skill` | `path` | skill 绝对目录路径（`SkillEntry.skillDir`） |
| `workitem` | `kind` + `id` | `kind` ∈ `{goal, kr, requirement, task}`；`id` = store 工作项 ID（G-0001 / KR-0001 / R-0001 / T-0001） |
| `member` | `id` | memberId（ULID） |

> **纠正 v0.0.68**：workitem 不再把 `workitem/<kind>/<id>` 塞进 path——拆 `kind`+`id` 两属性，XML flat 属性各占一格，可扩展、可独立查询。

### 3.2 Display 属性（全类型统一闭集合）

| 属性 | 含义 | file | skill | workitem | member |
|---|---|---|---|---|---|
| `icon` | glyph key | `file` | `skill` | `goal`/`kr`/`requirement`/`task`（按 kind） | `member` |
| `label` | 主文本（不含 `@` 前缀） | basename | skill name | title | 成员名 |
| `badge` | 徽标（可空） | — | — | — | `leader`（mate 省略） |

> `detail` 字段**已删**（v0.0.86 用户判定冗余）。workitem 的 id 只留 address，不进 display。

## 4. 4 type 完整报文样例

```xml
<mention type="file"     path="src/utils/helper.ts"              icon="file" label="helper.ts"/>
<mention type="skill"    path="/Users/.../drama-script-writer"   icon="skill" label="drama-script-writer"/>
<mention type="workitem" kind="task" id="T-0001"                 icon="task" label="接口联调"/>
<mention type="workitem" kind="goal" id="G-0001"                 icon="goal" label="提升DAU"/>
<mention type="member"   id="01J..."                             icon="member" label="张三" badge="leader"/>
<mention type="member"   id="01HXYZ..."                          icon="member" label="李四"/>
```

## 5. 端到端流转示例

用户在输入框输入 `请帮我看看 @helper.ts 这个文件`（`@helper.ts` 是选中的 pill，pill 文本为 `helper.ts`）。

### 5.1 前端发送（POST body）

```json
{
  "content": "请帮我看看 <mention type=\"file\" path=\"src/utils/helper.ts\" icon=\"file\" label=\"helper.ts\"/> 这个文件"
}
```

### 5.2 server 落库

`Message.content = [{ type: 'text', text: '请帮我看看 <mention type="file" path="src/utils/helper.ts" icon="file" label="helper.ts"/> 这个文件' }]`

**server 完全不处理 mention**——原样落库、原样发 SSE、原样发 LLM、原样回显。

### 5.3 SSE emit

`text_block_delta` 的 `delta` 字段包含整段字符串（含 tag），既有事件路径无改动。

### 5.4 LLM 收到

```
请帮我看看 <mention type="file" path="src/utils/helper.ts" icon="file" label="helper.ts"/> 这个文件
```

XML tag 自带语义：address（`type`+`path`）给 LLM 稳定句柄去读文件，display（`label`）给 LLM 人类可读上下文。

### 5.5 前端渲染（输入区 Tiptap + 消息区回放共用）

正则扫字符串 → 抽全部属性 → 取 `display`（icon/label/badge）→ 渲染 pill：

```
泛化正则（顺序无关，整段匹配 + 属性扫描）：
  tag 整体：/<mention\s+([^>]*?)\s*\/>/g
  属性抽取：/(\w+)="([^"]*)"/g  （在 tag 内体上跑）
```

- 命中 → 渲染 `<MentionPill icon={...} label={...} badge={...} />`
- 未命中片段 → 渲染 text
- pill 显示 `@` 前缀由 renderer 加（不在 `label` 属性里）

**INV-2**：renderer 只读 display 三属性，无 `if (type === ...)` 分支。详见 `specs/ui/components/chat-page/mention-pill.md`。

## 6. 持久化 = 渲染源自洽（核心不变量 INV-1）

display 跟 address 一起序列化进**同一条字符串**，server 原样落库 / 原样发 SSE / 原样发 LLM / 原样回显。读取回显：

- renderer 解析**同一字符串**取 display → pill
- **零 provider / store 调用**
- **零重解析、零二次查询**

**快照语义**：display 是发送时刻快照——实体改名后旧消息**保留旧名**（可接受，换来自洽回显）。address 仍留 tag 内作稳定句柄。

## 7. 向后兼容（不兼容，降级处理）

- **v0.0.45 / v0.0.68 旧 tag**（`<mention type="..." path="..."/>` 两属性）：renderer 新正则**仍能匹配**（属性抽取顺序无关），但抽出结果缺 `icon`/`label`/`badge` → renderer 降级为**纯文本显示**整段 tag 字符串（不 crash、不渲染 pill）。
- **不做数据迁移**：旧消息保留旧格式，新版用户重新发送即用新格式。
- **旧客户端**：发旧格式 tag → server 透传落库 → 新版 renderer 降级显示，不影响功能。

## 8. XML 转义规则（属性值）

| 字符 | 转义 |
|---|---|
| `"` | `&quot;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `&` | `&amp;` |

- 序列化时（前端 `serializeEditorContent`）必须转义
- 反序列化时（renderer 解析后）必须反转义
- 文件路径通常不含这些字符，但 workitem title / member name 可能含（如 `A & B Corp`）→ 必须转义

## 9. 未决事项

1. **未来扩展**：若 mention 需要更多信息（如 file 的 line range），走扩展属性 `<mention type="file" path="..." icon="..." label="..." lines="10-20"/>`，flat 格式不变。
2. **新 type 扩展**：加新 type = provider 给新 `icon` key + 前端 Glyph registry 注册对应 SVG，渲染逻辑零改动（INV-2 保证）。

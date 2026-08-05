# v0.0.86.mention_refactor — 跨版本发布说明（Mention 报文重构）

> 版本轴发布说明（读者导向：做了什么、为什么、影响什么）。method 级 review 合同见同目录 `change_plan.md`。
> 设计权威：`reqs/[working] v0.0.86.mention_refactor/req.md`（用户拍板锁定）
> per-KB 变更历史：`specs/tech/mention/log.md`（位置轴，倒序）
> PRD 增量：`specs/prd/version_logs/v0.0.86.mention_refactor.md`

## 一句话

mention 报文重构：**provider search 产出即完整内容**（address + display 同串持久化）+ **前端完全类型无关渲染**（无 `if(type===)` 分支）。**不向后兼容**（旧 tag 降级纯文本，不迁移）。

## 两条核心不变量

- **INV-1（provider 产出即完整）**：provider `search` 时构建完整 `MentionItem`（address + display 全字段），前端拿到什么存什么、渲染什么——零推导、零补全、零二次查询。display 不走 metadata 旁路，整个 tag flat 落 message content 字符串。
- **INV-2（前端 type-agnostic）**：renderer 只按统一 `{icon,label,badge}` 渲染，无 `if(type===)` 分支。加新 type = provider 给新 icon key + Glyph registry 注册 SVG，渲染逻辑零改动。

## 为什么翻转 v0.0.68 决策

v0.0.68「核心=地址，不嵌 name」是「名字易变，地址稳定」的合理主义，但落地为「pill 显示文本靠 path 末段推导」后产生连锁缺陷：

- workitem pill 显示裸 ID（`workitem/task/T-0001` → `T-0001`，title 丢失）
- member pill 显示裸 ULID（`01J...`，人名丢失）
- LLM 收到 `<mention type="member" path="01J..."/>` 是无意义 ULID

v0.0.86 翻转：**display 是发送时刻快照**（实体改名后旧消息保留旧名——可接受代价），换来自洽回显 + 零运行时查询。address 仍留 tag 内作稳定句柄。

## 做了什么

### 模块 1: server/mention（T1，独立）

- **`types.ts`**：`MentionItem` 加 `display: { icon, label, badge? }` 必填字段；`path` 改 optional；新增 `kind?` / `id?`（workitem/member address）；新增 `MentionItemDisplay` 类型；保留 `listView`（popover 列表渲染，与 display 并存，由 provider 同步构建）。
- **`file-provider.ts` / `skill-provider.ts`**：各 `toMentionItem` 加 `display { icon, label }`，与 listView 同源。
- **`workitem-provider.ts`**：address 拆 `kind` + `id`（不再 `workitem/<kind>/<id>` 塞 path）；`display.icon = kind`（goal/kr/requirement/task 各自）；保留 listView.subtitle=`${kind}·${status}`。
- **`member-provider.ts`**：address 走 `id`（不再 path=memberId）；`display.badge='leader'` 仅 leader（mate 条件 spread 省略 badge key，序列化不含 undefined）。

### 模块 2: web/chat-page（T2，独立）

5 文件重构实现「前端类型无关渲染」：

- **`chat-composer-extension.tsx`**：`MentionAttrs` 扩 `{type, path?, kind?, id?, icon, label, badge?}`；`MentionNodeView` 用 attrs.icon/label/badge 直传 `MentionPill`（删 `deriveMentionLabel`）；`serializeEditorContent` 输出 flat 全属性 tag（顺序 type→address→display + XML 转义四字符 + 空 badge/address 省略）。
- **`component-chat-composer.tsx`**：`handleSelect` 透传整条 item（按 type 构 address + display 三字段必传，零推导）。
- **`component-mention-render.tsx`**：泛化正则整段匹配 + 属性扫描（顺序无关）；XML 反转义；删 `deriveMentionLabel`；renderer 零 type 分支；旧 tag（v0.0.45/v0.0.68 两属性）降级纯文本不 crash。
- **`primitive-mention-pill.tsx`**：`MentionPillProps` 改 `{icon,label,badge?,onRemove?}`（删 `type`）；删 `MentionIcon`（4 分支函数）；新增 `GLYPHS`（7 key 内联 SVG：file/skill/member/goal/kr/requirement/task，size 12px / strokeWidth 1.5 / currentColor，4 workitem 形状可区分）+ `BADGES`（leader 皇冠）+ `Glyph`/`Badge` helper（未注册 fallback）；DOM 改 `data-mention-icon` / `data-mention-label` / `data-mention-badge?`（替代 `data-mention-type`）。
- **`component-mention-popover.tsx`**：前端 `MentionItem` 镜像 server schema（含 display）。

### 模块 3: web/studio-page（T3，blockedBy T2）

@按钮回路签名重构对齐 T2 MentionAttrs：

- **`component-board-at-button.tsx`**：`BoardAtMentionButtonProps` 替换 `path` 为 `kind` + `id` + `label`；新增 `BoardMentionPayload { type:'workitem', kind, id, label }` 类型；`onClick` 调 `onAtMention({type:'workitem', kind, id, label})`。
- **`use-board-at-mention.ts`**：`onAtMention` 签名改 `(payload: BoardMentionPayload) => void`；prefill 构造完整 `MentionAttrs`（含 display 三字段，`icon===kind`）。
- **4 board view caller**（goals-view/task-card/requirements-view/tasks-view）+ **squad-board.tsx**：透传 kind/id/label（用作用域内 entity.title，不查 store），prop 类型透传。

## 不向后兼容

- 旧 tag（v0.0.45/v0.0.68 `<mention type path/>` 两属性）：renderer 新正则仍能匹配但缺 display → 降级**纯文本显示**整段 tag 字符串（不 crash、不渲染 pill）。
- **不做数据迁移**：旧消息保留旧格式，新版用户重新发送即用新格式。
- 旧客户端发旧格式 tag → server 透传落库 → 新版 renderer 降级显示，不影响功能。

## 测试覆盖

- **API（8/8 PASS）**：4 个 search case（file/skill/workitem/member）+ message_with_mention_tc1（PRD P6 read-back 验 display 属性原样存活）+ 3 个无关 case（search_pagination/resolver/session_type）。
- **E2E（1/1 PASS）**：mention_flow_tc1（playground skill 流）按新 data-mention-icon/label 断言。
- **UT**：序列化/反序列化对称（含 XML 转义反转义对称：name/title 含 `<` `>` `"` `&` 时）+ Glyph registry 7 key 全可解析 + `deriveMentionLabel`/`MentionIcon` grep 0 残留 + 旧 tag 降级 + 属性顺序无关 + 多 mention 混合 roundtrip。

## 影响的 spec 文件

- `specs/tech/mention/index.md`（核心设计原则④更新：display 持久化自洽）
- `specs/tech/mention/log.md`（v0.0.86 条目）
- `specs/tech/mention/message-content.md`（重写 §2/§3/§3.1/§3.2/§4/§5/§6/§7/§8）
- `specs/tech/mention/provider-interface.md`（重写 §1/§3/§5/§6/§7/§8）
- `specs/ui/components/chat-page/mention-pill.md`（重写：Glyph registry + Props 改 icon/label/badge）
- `specs/ui/components/chat-page/chat-composer.md`（testid 节 data-mention-type → data-mention-icon）
- `specs/ui/components/studio-page/component-board-at-button.md`（签名重构对齐 T3）
- `specs/ui/components/studio-page/squad-board.md`（Props + testid 表 v0.0.86 签名）
- `specs/api/mention/GET-search.md`（v1.2 schema：display + workitem kind/id）
- `specs/api/overall/12-mention.md`（v1.2 schema 同步）
- `specs/ui/overall/02-llm-chat.md`（data-mention-type → data-mention-icon）
- `specs/prd/overall/03-llm-chat.md`（mention tag 格式对齐 v0.0.86 flat 属性）

## 不变的

- `specs/tech/mention/resolver.md`（D8 provider 可见性矩阵沿用）
- `specs/tech/mention/search-api.md`（sessionId → workspaceDir 解析规则不变）
- 消息 content 契约（仍是 `string`，不变）
- mention provider 注册机制（轻量 Registry，不走 plugin EP）
- `@` 触发字符（不引 `/` `#`）

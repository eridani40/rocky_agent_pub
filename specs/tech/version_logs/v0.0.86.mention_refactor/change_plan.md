# v0.0.86.mention_refactor 变更计划书 — Mention 报文重构（address/display 分离 + 统一渲染）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 设计权威：`reqs/[working] v0.0.86.mention_refactor/req.md`（用户拍板锁定）
> PRD：`specs/prd/version_logs/v0.0.86.mention_refactor.md`

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名/符号名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 + 项目原则编号 |
| 影响行 | +N / -M |

## 变更清单

### 模块 1: server/mention — MentionItem 类型 + 4 provider

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| mention | app/server/src/mention/types.ts | MentionItem | 修改 | 加 `display: { icon, label, badge? }` 必填字段；`path` 改 optional；新增 `kind?` / `id?` 字段（workitem/member 用） | MUST 保持 `type: string` + `listView` 字段不变（listView 与 display 并存）；MUST NOT 删 listView（popover 列表渲染仍需 subtitle） | specs/tech/mention/provider-interface.md §3 | +18/-3 |
| mention | app/server/src/mention/types.ts | MentionItemDisplay | 新增 | interface `{ icon: string; label: string; badge?: string }` —— display 字段类型 | MUST 是闭集合（不任意扩字段）；badge 仅 leader 用 | specs/tech/mention/provider-interface.md §3 | +6 |
| mention | app/server/src/mention/index.ts | (re-export block) | 修改 | 加 `MentionItemDisplay` 到 type re-export | MUST 与既有 MentionItem/MentionItemListView 同 path 导出 | specs/tech/mention/provider-interface.md §3 | +1 |
| mention | app/server/src/mention/providers/file-provider.ts | FileProvider.toMentionItem() | 修改 | 加 `display: { icon:'file', label: fileName }`（badge 不设）；保留 listView 字段（同步构建） | MUST label = basename；MUST NOT 删 listView；MUST display 与 listView 同源（同一 fileName） | specs/tech/mention/provider-interface.md §5 | +5/-0 |
| mention | app/server/src/mention/providers/skill-provider.ts | SkillProvider.toMentionItem() | 修改 | 加 `display: { icon:'skill', label: entry.name }`；保留 listView | MUST label = skill name；MUST NOT badge | specs/tech/mention/provider-interface.md §6 | +4/-0 |
| mention | app/server/src/mention/providers/workitem-provider.ts | WorkItemProvider.toMentionItem() | 修改 | 拆 address：传参改 `(kind, id, title, status)`，item 字段 `kind` + `id`（不再 path=`workitem/X/Y`）；display = `{icon:kind, label:title}` | MUST kind ∈ {goal,kr,requirement,task}；MUST icon === kind；MUST NOT 还塞 path；保留 listView.subtitle=`${kind}·${status}` | specs/tech/mention/provider-interface.md §7；req.md §2.2 | +6/-3 |
| mention | app/server/src/mention/providers/workitem-provider.ts | WorkItemProvider.search() | 修改 | 调用 toMentionItem 处已有 `(kind, id, title, status)` 实参，匹配新签名（无新增逻辑） | MUST NOT 改搜索算法；只对齐 toMentionItem 新签名 | specs/tech/mention/provider-interface.md §7 | +0/-0 |
| mention | app/server/src/mention/providers/member-provider.ts | MemberProvider.toMentionItem() | 修改 | 拆 address：`{ type:'member', id:memberId }`（不再 path=memberId）；display = `{icon:'member', label:name, badge: role==='leader'?'leader':undefined}` | MUST mate 省略 badge（不传 undefined）；MUST id === memberId；保留 listView | specs/tech/mention/provider-interface.md §8；req.md §2.3 | +6/-3 |

### 模块 2: web/chat-page — Tiptap extension + composer + render + pill + popover

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/chat-composer-extension.tsx | MentionAttrs | 修改 | 扩为 address + display 全字段：`{ type, path?, kind?, id?, icon, label, badge? }`（Tiptap node attrs） | MUST 包含全部持久化字段（icon/label/badge）；MUST NOT 仍只有 type+path | specs/tech/mention/message-content.md §3；req.md §3 | +6/-2 |
| ui-chat | app/web/src/components/chat-page/chat-composer-extension.tsx | MentionNode.addAttributes() | 修改 | 注册新 attrs：`path`/`kind`/`id`/`icon`/`label`/`badge` 各一个 attribute（default null/''） | MUST 所有 attr 都可序列化；MUST NOT 用 omit 漏持久化字段 | specs/tech/mention/message-content.md §3 | +8/-2 |
| ui-chat | app/web/src/components/chat-page/chat-composer-extension.tsx | MentionNodeView | 修改 | 渲染改用 `node.attrs.icon/label/badge` 直传 MentionPill（不再调 deriveMentionLabel） | MUST label 加 @ 前缀显示（`@${label}`）；MUST NOT 仍 import deriveMentionLabel | specs/ui/components/chat-page/mention-pill.md | +2/-2 |
| ui-chat | app/web/src/components/chat-page/chat-composer-extension.tsx | serializeEditorContent() | 修改 | mention node 序列化为 flat 全属性 tag `<mention type=".." {address} {display}/>`；按 type 决定 address 用哪些字段；display 三属性全写（badge 空省略）；值做 XML 转义（`"`→`&quot;` 等） | MUST 输出顺序固定（type→address→display，便于 diff）；MUST NOT 仍只写 type+path；MUST 转义 `<>"&`；空 badge MUST 省略 | specs/tech/mention/message-content.md §3 §8；req.md §2.4 | +18/-3 |
| ui-chat | app/web/src/components/chat-page/component-chat-composer.tsx | handleSelect() | 修改 | 透传整条 item：从 `item.type/path` 改为按 type 构造完整 MentionAttrs（path 或 kind+id 或 id + display 三字段），调 insertMention 时全字段传入 | MUST file/skill 传 path；workitem 传 kind+id；member 传 id；display 三字段必传；MUST NOT 还在 composer 里推导 label | specs/tech/mention/provider-interface.md §3；PRD 路径 P1-P4 | +12/-3 |
| ui-chat | app/web/src/components/chat-page/component-mention-render.tsx | MENTION_RE | 修改 | 泛化为整段匹配 + 属性扫描：tag 整体 `/<mention\s+([^>]*?)\s*\/>/g`；属性抽取（在 tag 内体跑）`/(\w+)="([^"]*)"/g`；顺序无关 | MUST 兼容 v0.0.86 全属性 tag；MUST NOT 仍 hardcode `type="..." path="..."` 顺序；MUST 反转义属性值（`&quot;`→`"` 等） | specs/tech/mention/message-content.md §5.5 §8 | +12/-3 |
| ui-chat | app/web/src/components/chat-page/component-mention-render.tsx | deriveMentionLabel() | 删除 | 删 path 末段推导函数（v0.0.86 display 持久化，不再推导） | MUST 同步删 chat-composer-extension.tsx 中对此函数的 import；MUST NOT 留死代码 | specs/ui/components/chat-page/mention-pill.md；req.md §3.6 | +0/-5 |
| ui-chat | app/web/src/components/chat-page/component-mention-render.tsx | MentionRender() | 修改 | 解析 tag → 取 `display.icon/label/badge` 三属性 → `<MentionPill icon={...} label={`@${label}`} badge={...} />`；display 缺失（旧 tag）→ 降级纯文本显示整段 tag 字符串 | MUST 仅按 display 渲染，零 type 分支（INV-2）；MUST 旧 tag 不 crash；MUST NOT 调 provider/store 兜底 | specs/tech/mention/message-content.md §5.5 §7；specs/ui/components/chat-page/mention-pill.md | +14/-6 |
| ui-chat | app/web/src/components/chat-page/primitive-mention-pill.tsx | MentionPillProps | 修改 | 改 `{ icon, label, badge?, onRemove? }`（删 `type`，加 `icon`/`badge`） | MUST label 语义保留（含/不含 @ 由调用方决定）；MUST NOT 保留 type 字段 | specs/ui/components/chat-page/mention-pill.md | +3/-2 |
| ui-chat | app/web/src/components/chat-page/primitive-mention-pill.tsx | MentionIcon() | 删除 | 删 `if(type===...)` 4 分支函数（统一走 Glyph registry） | MUST 同步删 MentionPill 内对它的引用；MUST NOT 留死代码 | specs/ui/components/chat-page/mention-pill.md；req.md §3.6 | +0/-46 |
| ui-chat | app/web/src/components/chat-page/primitive-mention-pill.tsx | GLYPHS | 新增 | icon key → SVG 映射的 module 常量，注册 7 个 key：`file`/`skill`/`member`/`goal`/`kr`/`requirement`/`task`（file/skill/member/task 沿用 v0.0.45/v0.0.68 SVG，goal/kr/requirement 新增 SVG） | MUST 注册 7 个 key；MUST 视觉可区分（4 workitem 不同形状）；MUST size 12px/strokeWidth 1.5/currentColor 一致；MUST NOT 用图标库（内联 SVG） | specs/ui/components/chat-page/mention-pill.md §Glyph registry；req.md §3.6 | +50 |
| ui-chat | app/web/src/components/chat-page/primitive-mention-pill.tsx | BADGES | 新增 | badge key → SVG 映射，注册 `leader`（皇冠）；可空 | MUST leader 唯一；MUST 未注册 key fallback null | specs/ui/components/chat-page/mention-pill.md | +8 |
| ui-chat | app/web/src/components/chat-page/primitive-mention-pill.tsx | Glyph({name}) | 新增 | 取 glyph helper：未注册 key → fallback `<span>@</span>` | MUST fallback 不 crash；MUST NOT 抛错 | specs/ui/components/chat-page/mention-pill.md | +6 |
| ui-chat | app/web/src/components/chat-page/primitive-mention-pill.tsx | MentionPill() | 修改 | 渲染 `{Glyph(name=icon)} {label} {badge===leader ? Crown : null}`；`data-mention-icon` 替代 `data-mention-type`；testid `mention-pill` 保留 | MUST 不含 type 分支；MUST badge 渲染（紧贴 icon 右侧 8px） | specs/ui/components/chat-page/mention-pill.md | +6/-3 |
| ui-chat | app/web/src/components/chat-page/component-mention-popover.tsx | MentionItem (前端 type) | 修改 | 镜像 server 新 schema：`{ type, path?, kind?, id?, display, listView }`；display = `{icon,label,badge?}` | MUST 与 server schema 同构（前端透传不解释）；MUST NOT 在前端定义里漏 display | specs/api/mention/GET-search.md §3 | +6/-2 |

### 模块 3: web/studio-page — 看板 @ 回路（prefill 带 display）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-board | app/web/src/components/studio-page/component-board-at-button.tsx | BoardAtMentionButtonProps | 修改 | 替换 `path: string` 为 `kind: string; id: string; label: string`（caller 传 kind/id/title）；`onAtMention` 签名改 `(payload: { type:'workitem', kind, id, label }) => void` | MUST 仍是 workitem-only（testid 仍是 squad-board-{entity}-{id}-at-mention）；MUST NOT 还传 path | PRD 路径 P5；specs/ui/components/studio-page/squad-board.md | +5/-2 |
| ui-board | app/web/src/components/studio-page/component-board-at-button.tsx | BoardAtMentionButton | 修改 | onClick 调 `onAtMention({ type:'workitem', kind, id, label })`（不再 `'workitem', path`） | MUST 调用方传入 kind/id/label（已在 props） | PRD 路径 P5 | +2/-1 |
| ui-board | app/web/src/components/studio-page/use-board-at-mention.ts | useBoardAtMention.onAtMention() | 修改 | 签名改 `(payload: { type, kind, id, label }) => void`；构造 prefill 为 `[{ type:'workitem', kind, id, icon:kind, label }]`（MentionAttrs 含 display） | MUST prefill MentionAttrs 含 display 三字段；icon === kind；MUST NOT 还原 path | PRD F5/路径 P5；specs/ui/components/chat-page/chat-composer-extension.md | +6/-3 |
| ui-board | app/web/src/components/studio-page/component-board-goals-view.tsx | (caller: BoardAtMentionButton props) | 修改 | kr 卡片：传 `kind="kr" id={kr.id} label={kr.title}`；goal 卡片：传 `kind="goal" id={goal.id} label={goal.title}`（不再传 `path`）；onAtMention prop 类型同步改 | MUST kr.title/goal.title 已在作用域（GoalCard/KrCard 现有字段）；MUST NOT 多查 store | PRD F5 | +4/-2 |
| ui-board | app/web/src/components/studio-page/component-board-task-card.tsx | (caller: BoardAtMentionButton props) | 修改 | 传 `kind="task" id={task.id} label={task.title}`；onAtMention prop 类型同步改 | MUST task.title 已在作用域 | PRD F5 | +2/-1 |
| ui-board | app/web/src/components/studio-page/component-board-requirements-view.tsx | (caller: BoardAtMentionButton props) | 修改 | 传 `kind="requirement" id={req.id} label={req.title}`；onAtMention prop 类型同步改 | MUST req.title 已在作用域 | PRD F5 | +2/-1 |
| ui-board | app/web/src/components/studio-page/component-board-tasks-view.tsx | onAtMention (prop type) | 修改 | 透传新签名 `(payload: {type,kind,id,label}) => void`（2 处 prop 类型 + 2 处 prop 透传） | MUST 同步 component-board-task-card 的 prop 类型；MUST NOT 还签 `(type,path)` | PRD F5 | +2/-2 |
| ui-board | app/web/src/components/studio-page/component-squad-board.tsx | onAtMention (prop type) | 修改 | 同步新签名（1 处 prop 类型 + 3 处透传） | MUST 透传无逻辑改动 | PRD F5 | +1/-1 |

### 模块 4: tests（更新 mention API/E2E case 对齐新 schema）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tests | tests/api/mention/workitem_search_tc1/checkpoint.json | (checkpoint) | 修改 | assert 改 `display.label`（不再 listView.title 推导）；address assert `kind`+`id`（不再 path=`workitem/X/Y`） | MUST 断言 `display.icon === kind`；MUST NOT 仍断言 path | specs/api/mention/GET-search.md §3；PRD P3 | +5/-3 |
| tests | tests/api/mention/member_search_tc1/checkpoint.json | (checkpoint) | 修改 | assert `display.label`（member name）；leader item assert `display.badge === 'leader'`；address assert `id` | MUST mate item assert badge 缺失/undefined；MUST NOT 还断言 path=memberId | specs/api/mention/GET-search.md §3；PRD P4 | +5/-2 |
| tests | tests/api/mention/message_with_mention_tc1/checkpoint.json | (checkpoint) | 修改 | message content assert 改全属性 tag `<mention type=".." path=".." icon=".." label=".."/>`（file case） | MUST assert 4 属性齐全；MUST server 透传（POST=GET=storage 同串） | specs/tech/mention/message-content.md §5；PRD P1 | +3/-2 |

## 影响面评估

**跨模块**：server/mention（4 provider + types）、web/chat-page（5 文件）、web/studio-page（@ 回路 6 文件透传）、tests（3 case 更新）。

**破坏性变更**：
- MentionItem schema（server+前端）：加 display 必填字段、workitem address 拆 kind+id（不再 path）
- mention tag 格式：从 `<mention type path/>` 改 `<mention type {address} {display}/>` 全属性 flat
- BoardAtMentionButton props + onAtMention 签名：从 `(type, path)` 改 `(payload: {type,kind,id,label})`
- MentionPill props：`type` → `icon`/`badge`

**依赖顺序**（底层先于上层）：
1. server types（MentionItem + MentionItemDisplay）→ 4 provider toMentionItem → server index re-export
2. server 完成 → API case 可断言新 schema（api-verifier 黑盒）
3. 前端 popover MentionItem → composer handleSelect → MentionAttrs → serializeEditorContent → render 正则 → pill Glyph registry → MentionPill
4. studio-page BoardAtMentionButton chain（自底向上：BoardAtMentionButton → callers → SquadBoard → page-studio → useBoardAtMention）

**风险点**：
- 正则泛化 + XML 转义 / 反转义对称性（必须 UT 覆盖）
- BoardAtMentionButton 签名变更涉及 6 个文件透传，容易漏改 → 必跑 typecheck
- Tiptap attrs 扩字段后，旧编辑器实例（已 mount）的 mention node 缺新字段 → 渲染时 fallback（display 缺失降级）

**spec↔code 偏离需 coder 注意**：
- v0.0.68 旧 spec 写 `SquadStore.getSquad().members` / `BoardStore.getBoard`（概念误植），实际 store API 是 `MemberStore.listMembers` / `BoardStore.listGoals+listRequirements+listTasks+buildAncestorView`——provider 实现已对齐正确（provider-interface.md §7/§8 已记录），coder 不需改 store 调用，只改 toMentionItem 返回结构。
- WorkItemProvider 当前 `toMentionItem(kind, id, title, status)` 入参已是拆开的（v0.0.68 实现就传 kind/id/title/status，只是 path 内拼回 `workitem/<kind>/<id>`）——本版本只需在 item 字段层把 kind+id 拆为 address 顶层字段、不再拼 path。改动比想象小。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec 概念与代码实际不符（如 store API 名）→ 按代码实际调整 + 汇报偏离 → orchestrator 记 doc-sync 待办

# component-chat-composer

> 层级: component
> 文件: app/web/src/components/chat-page/component-chat-composer.tsx
> 视觉契约: 无设计稿（本版本无视觉契约设计稿，视觉基线由 coder 设计后回填）
> 数据权威: specs/tech/mention/message-content.md（MessageContent 结构）

## 职责
共享的 pill-aware 输入区组件，替代三处独立 textarea。内含 Tiptap 编辑器 + @ 触发 MentionPopover 浮层 + pill 节点渲染。发送时产出**字符串**——mention 以 `<mention type="..." path|kind+id|id=".." icon=".." label=".." [badge=".."]/>` 内联标签嵌入正文（`serializeEditorContent` 序列化 Tiptap doc）。
边界：不做消息渲染（→ `ComponentMessageStream`）；不做 run 态 UI（→ `ComponentRunStateBar`）；不做 model 选择（→ `ModelPicker`）。

**输入草稿缓存（v0.0.267）**：每个 session 的未发送输入内容（文本 + mention pill + 多行）按 `sessionId` 内存级缓存（`chat-slice.drafts`，无 persist）——切走再切回完整恢复。接线全部在组件内部（`use-chat-draft.ts` hook + chat-slice 两个 action），**不新增 props**：onUpdate 实时写缓存（编辑即保存）、mount 恢复（草稿 > prefill 优先级）、发送后清除。详见「输入草稿缓存」节。

## Props
- biz: BizType
- sessionRole?: Role
- sessionId: string
- enabledProviders: string[]
- onSend: (content: string) => void
- disabled?: boolean
- placeholder?: string
- initialContent?: MentionAttrs[] | string

> **mount-time 一次性注入**（不监听后续变更；用户随后可自由编辑/删除/发送）：mention 数组 → 经 `chat-composer-helpers.injectInitialContent` 的 mention 分支顺序 `insertMention` 注为 pill；string → 经同 dispatcher 的 string 分支 `editor.chain().focus().insertContent(text).run()` 注成**可编辑 text node**（业务全景「更多」tab 引导跳 leader 单聊预填「帮我搭建一个看板，展示…」模板用此分支）。两种形态共用同一守卫：`!initialContent || initialContent.length === 0`（空串命中两条件、空数组命中 length===0）+ ref-guard 防重注入（v0.0.267 起由 `useChatDraft` 的 injectedRef 承担）+ `queueMicrotask` 推迟出 commit phase（避免 @tiptap/react flushSync lifecycle 警告）。dispatcher 单一出口在 `chat-composer-helpers.injectInitialContent`（`injectMentions` 保留为向后兼容包装，委托 dispatcher）。
> **草稿优先（v0.0.267）**：mount 注入统一由 `useChatDraft` hook 接管（原组件内 initialContent effect 移入 hook）——**有草稿（`store.drafts[sessionId]` 非空）→ 走 `restoreDraftContent` 恢复草稿、置 injectedRef 跳过 initialContent**；无草稿 → 走既有 `injectInitialContent`（ref-guard / empty check / queueMicrotask 语义与现状等价）。initialContent 仅在无草稿时生效（草稿 = 用户未完成输入强意图 > prefill 外部模板弱意图）。

## 输入草稿缓存（v0.0.267）

**存储（`chat-slice`，`app/web/src/store/chat-slice.ts`）**：`drafts: Record<sessionId, DraftContent>`——内存级 zustand 字段（无 persist middleware，关应用/刷新丢失符合需求）。`DraftContent = string` = `serializeEditorContent` 序列化字符串（文本 + `<mention …/>` 内联 tag，`\n` 段落分隔）——**与发送通道（onSend 的 content）同构**，mention 保真。空串 = 无草稿（saveDraft 不存 key）。

两个 action（均幂等、不可变更新）：
- `saveDraft(sessionId, content)`：`!content.trim()` → 删 key（等价清除）；非空 → spread 新建写 key；**值相同不 set**（防恢复回写同值触发订阅）。
- `clearDraft(sessionId)`：key 不存在 no-op 不 set（发送后清除用）。

**接线（`use-chat-draft.ts` hook，组件内部）**：`useChatDraft(editor, sessionId, initialContent, store?)` 返回 `{ saveDraft(ed), clearDraft() }`——**全部 `useChatStore.getState()` 读/写、不订阅 store** → 输入时 saveDraft 的 set 不触发任何组件 re-render（zustand 订阅者按 selector 引用 Object.is 比较，未订阅 drafts 的组件不收通知）。`store` 可选参数用于测试注入独立实例（`createChatSliceStore()`），生产默认 `useChatStore` 单例。

- **mount 恢复**（useEffect）：editor ready + `store.getState().drafts[sessionId]` 有值 → `queueMicrotask(() => restoreDraftContent(editor, draft))`（置 injectedRef，跳过 initialContent）；无草稿 → 既有 initialContent 注入。
- **编辑即写**（onUpdate）：`detectTrigger(ed)` 后追加 `saveDraft(ed)`——`serializeEditorContent(ed.getJSON())` 写缓存（含空内容清除：clearContent 触发 onUpdate → serialize '' → saveDraft 空 = 清除）。不加防抖（serialize 是 O(doc) 轻量）。
- **发送后清除**（handleSubmit）：`onSend(content)` + `clearContent()` 后显式 `clearDraft()`（不赌 clearContent 是否触发 onUpdate 的框架行为，双保险）。

**恢复（`chat-composer-helpers.restoreDraftContent(editor, content)`）**：`deserializeContentToParagraphs(content)`（mention pill 保真，复用 mention-tag.ts 注入路径原语）→ `editor.chain().focus().insertContent(paragraphs).run()`。与 `injectInitialContent` 并列（职责 = editor 命令封装；ref guard / queueMicrotask 推迟由 useChatDraft 负责）。

**覆盖范围**：所有经 SectionChatSession 接入的聊天页（playground / studio 单聊群聊 / academy×4）单点生效——`key={sessionId}` remount 是根因（切 session 组件卸载导致 Tiptap editor 销毁），草稿缓存兜底恢复，不改 remount 语义。subagent 只读页（readOnly）无输入区，不缓存不恢复。新建会话无草稿，正常空输入。

## 命令式句柄（ChatComposerHandle）
组件经 `forwardRef` 暴露以下方法（`component-chat-session-input.tsx` 的 ESC 监听 + 红钮中断入口都消费此 handle）：
- `send(): void`——触发发送（等价 Enter）：序列化 editor → `onSend(content)` + `clearContent()`；空内容 no-op
- `isPopoverOpen(): boolean`——`@` popover 是否打开（读 `triggerRef.current`，inline 同步，不 stale）
- `isFocused(): boolean`——editor 是否持有焦点（读 Tiptap 内置 `editor.isFocused`，不手查 `document.activeElement`，保封装）
- `applyInterrupt(items: { content: string }[]): void`——中断注入：把 items 反序列化为 paragraph（保留 mention pill）插入 doc 开头 + 焦点管理（见「中断注入」节）；**不调 onSend / 不 clearContent**（与 send 区分）；`items.length===0` 跳过注入仅走焦点分支

## 状态 / 交互
### 编辑器（Tiptap）
- **初始化**：空文档，单 paragraph。focus 时显示 placeholder（prop）。
- **pill 节点**：`<span data-mention-node>` inline node（不可部分编辑，整颗删除）。渲染为 `MentionPill` 组件。
- **文本输入**：普通 paragraph 文本编辑。
### @ 触发
- 用户在编辑器中输入 `@` 字符 → 检测 `@` 后跟随文本 → 弹出 `MentionPopover`。
- 触发位置：`@` 字符所在位置（编辑器光标处）。
- query 文本：`@` 后到光标间的文本（实时传给 MentionPopover 作为搜索关键词）。
### ESC 键路（焦点门控，run 态中断）
- **落点**：`component-chat-session-input.tsx` 在 window 上挂 `keydown` **capture 阶段**（第三参 `true`）listener，先于 composer 的 bubble handler 判定中断语义（`composer.md` 的 `onKeyDown` 仅在焦点位于 composer 内时才触发——UC-F1「焦点在 body 按 ESC」会漏；input 层全具备 `composerRef + pendingToolCall + sessionRunning`）。
- **门控判定链**（按优先级 short-circuit）：
  1. `!composerRef.current?.isFocused()` → noop（焦点不在输入区→ESC 不中断；modal/body/消息流各自 ESC handler 照常工作，本组件**不 preventDefault**。**内联 modal 盲区自动消除**：焦点进 modal → 不在输入区 → ESC 不中断）
  2. `composerRef.current?.isPopoverOpen()` → noop（`@` popover 开 → 让 composer 自管关 popover；其 onKeyDown 在 capture 之后 bubble 触发关 popover）
  3. `pendingToolCall` 非空 → noop（HITL 卡 pending，保留用户在 HITL 上下文）
  4. `sessionRunning === true` → `e.preventDefault()` + 执行「中断动作」（见下节）
  5. else noop（非 running 不发明新语义）
- **焦点门控取代 modal 探测**：modal 打开时焦点在 modal 内 → 不在输入区 → ESC 自然不中断，省去 `getOverlayRoot().childElementCount` DOM 查询（含 memory-editor-modal 等内联 modal 盲区一并覆盖）。

## 中断注入（applyInterrupt）

「中断动作」= 既有 abort + cancel 的**产品层编排**——ESC 触发（焦点门控通过后）或红钮（任意焦点位置兜底）任一触发都执行同一套，handler 落 `component-chat-session-input.tsx::handleInterrupt`：

1. `const items = enqueueItems`——snapshot 入参前（防 SSE 移项中段丢 content）
2. `items.forEach((it) => onEnqueueCancel(it.enqueueId))`——逐条 cancelEnqueue fire-and-forget；移项靠 SSE `enqueued_message_canceled`（INV-1/5 不进 store）
3. `composerRef.current?.applyInterrupt(items.map((it) => ({ content: it.content })))`——注入 + 焦点管理（单一 composer 方法）
4. `onAbort()`——既有 section 传入的 abort 原语 = `POST /session/:id/abort`

**红钮 wiring**：`ComponentRunStateAbortSlot` 的 `onAbort` 从直接透传改为 `() => handleInterrupt()`（与 ESC 同 handler，语义统一）。

### 焦点管理两分支（applyInterrupt 内）
- **wasFocused === true**（ESC 触发恒走此分支——焦点门控前提即焦点在输入区）：
  1. 捕获 `editor.state.selection.{from,to}` **BEFORE** mutation
  2. `buildInterruptTransaction(state, items)` 返 `{ tr, newFrom, newTo }`——`tr.insert(0, nodes)` 把反序列化后的 paragraph 插入 doc 开头；`tr.mapping.map(from/to)` 干净平移（插入点 position 0，原内容位置严格 > 0，无 associativity 歧义）
  3. `tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo))` + `editor.view.dispatch(tr)`（光标跟随原内容下移，相对偏移不变；不 blur）
- **wasFocused === false**（红钮触发走此分支——按钮点击使 editor 失焦）：
  - 仍 dispatch tr（注入内容；`items.length===0` 时 `buildInterruptTransaction` 返 null 跳过）+ `editor.chain().focus('end').run()`（焦点 + 光标到 doc 末尾，便于继续编辑）
- **无排队**（`items.length===0`）：`buildInterruptTransaction` 返 null → 不构造 tr、不改内容；`applyInterrupt` 仍执行焦点管理分支（满足 PRD「无排队时焦点管理仍执行」）。

### mention 反序列化器（注入路径专用）
- **`mention-tag.ts::deserializeContentToParagraphs(content): TiptapNodeJSON[]`**——纯函数，`serializeEditorContent`（输出侧）的逆运算：
  - 按 `\n` 切 content → 每行产出一个 `{ type: 'paragraph', content: InlineNode[] }`（多行 content → 多 paragraph）
  - 每行内用 `MENTION_RE` 全局扫 `<mention .../>`：tag 之间的纯文本 → `{ type: 'text', text }` 节点；tag → `parseTagAttrs` 取 attrs → **新格式**（含 `icon` + `label`）产 `{ type: 'mention', attrs: { type, ...(path/kind/id 按存在性), icon, label, ...(badge 按存在性) } }`（attrs 形状对齐 `MentionAttrs`）；**旧格式降级**（缺 `icon`/`label`）整段 tag 字符串作 `{ type: 'text', text }`（与 `component-mention-render.tsx` 降级规则一致，对齐 `message-content.md §7`）
  - 属性值经 `unescapeAttr` 反转义（`&quot;`→`"` 等，对齐 `message-content.md §8`）
  - **INV-2 类型无关**：deserializer 不含 `if (type === ...)` 分支，仅按 `attrs.icon/label/badge` 构 pill（与 renderer 同形）
- **不调 Tiptap schema**：返回纯 JSON；`schema.nodeFromJSON` 在 `buildInterruptTransaction` 内做（保持 deserializer 无 Tiptap 依赖、UT 友好）。
- **仅注入路径调用**：deserializer 仅由 `buildInterruptTransaction`（即 `applyInterrupt`）调用；**实时手打 `<mention/>` → pill 即时识别显式不做**（用户裁决：范围限定注入路径；实时识别是输入态校验另一独立场景）。

## parsing 原语单一权威（mention-tag.ts）
`MENTION_RE` / `ATTR_RE` / `parseTagAttrs` / `unescapeAttr` / `escapeAttr` 集中在 `app/web/src/components/chat-page/mention-tag.ts`（无 React / 无 Tiptap 依赖，纯字符串处理），三类消费者共用：
- **渲染侧**（`component-mention-render.tsx`）：扫 `<mention/>` → pill（enqueue/对话区共用）
- **序列化侧**（`chat-composer-extension.tsx::serializeMention`）：用 `escapeAttr` 输出 flat 全属性 tag
- **反序列化侧**（`mention-tag.ts::deserializeContentToParagraphs`）：注入路径专用，复用 `MENTION_RE/parseTagAttrs/unescapeAttr`

## 视觉基线
无设计稿（本版本无视觉契约设计稿）。基线由 coder 实现后回填：
- **编辑器外层容器**（`EditorContent` className）：无 border/bg（容器化由父级 section 提供）；（最大 6 行 ≈ 13.5px × 1.5 × 6，超出内部滚动，不无限撑高）；。
- **编辑器内层 `.tiptap`**（ProseMirror 编辑器，经 `[&_.tiptap]:` 选择器作用）：+ `outline-none` + 段落 `[&_.tiptap_p]:m-0`。
- **pill 内联样式**：圆角胶囊（视觉契约以 `mention-pill.md` primitive 为准）。

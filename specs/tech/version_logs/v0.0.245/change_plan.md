# v0.0.245 变更计划书 — 终端中断体验优化（ESC 中断 + 排队注入 + 焦点管理 + mention 反序列化器）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 性质：**纯前端**（零后端 / 零新依赖）。中断动作 = 既有 abort+cancel 的产品层编排；反序列化器 = 既有 serializeEditorContent 逆运算。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 内） |
| 函数/符号 | 函数名 / 类型 / 接口（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁模糊） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置（路径+章节）/ 项目原则 |
| 预计影响行 | +N / -M |

---

## 技术裁决（PRD §7 五项待对齐）

### 1. ESC 键路落点 → **window-level capture-phase listener 在 `component-chat-session-input.tsx`**（焦点门控）
- **落点理由**：composer 现有 `onKeyDown` 仅在焦点位于 composer 内时才触发——UC-F1「焦点不在输入区（如 body）按 ESC」会漏。section-chat-session.tsx 缺 `composerRef`（在子层）。`ComponentChatSessionInput` 同时持 `composerRef` + 全部所需 props（enqueueItems / onEnqueueCancel / onAbort / pendingToolCall / sessionRunning）= 自然落点。
- **门控判定方式（用户裁决 22:40——焦点门控取代 overlay-root 探测）**：`window.addEventListener('keydown', onKey, true)` **capture 阶段**（先于 bubble handler）。onKey 内按优先级链 short-circuit：
  1. `!composerRef.current?.isFocused()` → return（焦点不在输入区→ESC 不中断；modal/body/消息流焦点各自 ESC handler 照常工作，我们**不 preventDefault**。**内联 modal（如 memory-editor-modal）盲区自动消除**：焦点进 modal → 不在输入区 → ESC 不中断）
  2. `composerRef.current?.isPopoverOpen()` → return（@ popover 开 → 让 composer 自管关 popover；其 onKeyDown 在 bubble 阶段后触发，照常关 popover）
  3. `pendingToolCall` 非空 → return（HITL 卡自管，保留 PRD UC-E3 意图）
  4. `sessionRunning` → `e.preventDefault()` + `handleInterrupt()`
  5. else noop
- **焦点门控 vs overlay-root 探测**：焦点门控更简单明确——「焦点在弹窗 = 不在输入区」是 React 焦点系统的天然 invariant，无需查 DOM；overlay-root 探测对**内联 modal**（不走 Portal 的 modal，如 memory-editor-modal）有盲区，焦点门控自动覆盖所有 modal 场景，caveat 消除。

### 2. 焦点「位置不变」精确语义 → **相对原内容偏移（光标跟随原内容下移）**
- **语义**：注入内容追加在 doc 开头；原内容整体下移；光标停留在「原内容里的相同相对位置」（如原光标在原内容第 5 字符后，注入后仍在新位置的第 5 字符后 = 注入尺寸 + 5）。
- **Tiptap/ProseMirror 实现**：在 `applyInterrupt` 内
  1. 捕获 `wasFocused = editor.isFocused` + `const { from, to } = editor.state.selection` **BEFORE** 任何 mutation
  2. 由 `buildInterruptTransaction(state, items)` 返回 `{ tr, newFrom, newTo }`（`tr.insert(0, nodes)` + `tr.mapping.map(from)` / `tr.mapping.map(to)`）
  3. `wasFocused` → `tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo))`；`editor.view.dispatch(tr)`（不 blur）
  4. `!wasFocused` → 仍 dispatch tr（注入内容）+ `editor.chain().focus().setTextSelection('end').run()`（焦点 + 光标到末尾）
- **`tr.insert(0, ...)` 用 position 0（doc 内容开头）**：保证原内容所有位置严格 > 插入点 → `mapping.map` 无 associativity 歧义，干净平移（在 R&D 中已验算）。

### 3. `handleInterrupt` 落点 → **`component-chat-session-input.tsx`（composerRef home）**
- **签名**：`() => void`（无参；闭包捕获 enqueueItems / onEnqueueCancel / onAbort / composerRef）。
- **步骤顺序**（对齐 PRD §3.2）：
  1. `const items = enqueueItems`（snapshot，防 SSE 移项中段丢 content）
  2. `items.forEach((it) => onEnqueueCancel(it.enqueueId))`（逐条 cancelEnqueue fire-and-forget；移项靠 SSE）
  3. `composerRef.current?.applyInterrupt(items.map((it) => ({ content: it.content })))`（注入 + 焦点管理，单一 composer 方法）
  4. `onAbort()`（既有 section 传入的 `() => runState.abort()` 包装 = POST /abort）
- **统一入口**：ESC 窗口监听 + 红钮 `onAbort` 都调 `handleInterrupt`（语义统一，UC-A4）。
- **红钮 wiring**：`ComponentRunStateAbortSlot` 的 `onAbort` 从 `onAbort`（直接透传）改为 `() => handleInterrupt()`（ComponentAbortBtn 调用 `onAbort(sessionId)` 传入的 sessionId 参数被忽略）。
- **section-chat-session.tsx 零改**：仍传 `onAbort={() => runState.abort()}` 作为 abort 原语。

### 4. MENTION_RE 复用 → **新 `mention-tag.ts` 共用纯函数模块（单一权威）**
- **新文件**：`app/web/src/components/chat-page/mention-tag.ts`（无 React / 无 Tiptap 依赖，纯字符串处理）。
- **导出**：`MENTION_RE`、`ATTR_RE`、`parseTagAttrs`、`unescapeAttr`、`escapeAttr`（五者从 `component-mention-render.tsx` + `chat-composer-extension.tsx` 平移，**字面不变**），+ 新增 `deserializeContentToParagraphs` + 类型 `TiptapNodeJSON`。
- **来源切换**：`component-mention-render.tsx` 删本地 `MENTION_RE/ATTR_RE/parseTagAttrs/unescapeAttr` 改 import；`chat-composer-extension.tsx` 删本地 `escapeAttr` 改 import（serializeMention 继续用）。
- **不选「export from composer-extension」方案**：escapeAttr 在 extension、MENTION_RE 在 render 双向不对称；新建中性 util 模块是单一权威的最干净落地（也是 PRD §7.4 提示的「新 mention-tag 共用 util」选项）。

### 5. ~~modal 弹层状态查询~~ → **已废弃（用户裁决 22:40）**

**焦点门控取代 modal 探测**——裁决① 的 `!isFocused()` 自动覆盖所有 modal 场景（含内联 modal 如 memory-editor-modal 的盲区），无需 `getOverlayRoot().childElementCount` 探测。caveat 消除。原方案（`getOverlayRoot().childElementCount > 0` DOM 查询 + Portal/overlay-root 单节点架构依据）作废。

---

## 反序列化器设计（§3.4，落 `mention-tag.ts`）

**`deserializeContentToParagraphs(content: string): TiptapNodeJSON[]`** —— 纯函数，`serializeEditorContent` 的逆运算：

- 按 `\n` 切 content → 每行产出一个 `{ type: 'paragraph', content: InlineNode[] }`（多行 content → 多 paragraph；单行 → 单 paragraph）
- 每行内用 `MENTION_RE` 全局扫 `<mention .../>`：
  - tag 之间的纯文本 → `{ type: 'text', text }` 节点
  - 每个 tag → `parseTagAttrs(tagInner)` 取 attrs 字典 →
    - **新格式**（含 `icon` + `label`）→ `{ type: 'mention', attrs: { type, ...(path/kind/id 按存在性), icon, label, ...(badge 按存在性) } }`（MentionNode attrs 形状对齐 `chat-composer-extension.tsx` `MentionAttrs`）
    - **旧格式降级**（缺 `icon`/`label`）→ 整段 tag 字符串作 `{ type: 'text', text: m[0] }`（与 `component-mention-render.tsx` 降级规则一致，对齐 `message-content.md §7`）
- 属性值经 `parseTagAttrs` 内的 `unescapeAttr` 反转义（`&quot;`→`"` 等，对齐 `message-content.md §8`）
- **INV-2 类型无关**：deserializer 不含 `if (type === ...)` 分支，仅按 `attrs.icon/label/badge` 构 pill（与 renderer 同形）
- **不调 Tiptap schema**：返回纯 JSON（`schema.nodeFromJSON` 在 `buildInterruptTransaction` 内做，保持 deserializer 无 Tiptap 依赖、UT 友好）

**仅注入路径调用**：deserializer 仅由 `buildInterruptTransaction`（即 `applyInterrupt`）调用；**实时手打 `<mention/>` → pill 即时识别显式不做**（PRD §3.4 非目标）。

---

## 注入规格（§3.2）

- **拼接**：`items.flatMap((it) => deserializeContentToParagraphs(it.content))` —— 每个 EnqueueItem 反序列化为 ≥1 个 paragraph（item content 含 `\n` → 多 paragraph；无 `\n` → 单 paragraph）。条间分隔由 paragraph 边界天然形成（无需手插 `\n`，对齐 `serializeEditorContent` 段落 join 语义）。
- **插入位置**：`tr.insert(0, nodes)` —— doc 内容开头（position 0）；原 paragraphs 自然续后。
- **selection 平移**：`tr.mapping.map(from)` / `tr.mapping.map(to)` —— 原内容所有位置严格 > 0，mapping 干净平移（光标跟随原内容下移）。
- **无排队**（`items.length === 0`）：`buildInterruptTransaction` 返 null → 不构造 tr、不改内容；`applyInterrupt` 仍执行焦点管理分支（wasFocused noop / !wasFocused focus+end），满足 PRD §3.3「无排队时焦点管理仍执行」。

---

## 变更清单（method 级，按模块/文件相邻分组）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-mention-tag | app/web/src/components/chat-page/mention-tag.ts | MENTION_RE / ATTR_RE / parseTagAttrs / unescapeAttr / escapeAttr | 新增 | 5 个 parsing 原语从 component-mention-render.tsx（MENTION_RE/ATTR_RE/parseTagAttrs/unescapeAttr）+ chat-composer-extension.tsx（escapeAttr）平移到本文件；**字面 100% 不变**；改为 export | MUST 字面与原 const 完全一致（不改 regex/字符集/分支）；MUST 单一权威（删除原文件本地定义） | message-content.md §5.5/§8; PRD §7.4 | +42/-0 |
| ui-mention-tag | app/web/src/components/chat-page/mention-tag.ts | TiptapNodeJSON | 新增 | Tiptap content JSON 节点形状类型（`{ type: string; content?: TiptapNodeJSON[]; attrs?: Record<string, unknown>; text?: string }`） | MUST 与 `editor.getJSON()` 内容形状兼容（用于 schema.nodeFromJSON 输入） | chat-composer-extension.tsx serializeEditorContent 现有 doc JSON 形状 | +6/-0 |
| ui-mention-tag | app/web/src/components/chat-page/mention-tag.ts | deserializeContentToParagraphs(content) | 新增 | 纯函数：`string → TiptapNodeJSON[]`（paragraph 数组）。按 `\n` 切行；每行扫 MENTION_RE：tag 间文本→text 节点；tag→parseTagAttrs→新格式(icon+label)产 mention 节点(attrs 含 type + 按存在性的 path/kind/id + icon/label + 按存在性的 badge) / 旧格式降级整段 tag 字符串作 text 节点 | MUST 复用本文件 MENTION_RE/parseTagAttrs/unescapeAttr（单一权威）；MUST NOT 引入 `if(type===)` 分支（INV-2 类型无关）；旧格式降级规则与 component-mention-render.tsx 一致；MUST NOT 依赖 Tiptap schema（返纯 JSON） | message-content.md §3/§5.5/§7/§8; PRD §3.4; chat-composer-extension.tsx MentionAttrs 形状 | +35/-0 |
| ui-composer-ext | app/web/src/components/chat-page/chat-composer-extension.tsx | escapeAttr (local) | 删除 | 删除本文件 local `escapeAttr`，改 `import { escapeAttr } from './mention-tag'`；serializeMention 继续调用（来源切换，逻辑零改） | MUST 删除本地定义防双份；MUST 保持 serializeMention 行为不变 | mention-tag.ts escapeAttr | +1/-15 |
| ui-composer-ext | app/web/src/components/chat-page/chat-composer-extension.tsx | buildInterruptTransaction(state, items) | 新增 | 纯函数：`(state: EditorState, items: {content: string}[]) → { tr, newFrom, newTo } \| null`。items.length===0 返 null；否则 items.flatMap(deserializeContentToParagraphs) → `state.schema.nodeFromJSON(p)` 构 PM Node[] → `const tr = state.tr; tr.insert(0, nodes)`；返 `{ tr, newFrom: tr.mapping.map(state.selection.from), newTo: tr.mapping.map(state.selection.to) }` | MUST 用 schema.nodeFromJSON 构造（不手拼 PM Node）；MUST 插入 position 0（doc 内容开头）；MUST NOT 调用 view.dispatch / editor.commands（caller applyInterrupt 负责分发 + 焦点）；MUST NOT 在 items.length===0 时构造 tr（返 null 让 caller 跳过） | PRD §3.2/§3.3/§7.2; serializeEditorContent 逆运算; message-content.md §3 | +22/-0 |
| ui-mention-render | app/web/src/components/chat-page/component-mention-render.tsx | MENTION_RE / ATTR_RE / parseTagAttrs / unescapeAttr (locals) | 删除 | 删除本文件 4 个 local helper，改 `import { MENTION_RE, ATTR_RE, parseTagAttrs, unescapeAttr } from './mention-tag'`；MentionRender 渲染逻辑零改 | MUST 渲染行为零改（仅 import 来源切换） | mention-tag.ts | +1/-30 |
| ui-chat-composer | app/web/src/components/chat-page/component-chat-composer.tsx | ChatComposerHandle (interface) | 修改 | 扩三方法：`isPopoverOpen(): boolean`（返 triggerRef.current !== null）；`applyInterrupt(items: { content: string }[]): void`（执行注入 + 焦点管理；不调 onSend / 不 clearContent）；`isFocused(): boolean`（返 `editor.isFocused`，Tiptap 内置；ESC 焦点门控用） | MUST NOT 暴露 Tiptap editor 实例（保持封装）；MUST 用 `editor.isFocused`（不手查 `document.activeElement`，保封装）；MUST NOT 让 useImperativeHandle deps 挂 trigger（triggerRef 解耦） | PRD §3.1/§3.2/§3.3/§7.1（焦点门控用户裁决 22:40）; chat-composer.md | +8/-0 |
| ui-chat-composer | app/web/src/components/chat-page/component-chat-composer.tsx | triggerRef | 新增 | `const triggerRef = useRef(trigger); triggerRef.current = trigger;`（inline 同步，无 effect）。isPopoverOpen 读 triggerRef.current 取最新态 | MUST inline 同步（不用 useEffect 链）；isPopoverOpen 必须返当前态（不能 stale） | PRD §7.1 | +3/-0 |
| ui-chat-composer | app/web/src/components/chat-page/component-chat-composer.tsx | useImperativeHandle 闭包 | 修改 | handle 对象扩 `isPopoverOpen: () => triggerRef.current !== null` + `isFocused: () => editor?.isFocused ?? false` + `applyInterrupt: (items) => { if (!editor) return; const wasFocused = editor.isFocused; const { from, to } = editor.state.selection; const result = buildInterruptTransaction(editor.state, items); if (result) { const { tr, newFrom, newTo } = result; if (wasFocused) tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo)); editor.view.dispatch(tr); } if (!wasFocused) editor.chain().focus().setTextSelection('end').run(); }`；deps: `[handleSubmit, editor]`（不挂 trigger / items） | MUST 焦点两分支：wasFocused→相对原内容偏移(setSelection+dispatch 不 blur)；!wasFocused→focus+'end'；MUST `import { TextSelection } from '@tiptap/pm/state'`；MUST NOT 在 applyInterrupt 内调 onSend/clearContent（与 send() 区分）；items.length===0 时 result=null → 跳过 dispatch，仅走焦点分支 | PRD §3.3/§7.2; buildInterruptTransaction; chat-composer.md; tiptap isFocused/setTextSelection API | +22/-2 |
| ui-chat-input-asm | app/web/src/components/chat-page/component-chat-session-input.tsx | handleInterrupt | 新增 | `useCallback(() => { const items = enqueueItems; items.forEach((it) => onEnqueueCancel(it.enqueueId)); composerRef.current?.applyInterrupt(items.map((it) => ({ content: it.content }))); onAbort(); }, [enqueueItems, onEnqueueCancel, onAbort])`。步骤顺序对齐 PRD §3.2 | MUST snapshot items 入参前（防 SSE 移项中段丢 content）；MUST NOT 在 forEach 内 await（cancelEnqueue fire-and-forget）；onAbort 作为 abort 原语最后调 | PRD §3.2/§7.3; section-chat-session onAbort=runState.abort; use-run-state.ts abort() | +12/-0 |
| ui-chat-input-asm | app/web/src/components/chat-page/component-chat-session-input.tsx | ESC window listener useEffect | 新增 | `useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; if (!composerRef.current?.isFocused()) return; if (composerRef.current?.isPopoverOpen()) return; if (pendingToolCall) return; if (sessionRunning) { e.preventDefault(); handleInterrupt(); } }; window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true); }, [sessionRunning, pendingToolCall, handleInterrupt])` | MUST capture phase（第三参 true，先于 bubble handler）；MUST `!isFocused()` 早于其他判定（焦点不在输入区→ESC 不中断；modal/body/消息流焦点各自 ESC handler 照常工作，**不 preventDefault**；内联 modal 盲区自动消除）；MUST NOT 在 `!isFocused` / popover 开 / HITL pending 时触发中断；MUST cleanup removeEventListener；MUST NOT import getOverlayRoot（焦点门控取代 overlay-root 探测，裁决⑤ 废弃） | PRD §3.1/§7.1（焦点门控，用户裁决 22:40） | +16/-0 |
| ui-chat-input-asm | app/web/src/components/chat-page/component-chat-session-input.tsx | buttonRowSlot onAbort wiring | 修改 | `<ComponentRunStateAbortSlot ... onAbort={() => handleInterrupt()} />`（原 `onAbort={onAbort}` 改为调 handleInterrupt；ComponentAbortBtn 调 `onAbort(sessionId)` 的 sessionId 参数被忽略） | MUST 红钮与 ESC 同 handler（语义统一 UC-A4）；MUST NOT 改 section 传入的 onAbort prop 本身（仍是 abort 原语，由 handleInterrupt 末尾调用） | PRD §3.2 UC-A4/§7.3; component-run-state-bar ComponentRunStateAbortSlot | +1/-1 |

---

## 文件级变更清单（feature 维度）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/web/src/components/chat-page/mention-tag.ts | 新增 | 共享 parsing util（5 原语平移 + deserializeContentToParagraphs + TiptapNodeJSON） |
| app/web/src/components/chat-page/chat-composer-extension.tsx | 修改 | 删 local escapeAttr 改 import；新增 buildInterruptTransaction 纯函数 |
| app/web/src/components/chat-page/component-mention-render.tsx | 修改 | 删 4 个 local helper 改 import mention-tag.ts（渲染逻辑零改） |
| app/web/src/components/chat-page/component-chat-composer.tsx | 修改 | ChatComposerHandle 扩 isPopoverOpen+applyInterrupt；triggerRef；useImperativeHandle 扩（注入+焦点）；imports（buildInterruptTransaction, TextSelection） |
| app/web/src/components/chat-page/component-chat-session-input.tsx | 修改 | 新增 handleInterrupt + ESC window listener（capture，焦点门控）；红钮 onAbort 改 handleInterrupt（无 getOverlayRoot import） |
| specs/ui/components/chat-page/chat-composer.md | doc-sync | 阶段 5 doc-modifier 补：ESC 键路 + 焦点管理两分支（架构期不写 spec，coder 不动） |
| specs/ui/components/chat-page/_overview.md §5.3 | doc-sync | 阶段 5 补：ESC + 红钮双触发同一中断动作 |
| specs/ui/components/chat-page/_data-flow.md §3.3 | doc-sync | 阶段 5 补：中断动作 = 取消排队 + 注入 + abort + 焦点（产品层编排） |
| specs/ui/components/chat-page/chat-composer-extension（spec） | doc-sync | 阶段 5 补：输入侧反序列化器契约（注入路径专用） |

---

## 风险 + 文件大小

- **`component-chat-composer.tsx` 现 287 行，加 ~32 行（interface 8 + triggerRef 3 + useImperativeHandle applyInterrupt/isFocused 22 - cleanup 2 + imports 3）≈ 319 行 ⚠️ 超 300**。
  - **缓解**：coder 自检超限则抽 `detectTrigger`（现 L178-192，~15 行纯函数）或 `initialContent` effect（L160-172，~12 行）到新 helper 文件（如 `chat-composer-helpers.ts`）。**架构期不定具体抽哪个**——交给 coder 按「最小行为变更」原则选；只约束「抽 helper 不改 behavior + 文件回归 ≤300」。
- **`mention-tag.ts`（NEW）~ 85 行**：5 原语 + deserializer + type，单文件 < 300 ✓。
- **`chat-composer-extension.tsx` 205 + 22 - 15 + 1 ≈ 213 行** ✓。
- **`component-chat-session-input.tsx` 176 + 12 + 16 + 1 ≈ 205 行** ✓（移除 getOverlayRoot import）。
- **`component-mention-render.tsx` 75 - 30 + 1 ≈ 46 行** ✓（净减）。

**P-C 行为变更（用户裁决 22:40，焦点门控副作用）**：原 PRD P-C「焦点不在输入区 + ESC → 中断 + 焦点到末尾」**作废**——新门控下「焦点不在输入区 + ESC → 无反应」（modal/body/消息流焦点各自的 ESC handler 照常工作）。**红钮仍可任意位置中断（兜底）**。焦点管理两分支仍适用：ESC 触发时焦点必在输入区 → 走「位置不变」分支（`wasFocused=true`）；红钮触发时焦点可能在按钮/别处 → 走「焦点到末尾」分支（`wasFocused=false`，因按钮点击使 editor 失焦）。PRD §3.1/P-C 由 prd agent 并行更新。

**ProseMirror 位置数学风险**：`tr.insert(0, ...)` + `tr.mapping.map(from/to)` 在 R&D 中已验算（原内容位置严格 > 0 → 干净平移，无 associativity 歧义）。coder 实现 `applyInterrupt` 后**必须用 UT 验证 UC-F2**（焦点相对原内容位置不变：在原内容某位置 + 注入后断言 selection.from == oldFrom + insertedSize）。

---

## 影响面评估

- **范围**：纯前端、零后端、零新依赖（`@tiptap/pm` 已在 `app/web/package.json`）。
- **依赖方向（单向，无环）**：`mention-tag.ts` ← `chat-composer-extension.tsx`（buildInterruptTransaction）+ `component-mention-render.tsx`（render）；`chat-composer-extension.tsx` ← `component-chat-composer.tsx`（applyInterrupt）；`component-chat-composer.tsx` ← `component-chat-session-input.tsx`（handleInterrupt + ESC listener）。
- **零破坏性**：所有改动是新增方法 / 新增 prop 行为 / 平移 helper；既有 `send()` / `handleSubmit` / `serializeEditorContent` / `MentionRender` / `runState.abort` 行为零改。
- **既有契约保持**：
  - `serializeEditorContent` 输出侧零改（仍对齐 message-content.md §3/§8）
  - `cancelEnqueue` / `abortSession` HTTP 链路零改
  - `ComponentAbortBtn` 视觉零改（仅 onAbort 回调语义升级）
  - `MentionRender` 渲染零改（仅 import 来源切换）

---

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

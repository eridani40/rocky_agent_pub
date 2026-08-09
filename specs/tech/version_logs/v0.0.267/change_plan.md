# v0.0.267 变更计划书 — Session 输入草稿缓存

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.267.input_draft_cache/prd.md`。版本上下文：`states/v0.0.267/context.md`。
> **架构期裁决（3 个 PRD 决策点）**：
> ① **草稿格式 = 序列化字符串**（`serializeEditorContent` 输出：text + `<mention …/>` 内联 tag，`\n` 段落分隔）——与发送通道同构（onSend 的 content 就是它），mention 保真（icon/label/address 全属性经 serializeMention/deserializeLine 双向），存储轻量（string vs Tiptap JSON 对象），恢复用既有逆运算 `deserializeContentToParagraphs`。`DraftContent = string`。
> ② **接线 API = ChatComposer 内部接 useChatStore（getState 读/写，不订阅）**——不新增 props、不新增装配层改动：7 页（playground/studio 单聊群聊/academy×4）经 SectionChatSession → ComponentChatSessionInput → ChatComposer 单点生效；新建 `use-chat-draft.ts` hook 接管 mount 注入（草稿 > prefill 优先级）+ 提供 saveDraft/clearDraft actions；ChatComposer 原 initialContent effect 移入 hook（ref-guard/empty check/queueMicrotask 语义等价）。
> ③ **selector 精化 = 天然满足（零 re-render）**——ChatComposer/hook 用 `useChatStore.getState()` 读写 drafts（不订阅 store）→ 输入时 saveDraft 的 zustand set 不触发任何组件 re-render（zustand 订阅者按 selector 返回引用 Object.is 比较，未订阅 drafts 的组件不收通知）；`saveDraft` 值相同不 set（幂等优化，恢复回写同值不触发）。既有 useChatStore 消费方（sessions/childrenByParent 等）selector 已精化到各自字段，drafts 变化不影响——零改动。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（chat-slice / ui-chat） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| chat-slice | app/web/src/store/chat-slice.ts | DraftContent type | 新增 | `export type DraftContent = string`——输入草稿内容 = `serializeEditorContent` 序列化字符串（文本 + `<mention/>` tag，`\n` 段落分隔） | MUST 与发送通道同构（onSend 的 content 同形）；MUST 空串 = 无草稿（不存 key） | PRD §2.1/§3.1；决策① | +3 |
| chat-slice | app/web/src/store/chat-slice.ts | ChatSliceState.drafts | 修改 | `drafts: Record<string, DraftContent>`——sessionId → 序列化草稿（内存级，无 persist） | MUST 内存态（关应用/刷新丢失，符合需求）；MUST 不引入 persist middleware | PRD §2.1/§3.1；chat-slice.ts 现状（无 persist） | +4 |
| chat-slice | app/web/src/store/chat-slice.ts | ChatSliceState.saveDraft | 新增 | `saveDraft(sessionId, content)`：content 空（`!content.trim()`）→ 删 key（等价清除，幂等）；非空 → 写 `{...drafts, [sessionId]: content}`；**值相同不 set**（`s.drafts[sessionId] === content ? s : …`，防恢复回写同值触发订阅） | MUST 空内容 = 清除（PRD §2.2「空草稿不写」）；MUST 值相同不触发 store set（性能护栏：不引发无谓 re-render）；MUST 用不可变更新（spread 新建对象，不 mutate） | PRD §2.2/§3.1/§7 性能护栏；决策③ | +16 |
| chat-slice | app/web/src/store/chat-slice.ts | ChatSliceState.clearDraft | 新增 | `clearDraft(sessionId)`：删 drafts 中该 session key；不存在 → no-op 不 set（幂等） | MUST 幂等（key 不存在时不触发 store set）；MUST 不可变更新 | PRD §3.1/§3.4 | +10 |
| ui-chat | app/web/src/components/chat-page/chat-composer-helpers.ts | restoreDraftContent() | 新增 | `restoreDraftContent(editor, content)`：`deserializeContentToParagraphs(content)` → `editor.chain().focus().insertContent(paragraphs).run()`——草稿恢复专用（mention pill 保真）；与 injectInitialContent 并列（职责 = editor 命令封装） | MUST 走 deserializeContentToParagraphs（mention 保真，非 string 分支的纯 text 注入）；MUST 不解析实时手打 `<mention/>`（沿用 mention-tag.ts 注入路径语义）；MUST 纯函数无状态 | PRD §3.3；决策①；mention-tag.ts deserializeContentToParagraphs | +10 |
| ui-chat | app/web/src/components/chat-page/use-chat-draft.ts（新） | useChatDraft() | 新增 | 输入草稿 hook（接管 mount 注入 + 提供 actions）：① mount 恢复——editor ready + `useChatStore.getState().drafts[sessionId]` 有值 → `restoreDraftContent`（**草稿 > prefill**：恢复后置 injectedRef，跳过 initialContent）；无草稿 → 走既有 initialContent 注入（`injectInitialContent`，ref-guard/empty check/queueMicrotask 语义与 ChatComposer 现状等价）；② 返回 `saveDraft(ed)`（`getState().saveDraft(sessionId, serializeEditorContent(ed.getJSON()))`）+ `clearDraft()`（`getState().clearDraft(sessionId)`） | MUST 全部 getState 读/写（不订阅 store → 输入零 re-render）；MUST injectedRef 防重注入（同 ChatComposer 现状 ref-guard 语义）；MUST 有草稿时 initialContent（prefill）不注入（决策② PRD §2.5 草稿优先）；MUST queueMicrotask 推迟出 commit phase（守 memory tiptap-effect-flushsync-lifecycle） | PRD §2.3/§2.5/§3.2/§3.3；决策②③；component-chat-composer.tsx 现状 initialContent effect（170-179 行） | +42 |
| ui-chat | app/web/src/components/chat-page/component-chat-composer.tsx | ChatComposer 组件（initialContent effect） | 修改 | 删除原 initialContent effect（170-179 行：`initialContentInjectedRef` + `queueMicrotask(() => injectInitialContent(...))`），改为调用 `useChatDraft(editor, sessionId, initialContent)`（接管 mount 注入 + 返回 saveDraft/clearDraft）；`initialContentInjectedRef` 移入 hook | MUST 删除后组件不再自管 initialContent 注入（单一出口 = useChatDraft）；MUST 文件行数 ≤300（删除 effect 净减 ~10 行，为 onUpdate/handleSubmit 增量留余量） | 决策②；本 change_plan useChatDraft 行 | -10 |
| ui-chat | app/web/src/components/chat-page/component-chat-composer.tsx | ChatComposer onUpdate | 修改 | useEditor onUpdate 回调：现有 `detectTrigger(ed)` 后追加 `saveDraft(ed)`（编辑即写缓存，含空内容清除——clearContent 触发 onUpdate → serialize '' → saveDraft 空 = 清除） | MUST 不改变 detectTrigger 行为（@ 触发检测原样保留）；MUST 每次输入实时写（不加防抖——serialize 是 O(doc) 轻量，人类输入频率无卡顿）；MUST saveDraft 空串自动清除（PRD §2.2） | PRD §3.2；决策①③ | +2 |
| ui-chat | app/web/src/components/chat-page/component-chat-composer.tsx | ChatComposer handleSubmit | 修改 | `onSend(content)` + `clearContent()` 后追加 `clearDraft()`（发送后显式清草稿，语义明确 PRD §3.4；不依赖 clearContent 是否触发 onUpdate 的框架行为） | MUST 在 onSend 之后清（发送成功语义）；MUST 空内容发送 no-op 守卫不变（不触发清除）；MUST clearDraft 幂等（无草稿 no-op） | PRD §3.4；决策② | +2 |
| ui-chat | app/web/src/store/__tests__/chat-slice-draft.test.ts（新） | 草稿纯逻辑 UT | 新增 | saveDraft 写/空清除/值相同不 set（订阅者不重触发）/clearDraft 幂等/不可变更新（原 drafts 不被 mutate）/DraftContent 字符串形 | MUST 用 createChatSliceStore() 工厂新建实例（不碰 useChatStore 单例，测试隔离）；MUST 断言值相同 saveDraft 不触发 set（subscribe spy） | PRD §3.1/§7 UT 范围 | +60 |
| ui-chat | app/web/src/components/chat-page/__tests__/use-chat-draft.test.tsx（新） | useChatDraft UT | 新增 | 有草稿 → 恢复（含 mention pill 保真：deserialize → insertContent）；无草稿 → initialContent（prefill）注入；**草稿优先**（有草稿时 initialContent 不注入）；恢复后 saveDraft 回写同值幂等（store 不重复 set）；saveDraft/clearDraft action 语义 | MUST jsdom 环境（Tiptap 真实 editor，对齐 component-chat-composer.test.tsx 模式）；MUST 用 createChatSliceStore() 独立实例注入（不污染 useChatStore 单例） | PRD §3.3/§2.5/§7 UT 范围 | +70 |
| ui-chat | app/web/src/components/chat-page/__tests__/component-chat-composer.test.tsx | ChatComposer 草稿集成 UT | 修改 | 追加草稿用例：mount 有草稿 → 编辑器恢复内容；输入 → drafts[sessionId] 更新；发送 → clearDraft（草稿清除）；无草稿 + prefill → prefill 注入（回归）；既有用例全保持 | MUST 既有用例零破坏（草稿用例 beforeEach 清 drafts 隔离）；MUST 断言编辑器 DOM 内容（.ProseMirror textContent 含恢复文本 + pill 渲染） | PRD UC-1~8；决策① | +50 |

## 影响面评估

- **改动文件**：4 个代码/组件（chat-slice + use-chat-draft 新 + helpers + ChatComposer）+ 3 个测试（1 新 + 1 新 + 1 改）+ 4 个 specs（doc-modifier 阶段 5 同步：chat-composer.md / section-chat-session.md / component_architecture.md / 00-app-guide.md）
- **风险点**：
  1. **ChatComposer 299 行压线**：删除 initialContent effect（-10）+ onUpdate/handleSubmit 增量（+4）→ 净 -6 → ~293 行，有安全余量；若超限需拆（use-chat-draft 已独立成文件）
  2. **useChatStore 单例测试污染**：ChatComposer 集成 UT 渲染时真实读写单例 drafts——beforeEach/afterEach 清 drafts 隔离；纯逻辑/新 hook 测试用 createChatSliceStore() 工厂独立实例
  3. **clearContent 触发 onUpdate**：发送清空会触发 onUpdate → saveDraft('') → 自动清除（兜底）；handleSubmit 显式 clearDraft 双保险（不赌框架行为）
  4. **恢复触发 onUpdate 回写**：insertContent 触发 onUpdate → saveDraft（同值幂等不 set，内容等价）——PRD §3.3 已接受
  5. **序列化保真**：serialize/deserialize 往返已有 5+ 版本稳定（mention-tag.ts + extension UT 覆盖），本版仅复用原语不新增序列化逻辑
- **不做**（PRD §6）：持久化 / 跨窗口共享 / 光标位置缓存 / 草稿列表 UI / 发送失败补偿 / AT/ET 持久 case（UT 覆盖）

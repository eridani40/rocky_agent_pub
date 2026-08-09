# v0.0.267 tech change log — Session 输入草稿缓存

> 对应需求：`reqs/[working] v0.0.267/req.md`（用户可感知的行为改动 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.267.input_draft_cache/prd.md`。
> 权威契约：`specs/tech/version_logs/v0.0.267/change_plan.md`（method 级 10 行表，frozen）。

## 变更摘要

### 需求与动机

用户在某个 session 的输入区输入了一半内容（纯文本 / mention pill / 混合），切到其他 session 再切回，**输入半路的内容丢失**。根因（代码摸底确认）：所有聊天页统一经 `SectionChatSession` 装配，消费方切 session 用 `key={sessionId}` remount（`page-chat.tsx:102`；studio 由 router 同语义）——切 session 整个 SectionChatSession 卸载 → ChatComposer（Tiptap `useEditor`）卸载销毁 → 输入内容随组件生命周期丢失。既有 `prefill`/`initialContent`（mount-time 一次注入）只服务外部模板，不服务「上次编辑内容」。

### 方案（3 口子架构期裁决，详见 change_plan「架构期裁决」）

1. **草稿格式 = 序列化字符串**（决策①）：`DraftContent = string` = `serializeEditorContent` 输出（文本 + `<mention …/>` 内联 tag，`\n` 段落分隔）——与发送通道（onSend 的 content）同构，mention 保真（serializeMention/deserializeLine 双向），存储轻量（string vs Tiptap JSON 对象），恢复用既有逆运算 `deserializeContentToParagraphs`。
2. **接线 API = ChatComposer 内部接 useChatStore（getState 读/写，不订阅）**（决策②）：不新增 props、不新增装配层改动——7 页（playground/studio 单聊群聊/academy×4）经 SectionChatSession → ComponentChatSessionInput → ChatComposer 单点生效；新建 `use-chat-draft.ts` hook 接管 mount 注入（**草稿 > prefill 优先级**）+ 提供 saveDraft/clearDraft actions；ChatComposer 原 initialContent effect 移入 hook（ref-guard/empty check/queueMicrotask 语义等价）。
3. **selector 精化 = 天然满足（零 re-render）**（决策③）：ChatComposer/hook 用 `useChatStore.getState()` 读写 drafts（不订阅 store）→ 输入时 saveDraft 的 zustand set 不触发任何组件 re-render；`saveDraft` 值相同不 set（幂等优化，恢复回写同值不触发）。

### T1 — chat-slice 草稿 store（纯前端状态）

- **`store/chat-slice.ts`（201 → 248 行）**：
  - `DraftContent = string` type（序列化字符串，与发送通道同构，mention 保真；空串 = 无草稿）。
  - `ChatSliceState.drafts: Record<sessionId, DraftContent>`——内存级（无 persist middleware，关应用/刷新丢失符合需求）。
  - `saveDraft(sessionId, content)`：空内容（`!content.trim()`）→ 删 key（等价清除，幂等）；非空 → `{...drafts, [sessionId]: content}` spread 新建写；**值相同不 set**（`s.drafts[sessionId] === content ? s : …`，防恢复回写同值触发订阅）。
  - `clearDraft(sessionId)`：删 key；key 不存在 no-op 不 set（幂等）。
- **`store/__tests__/chat-slice-draft.test.ts` NEW（11 用例）**：saveDraft 写 / 空内容清除 / 值相同不 set（subscribe spy 断言不重触发）/ clearDraft 幂等 / 不可变更新（原 drafts 不被 mutate）/ DraftContent 字符串形——用 `createChatSliceStore()` 工厂新建实例（不碰 useChatStore 单例，测试隔离）。

### T2 — useChatDraft 接线 + ChatComposer 接入

- **`chat-page/use-chat-draft.ts` NEW（70 行）**：`useChatDraft(editor, sessionId, initialContent, store?)` 返回 `{ saveDraft(ed), clearDraft() }`：
  - mount 恢复（useEffect）：editor ready + `store.getState().drafts[sessionId]` 有值 → `queueMicrotask(() => restoreDraftContent(editor, draft))`（置 injectedRef，跳过 initialContent）；无草稿 → 既有 injectInitialContent（ref-guard / empty check / queueMicrotask 语义与 ChatComposer 现状等价）。
  - `saveDraft(ed)` = `store.getState().saveDraft(sessionId, serializeEditorContent(ed.getJSON()))`；`clearDraft()` = `store.getState().clearDraft(sessionId)`。
  - **全部 getState 读/写、不订阅 store** → 输入零 re-render；`store` 可选参数 = 测试注入独立实例（`createChatSliceStore()`），生产默认 useChatStore 单例。
- **`chat-page/chat-composer-helpers.ts`（79 行）**：新增 `restoreDraftContent(editor, content)`——`deserializeContentToParagraphs(content)`（mention pill 保真，复用 mention-tag.ts 注入路径原语）→ `editor.chain().focus().insertContent(paragraphs).run()`；与 injectInitialContent 并列（职责 = editor 命令封装；ref guard / queueMicrotask 推迟由 useChatDraft 负责）。
- **`chat-page/component-chat-composer.tsx`（299 → 297 行）**：
  - 删原 initialContent effect（170-179 行：`initialContentInjectedRef` + `queueMicrotask(() => injectInitialContent(...))`）→ 改为 `useChatDraft(editor, sessionId, initialContent)`（单一出口，`initialContentInjectedRef` 移入 hook）。
  - onUpdate：`detectTrigger(ed)` 后追加 `saveDraft(ed)`（编辑即写缓存，含空内容清除——clearContent 触发 onUpdate → serialize '' → saveDraft 空 = 清除）。
  - handleSubmit：`onSend(content)` + `clearContent()` 后追加 `clearDraft()`（发送后显式清，不赌 clearContent 是否触发 onUpdate 的框架行为，双保险）。
- **测试**：`chat-page/__tests__/use-chat-draft.test.tsx` NEW（7 用例：有草稿恢复含 mention pill 保真 / 无草稿 prefill 注入 / **草稿优先**（有草稿时 initialContent 不注入）/ 恢复后 saveDraft 回写同值幂等（store 不重复 set）/ actions 语义）+ `chat-page/__tests__/component-chat-composer.test.tsx` 追加草稿集成用例（mount 恢复 / 输入写缓存 / 发送清除 / prefill 回归）。

## 设计决策

- **草稿格式 = 序列化字符串而非 Tiptap JSON**：与发送通道同构（onSend 的 content 就是 serializeEditorContent 输出）→ 存的就是「即将发送的内容」，恢复 = 发送路径逆运算，无格式转换心智；mention 保真（serializeMention/deserializeLine 双向，icon/label/address 全属性）；存储轻量（string vs JSON 对象）。Tiptap JSON 最保真但存储重 + 恢复需 JSON 解析 + 与发送通道两套格式。序列化/反序列化往返已有 5+ 版本稳定（mention-tag.ts + extension UT 覆盖），本版仅复用原语不新增序列化逻辑。
- **接线 = ChatComposer 内部 hook（getState 不订阅）而非新增 props / 装配层改**：7 页统一装配层单点生效，零装配改动；getState 读写不订阅 → 输入时 saveDraft 的 set 零 re-render（zustand 订阅者按 selector 引用 Object.is 比较，未订阅 drafts 的组件不收通知）；saveDraft 值相同不 set 双重护栏。否决「新增 draftKey/onDraftChange props」（每页接线 + props 扩散 + SectionChatSession/ComponentChatSessionInput 逐层透传）。
- **草稿 > prefill 优先级**：草稿 = 用户上次编辑进行到一半的强意图；prefill = 外部跳转入口（studio 看板 @ / 业务全景引导）的弱意图。恢复草稿不覆盖用户未完成输入；prefill 仅在无草稿时注入（mount-time 一次性，发送/清空后不重注入）。
- **保存时机 = onUpdate 实时写而非 unmount cleanup**：key remount 下「卸载前保存」依赖 React cleanup 与 Tiptap editor destroy 的顺序（父 cleanup 在子 unmount 后执行，可能读不到已销毁的 editor，时序脆弱）；实时写缓存从根上消除该风险——编辑器内容任何时候都有缓存兜底。
- **发送后显式 clearDraft（不赌 clearContent 触发 onUpdate）**：发送清空会触发 onUpdate → saveDraft('') → 自动清除（兜底）；handleSubmit 显式 clearDraft 双保险——onSend 之后清（发送成功语义），语义明确不依赖框架行为。
- **不缓存非内容态**（PRD §3.2）：@ popover 打开态 / 光标位置 / 选中态不缓存（需求「输入内容」不含焦点/弹层）。

## 代码↔spec 核实（doc-modifier 阶段 5 — 逐项比对 change_plan + 代码）

| # | change_plan 契约 | 代码实现 | 一致 |
|---|---|---|---|
| 1 | `DraftContent = string` type（与发送通道同构，mention 保真） | `chat-slice.ts:41` `export type DraftContent = string`（注释对齐 PRD §2.1/§3.1 + 决策①） | ✅ |
| 2 | `ChatSliceState.drafts: Record<sessionId, DraftContent>`（内存级，无 persist） | `chat-slice.ts:103` drafts 字段 + `:155` 工厂初始 `drafts: {}`；无 persist middleware | ✅ |
| 3 | `saveDraft`：空内容删 key / 值相同不 set / 不可变更新 | `chat-slice.ts:219-234`：`!content.trim()` → 删 key（`sessionId in get().drafts` 守卫）；同值 `return` 不 set；spread 新建 | ✅ |
| 4 | `clearDraft`：删 key，不存在 no-op 不 set（幂等） | `chat-slice.ts:235-243`：`!(sessionId in get().drafts)` return；spread 删 | ✅ |
| 5 | `restoreDraftContent(editor, content)`：deserializeContentToParagraphs → insertContent（mention pill 保真） | `chat-composer-helpers.ts:75-78`：`deserializeContentToParagraphs(content)` → `editor.chain().focus().insertContent(paragraphs).run()` | ✅ |
| 6 | `useChatDraft`：getState 读/写不订阅；mount 恢复草稿>prefill；queueMicrotask；store 可选参数 | `use-chat-draft.ts:30-70`：全部 `store.getState()`；useEffect 有草稿 → restoreDraftContent + injectedRef；无草稿 → injectInitialContent；`queueMicrotask` 推迟；`store` 参数默认 useChatStore | ✅ |
| 7 | ChatComposer 删 initialContent effect，改为 useChatDraft | `component-chat-composer.tsx:173-175`：`const { saveDraft, clearDraft } = useChatDraft(editor, sessionId, initialContent)`；无独立 initialContent effect | ✅ |
| 8 | onUpdate 追加 saveDraft(ed)（不改变 detectTrigger） | `component-chat-composer.tsx:155-160`：`detectTrigger(ed)` 后 `saveDraft(ed)` | ✅ |
| 9 | handleSubmit 追加 clearDraft()（onSend 之后） | `component-chat-composer.tsx:184-194`：`onSend(content)` → `clearContent()` → `clearDraft()` | ✅ |
| 10 | 测试隔离：createChatSliceStore() 工厂 + beforeEach 清 drafts | `chat-slice-draft.test.ts`（11 用例）+ `use-chat-draft.test.tsx`（7 用例）+ composer 集成用例；interrupt.test beforeEach 清 drafts（既有测试适配） | ✅ |

**偏离记录（等价合理，非静默）**：
- `interrupt.test` beforeEach 清 drafts：既有测试适配必要（editor 内容变化 → onUpdate 写缓存 → 同文件后续用例 mount 恢复残留 → pills 多 1）——code-reviewer 记录「偏离 2 项等价合理」。
- `useChatDraft` store 可选参数：测试隔离注入点（生产默认 useChatStore 单例，零影响）。
- 行数：chat-slice.ts 248 / use-chat-draft.ts 70 / chat-composer-helpers.ts 79 / component-chat-composer.tsx 297（全部 ≤300 达标；ChatComposer 299 压线风险由删 initialContent effect 净减化解）。

## 文档同步

- `specs/ui/components/chat-page/chat-composer.md`：职责段补草稿缓存；initialContent 说明补「草稿优先（useChatDraft 接管 mount 注入）」；新增「输入草稿缓存」节（存储 / saveDraft/clearDraft / useChatDraft 接线 / restoreDraftContent / 覆盖范围）。
- `specs/ui/components/chat-page/section-chat-session.md`：prefill prop 注释补「无草稿时注入，草稿优先」；新增「输入区草稿」节。
- `specs/tech/app/frontend/[P0]component_architecture.md`：§3.4 store 保留清单补 drafts/saveDraft/clearDraft。
- `specs/ui/overall/00-app-guide.md`：§3.1 补「聊天输入草稿缓存」操作语义（切 session 草稿保留 / 发送清除 / 内存级）。
- `specs/tech/app/frontend/log.md` + `index.md`：v0.0.267 条目 + 概念行。
- **不做**：AT/ET 持久 case（纯前端确定性状态逻辑，UT 覆盖；PRD 用户铁律）；前端无 API 变更（无 specs/api 同步）。

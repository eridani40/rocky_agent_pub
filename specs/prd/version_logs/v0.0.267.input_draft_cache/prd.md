# v0.0.267 PRD — Session 输入草稿缓存

> 版本：v0.0.267 · 主题：每个 session 的输入区域内容（未发送草稿）在内存中缓存，切走再切回内容完整恢复。
> PRD 边界（用户裁决 2026-07-14）：本文只覆盖**用户可感知**的产品逻辑/体验/反馈；缓存存储位置（chat-slice / module Map）、草稿序列化格式（Tiptap JSON vs 序列化字符串）、保存时机实现（onUpdate 实时写 vs unmount cleanup）归 architect 落 `specs/tech/version_logs/v0.0.267/change_plan.md`；组件 spec 由编码期补/改 `specs/ui/components/`。PRD 不发明技术细节，只描述产品语义到可落地。
> 需求来源：`reqs/[working] v0.0.267/req.md`（4 点）+ 代码摸底（根因：key remount）

---

## 1. 背景 + 目标

### 1.1 背景（现状）

用户在某个 session 的输入区输入了一半内容（纯文本 / mention pill / 混合），切到其他 session 再切回来，**输入半路的内容丢失**。

**根因（代码摸底确认）**：
- 所有聊天页（playground / studio 单聊群聊 / academy×4）统一经 `SectionChatSession` 装配，输入区 = `ChatComposer`（Tiptap 编辑器，`useEditor` mount 时新建空文档）。
- 消费方页面切换 session 用 **`key={sessionId}` remount**（`page-chat.tsx:102` `key={viewedSessionId}`；studio 由 router 保证同语义）——切 session 时整个 `SectionChatSession` 卸载 → `ChatComposer` 卸载 → Tiptap editor 销毁 → **输入内容随组件生命周期丢失**。
- 现有恢复通道 `prefill`/`initialContent`（mount-time 一次注入）只服务外部模板（studio 看板 @ 入口 / 业务全景引导），不服务「上次编辑内容」。

### 1.2 目标

1. **每个 session 独立缓存**：草稿按 sessionId 隔离，互不串扰。
2. **内存级缓存**：关应用丢失可接受，不做持久化。
3. **完整输入态恢复**：纯文本、mention（@人）pill、混合内容、多行——切回 session 时完整恢复。
4. **发送后清除**：已发送的内容不应作为草稿残留。

## 2. 范围与代决（orchestrator 代 AFK 用户拍板）

### 2.1 草稿缓存 = 内存级 store（chat-slice 扩展），key = sessionId

- **存储位置**：扩展 `chat-slice`（内存级 zustand，无 persist middleware——正好符合「关应用丢失可接受」）。
- **数据结构**：`drafts: Record<sessionId, DraftContent>`（sessionId → 草稿）；`saveDraft(sessionId, content)` / `clearDraft(sessionId)` 两个 action。
- **草稿格式**（产品语义，实现归架构期）：能完整表达编辑内容（文本 + mention pill + 段落/换行）——候选：Tiptap JSON（`editor.getJSON()`，最保真）或序列化字符串（`serializeEditorContent` 输出 `<mention/>` 内联标签，复用现有序列化/反序列化原语 `mention-tag.ts`）。**产品验收口径 = 恢复后用户看到与切走时一致的编辑内容（含 pill）**。

### 2.2 保存时机 = 编辑即写（onUpdate 实时写缓存）

- **产品语义**：输入内容一变即记入缓存（实时），任何时刻切走都完整保留，不依赖卸载时机/顺序。
- **理由（代决）**：key remount 下「卸载前保存」依赖 React cleanup 与 Tiptap editor destroy 的顺序（父 cleanup 在子 unmount 后执行，可能读不到已销毁的 editor，时序脆弱）；实时写缓存从根上消除该风险——编辑器内容任何时候都有缓存兜底。
- **空草稿不写**（空串/空文档 = 无草稿，写空等价清除）。

### 2.3 恢复时机 = mount 时注入（复用 initialContent 通道）

- **产品语义**：切回 session → ChatComposer mount → 从缓存读该 sessionId 草稿注入编辑器。
- **实现**：复用既有 `initialContent` mount-time 一次性注入机制（`chat-composer-helpers.injectInitialContent`，已有 ref-guard 防重注入）。
- **格式适配**：缓存格式（Tiptap JSON / 序列化字符串）与 initialContent 现有两形（MentionAttrs[] / string）的适配归架构期定——可以是 ChatComposer 增加一个「恢复草稿」专用注入路径，或把缓存格式对齐 initialContent 可接受形。

### 2.4 发送后清除缓存

- **产品语义**：发送成功（内容已送出）→ 清除该 session 草稿缓存——否则切回 session 会恢复出**已发送**的内容（错误行为）。
- **时机**：与现有「发送后编辑器立即清空」一致——`handleSubmit` 内 `onSend(content)` 后清除（乐观清除，与 postMessage fire-and-forget 一致；发送失败时输入内容已按现状清空，草稿同步清空是合理语义，不补偿）。

### 2.5 prefill 与草稿的优先级：草稿优先

- **冲突场景**：SectionChatSession 的 `prefill` prop（外部模板，如 studio 看板 @ 入口 / 业务全景引导）与已存在草稿同时存在。
- **规则（代决）**：**有草稿时恢复草稿**；prefill 仅在无草稿时注入。理由：草稿 = 用户上次编辑进行到一半的强意图；prefill = 外部跳转入口的弱意图。恢复草稿不覆盖用户未完成输入。
- **prefill 注入后**：若用户发送/清空（草稿清除），下次切回无草稿 → prefill 不再注入（initialContent 是 mount-time 一次性，不受影响）。

### 2.6 覆盖范围：所有经 SectionChatSession 接入的聊天页

- playground 主会话 + studio 单聊/群聊 + academy×4 —— 统一装配层单点生效，不逐页接入。
- **subagent 只读页**（readOnly）：无输入区，不缓存不恢复。
- **新建会话**：无草稿，正常空输入。

## 3. 功能需求

### 3.1 草稿缓存 store（P0）

**描述**：chat-slice 新增草稿缓存（内存级），key = sessionId。

**优先级**：P0

**产品规则**：
- `drafts: Record<string, DraftContent>`（sessionId → 草稿内容）。
- `saveDraft(sessionId, content)`：写入；空内容 = 清除（幂等）。
- `clearDraft(sessionId)`：删除该 session 草稿。
- 无持久化（zustand 内存态，关应用/刷新丢失——符合需求）。

### 3.2 编辑即保存（P0 核心）

**描述**：ChatComposer 内容变化（onUpdate）→ 实时写入该 session 草稿缓存。

**优先级**：P0

**产品规则**：
- 任何编辑（输入文本 / 插删 mention pill / 换行 / 粘贴）→ 草稿更新。
- 空内容（清空/删光）→ 草稿清除（等价无草稿）。
- **不缓存**：@ popover 打开态、光标位置、选中态（非内容态，切回不恢复这些是合理范围——需求「输入内容」不含焦点/弹层）。

### 3.3 切回恢复（P0 核心）

**描述**：session 切回（ChatComposer mount）→ 从缓存读草稿注入。

**优先级**：P0

**产品规则**：
- 有草稿 → 注入恢复（完整内容：文本 + mention pill + 多行）。
- 无草稿 → 正常空输入（或有 prefill 则注入 prefill）。
- 恢复后用户可继续编辑/删除/发送（注入是一次性的，恢复后即普通编辑器）。
- 恢复不触发「编辑即保存」回写循环（注入 = 恢复缓存内容，写回同值幂等无害）。

### 3.4 发送后清除（P0）

**描述**：发送成功 → 清除该 session 草稿。

**优先级**：P0

**产品规则**：
- `handleSubmit` 内 `onSend(content)` 后 → `clearDraft(sessionId)`。
- 空内容发送 no-op（现有守卫）不触发清除。

### 3.5 prefill 优先级（P0 配套）

**描述**：有草稿时草稿优先于 prefill。

**优先级**：P0

**产品规则**：见 §2.5——mount 时「草稿 > prefill」优先级，草稿存在则注入草稿、忽略 prefill。

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 在 session A 输入纯文本「帮我看看代码」→ 切到 session B → 切回 A | 输入区恢复「帮我看看代码」，可继续编辑 |
| UC-2 | 在 session A 输入「发给 @leader」+ mention pill（@leader）→ 切走再切回 | 文本 + mention pill 完整恢复（pill 仍是 pill，非纯文本） |
| UC-3 | 在 session A 输入多行文本（含换行）→ 切走再切回 | 多行内容完整恢复（换行保留） |
| UC-4 | 在 session A 输入半截 → 发送 → 切走再切回 A | 输入区为空（已发送内容不残留为草稿） |
| UC-5 | session A 无草稿（空输入 / 已清空）→ 切走再切回 | 输入区为空（不凭空恢复） |
| UC-6 | 有草稿的 session A + 外部 prefill 入口进入（如 studio 看板 @） | 恢复草稿（prefill 不覆盖草稿） |
| UC-7 | session A 输入 → 切 B → 切 A 恢复 → 再切 B | B 的草稿独立存在（A/B 互不串扰，key=sessionId 隔离） |
| UC-8 | 回归：新建会话 / subagent 只读页 / 无会话空态 | 输入区行为与现状一致（无草稿干扰） |

> **AT 入选评估**：本版本是**纯前端确定性状态逻辑**（无 API 变更、无 LLM 不确定性）——缓存 store + 注入恢复全部可 UT 确定性覆盖。**v1 不新增 AT case**（用户铁律）。
> **UT 范围（核心）**：chat-slice `saveDraft/clearDraft/drafts` 纯逻辑；ChatComposer onUpdate 实时写缓存（含空内容清除）；mount 恢复注入（含 mention pill 恢复）；发送后清除；prefill 优先级（草稿 > prefill）。既有 chat-composer / chat-slice UT 回归。
> **ET 评估**：聊天板块已有 send-message 冒烟 case（核心冒烟集）——**v1 不新增持久 ET case**。切 session 恢复草稿是纯前端交互，UT 覆盖足够；若 orchestrator 判定需要真机验证，可临时跑非持久 case（自由心证），不落库。

## 5. 概念对齐（PRD ↔ ui/tech spec — 不发明新概念）

| PRD 引用 | 权威 spec / 归属 |
|---|---|
| ChatComposer（Tiptap + mention pill + initialContent mount-time 注入 + serializeEditorContent） | `specs/ui/components/chat-page/chat-composer.md` |
| 统一装配层（SectionChatSession，7 页接入点 + prefill 传递） | `specs/ui/components/chat-page/section-chat-session.md` |
| 输入区骨架（BaseChatInputBar composerSlot） | `specs/ui/components/chat-page/base-chat-input-bar.md` |
| chat-slice（内存级 zustand，列表/拓扑/workspace 扇出） | `app/web/src/store/chat-slice.ts` + `[P0]component_architecture.md` |
| 序列化/反序列化原语（serializeEditorContent / deserializeContentToParagraphs / mention-tag.ts） | `specs/tech/mention/message-content.md` + `chat-composer.md` |

**新概念（架构期/编码期补 spec，PRD 只定义产品语义）**：

- **「草稿缓存」store 扩展**（新）：chat-slice 加 `drafts: Record<sessionId, DraftContent>` + `saveDraft/clearDraft`。**注意订阅粒度**：SectionChatSession 等既有消费方若订阅 chat-slice 需按 selector 精化，避免每次输入触发全量 re-render（实现细节归架构期）。
- **ChatComposer 草稿接线**（新）：onUpdate → saveDraft；mount 恢复（草稿 > prefill 优先级）；发送后 clearDraft。可能新增 prop（如 `draftKey`/`onDraftChange`）或直接内部接 store——归架构期定 API 形态。
- **草稿格式规范**（新）：DraftContent 的具体形（Tiptap JSON vs 序列化字符串）归架构期定；产品验收 = 完整内容恢复（含 pill）。

**与既有 spec 的已知差异（doc-modifier 阶段 5 待同步）**：

- `chat-composer.md` → 补草稿缓存接线（onUpdate 写缓存 / mount 恢复 / 发送清除 / prefill 优先级）
- `section-chat-session.md` → 补「输入区草稿」行为（草稿 > prefill）
- `chat-slice.ts` / `[P0]component_architecture.md` → 补 drafts 字段 + actions
- `specs/ui/overall/00-app-guide.md` → 补「切 session 草稿保留」操作语义

## 6. 边界 / 不做（v1）

- **不做持久化**：关应用/刷新页面草稿丢失（需求明确内存级）
- **不做跨窗口/跨 tab 共享**：草稿在单个 renderer 内存内（多窗口各自独立）
- **不缓存光标位置 / 选中态 / @ popover 打开态**：只缓存输入内容（文本 + pill）
- **不做草稿列表 UI / 手动管理**：无「草稿箱」、无「保存」按钮、无恢复确认——全自动，用户无感知
- **不缓存 subagent 只读页**：readOnly 无输入区
- **不新增 AT/ET 持久 case**（用户铁律）：UT 覆盖
- **不改发送链路 / API**：无 API 变更，postMessage 等现状不变
- **不处理「发送失败补偿」**：发送失败时编辑器已按现状清空，草稿同步清除（与现状行为一致，不额外补偿）

## 7. 验收口径

- **功能**：UC-1~8 全部成立（UT：drafts store + onUpdate 写缓存 + mount 恢复 + 发送清除 + prefill 优先级；回归：既有 chat-composer / chat-slice UT）
- **能力不变量**：
  - 每个 session 草稿独立（key=sessionId），切走再切回内容完整恢复（文本 + mention pill + 多行）
  - 发送后草稿清除（不残留已发送内容）
  - 草稿优先于 prefill（外部模板不覆盖未完成输入）
  - 空草稿 = 无草稿（不凭空恢复）
- **回归不变量**：
  - 发送链路 / onSend 行为不变（草稿清除是附加副作用）
  - prefill 注入在无草稿时行为不变（studio 看板 @ / 业务全景引导）
  - 新建会话 / subagent 只读 / 空态输入区行为不变
- **性能护栏**：编辑即写缓存不得引发输入卡顿/全量 re-render——订阅粒度按 selector 精化（仅 drafts 相关消费方更新），写入是轻量对象替换（无深拷贝放大）
- **布局稳定性**（CLAUDE.md MANDATORY）：草稿缓存不引入任何新 UI 元素/布局变化
- **视觉保真门禁**：**无 UI 变化** → 本项跳过 `vision_check compare`

## 8. spec 对齐备忘（读 spec 时发现的出入，供 doc-modifier 后续修）

- `page-chat.tsx:102` `key={viewedSessionId}` remount 是草稿丢失根因——本版本不改 remount 语义（草稿缓存兜底），但 spec 注释可补「切 session remount + 草稿恢复」说明
- `section-chat-session.tsx` 的 `prefill` prop 注释当前写「初始内容预填（mount-time 注入）」——需补「无草稿时注入；有草稿时草稿优先」
- `chat-composer.md` Props `initialContent` 描述「mount-time 一次性注入」——草稿恢复复用此通道或新增专用通道，spec 需同步

## 9. 版本

**v0.0.267** — Session 输入草稿缓存：每个 session 的输入区内容（纯文本 + mention pill + 多行）在内存级 store（chat-slice drafts，key=sessionId）中缓存；编辑即写（onUpdate 实时保存）、切回即恢复（mount 注入，草稿优先于 prefill）、发送后清除；覆盖全部经 SectionChatSession 接入的聊天页，无 API 变更。详见本 PRD + change_plan（architect 落 `specs/tech/version_logs/v0.0.267/change_plan.md`）。

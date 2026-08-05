# v0.0.248 变更计划书 — 业务全景「更多」tab 引导：跳 leader 单聊 + 预填搭看板文本

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 选型决策（唯一技术未知 — 架构钉死）

**选 A：把 `prefill`/`initialContent` 扩成联合类型 `MentionAttrs[] | string`**（从 page-studio MainView 一路透传到 ChatComposer，消费端窄化分派）。

**理由（一句）**：联合类型对中间 4 层是零成本透传（不窄化、不重命名、不改 JSX），只在唯一消费端 ChatComposer 做 `typeof === 'string'` 分派——blast radius 最小、不破坏现有 mention pill mount-time 注入回路（ref guard / queueMicrotask 全复用）、单一 prop 表达「初始内容」单一概念（优于新加 `initialText` 双 prop）。

**不选 B（新增 `initialText` prop）**：双 prop 表达近似概念（「初始 mention」+「初始文本」），5 层链路每个都加一个 optional prop，API 表面更大、文档更碎。

**不选 C（仅 tiptap commands 文本注入、不动 prop）**：C 是注入机制不是传输机制——文本仍须从 page-studio 传到 composer，必须有 prop；选 A 后 C 自然落地为 composer 内的 string 分支（`editor.chain().focus().insertContent(text).run()`）。

---

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（ui-studio / ui-chat / ui-i18n / test） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT 钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 原则编号 / memory） |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | app/web/src/components/studio-page/page-studio.tsx | `MainView`（type，chat 分支 :42） | 修改 | `prefill?: MentionAttrs[]` → `prefill?: MentionAttrs[] \| string`（联合类型，支持文本预填） | MUST 只动 chat 分支的 prefill 字段；MUST NOT 改其他 kind shape | specs/ui/overall/06-studio.md §7；选型决策 A | +1/-1 |
| ui-studio | app/web/src/components/studio-page/page-studio.tsx | `SeatsPanel.onAtLeader` 内联回调（:169-188） | 修改 | ①`sessionId: d.squadChatSessionId` → `sessionId: leader.sessionId`（切 leader 单聊）②`title/tag` 改 leader 单聊派生（title=leader.name，tag=`t('studio:squadTree.tagLeader',{name:d.name})`）③`prefill: [{type:'member',...badge:'leader'}]` → `prefill: '帮我搭建一个看板，展示…'`（字面 `...` 作填空标记）④删 mention attrs 构造 ⑤保留 `!d \|\| !leader` flash 兜底 | MUST `leader.sessionId` 是 Member 真实字段（确认存在，参考 buildMemberChatNode :91 用同字段）；MUST NOT 保留 mention chip；MUST 保留 noLeaderAvailable flash 兜底分支不动；MUST prefill 待发（不自动 send） | reqs/[working] v0.0.248/req.md 锁定决策；PRD §3.1/§3.2/§4 UC-248-MAIN；06-studio.md §7.2 单聊页 | +10/-12 |
| ui-chat | app/web/src/components/studio-page/component-studio-chat-router.tsx | `StudioChatRouterProps.prefill`（type :41） | 修改 | prop 类型 `MentionAttrs[]` → `MentionAttrs[] \| string`（中间层联合类型透传，不窄化） | MUST 不做 typeof 窄化（透明透传给 SectionStudioChat）；MUST NOT 改 prop 名 | 选型决策 A（中间层零成本透传） | +1/-1 |
| ui-chat | app/web/src/components/studio-page/section-studio-chat.tsx | `SectionStudioChatProps.prefill`（type :27） | 修改 | 同上，类型扩成联合，透传给 SectionChatSession | MUST 透传不窄化 | 选型决策 A | +1/-1 |
| ui-chat | app/web/src/components/chat-page/section-chat-session.tsx | `SectionChatSessionProps.prefill`（type :58） | 修改 | 同上，类型扩成联合，透传给 ComponentChatSessionInput | MUST 透传不窄化 | 选型决策 A | +1/-1 |
| ui-chat | app/web/src/components/chat-page/component-chat-session-input.tsx | `ChatSessionInputProps.prefill`（type :64） | 修改 | 同上，类型扩成联合，透传给 ChatComposer `initialContent` | MUST 透传不窄化；MUST NOT 在此层做注入（注入只在 ChatComposer） | 选型决策 A | +1/-1 |
| ui-chat | app/web/src/components/chat-page/component-chat-composer.tsx | `ChatComposerProps.initialContent`（type :42-46） | 修改 | ①prop 类型 `MentionAttrs[]` → `MentionAttrs[] \| string` ②doc 注释更新：「初始内容，mount 时一次性注入——mention 注为 pill、string 注为 text node（可编辑）」 | MUST 文档说明两形语义；MUST NOT 改 prop 名（`initialContent` 沿用） | specs/ui/components/chat-page/chat-composer.md；选型决策 A | +3/-2 |
| ui-chat | app/web/src/components/chat-page/component-chat-composer.tsx | `useEffect`（mount-time 注入 :174-179） | 修改 | 把 `queueMicrotask(() => injectMentions(editor, initialContent))` 改为 `queueMicrotask(() => injectInitialContent(editor, initialContent))`（单一 dispatcher 调用，分派在 helper 内）；现有 `!initialContent \|\| initialContent.length === 0` 守卫对 string/array 两形都正确（string 有 .length，'' 命中两条件），**不改守卫** | MUST 复用 `initialContentInjectedRef` + `queueMicrotask` 推迟机制（防 @tiptap/react flushSync lifecycle 警告）；MUST 仍 ref-guard 防重注入；MUST NOT 把分派逻辑写进 composer（保 300 行红线，分派进 helper） | component-chat-composer.tsx :171-179 现状；memory tiptap-effect-flushsync-lifecycle | +2/-2 |
| ui-chat | app/web/src/components/chat-page/component-chat-composer.tsx | `import`（:22） | 修改 | `injectMentions` → `injectInitialContent`（dispatcher 取代单一函数） | — | — | +1/-1 |
| ui-chat | app/web/src/components/chat-page/chat-composer-helpers.ts | `ChainableEditor`（interface :18-20） | 修改 | interface 加 `insertContent: (content: string) => Chain` 与 `focus: () => Chain` 两方法（为文本注入）；chain() 返回类型相应放宽 | MUST 保持 `insertMention` 现有方法不动；MUST NOT 用 `any`（保类型安全） | chat-composer-helpers.ts :18-20 现状 | +3/-1 |
| ui-chat | app/web/src/components/chat-page/chat-composer-helpers.ts | `injectInitialContent(editor, initial)`（function，新） | 新增 | 单一 dispatcher：`typeof initial === 'string' ? editor.chain().focus().insertContent(initial).run() : 既有 mention 链路（顺序 insertMention 后 run）`；签名 `(editor: ChainableEditor, initial: MentionAttrs[] \| string) => void` | MUST 单一出口（消除 composer 内分派）；MUST NOT 在 helper 内做 ref guard / empty check（那是 composer 责任）；MUST string 分支注成真实 text node（非 placeholder，用户可编辑——满足 UC-248-EDIT-PREFILL） | chat-composer-helpers.ts injectMentions 现状；tiptap insertContent 用法（chat-composer-extension.tsx :100,104） | +14/-0 |
| ui-chat | app/web/src/components/chat-page/chat-composer-helpers.ts | `injectMentions(editor, items)`（function :35-41） | 修改 | 函数体改为委托 `injectInitialContent(editor, items)`（保持导出签名 `MentionAttrs[]` 不变，向后兼容；消除双份 mention 链路逻辑） | MUST 保留函数（其他场景/UT 可能直接引用）；MUST 签名向后兼容 | — | +1/-6 |
| ui-studio | app/web/src/components/studio-page/component-panorama-idle.tsx | `PanoramaIdle`（button 渲染 :49-52） | 修改 | ①按钮文案 i18n value（由 coder 定具体话术，如「找 leader 搭看板」，沿用 `panorama.idle.atLeaderBtn` key 改 value 即可，不新增 key）②图标 `Icon name="chat"` 是否换（coder 定，可保留 chat 图标也可换，视觉骨架不变）③`data-action-key="studio.panorama.mention-leader"` 命名现已语义不符——**coder 定位**（重命名须同步 zh/en + 此处；本版本无 AT/ET 引用该 key，重命名影响小；不重命名亦可接受为 known semantic drift，由 doc-modifier 阶段 5 同步） | MUST `BTN_PRIMARY` 不变；MUST 卡片视觉骨架（IconBox/标题/副标题/描述）不变；MUST NOT 改 Props 签名（`onAtLeader: () => void` 锁定） | specs/ui/components/studio-page/component-panorama-idle.md §视觉结构；PRD §5；memory ui-out-requirements-not-design、action-key-convention-rollout | +2/-2（coder 定位） |
| ui-i18n | app/web/src/i18n/locales/zh-CN/studio.json | `panorama.idle.atLeaderBtn` + `panorama.idle.desc`（:281-282） | 修改 | ①`atLeaderBtn: 去群聊 @leader` → 「找 leader 搭看板」类（coder 定话术，对齐 PRD §3.1 跳 leader 单聊语义）②`desc` 里「在群聊里对 leader 说...」同步改（现走单聊，群聊字眼语义不符） | MUST zh-CN + en 双语都改；MUST NOT 新增 i18n key 不补另一语言（守 i18n-key-add-checklist）；本行不新增 key，仅改 value | memory i18n-key-add-checklist；PRD §3 | +2/-2 |
| ui-i18n | app/web/src/i18n/locales/en/studio.json | `panorama.idle.atLeaderBtn` + `panorama.idle.desc`（:281-282） | 修改 | 同上（英文文案改，对齐 leader single-chat 语义） | MUST 与 zh-CN 同步改（双语一致） | memory i18n-key-add-checklist | +2/-2 |
| test | app/web/src/components/studio-page/__tests__/page-studio.test.tsx | `onAtLeader handler` 测试（新增/扩 case） | 新增 | UT 覆盖：①有 leader 点 onAtLeader → `setMainView({kind:'chat', node:{sessionId: leader.sessionId（非 squadChatSessionId）}, prefill: '帮我搭建一个看板，展示…'})`（断言 prefill 是 string，sessionId 等于 leader.sessionId）②无 leader 场景 → `flash(noLeaderAvailable)`，不跳转 | MUST 验 sessionId ≠ squadChatSessionId；MUST 验 prefill 是 string（非 array、非 mention）；MUST 两分支都覆盖 | PRD §4 UC-248-MAIN + UC-248-NO-LEADER | +30/-0 |
| test | app/web/src/components/chat-page/__tests__/chat-composer-helpers.test.ts | `injectInitialContent` dispatcher 测试（新文件） | 新增 | UT 覆盖：①`initial='text'` → mock editor 验 `chain().focus().insertContent('text').run()` 被调 ②`initial=[mentionAttrs]` → 验 `chain().insertMention(attrs).run()` 被调（与现有 injectMentions 行为一致）③空 string / 空 array → 不调任何命令（守卫在 composer，helper 仍可被调用但应安全：由 dispatcher 透传到 chain，空数组 for-loop 不执行） | MUST 两分支均覆盖；MUST NOT 跨界测 composer ref-guard（那是 composer UT 责任） | memory bottom-up-layer-verify、tests-respect-product-architecture | +35/-0 |
| test | app/web/src/components/chat-page/__tests__/component-chat-composer.test.tsx | `initialContent` 文本分支测试（新增 case） | 新增 | UT 覆盖：`initialContent='帮我搭建一个看板，展示…'` → editor 注入后含该文本 text node；模拟用户编辑（插入/删除）有效（非只读）；ref-guard 防重注入（mount 二次 effect 不重注） | MUST 验文本是可编辑 text node（满足 UC-248-EDIT-PREFILL）；MUST 验只注入一次 | PRD §4 UC-248-EDIT-PREFILL；memory tiptap-effect-flushsync-lifecycle | +25/-0 |

## 影响面评估

**跨模块**：纯前端改动，3 个模块（ui-studio / ui-chat / ui-i18n）+ 3 个测试文件。无 API 变更、无后端、无 plugin/ext、无持续可打包护栏触发（不进 server/protocol/electron/runtime-config）。

**破坏性变更**：`prefill` / `initialContent` 类型从 `MentionAttrs[]` 扩成 `MentionAttrs[] | string` 是**协变放宽**（新增分支，旧调用方传 `MentionAttrs[]` 仍类型兼容）——零破坏。现有唯一 prefill 调用方（page-studio onAtLeader handler）同步切到 string 分支后，整个 studio 内再无 `MentionAttrs[]` 形态的 prefill 调用方；但 prop 链路保持 `MentionAttrs[] | string` 联合（前向兼容：未来其他入口仍可传 mention 数组）。

**依赖顺序**（底层先）：
1. `chat-composer-helpers.ts` 加 `injectInitialContent` dispatcher + `ChainableEditor` 扩（底层，UT 可独立验证）
2. `component-chat-composer.tsx` 改 `initialContent` 类型 + 切 dispatcher（依赖 1）
3. 4 层 prop 链路改类型（section-chat-session → session-input → section-studio-chat → studio-chat-router，依赖 2 无关，类型放宽即可）
4. `page-studio.tsx` MainView 类型 + onAtLeader handler（依赖 3）
5. `component-panorama-idle.tsx` 按钮 + i18n value（独立，并行可）
6. UT 文件（依赖 1-4）

**风险点**：
- **ChatComposer 文件 299 行**（贴 300 红线）：dispatcher 抽到 helper 后，composer 净 +0/-0 左右（import 与 effect 各 ±1）。coder 注意不要在 composer 内写分派逻辑（否则超限）。
- **page-studio.tsx 275 行**：handler 内联改写后约 277 行，安全。
- **tiptap insertContent 文本节点**：注成真实 text node（非 placeholder），用户可删 `...` 填内容——满足 UC-248-EDIT-PREFILL 可编辑语义。
- **现有 chat-composer UT**：不破坏现有 mention pill 注入测试（dispatcher 对 array 分支行为零改）。

**coder 开放点（标「coder 定位」，非硬约束）**：
- PanoramaIdle 按钮具体文案话术（沿用 `panorama.idle.atLeaderBtn` key 改 value）
- 图标是否换（保留 chat 或换其他）
- `data-action-key="studio.panorama.mention-leader"` 是否重命名（语义已不符但本版本无 AT/ET 引用）
- handler 内 leader 单聊 ChatNode 是否抽到 buildMemberChatNode 复用（现状内联，保持内联亦可）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 偏差（如 `buildMemberChatNode` 真实存在但 handler 内联风格不一致）→ coder 按代码实际调整 + 汇报偏离，doc-modifier 阶段 5 同步 spec

# v0.0.165 change_plan — UI 视觉体系升级（暖橙→银灰）+ 坐席面板

> **Method 级 review 合同**（architect 冻结）。行=函数/符号。planner 按此切 task（coversModules/coversFiles/coversMethods）；coder 参考+汇报偏离；code-reviewer 按此查偏离。
>
> **上游**：PRD `specs/prd/version_logs/v0.0.165.ui_upgrade/change_log.md`；规范 `specs/ui/regulation/{01-tokens,02-components,03-principles}.md`；设计稿 `reqs/[working] v0.0.165.ui_upgrade/design/*`；设计稿参考实现 `design/tokens.css` + `design/_shell.css`。
>
> **硬约束**：后端零改动（`app/server` / `app/protocols` / `app/shared` 一行不动）；纯前端 `app/web/src`；单文件 ≤300 行；light-only；无 keyframes；无装饰 emoji；硬编码 hex 清零（全部走 `var(--*)`）；设计稿为视觉权威。

---

## 0. PRD §6.4 字段可得性核实结论（架构裁决）

| PRD 字段 | 现有 API/store 事实 | 落地 |
|---|---|---|
| presence 4 态 online/busy/idle/offline | `member.state` deployed→online / benched→offline；session state（via `useStudioUnreadMeta.stateMap`）running/interrupting/suspended→busy；**无 idle 信号** | ✅ 降 3 态（online/busy/offline），不显 idle |
| 状态行文案 | `member.currentWork.text`（`Member.currentWork?:{text,updatedAt}`，`squad-types.ts` 已定义，v0.0.116 presence 工具写入） | ✅ 有值展示；空则 online→「在线待命」 / offline→「已下岗」/ busy→「推理中…」（i18n key） |
| meta·最近活跃时间 | `session.updatedAt`（`Session.updatedAt`，`listSessions()` 返回全量） | ✅ 挂载时 `listSessions()` 一次 → 按 `member.sessionId` 反查 → format 相对时间 |
| meta·in/out token per member | **无 per-member 计数字段**（`BudgetUsage.perSession[]` 是 session 维度但只含 `consumed`，无 in/out 拆分） | ❌ 本版不显示；meta 行只剩「最近活跃」单字段 |
| 统计条·在线数 | `detail.members.filter(m => m.state==='deployed').length` | ✅ 直接派生 |
| 统计条·进行中任务 | `stateMap`（已有），count sessions where `sid ∈ squadSessionIds && state ∈ {running,interrupting,suspended}`；squadSessionIds = `[squadChatSessionId, ...members.map(m=>m.sessionId)]` | ✅ 前端派生 |
| 统计条·今日消息 | **后端无 per-day message 聚合端点** | ❌ 降级：卡内显「—」（大字号 muted） |
| 统计条·今日 token | `GET /squad/:id/budget/usage`（v0.0.116）已存在，返 `consumed`（daily 窗口）；语义已是「窗口内消耗」，非精确「今日 0-24」但近似 | ✅ 用 `budget.consumed`，label 改「已用 token」（i18n key `studio:seats.stats.tokenUsed`）；`budget=null`（未配额）→ 「—」 |

**关键 API 事实（core-verified）**：
- `Member.currentWork?: { text: string; updatedAt: string } | null` — `squad-types.ts:100`
- `SquadDetail.members: Member[]` / `squadChatSessionId: string` — `squad-types.ts:127-153`
- `Session.updatedAt: string` — `types/session.ts:121`
- `listSessions(base?): Promise<Session[]>` — `lib/chat-api/session-api.ts:51`
- `getBudgetUsage(id, base?): Promise<BudgetUsage>` — `lib/squad-api.ts:227`
- `useStudioUnreadMeta().stateMap: Record<sessionId, SessionState>` — `use-studio-unread-meta.ts:56`
- `Message.createdAt: string` — `types/message.ts:75`

---

## 1. tokens + 全局样式（styles/）

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tokens | app/web/src/styles/tokens.css | `:root` 变量集 | 修改 | 全表重写为 regulation 01 §1 银灰体系：bg/surface/fg/border/btn/state/presence/hue（8 色）/brand-grad/font（Playfair 下线）/radius/shadow/z。逐 token 照抄 `design/tokens.css`，不改名（沿用 `--color-*` 前缀不动，只换值——避免全站 Tailwind class 大改）。**注意**：现物理源用 `--color-bg` 而 regulation 用 `--bg`——两套命名冲突。**决策 A**：保留现有 `--color-*` 前缀，将新 hex 灌入原 token 名（旧词表如 `--color-accent` 灌 `#18181b`=btn-primary-bg 作向后兼容），同时**新增 regulation 01 全套 `--bg`/`--surface`/…（无 `--color-` 前缀）作正式契约**；组件迁移过程中新代码走无前缀 token，旧代码延用兼容 alias | MUST 保留 `--color-*` 前缀 alias（不然全站 Tailwind class `bg-accent`/`text-fg`/`bg-accent-surface` 大爆炸）；MUST 加 8 色 hue palette (`--hue-{rose,orange,amber,green,teal,blue,violet,pink}` + `-bg`)；MUST 加 presence 4 色；MUST 加 brand-grad；MUST 补 shadow-focus 灰环；**MUST NOT** 保留 `--color-accent-*` 暖橙原值（灌新中性值） | regulation/01 §1；design/tokens.css | +80/-30 |
| tokens | app/web/src/styles/tokens.css | `[data-theme='light']`/`[data-theme='dark']` 变量集 | 删除 | 删除两个 `[data-theme=...]` 作用域块（tokens 只在 `:root`）；light-only | MUST NOT 保留任何 `[data-theme=dark]`；MUST 保留 z-index 常量迁至 `:root` | regulation/03 §4；PRD §3 | -60 |
| tokens | app/web/src/styles/tokens.css | `@keyframes drawerUp/fadeIn/fabIn/floaty/idlePulse/wave` | 删除 | 全部 keyframes 删除（严肃基调，无入场/浮动/挥手动效） | MUST NOT 保留任何 `@keyframes`；MUST 保留 ≤150ms transition class（那是 utility 不是 keyframe） | regulation/03 §3；PRD §3.1 | -60 |
| tokens | app/web/src/styles/tokens.css | 新增 `--font-serif` 变量 | 删除 | 删除 Playfair Display 引用（brand 用渐变块不用衬线） | MUST NOT 引用 Playfair | regulation/01 §2；PRD §2.1 | -2 |

---

## 2. 主题/appearance 下线（lib + main + config）

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| theme | app/web/src/main.tsx | 入口 `bootstrap()` | 修改 | 删 `import { initThemeFromConfig }` + `await initThemeFromConfig()` 调用（首屏不再据持久化 theme 设 data-theme） | MUST NOT 调 initThemeFromConfig；MUST 删 import | PRD §3.1 | -3 |
| theme | app/web/src/lib/theme-init.ts | 整文件 | 删除 | **mv 到** `soft_deleted/`（含 `applyTheme`/`initThemeFromConfig`/`Theme` type） | MUST 用 mv 而非 rm（soft-delete-instead-of-rm memory）；MUST 保留 test file 一并 mv | PRD §3.1；决策 D3 | -60 |
| theme | app/web/src/lib/__tests__/theme-init.test.ts | 整文件 | 删除 | 同上，mv 到 `soft_deleted/` | MUST 与 theme-init.ts 一并处理 | — | -50 |
| theme | app/web/src/lib/api-client.ts | `getAppTheme()` / `setAppTheme()` / `type Theme` | 删除 | 删除函数+类型；appearance/theme 后端保留但前端不再 read/write | MUST NOT 移除 `getConfigGroup`/`putConfigGroup`（其他 group 仍用）；MUST 修改所有 import 该三个符号的文件 | PRD §3.1；PRD §3 | -30 |
| theme | app/web/src/components/app-dev-config-page/app-settings-persist.ts | `loadAllConfig()` + `saveGroup()` | 修改 | 删「读取 appearance/theme + applyTheme」分支；`saveGroup('appearance')` 分支删除；仍保留 language 单独持久化路径（`change-language.ts` 走同 group） | MUST NOT 调 `applyTheme`；MUST NOT put `appearance/theme`；MUST 保留 language put 不动 | PRD §3.1 | -25 |
| theme | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | `useAppSettingsConfig()` initial state + `load()` + `save()` | 修改 | 删所有 `appearance` snapshot/draft/dirty 分支；`kvGroups.appearance` 相关全删；general tab 不再需要 KV 追踪 | MUST 删 `appearance: { theme: 'light' }` 初值 + `appearance` load/save 分支 | PRD §3.1 | -20 |
| theme | app/web/src/components/app-dev-config-page/app-settings-config-defs.ts | `KV_GROUPS` 常量 + `TAB_KV_GROUPS` | 修改 | `KV_GROUPS` 移除 `appearance` 项（含 theme key）；`TAB_KV_GROUPS.general` 改为 `[]`（general tab 无 KV group，只有语言 card——**实现现状 v0.0.165**：`APP_SETTINGS_TABS[general].groups=['locale']` 用作 tab 展示元数据，但 `TAB_KV_GROUPS.general=[]` 表示不进 dirty/save 编排，语言由 `ComponentLocaleCard` 切即生效走 `change-language.ts` 独立路径） | MUST 保留 `GroupDef.groupId` union 类型编译过（union 里去 `'appearance'`） | PRD §3.1 | -18 |
| theme | app/web/src/components/app-dev-config-page/section-tab-panel.tsx | `case 'general'` 分支 | 修改 | 删 theme `ComponentKeyCard` 渲染；只留 `<ComponentLocaleCard />` + title「语言」（i18n key `group.locale.label`，新加）；`data-testid` 改 `group-item-language` | MUST 保留 general tab 存在；MUST 保留 ComponentLocaleCard 不动 | PRD §3.1；决策 D3 | +10/-15 |
| theme | app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json | i18n keys | 修改 | 新增 `group.locale.label`（中文「语言」/ en 「Language」）；`group.appearance.label` / `schema.appearance.theme.*` 保留在文件中不删（back-compat i18n test，防抛错），加注释 // deprecated v0.0.165 | MUST 保留旧 key（防 i18n test 断言 fail）；MUST 加新 key | i18n-key-add-checklist memory | +6 |
| theme | app/web/src/i18n/change-language.ts | 整文件 | 保留 | 不变（仍走 `getConfigGroup('app','appearance') → putConfigGroup 'appearance' [language]`，backend group 名不改，只是前端不再管 theme key） | MUST NOT 改 | — | 0 |

---

## 3. 硬编码 hex 清零（一次性 sweep，跨文件）

**统计**：`grep -rn '#[0-9a-fA-F]\{6\}' app/web/src --include='*.tsx' --include='*.ts' | grep -v __tests__ | wc -l` = **56 行 / 28 文件**（v0.0.165 快照）。全部替换为 `var(--*)` 或 token class；无对应 token 时新建（新颜色须先加 `styles/tokens.css` 再引用）。

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| hex-sweep | app/web/src/components/chat-page/component-empty-state.tsx | `MascotFace()` 内 SVG stroke/fill 常量（10 处 hex） | 修改 | 见 §5「empty-state 简化」——整个 mascot + SVG 删掉，一并去 hex；本行影响并到 §5 | 见 §5 | 见 §5 | 见 §5 |
| hex-sweep | app/web/src/components/chat-page/component-tool-call-item.tsx | 内联 style hex | 修改 | 4 处 hex → `var(--fg-3)` / `var(--surface-2)` / `var(--border)` 等对应 token | MUST 用 CSS var 不用 tailwind class（保内联 style 结构） | regulation 01 | ~4 行改 |
| hex-sweep | app/web/src/components/studio-page/component-squad-tree.tsx | `TreeChild` 未读红点 `#DC2626` 等 | 修改 | 未读红点 hex → `var(--danger)`；其他 hex → 对应 token | MUST NOT 保留 `#DC2626` 字面量 | regulation 01 §1.5；spec-writing-hygiene | ~3 行改 |
| hex-sweep | app/web/src/components/chat-page/component-usage-ring.tsx | ring stroke hex | 修改 | 3 处 hex → `var(--fg-3)` / `var(--muted)` 等 | 视觉不变（暖橙 accent→黑主 CTA 同视觉重量） | regulation 01 | ~3 |
| hex-sweep | app/web/src/components/chat-page/component-run-finish.tsx | finish 图标/文字 hex | 修改 | 3 hex → `var(--success)` / `var(--fg-2)` | — | regulation 01 | ~3 |
| hex-sweep | app/web/src/components/chat-page/component-cron-job-card.tsx | cron 卡片 hex | 修改 | 3 hex → `var(--fg-2)` / `var(--border)` | — | — | ~3 |
| hex-sweep | app/web/src/components/chat-page/component-conversation-item.tsx | conv item hex | 修改 | 3 hex → `var(--fg-2)` / `var(--muted)` | — | — | ~3 |
| hex-sweep | app/web/src/components/studio-page/component-board-goals-view.tsx | goal card hex | 修改 | 2 hex → tokens | — | — | ~2 |
| hex-sweep | app/web/src/components/skill-page/component-skill-item.tsx | skill icon-box hex | 修改 | 2 hex → `var(--hue-*-bg)` / `var(--hue-*)`（regulation 02 §4，skill 走 icon-box hash 色，同实体 hash 同色，用同 hash 函数 `hashHueIndex(skill.name)`） | MUST 走 hash palette（决策 D2） | regulation 02 §4；03 §2 | ~2 |
| hex-sweep | app/web/src/components/framework/primitives/key-choice-cards.tsx | choice card 内联 hex | 修改 | 2 hex → tokens | — | — | ~2 |
| hex-sweep | app/web/src/components/chat-page/component-readonly-badge.tsx | badge hex | 修改 | 2 hex → `var(--info)` / `var(--info-bg)` | — | regulation 02 §2 | ~2 |
| hex-sweep | app/web/src/components/chat-page/component-memory-editor-fields.tsx | 编辑器 hex | 修改 | 2 hex → tokens | — | — | ~2 |
| hex-sweep | app/web/src/components/chat-page/component-enqueue-view.tsx | enqueue hex | 修改 | 2 hex → tokens | — | — | ~2 |
| hex-sweep | app/web/src/components/chat-page/component-cron-modal.tsx | cron modal hex | 修改 | 2 hex → tokens | — | — | ~2 |
| hex-sweep | app/web/src/components/studio-page/component-member-skill-filter.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/studio-page/component-board-task-card.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/section-conv-panel.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/primitive-mention-pill.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/component-usage-panel.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/component-pending-approval-card.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/component-mention-popover.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/component-memory-modal.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/component-loading-status.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/component-cron-new-form.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/component-clear-confirm-modal.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/chat-page/base-chat-input-bar.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/app-dev-config-page/section-user-memory.tsx | 1 hex | 修改 | → token | — | — | ~1 |
| hex-sweep | app/web/src/components/framework/nav-rail/nav-rail.tsx | brand「R」内联 class `bg-accent text-white font-serif` | 修改 | brand 改为 `background: var(--brand-grad)` + `text-white font-sans font-bold`；删 `font-serif` | MUST 用 `--brand-grad`（regulation 01 §1.8）；MUST NOT 用 `font-serif` | regulation 01 §1.8；02 §8 | ~3 |
| hex-sweep | app/web/src 全站 | code review sweep | 修改 | code-review 阶段 `grep '#[0-9a-fA-F]\{6\}' app/web/src --include='*.tsx' --include='*.ts' \| grep -v __tests__` **必须归零**（除 tests/svg 常量白名单，如 fill-rule 无关色） | reviewer 硬门禁：非零 = FAILED | regulation 03 §5.2 | 兜底 |

---

## 4. member-avatar 改 hash-by-id 8 色 palette

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| member-avatar | app/web/src/components/common/member-avatar.tsx | `bgColor(role)` | 修改 | 签名改 `bgColor(role, id)`；leader/mate 分支不再返 `var(--color-accent)`/`--color-gold`，改用 `var(--hue-{palette[hashHueIndex(id)]})`；user 仍返 `var(--fg-2)`；squad 仍返 `var(--brand-grad)`（brand 保留渐变块，regulation 01 §1.8） | MUST 用 hash 函数 djb2 或 FNV-1a（简单串→uint32 %8，避免依赖）；MUST 保留 role='user' → 中性灰、'squad' → brand-grad | regulation 02 §3；03 §2；PRD 决策 D2 | +8/-4 |
| member-avatar | app/web/src/components/common/member-avatar.tsx | `hashHueIndex(id)` | 新增 | 纯函数 `(id:string)=>number`（0-7）；djb2 hash % 8；export 供 icon-box 场景复用 | MUST 纯函数、无副作用；MUST 对同 id 恒返同值 | regulation 01 §1.7；PRD §2.1 | +12 |
| member-avatar | app/web/src/components/common/member-avatar.tsx | `HUE_PALETTE` 常量 | 新增 | `readonly ['rose','orange','amber','green','teal','blue','violet','pink']`（顺序对应 01-tokens §1.7） | MUST 匹配 regulation 01 §1.7 顺序（vision compare 依赖 index→hex） | regulation 01 §1.7 | +2 |
| member-avatar | app/web/src/components/common/member-avatar.tsx | `MemberAvatarProps` interface | 修改 | 新增可选 prop `id?: string`（member.id 或等价稳定 id；缺省 fallback `name` 参与 hash）；`showPresence?: 'online'\|'busy'\|'idle'\|'offline'`（可选，非空则在右下渲 presence 点，用于坐席卡；size='sm' 时忽略） | MUST 保持 `name/role/size/showName/testId` 兼容；MUST 新增 prop 均可选（back-compat） | regulation 02 §3；PRD §2.1 | +6 |
| member-avatar | app/web/src/components/common/member-avatar.tsx | `MemberAvatar()` 组件 | 修改 | 传 `id ?? name` 到 `bgColor()`；size='lg' 尺寸对齐 regulation 02 §3 的 lg=48px（现为 34px）；`showPresence` 非 undefined 时在 avatar 外层 `avatar-wrap` 定位 `.presence` 点（右下 `bottom:-2px right:-2px 10×10 rounded-full` + 白 2px 描边 + `bg-[var(--presence-{status})]`）；`font-serif` → `font-sans font-bold` | MUST 保留 sm 分支「无外层列 + inline」；MUST 保持既有 chat 流三区布局 w-9 外层不动 | regulation 02 §3；PRD §2.1；03 §2 | +18/-6 |
| member-avatar | app/web/src/components/common/__tests__/member-avatar.test.tsx | UT | 新增 | 断言：同 id 恒返同色（hash 稳定性）；不同 id 分布 8 色；user role → 中性灰不 hash；showPresence 渲染 `.presence` + 正确 status class；size='lg' 尺寸 48px | MUST 覆盖 hash 稳定性 + 8 色分布（至少 8 个不同 id 全覆盖） | tests-respect-product-architecture | +80 |

---

## 5. Playground idle empty-state 简化

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| empty-state | app/web/src/components/chat-page/component-empty-state.tsx | `MascotFace()` | 删除 | 整函数删（无 mascot） | MUST NOT 保留 SVG hex；MUST 完全删除函数不保留 | PRD §3.1；03 §3 | -50 |
| empty-state | app/web/src/components/chat-page/component-empty-state.tsx | `ComponentEmptyState()` | 修改 | 删「radial-gradient 环境光」+ 「mascot + ＋角标」+ 「headline 👋 wave」+ 「eyebrow」+ 「hint」；仅保留一个居中大 CTA 按钮 `<button>新建对话</button>`，`h-[46px] px-6 rounded-lg bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] hover:bg-[var(--btn-primary-hover)] transition-colors text-[14px] font-semibold flex items-center gap-2`，前置 `<PlusIcon/>`；testid 保留 `idle-new-conv-cta`（i18n `chat:emptyState.newConversation`） | MUST 删所有 `animate-[floaty*|idlePulse*|wave*]` 引用；MUST 保留 testid `idle-new-conv-cta`（ET 兼容）；MUST NOT 保留 testid `idle-mascot` / `idle-new-conv-btn`（组件已简化） | PRD §3.1(4)；regulation 03 §3 | +20/-100 |
| empty-state | app/web/src/i18n/locales/{zh-CN,en}/chat.json | `emptyState.welcomeTitle`/`welcomeHint`/`eyebrow` | 修改 | `welcomeTitle` / `welcomeHint` / `eyebrow` 三 key **删除**（组件不再引用）；`newConversation` 保留（CTA 文案 = 「新建对话」/ "New Conversation"） | MUST 中英同步删；MUST 保留 `newConversation` key | i18n-key-add-checklist memory | -6 |
| empty-state | app/web/src/i18n/__tests__/chat-ns.test.ts | `expect welcomeTitle/welcomeHint/eyebrow` | 修改 | 删除对应断言（组件不再依赖） | MUST 与 i18n 文件同批改 | — | -6 |

---

## 6. 消息时间显示（三 chat 页共享）

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| message-time | app/web/src/lib/format-time.ts | `formatMsgTime(iso, now?)` | 新增 | 新增文件；纯函数 `(iso:string, now?:Date)=>string`：同日→`HH:mm`；跨日→`MM-dd HH:mm`；now 缺省 = `new Date()`（测试可注入） | MUST 纯函数无副作用；MUST 无外部依赖（不引 date-fns） | PRD §4.1；regulation 02 §6 | +25 |
| message-time | app/web/src/lib/__tests__/format-time.test.ts | UT | 新增 | 覆盖同日/跨日/边界（跨 0 点）/无效 iso 兜底空串 | MUST 用注入 now 参数（避 Date.now 时序 flaky） | test-case-user-principles | +60 |
| message-time | app/web/src/components/chat-page/component-message-stream.tsx | user 分支 `<div>` 内 `<PrimitiveBubble>` 后 | 修改 | 在 `originName` div 之前插入 `<MsgTime iso={msg.createdAt}/>` （agent 分支同样在 bubble 后加） | MUST 走 `msg.createdAt`（`msgById.get(row.messageId)?.createdAt`）；MUST 用 span `data-testid="msg-time-${messageId}"`，class `text-[10.5px] font-mono text-[var(--muted-2)] mt-1`；user 分支 `text-right`，agent `text-left`（布局稳定性：固定行高，不随 hover 变） | PRD §4.1；02 §6；`chat-page/_overview.md` | +14 |
| message-time | app/web/src/components/chat-page/component-message-stream.tsx | 新增内联组件 `MsgTime({iso})` | 新增 | 局部组件（不导出）；`return <span data-testid={...} className={...}>{formatMsgTime(iso)}</span>` | MUST 单文件不超 300 行（现 307 已超；本次需拆出 `component-msg-time.tsx`） | 单文件 ≤300 行 | +12 |
| message-time | app/web/src/components/chat-page/component-msg-time.tsx | 新文件 `MsgTime` | 新增 | 独立文件 `<MsgTime iso side testId?/>`，side='user'\|'assistant' 控 text-align；testId 缺省 `msg-time`；测试友好 | MUST 从 message-stream 抽出以保 300 行上限 | 单文件 ≤300 行 | +40 |
| message-time | app/web/src/components/chat-page/__tests__/component-msg-time.test.tsx | UT | 新增 | 断言 side='user' → text-right；同日→HH:mm；testId 传入生效 | — | — | +40 |

**覆盖三 chat 页**：`ComponentMessageStream` 是三页共享内核（playground/studio 单聊/群聊），一次改覆盖 P4。

---

## 7. 模型选择面板全站统一（regulation 02 §7）

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| model-picker | app/web/src/components/common/component-model-picker-panel.tsx | 新文件 | 新增 | 新建**共用 panel primitive**（regulation 02 §7 展开态），props: `{items:PickerItem[], value?:{providerId,modelId}, onPick:(sel)=>void, searchable?:boolean, headerTitle?, headerTestId?, extraTopItems?, emptyMessage?, showModelIdSubtitle?, panelTestid:string, itemTestidPrefix?, className?}`（不持有 open state，父级管闭合）；渲染 300px 白卡 `w-[300px] bg-[var(--surface)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] py-1`；顶部 search input（`searchable=true`）；`extraTopItems` 在列表最上（用于「继承默认」/「a(默认)」）；每行 = IconBox24 + mono 名 + 选中 ✓（黑色） | MUST ≤211 行；MUST 无 hex；MUST NOT 持有 open state；**testid 契约（doc-sync 订正）**：panel testid 由消费方通过 `panelTestid` prop 显式传（**不由 primitive 派生**——三消费方 back-compat 命名不统一：ModelPicker 传 `${triggerTestid}-list`（v0.0.9~v0.0.72 一路沿用不改）/ InputModelPicker 传 `model-picker-menu` 或 `model-picker-preview` / KeyModelPicker 传 `${suffix}-menu`）；item testid 由 `itemTestidPrefix` 派生 `${prefix}-{providerId}-{modelId}` | regulation 02 §7；PRD 决策 D6；code-review T4 数据边界锁定 | +211 |
| model-picker | app/web/src/components/common/component-model-picker-trigger.tsx | 新文件 | 新增 | 新建**共用 trigger primitive**（regulation 02 §7 收起态），props: `{value?:{providerId,modelId,modelLabel}, placeholder?:string, disabled?:boolean, onClick:()=>void, testid:string, size?:'sm'\|'md'}`；渲染 `<button class="inline-flex items-center gap-2 h-[32px] px-3 rounded-[var(--radius-md)] border border-[var(--border-2)] bg-[var(--surface)] hover:bg-[var(--surface-2)]"> <IconBox size=22 hueBy={providerId}/> <span class="font-mono text-[13px]">{modelLabel ?? placeholder}</span> <ChevronDownIcon/></button>` | MUST ≤120 行；MUST 无 hex | regulation 02 §7 | +100 |
| model-picker | app/web/src/components/common/component-icon-box.tsx | 新文件 | 新增 | 新建 IconBox primitive（regulation 02 §4）；props `{hueBy:string, size?:22\|24\|32, icon?:ReactNode}`；渲染 `<span style={{background:'var(--hue-{palette[hashHueIndex(hueBy)]}-bg)', color:'var(--hue-{...})'}} class="inline-flex items-center justify-center rounded-md">{icon ?? initial}</span>`；同一 hueBy 恒同色（复用 §4 的 `hashHueIndex`） | MUST 复用 `hashHueIndex`（从 member-avatar 提出到 `lib/hue-hash.ts`）；MUST NOT 引入新 hash 算法 | regulation 02 §4；03 §2 | +80 |
| model-picker | app/web/src/lib/hue-hash.ts | 新文件 `hashHueIndex(id)` + `HUE_PALETTE` | 新增 | 从 `member-avatar.tsx` 提出：`hashHueIndex(id:string):number` + `HUE_PALETTE:readonly string[]`；两处以上复用 | MUST 单例；member-avatar / IconBox 均 import 本文件 | regulation 01 §1.7 | +25 |
| model-picker | app/web/src/components/chat/ModelPicker.tsx | `ModelPicker()` | 修改 | 保留组件（studio wizard `new-squad-model` / manage-tab 用它），**内部改为**组装 `<ModelPickerTrigger>` + `<ModelPickerPanel>`；testid 沿用（`chat-model-picker` 默认 / caller 传 `new-squad-model`/`chat-model-picker` 等）；`inheritLabel`/`onInherit` 走 panel `extraTopItems`；下拉方向 top-full 保留 | MUST 保留 testid + props 签名（back-compat 消费方零改）；MUST 视觉走新 primitive；MUST NOT 保留原 tailwind class `w-[180px] bg-surface-2 rounded-sm`（换新） | regulation 02 §7；PRD §5 | +30/-50 |
| model-picker | app/web/src/components/common/component-key-model-picker.tsx | `KeyModelPicker()` | 修改 | 内部改为 `<ModelPickerTrigger>` + `<ModelPickerPanel searchable>`（配置页要搜索）；`x 清除`按钮保留在 trigger 右侧（原实现）；testid 沿用 (`key-model-picker-{suffix}` / `key-model-picker-{suffix}-menu` / `key-model-picker-item-{provider}-{model}`) | MUST 保留 testid；MUST 保留 clear button（配置页专属交互，chat 输入区无） | regulation 02 §7；PRD §5 | +25/-70 |
| model-picker | app/web/src/components/chat-page/component-input-model-picker.tsx | `InputModelPicker()` 内 trigger + PICKER_PANEL_CLS/PICKER_ITEM_CLS | 修改 | trigger 从 21px 纯 BrainIcon 图标 → 走 `<ModelPickerTrigger>`（22px icon-box + mono 名 + chevron；size=md 但 h32→保持 h26 或 h28 以贴合 chat-input-bar 高度）；PICKER_PANEL_CLS 换为 `<ModelPickerPanel>` 组件（保留 hover preview 特性：preview 也用 panel 只是不 searchable + `extraTopItems` 挂「a(默认)」置顶）；testid 沿用 `chat-model-picker`（chat-input-bar 内） | MUST 保留双场景（配了 defaultA→顶部「a(默认)」+ 完整列表；未配→仅完整列表）；MUST 保留 hover preview / click menu 双菜单；MUST 保留 `disabled` 分支；MUST 保留 spec 契约 testid `chat-model-picker`/`model-picker-preview`/`model-picker-menu` | regulation 02 §7；组件 spec `component-input-model-picker.md`；PRD §5 | +40/-80 |
| model-picker | specs/ui/components/common/component-model-picker-panel.md | 新组件 spec | 新增 | coder 编码**前置**创建（`_conventions.md`）：Props、testid 契约、视觉基线（对照 design/_gallery.html「模型选择面板」节 300px 白卡） | MUST 先写 spec 后写代码（架构原则 6）；MUST 引 regulation 02 §7 | _conventions.md；regulation 02 §7 | +60（spec） |
| model-picker | specs/ui/components/common/component-model-picker-trigger.md | 新组件 spec | 新增 | 同上，trigger primitive | 同上 | 同上 | +40（spec） |
| model-picker | specs/ui/components/common/component-icon-box.md | 新组件 spec | 新增 | IconBox primitive spec（hueBy hash 色规则） | 同上 | regulation 02 §4；03 §2 | +40（spec） |

---

## 8. 坐席面板（新 IA）

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| seats | app/web/src/components/studio-page/component-seats-panel.tsx | 新文件 `SeatsPanel({squadId, detail, onEnterChat, onOpenBoard, onOpenGroupChat})` | 新增 | Studio 主区新 view：顶部主 header（team avatar + 团队名 + 在线数 badge + right tabs 占位）→ 4 格统计条 → 团队入口行（看板 + 群聊 2 卡）→ 坐席卡网格（3 列 grid gap-3.5）；每卡 = SeatCard（见下）；空态（squad 无 member 时）居中 muted 文案 | MUST ≤200 行（超需再拆 sub-component）；MUST NOT 直接调 http（数据从 props 或 hook 拉，见下 `use-seats-data`）；MUST 使用 IconBox + brand-grad + presence 点 primitive；无 hex | PRD §6.1；regulation 02 §9；设计稿 studio-console.html | +180 |
| seats | app/web/src/components/studio-page/component-seat-card.tsx | 新文件 `SeatCard({member, isLeader, presence, statusText, lastActiveIso, onEnter, onMore})` | 新增 | 单张坐席卡；结构 = seat-top (`<MemberAvatar size='lg' id={member.id} name={member.name} showPresence={presence}/>` + name + role + LEADER badge) → seat-status (surface-2 底 + 脉冲点 CSS + statusText，min-h 52px) → seat-meta (mono 11px `<最近活跃>`；in/out token 不显示因后端无字段) → seat-actions (primary「进入对话」按钮 + secondary icon「更多」)；`isLeader=true` 外层加 `border-[var(--border-strong)]`；`presence='offline'` 时整卡 opacity 0.75 + primary 降 secondary；testid：`seat-card-{memberId}` / `seat-card-{memberId}-enter` / `seat-card-{memberId}-more` | MUST ≤200 行；MUST 保持布局稳定性（hover 不位移）；MUST NOT 用 CSS `@keyframes`（脉冲点用「相对饱和度 box-shadow」静态展示——严肃基调；或 CSS-only `radial` 静态圈，非动画） | PRD §6.1；regulation 02 §9；PRD §8.2 | +140 |
| seats | app/web/src/components/studio-page/component-seat-stats.tsx | 新文件 `SeatStats({onlineCount, totalCount, inProgressCount, todayMsgCount, tokenUsed, showToday})` | 新增 | 4 格白卡横排（flex gap-3）；每格 = 34px icon-box (hue 固定：green/orange/blue/violet) + 数字（22px 700） + label（11.5px muted）；不可得字段（今日消息 = null）→ 该格 num 显「—」（不隐藏格保留栏目稳定）；`tokenUsed=null`（未配 budget）→ 显「—」；testid：`seat-stats-online` / `seat-stats-inprogress` / `seat-stats-today-msg` / `seat-stats-today-token` | MUST 数字降级 = 「—」不隐藏整格（避免布局跳）；MUST NOT 走「今日 0-24 精确窗口」（用 budget.consumed daily 窗口近似） | PRD §6.1；PRD §6.4；决策 D8 | +90 |
| seats | app/web/src/components/studio-page/component-team-entry-row.tsx | 新文件 `TeamEntryRow({squadName, boardMeta?, groupChatMeta?, onOpenBoard, onOpenGroupChat})` | 新增 | 2 卡横排（grid cols-2 gap-3.5）：看板卡 + 群聊卡；每卡 = icon-box + 主标题 + 副标题（元信息如 boardMeta「9 条推进中」/ groupChatMeta「最新：X · 14 天前」）+ ChevronRight；元信息**可选**（后端无该聚合时缺省不渲染副标题，主标题永在）；testid：`seat-team-entry-board` / `seat-team-entry-groupchat` | MUST NOT 强依赖看板 count/群聊最新元信息（后端无 → 缺省不渲染副标题） | PRD §6.1；决策 D8；设计稿 | +60 |
| seats | app/web/src/components/studio-page/use-seats-data.ts | 新 hook `useSeatsData(squadId, detail, stateMap)` | 新增 | 派生纯数据 hook：**不新增网络请求**（数据全走既有 store + props）；返回 `{seats: SeatRow[], stats: SeatStats, onlineCount, inProgressCount}`；`seats[i]` 组装 `{member, presence, statusText, lastActiveIso}`；presence 派生规则：`stateMap[member.sessionId] ∈ {running,interrupting,suspended}` → 'busy'；`member.state==='benched'` → 'offline'；else → 'online'（无 idle）；statusText 派生：`member.currentWork?.text` ?? i18n fallback（`studio:seats.status.online/busy/offline`）；lastActiveIso 需 sessions 列表——`useLifecycle` 挂 `sessions` KeyedMap（一次 listSessions()，无 SSE 订阅——切 tab 不刷新，可接受本版陈旧），按 `member.sessionId` 反查 → session.updatedAt | MUST 走 useLifecycle 而非裸 useState（对齐 §3.10 契约）；MUST NOT 新增 backend endpoint；MUST 数据形 = KeyedMap<sessionId,Session>（对齐 lifecycle_data_shapes §2.3）| PRD §6.4；[P0]component_data_map.md；[P0]lifecycle_data_shapes.md §2.3 | +100 |
| seats | app/web/src/components/studio-page/use-seats-data.ts | `derivePresence(member, sessionState)` | 新增 | 纯函数 `(m:Member, s?:SessionState)=>'online'\|'busy'\|'offline'`；单测覆盖 | MUST 无 idle 分支（决策：本版三态） | PRD §6.4 | +8 |
| seats | app/web/src/components/studio-page/use-seats-data.ts | `deriveInProgressCount(members, squadChatSessionId, stateMap)` | 新增 | 遍历 squad 全 session ids 数 `stateMap[sid] ∈ {running,interrupting,suspended}` | — | PRD §6.4 | +8 |
| seats | app/web/src/components/studio-page/__tests__/use-seats-data.test.ts | UT | 新增 | 覆盖 presence 派生 / inProgressCount / statusText fallback / lastActiveIso 组装；用真实 useLifecycle mock reducer 走一遍 | — | test-vitest-mock-absolute-path memory | +140 |
| seats | app/web/src/components/studio-page/page-studio.tsx | `MainView` union | 修改 | 加分支 `\| { kind:'seats'; squadId:string }` | MUST 不改现有 kind 语义 | — | +1 |
| seats | app/web/src/components/studio-page/page-studio.tsx | `selectSquad(id)` | 修改 | **决策：默认 landing = 'seats'**（而非 'panel'）——PRD §6.2 IA 过渡期用户选 squad 直接看坐席全景；面板 tab 保留通过点击 sidebar 二次进入或 seats 内 breadcrumb「管理面板」入口 | MUST 保持点 chat 节点 → 'chat' 语义；MUST 保持看板节点 → 'board' 语义 | PRD §6.2/§6.3；用户裁决 D7 | +3/-1 |
| seats | app/web/src/components/studio-page/page-studio.tsx | 主区渲染 chain | 修改 | 加 `mainView.kind === 'seats'` 分支 → 渲染 `<SeatsPanel squadId onEnterChat={(node)=>setMainView({kind:'chat', node, from:'seats'})} onOpenBoard onOpenGroupChat/>` | MUST 传 `from:'seats'` 标签（下 §9） | PRD §6.5 UC-E1 | +8 |
| seats | app/web/src/components/studio-page/section-studio-sidebar.tsx | sidebar 头部区 | 修改 | 在「新建 squad」按钮下新增顶层「坐席」快捷入口（可选，用户裁决 D7 说「入口位置 architect 定」）——**决策**：不加顶层入口，走「选中 squad 即进 seats」路径（selectSquad 已改，见上），保持 sidebar 结构不变 | MUST 保 sidebar 现有 testid 不变 | 决策 D7；PRD §6.3 | 0 |

---

## 9. chat-topbar 条件返回按钮（源追踪）

| 所属模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| chat-back | app/web/src/components/studio-page/page-studio.tsx | `MainView` chat 分支 | 修改 | `{kind:'chat', node, prefill?, from?: 'seats'\|'sidebar'}`；缺省 'sidebar'；坐席点入传 'seats'；侧栏 sidebar `onOpenChat` 不传（缺省 'sidebar'） | MUST 只在 seats 入口显式传 'seats'（保 sidebar 路径 back-compat） | PRD §6.2；决策 D7；PRD UC-E3/E5 | +2 |
| chat-back | app/web/src/components/studio-page/page-studio.tsx | chat 主区渲染 | 修改 | `<StudioChatRouter node={node} from={mainView.from} onBackToSeats={() => setMainView({kind:'seats', squadId: selectedSquadId!})}/>`；`onBackToSeats` 仅在 `from==='seats'` 时才有意义（router 内部按 from 门控是否透传） | MUST 保留 `onOpenMember`/`prefill` prop 不改 | 同上 | +3 |
| chat-back | app/web/src/components/studio-page/component-studio-chat-router.tsx | `StudioChatRouterProps` | 修改 | 新增 `from?: 'seats' \| 'sidebar'` + `onBackToSeats?: () => void`；透传给 SquadChatPage / MemberChatPage | MUST 可选（back-compat 单元测试） | 同上 | +2 |
| chat-back | app/web/src/components/studio-page/component-studio-chat-router.tsx | `StudioChatRouter()` | 修改 | `<SquadChatPage ... showBackButton={from==='seats'} onBack={onBackToSeats}/>` / `<MemberChatPage ... showBackButton={from==='seats'} onBack={onBackToSeats}/>` | MUST 显示逻辑门控在 router；不在 chat page 内 hard-code | 同上 | +4 |
| chat-back | app/web/src/components/studio-page/section-squad-chat.tsx | `SquadChatPage` Props + `topbarLeft` | 修改 | Props 加 `showBackButton?: boolean` + `onBack?: () => void`；`topbarLeft` 前置 `showBackButton && <ChatTopbarBackBtn onClick={onBack}/>`（**T5 抽 primitive 收敛 11 行 JSX 重复**，见下 primitive 行；testid `chat-topbar-back-btn` 沿用；i18n `common:action.back`） | MUST testid `chat-topbar-back-btn`（regulation 02 §9 & PRD §8.2 布局稳定：按钮出现不推挤 title——用 flex + fixed-width slot 或右侧内容不 flex-grow）；MUST i18n `common:action.back`（现有 key，非新增） | PRD §6.2 UC-E3；规范 02 §9 | +3 |
| chat-back | app/web/src/components/studio-page/section-member-chat.tsx | `MemberChatPage` Props + `topbarLeft` | 修改 | 同上；`topbarLeft` 前置 `<ChatTopbarBackBtn/>` | 同上 | 同上 | +3 |
| chat-back | app/web/src/components/studio-page/component-chat-topbar-back-btn.tsx | `ChatTopbarBackBtn` primitive | **新增 [T5 追加]** | ghost 型 h32 按钮 = ChevronLeftIcon 14px + i18n `common:action.back`；消除 section-{squad,member}-chat 两处 11 行 JSX 重复；`onClick` 单一 prop；testid `chat-topbar-back-btn` | MUST 单文件 ≤50 行；MUST i18n `common:action.back`；MUST 无 hex | code-review T3 Major-borderline 分派 T5 收敛 | +44（新文件） |
| chat-back | app/web/src/components/chat-page/base-chat-page.tsx | topbar 容器 class | 修改 | 保持不变——`topbarLeft` slot 由消费方组装（back 按钮 = 消费方职责）；只需确保容器 flex 不阻挡 back（现 `flex items-center gap-2 min-w-0` 支持前置节点）| MUST NOT 加 back 相关逻辑（base 无源头信息） | 单一职责 | 0 |
| chat-back | app/web/src/i18n/locales/{zh-CN,en}/common.json | `action.back` key | 保留 | **doc-sync 订正**：change_plan 原本要求新增顶层 `back`，实现改为**沿用已就绪的 `common:action.back`**（中英，`common.json` 已存在，section-member-panel 亦已用）——语义等价、避免键重复、`i18n-key-add-checklist` 双确认通过；UT `component-chat-topbar-back-btn.test.tsx` 已断言 | MUST 沿用现有 key；MUST NOT 新增顶层 `back` | i18n-key-add-checklist memory；section-member-panel.tsx:125 | 0 |
| chat-back | specs/ui/components/chat-page/_overview.md | §4.4 topbar 左侧 slot 描述 | 修改（doc-modifier 阶段） | 补充：studio 消费方可条件挂载「返回」按钮（`chat-topbar-back-btn` testid）；playground 不适用 | doc-modifier 阶段落 | PRD §10 边界 | +8 |

---

## 10. 组件 spec 清单（coder 编码前置创建/更新 — MANDATORY）

按 CLAUDE.md 概念先行：新组件先落 spec 后写代码。coder 起 task 前**必须先** Read `_conventions.md` 并创建/更新以下 spec：

| spec 路径 | 类型 | 交付内容 |
|---|---|---|
| specs/ui/components/common/component-model-picker-panel.md | 新增 | 300px 白卡展开态契约（regulation 02 §7）；testid / props / 视觉基线；见 §7 |
| specs/ui/components/common/component-model-picker-trigger.md | 新增 | 收起态 trigger 契约；见 §7 |
| specs/ui/components/common/component-icon-box.md | 新增 | hueBy hash 色 icon-box primitive；见 §7 |
| specs/ui/components/common/member-avatar.md | 修改 | 更新为 hash-by-id 8 色 palette + presence 点契约；见 §4 |
| specs/ui/components/studio-page/component-seats-panel.md | 新增 | 坐席面板整体契约（§6.1）；testid 汇总 |
| specs/ui/components/studio-page/component-seat-card.tsx.md | 新增 | 单卡契约 + testid |
| specs/ui/components/studio-page/component-seat-stats.md | 新增 | 统计条契约 + 降级规则 |
| specs/ui/components/studio-page/component-team-entry-row.md | 新增 | 团队入口行契约 |
| specs/ui/components/chat-page/_overview.md | 修改 | §4.4 补 chat-topbar-back-btn testid（doc-modifier 阶段落） |
| specs/ui/components/chat-page/component-msg-time.md | 新增 | 消息时间 primitive |
| specs/ui/components/chat-page/component-empty-state.md | 修改 | 简化后契约（无 mascot / 无 wave） |
| specs/ui/regulation/_conventions.md（现 `specs/ui/components/_conventions.md`）| 已有 | 不动 |
| specs/ui/overall/06-studio.md | 修改（doc-modifier 阶段） | 补坐席 tab §2.3 |

---

## 11. 影响面聚合（按模块行数估算）

| 模块 | +行 | -行 | 净变 |
|---|---|---|---|
| tokens + 全局样式 | +80 | -152 | -72 |
| 主题下线 | +16 | -167 | -151 |
| hex 清零 | ~50 | ~50 | 0（原地替换） |
| member-avatar | +126 | -10 | +116 |
| empty-state 简化 | +26 | -162 | -136 |
| 消息时间 | +191 | 0 | +191 |
| 模型选择统一 | +580 | -200 | +380 |
| 坐席面板 | +725 | -1 | +724 |
| chat-topbar 返回按钮 | +49 | 0 | +49 |
| **合计（含 spec ~380 行）** | **~1843** | **~742** | **~+1101** |

---

## 12. 关键 invariant / 边界（reviewer 重点核查）

1. **INV-1（后端零改动）**：`git diff dev1..HEAD -- app/server app/protocols app/shared` **必须无变化**（除了 shared 无关的 lint fix，需 architect 二次核对）。违反 = 硬 FAIL。
2. **INV-2（hex 归零）**：`grep -rn '#[0-9a-fA-F]\{6\}' app/web/src --include='*.tsx' --include='*.ts' | grep -v __tests__` **必须为 0** 行（除 tests 白名单 + tokens.css）。code-reviewer 硬门禁。
3. **INV-3（无 keyframes 引用）**：`grep -rn 'animate-\[.*_' app/web/src` **必须为 0**（`animate-*` tailwind class 也要清）。code-reviewer 硬门禁。
4. **INV-4（Playfair Display 归零）**：`grep -rn 'font-serif\|Playfair' app/web/src` **必须为 0**（brand 用 brand-grad）。
5. **INV-5（单一 hash 函数）**：`hashHueIndex` 只在 `lib/hue-hash.ts` 定义一次；member-avatar / icon-box / skill-item 均 import 该单例（消除重复实现）。
6. **INV-6（chat-topbar 布局稳定）**：back 按钮出现/消失**不导致 title 位移**（用 flex gap 或固定宽度 slot；PRD §8.2）。UT 断言渲染前后 title x-offset 不变。
7. **INV-7（三 chat 页消息时间同源）**：仅在 `component-msg-time.tsx` + `component-message-stream.tsx` 修改一次即三页共享（BaseChatPage 消费者 unification 已由 v0.0.156 完成）。
8. **INV-8（坐席卡数据零后端新增）**：`use-seats-data.ts` 只允许调 `listSessions()`（一次挂载）+ 读现有 detail / stateMap；**不得**新增 `POST/GET /squad/:id/seats` 类端点。
9. **INV-9（token 命名双轨兼容）**：新 regulation token（无 `--color-` 前缀）与旧 `--color-*` alias 共存；新代码走无前缀；不删旧 alias（防 tailwind class 大爆炸）。

---

## 13. 与「文件级变更清单」的关系

本 change_plan 为**符号级 review 合同**（架构冻结）。每个 feature 章节内的「文件变更清单」由 PRD §10 边界 + regulation 02/03 隐含契约综合，行=符号级；planner 按此切 task（`coversModules/coversFiles/coversMethods`，最粗 owning 级别）；coder 参考实现+汇报偏离；code-reviewer 按此查偏离（清单 G）。二者数据一致。

**开放点（coder 可决策，需汇报）**：
- OP-1：`ModelPicker` 内的 tailwind class 细节（如 h32 vs h28 视觉贴合）——设计稿只保证 300px panel + 22px icon，具体 padding 由 coder 试
- OP-2：`SeatCard` 「更多」按钮的下拉菜单内容（本版可先留空 disabled 或做 hire/bench 快捷）——PRD 未明规，coder 先留 disabled + TODO 注释
- OP-3：`use-seats-data` 是否用 SSE 订阅 session_meta 增量更新（当前设计 = 只挂载拉一次 + stateMap SSE 覆盖 presence）——性能可以后优化
- OP-4：seats 主 header 的 tabs「坐席/管理/自动工作」是 sticky 顶栏 3 按钮 or 单纯当前视图无 tabs（进管理靠点 sidebar squad 行）——design html 有 tabs，架构选后者（无 tabs，纯 landing view），coder 若发现有 UX 更佳方案可提

**关键风险**：
- R-1：**tailwind class 大爆炸**——现全站 `bg-accent` / `text-accent` / `bg-accent-surface` 分布上百处；决策保留 `--color-accent-*` alias 灌新值（黑主 CTA），视觉上「accent 就是黑」；这是最省 diff 的做法但**语义污染**（accent 名字不合适）——本版接受，v0.0.166+ 再逐步清 alias。
- R-2：**Session.updatedAt 用作「最近活跃」不够精确**——它反映 session 元数据更新时间（含 title 改、内部 mutation），非「最近一条消息时间」；本版接受近似，PRD §6.4 已允许降级。
- R-3：**stateMap 只覆盖 studio biz session**——use-studio-unread-meta 走 `session_meta _all` + biz='studio' 反向守卫；如某 member session 长时间无事件（不 running）则 stateMap 无值 → 落 online（`state===undefined` 走默认分支）——符合 PRD 意图。
- R-4：**「今日 token」用 budget.consumed 语义偏移**——budget.consumed 是 daily 窗口（时区跟 squad.timezone），非 UTC「今日 00-24」，label 改「已用 token」+ tooltip 提示可缓解。

---

**version**：1.1（v0.0.165 doc-sync 阶段 5 订正——`common:back` → `common:action.back`（沿用现有 key，非新增）；panel testid 由 `panelTestid` prop 显式传而非派生 `-menu`（三消费方 back-compat 命名不统一：ModelPicker `${trigger}-list` / InputModelPicker `model-picker-menu`+`model-picker-preview` / KeyModelPicker `${suffix}-menu`）；`TAB_KV_GROUPS.general=[]` 说明补充（`APP_SETTINGS_TABS[general].groups=['locale']` 是 tab 展示元数据，非 dirty 编排）；chat-back 抽 primitive `component-chat-topbar-back-btn.tsx` 收敛两处 JSX 重复）。

version：1.0（v0.0.165 首版；行=符号；覆盖 tokens/主题/hex/avatar/empty-state/msg-time/model-picker/seats/chat-topbar-back 9 模块）

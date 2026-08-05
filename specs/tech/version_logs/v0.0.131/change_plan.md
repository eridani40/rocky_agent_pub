# v0.0.131 变更计划书 — 会话区域 2 个升级（历史 query minimap + 右上悬浮菜单）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **纯前端版本**：无后端 API 变更、无 schema 变更（`specs/api/` 不动）。复用既有 `/memory/session` + `/session/:id/cron` CRUD。
>
> **关键架构决策（详见文末影响面）**：
> 1. **flatten 单次分发**：三处 chat root 用 `useFlattenedView` 单次 flatten → 分发 message-stream（新增可选 `flattened` prop）+ minimap（`deriveMinimapBars`），不二次 flatten。
> 2. **minimap bar = 右侧 user 气泡**：按 message-stream 同款 `sideResolver ?? sideOfMessage` 判定，仅 side==='user' 产 bar（**修正 PRD §2.2「a2a inbox 不产 user-text」的不准确**——a2a inbox `role:'user'` 确产 user-text，靠 side 判定排除群聊左侧 a2a）。
> 3. **统一右缘 overlay**：`component-chat-right-overlay` 承载 minimap + float-menu，3 root 各挂一处，z-index < usage-panel 展开面板（z-50/z-60）。
> 4. **badge 与弹层同源**：float-menu 恒挂载 `useMemoryCrud` + `useCronCrud`（chat 挂载即取），badge 与弹层列表同源，用户 CRUD 写后 refetch 即时更新；agent 侧写入非实时（known-boundary）。
> 5. **弹层二级视图**：`component-memory-modal` / `component-cron-modal` 内 `view: list|editor` 切换 + 返回按钮，复用既有卡片/表单零件，不弹层套弹层。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 / 原则编号 |
| 预计影响行 | +N / -M |

## 变更清单

### A. 派生/数据基础设施（新增）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/use-flattened-view.ts | `useFlattenedView(messages, opts)` | 新增 | 记忆化包裹 `flattenAndGroup(messages, {messageFilter, blockFilter})`，返回 `FlattenedView`；deps=[messages, messageFilter, blockFilter] | MUST 纯 useMemo 无副作用；MUST 复用 `flattenAndGroup`（不自写 flatten 逻辑） | `component-history-minimap.md §2`；`message-flatten.ts` | +22 |
| ui-chat | app/web/src/components/chat-page/minimap-bars.ts | `MinimapBar` interface | 新增 | `{messageId, query, preview?}` | — | `component-history-minimap.md §2` | +6 |
| ui-chat | app/web/src/components/chat-page/minimap-bars.ts | `deriveMinimapBars(elements, messages, sideResolver?, max=10)` | 新增 | 遍历 `elements` 取 user-text；按 `sideResolver ?? sideOfMessage` 判 side==='user' 才产 bar；preview=该 user-text 后、下一个 user-text 前首个 agent-answer.text（无则 undefined）；返回末尾 10 条 | MUST 复用 `sideOfMessage`（从 component-message-stream 导入）；MUST NOT 按 kind 裸判（须 side 判定排除群聊 a2a 左侧）；纯函数 | `component-history-minimap.md §2`；`squad-chat-helpers.isA2aInbox` | +34 |
| ui-chat | app/web/src/components/chat-page/use-cron-crud.ts | `NewFormState` / `INITIAL_NEW` | 新增 | 从 section-cron-panel 迁入的 cron 新建表单 state 类型 + 初值（`cron:'*/30 * * * *'` 等） | 迁移后 section-cron-panel 删；component-cron-new-form 改从本文件 import | `section-cron-panel.tsx`（迁移源）；原则「不留僵尸」 | +12 |
| ui-chat | app/web/src/components/chat-page/use-cron-crud.ts | `useCronCrud(sessionId, {enabled})` | 新增 | 从 section-cron-panel 抽出 cron 列表 CRUD：useLifecycle onInit GET /cron + startTimer(60s) + onTick 重读；返回 `{jobs, loading, error, busyId, refetch, handleToggle, handleDelete}`；`enabled:false`（群聊）→ onInit 返空 + 不 startTimer + 不 fetch | MUST 走 useLifecycle 四方法（不裸 setInterval）；MUST `enabled:false` 时零网络；Collection\<CronJobSummary\> keyOf=id | `[P0]component_architecture.md §3.10`；`[P0]lifecycle_data_shapes.md §2.1`；`section-cron-panel.tsx`（抽出源） | +90 |

### B. 新 UI 组件（新增）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/component-history-minimap.tsx | `ComponentHistoryMinimap(props)` | 新增 | 竖排 bar + Dock 悬停放大（CSS width transition 右锚向左延伸）+ 左侧预览气泡（query 加粗 / answer 或占位）+ 点击 `document.querySelector([data-testid=anchorTestid(mid)]).scrollIntoView` | MUST 布局稳定（bar 放大/预览 overlay 绝对定位，不推动相邻）；MUST 空 bars 不渲染；testid 全按 spec §6 | `component-history-minimap.md`（.md+.tsx spec 已落全） | +80 |
| ui-chat | app/web/src/components/chat-page/component-chat-float-menu.tsx | `ComponentChatFloatMenu(props)` + `Badge` | 新增 | 竖向工具条 + memory/cron 菜单项 + badge；恒挂载 useMemoryCrud + useCronCrud（badge 同源）；`hideCron` 隐藏 cron 项 + 用 enabled gate；点项开弹层（openModal state） | MUST badge=0 绝对定位不渲染（不占位）；MUST hideCron 时 cron 项不挂载 + cron hook enabled=false；MUST 数据 hook 恒挂载（弹层开关不重 GET） | `component-chat-float-menu.md`（.md+.tsx spec 已落全）；orchestrator 裁决#1/#4 | +90 |
| ui-chat | app/web/src/components/chat-page/component-chat-right-overlay.tsx | `ComponentChatRightOverlay(props)` | 新增 | chat-detail 右缘统一 overlay：`absolute right-3 top-16 z-20 pointer-events-none`，内含 float-menu（top，pointer-events-auto）+ minimap（下，右 gutter）；props `{sessionId, hideCron, bars, anchorTestid}` | MUST z-index < usage-panel 展开(z-50/z-60)；MUST 容器 pointer-events-none + 子 auto（不挡正文点击）；3 root 复用同组件 | `component-chat-float-menu.md §8`；orchestrator 裁决#2/#3 | +40 |
| ui-chat | app/web/src/components/chat-page/component-chat-right-overlay.md | 组件 spec | 新增 | coder 前置产出（定位/z-index/pointer-events/组合关系/testid `chat-right-overlay`） | 先 spec 后实现（_conventions §5） | `_conventions.md §5` | +50 |
| ui-chat | app/web/src/components/chat-page/component-memory-modal.tsx | `ComponentMemoryModal(props)` | 新增 | 记忆弹层二级视图：view 由 `crud.editor.open` 驱动（list↔editor）；list=memory-entry-card 列表 + 空态 `memory-modal-empty` + 新建 btn；editor=`ComponentMemoryEditorFields` + 返回按钮（`crud.setEditor({open:false})`）；save 走 crud.handleSave（自动回 list+refetch） | MUST 复用 useMemoryCrud editor state（不新建 view state）；MUST NOT 弹层套 modal（editor 为二级视图非叠加）；testid 按 float-menu spec §5 | `component-chat-float-menu.md §4/§5`；`section-memory-panel.md` | +110 |
| ui-chat | app/web/src/components/chat-page/component-memory-modal.md | 组件 spec | 新增 | coder 前置产出（二级视图/idle 空态/复用零件/testid） | 先 spec 后实现 | `_conventions.md §5` | +60 |
| ui-chat | app/web/src/components/chat-page/component-cron-modal.tsx | `ComponentCronModal(props)` | 新增 | cron 弹层二级视图：view=list\|editor；list=cron-job-card 列表 + `cron-empty` 空态 + 新建 btn + 删除二次确认；editor=cron-new-form(freq-picker+prompt) + 返回按钮；toggle/delete 走 crud；new 走 cron-new-form onSaved=crud.refetch | MUST 复用 useCronCrud + component-cron-new-form；MUST NOT 弹层套 modal；testid 按 float-menu spec §5 | `component-chat-float-menu.md §4/§5`；`component-cron-panel.md` | +130 |
| ui-chat | app/web/src/components/chat-page/component-cron-modal.md | 组件 spec | 新增 | coder 前置产出 | 先 spec 后实现 | `_conventions.md §5` | +55 |
| ui-chat | app/web/src/components/chat-page/component-memory-editor-fields.tsx | `ComponentMemoryEditorFields(props)` | 新增 | 从 memory-editor-modal 抽出纯表单字段（name/intro/type/body/why/how/evolvable + 校验 + save/cancel），**无 modal 壳**；testid 前缀沿用（`{prefix}-editor-*`） | MUST 字段/校验/testid 与旧 editor-modal 一致（ET 观测契约稳定）；MUST NOT 含 fixed overlay | `component-memory-editor-modal.md`；`component-memory-editor-modal.tsx`（抽出源） | +150 |
| ui-chat | app/web/src/components/chat-page/component-memory-editor-fields.md | 组件 spec | 新增 | coder 前置产出 | 先 spec 后实现 | `_conventions.md §5` | +45 |

### C. 既有组件重构（修改）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | `ComponentMessageStream` | 修改 | 新增可选 prop `flattened?: FlattenedView`；内部 `const fv = flattened ?? flattenAndGroup(messages, {messageFilter, blockFilter})`（其余不动） | MUST 向后兼容（不传 flattened = 内部计算，零回归）；MUST NOT 改渲染逻辑 | `component-history-minimap.md §2/§7`；`_overview.md §2` | +6/-1 |
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | `MessageStreamProps` | 修改 | interface 加 `flattened?: FlattenedView` 字段（+import 类型） | — | 同上 | +3 |
| ui-chat | app/web/src/components/chat-page/component-memory-editor-modal.tsx | `ComponentMemoryEditorModal` | 修改 | body 表单委托给 `ComponentMemoryEditorFields`（保留 fixed 遮罩 + head + close 壳）；app config section-user-memory 仍用本 modal | MUST DRY（表单逻辑单一源在 fields 组件）；MUST 保 app config global scope 用法不变 | `component-memory-editor-modal.md`；PRD §7（session 废弃 / global 保留） | +10/-140 |

### D. 三处 chat root 接线（修改，3 处一致）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/section-chat-detail.tsx | `SectionChatDetail` | 修改 | 计算 `const fv = useFlattenedView(messages, {})` + `bars = useMemo(() => deriveMinimapBars(fv.elements, messages))`（无 sideResolver）；`<ComponentMessageStream flattened={fv} .../>`；根 section 内挂 `{sessionId && <ComponentChatRightOverlay sessionId hideCron={false} bars anchorTestid=... />}`，anchorTestid 返回 `msg-user-{id}` | MUST 根 section 保持 relative（overlay 定位基准）；MUST anchorTestid 用 `msg-user-{id}`（playground 行 testid） | `component-chat-float-menu.md §8`；orchestrator 裁决#3 | +14 |
| ui-chat | app/web/src/components/studio-page/section-member-chat.tsx | `MemberChatPageLoaded` | 修改 | 同上；`useFlattenedView(messages, {})`（member 无 messageFilter）；`deriveMinimapBars(fv.elements, messages, memberSideResolver)`（a2a→右也产 bar）；`<ComponentMessageStream flattened={fv} .../>`；`<main>` 内挂 overlay（hideCron=false，anchorTestid=`squad-chat-message-{id}`） | MUST anchorTestid `squad-chat-message-{id}`（studio 行 testid）；MUST 传 memberSideResolver 给 deriveMinimapBars（与 stream 同 side 判定） | `component-history-minimap.md §2`；`squad-chat-helpers.memberSideResolver` | +14 |
| ui-chat | app/web/src/components/studio-page/section-squad-chat.tsx | `SquadChatPageLoaded` | 修改 | 同上；`useFlattenedView(messages, {messageFilter: groupMessageFilter})`；`deriveMinimapBars(fv.elements, messages)`（默认 sideOfMessage，a2a→左不产 bar）；`<ComponentMessageStream flattened={fv} messageFilter={groupMessageFilter} .../>`；overlay `hideCron={true}`（群聊无 cron，UC-F6）+ anchorTestid=`squad-chat-message-{id}` | MUST hideCron=true；MUST flatten opts 与 stream 一致（messageFilter=groupMessageFilter）否则 bar 与气泡不同源 | `component-history-minimap.md §2`；PRD §3.5；`squad-chat-helpers.groupMessageFilter` | +14 |

### E. 废弃删除（删除/修改 —— 不留僵尸）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/component-ws-tab-bar.tsx | `WsTab` type | 修改 | `'workspace' \| 'memory' \| 'cron'` → `'workspace'`（仅工作区） | — | PRD §7；`component-workspace-panel.md §2` | +1/-1 |
| ui-chat | app/web/src/components/chat-page/component-ws-tab-bar.tsx | `ComponentWsTabBar` | 修改 | 删 memory tab 按钮（BrainIcon `ws-tab-memory`）+ cron tab 按钮（ClockIcon `cron-tab`）+ `hideCronTab` prop + `onTabChange` memory/cron 分支；仅剩 workspace tab + actions（swap/refresh/collapse）；删 BrainIcon/ClockIcon import | MUST 删干净（`ws-tab-memory`/`cron-tab` testid 消失，UC-F7）；MUST 保 `ws-tab-workspace`/switch/refresh/collapse | PRD §7；UC-F7 | +2/-55 |
| ui-chat | app/web/src/components/chat-page/section-workspace-panel.tsx | `SectionWorkspacePanel` | 修改 | 删 `activeTab` state（恒 workspace）+ memory/cron 分支（`{activeTab==='memory'...}`/`{activeTab==='cron'...}`）+ `hideCronTab` prop + `SectionMemoryPanel`/`SectionCronPanel`/`WsTab` import；ws-tab-bar 调用去 activeTab/onTabChange/hideCronTab | MUST 删干净（无孤儿 import/分支）；workspace 内容（path-bar/file-tree）不动 | PRD §7；`component-workspace-panel.md` | +2/-30 |
| ui-chat | app/web/src/components/chat-page/section-workspace-panel.tsx | `SectionWorkspacePanelProps` | 修改 | 删 `hideCronTab?: boolean` 字段 | — | 同上 | +0/-3 |
| ui-chat | app/web/src/components/chat-page/section-memory-panel.tsx | 整文件 | 删除 | ws-panel 长期记忆 tab 内容组件，被 memory-modal 取代；无其他引用（grep 确认仅 ws-panel）；逻辑走 useMemoryCrud（保留） + 卡片/表单（保留） | MUST 确认零引用后删（含 test 文件迁移/删）；useMemoryCrud/memory-entry-card 不删 | PRD §7；grep 确认仅 section-workspace-panel 引用 | -98 |
| ui-chat | app/web/src/components/chat-page/section-cron-panel.tsx | 整文件 | 删除 | ws-panel 定时任务 tab 内容组件，被 cron-modal 取代；CRUD 逻辑已抽 useCronCrud；`NewFormState`/`INITIAL_NEW` 迁 use-cron-crud（或 cron-new-form）；无其他引用（除 component-cron-new-form 的 type import，改指向） | MUST 迁移 NewFormState/INITIAL_NEW 后再删（否则 cron-new-form 断链）；含 test 迁移/删 | PRD §7；grep 确认引用面 | -264 |
| ui-chat | app/web/src/components/chat-page/component-cron-new-form.tsx | import `NewFormState` | 修改 | `import type { NewFormState } from './section-cron-panel'` → 改从 `./use-cron-crud`（迁移目标）；适配 cron-modal 二级视图内嵌（去外层 border-t 容器或由 modal 控制，保表单零件 + testid） | MUST 保 `cron-new-cron`/`cron-new-prompt`/`cron-new-save`/`cron-new-cancel` testid；不断 createCronJob 逻辑 | `component-cron-new-form.tsx:18`（当前 import） | +4/-4 |
| ui-chat | app/web/src/components/studio-page/section-right-tabs.tsx | `SectionRightTabsProps` / `SectionRightTabs` | 修改 | 删 `showCronTab` prop（ws-panel 无 cron tab 后无意义）；`<SectionWorkspacePanel>` 调用去 `hideCronTab` | MUST 删干净（prop 链整条清理）；保 `squad-right-tabs`/`data-workspace-semantic` | PRD §7 单一来源护栏；`section-right-tabs.md` | +2/-6 |
| ui-chat | app/web/src/components/studio-page/component-studio-chat-router.tsx | `showCronTab` 传递 | 修改 | 删 2 处 `showCronTab={...}` 传参（line ~62 群聊 false / line ~96 单聊）+ `const showCronTab = !isGroup`（line ~75）死代码 | MUST 删干净（无孤儿变量） | `component-studio-chat-router.tsx:62/75/96` | +0/-4 |

### F. i18n + tech 文档

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n | app/web/src/i18n/locales/{zh-CN,en}/chat.json | `minimap.noReply` / `floatMenu.memory` / `floatMenu.cron` | 新增 | minimap 预览占位 +悬浮菜单项 aria/title 文案（中英双语，locale 目录 zh-CN + en） | MUST 两语言都加（memory `i18n-key-add-checklist`）；渲染走 t() | `_conventions.md §8a`；memory `i18n-key-add-checklist` | +6 |
| tech | specs/tech/app/frontend/[P0]component_data_map.md | §2 表 | 修改 | `SectionCronPanel` 行 → `useCronCrud`（Collection\<CronJobSummary\>, onTick 60s, enabled gate）；`useMemoryCrud` 备注加「float-menu badge 复用」；补 `useFlattenedView`（纯 memo，不迁类）说明 | 由 doc-modifier 阶段5 finalize；本行仅登记待改点 | `[P0]component_data_map.md §2`；本表 A 组 | +3/-1 |

### G. UT 覆盖点（新增测试）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/components/chat-page/__tests__/minimap-bars.test.ts | deriveMinimapBars 用例 | 新增 | 覆盖：user-text→bar / ≤10 取最近 10 / a2a inbox 群聊(默认 side)不产 bar + 单聊(memberSideResolver)产 bar / reminder 天然无 bar / preview=下一 agent-answer / 无 answer→undefined(占位) / 无 answer 但下一 user-text 先到→undefined | MUST 覆盖 PRD §9 UT 全部派生分支 | PRD §9 UT；`component-history-minimap.md §2` | +90 |
| ui-chat | app/web/src/components/chat-page/__tests__/component-chat-float-menu.test.tsx | badge 计数用例 | 新增 | 覆盖：memory badge=entries.length / cron badge=enabled 数 / =0 隐藏 / hideCron 隐藏 cron 项 + cron hook 不 fetch | MUST 覆盖 badge 计数 + hideCron gate | PRD §9 UT；`component-chat-float-menu.md §2/§3` | +70 |
| ui-chat | app/web/src/components/chat-page/__tests__/use-cron-crud.test.ts | useCronCrud 用例 | 新增 | 覆盖：GET 列表 / toggle/delete refetch / enabled=false 零 fetch / 60s poll 声明 | MUST 覆盖 enabled gate + CRUD refetch | `use-cron-crud.ts` | +60 |
| ui-chat | app/web/src/components/chat-page/__tests__/*（既有 ws-tab-bar/section-memory-panel/section-cron-panel test） | 相关 test | 修改/删除 | ws-tab-bar test 去 memory/cron tab 断言；section-memory-panel/section-cron-panel test 删（组件删）或迁 modal test | MUST 测试与删除同步（无悬空 import） | E 组删除 | +0/-N |

## 影响面评估

- **跨模块**：全部集中在 `app/web/src/components/chat-page/`（新组件 + 派生 + 弹层）+ `studio-page/`（3 处 root 接线 + section-right-tabs/router prop 清理）+ i18n。**无后端 / 无 protocol / 无 shared**。
- **破坏性变更**：
  - **testid 废弃**（ws-panel）：`ws-tab-memory` / `cron-tab` 消失（UC-F7 正向断言）；记忆/cron 列表容器 + 新建按钮 testid 迁弹层（`memory-modal-*`/`cron-modal-*`）。entry/job 卡片 + 表单字段 testid **不变**（复用零件）。ET designer 按新 float-menu spec §5 写 case。
  - **组件删除**：`section-memory-panel.tsx` / `section-cron-panel.tsx`（含 test）——grep 确认仅 ws-panel 引用，删前须迁 `NewFormState`/`INITIAL_NEW`。
  - **ComponentMessageStream 加可选 `flattened` prop**：向后兼容（fallback 内部计算），非破坏。
- **依赖顺序**（planner 切 task 参考）：A（基础设施 use-flattened-view / minimap-bars / use-cron-crud）→ B（新组件，含 editor-fields 抽出）→ C（message-stream prop + editor-modal 委托）→ D（3 root 接线）→ E（废弃删除）→ F/G（i18n + UT）。D 依赖 A+B；E 依赖 B（modal 就绪才删 panel）。
- **风险点**：
  1. **flatten 同源**：D 组 3 root 的 `useFlattenedView` opts 必须与传给 stream 的 `messageFilter`/`blockFilter` 完全一致，否则 bar 与气泡不同源（bar 数 ≠ 可见气泡数）。code-reviewer 重点核对。
  2. **a2a inbox side 判定**：`deriveMinimapBars` 必须用 side 判定（非 kind），且各 root 传对 sideResolver（member 传 memberSideResolver / 群聊不传=默认）。PRD §2.2 表述不准，以本 change_plan + minimap spec §2 为准。
  3. **overlay z-index / pointer-events**：overlay 容器 pointer-events-none + 子 auto，z<50，否则挡正文点击或被 usage-panel 遮。
  4. **use-cron-crud enabled gate**：群聊 enabled=false 必须真正零 fetch（避免无主 cron GET）。
- **spec↔code 漂移点（architect 核对发现，已在 minimap spec §2 修正）**：PRD §2.2「squad 群聊…a2a inbox 是 assistant 侧，不产 user-text」**不准确**——a2a inbox `role:'user'`（`squad-chat-helpers.tsx:9`）在 `flattenMessages` 确产 `user-text`（`message-flatten.ts:89`）。正确判定 = 按 message-stream 同款 side（a2a inbox 群聊默认 `sideOfMessage`→'assistant'/左→不产 bar；单聊 memberSideResolver→'user'/右→产 bar）。已落 minimap spec + deriveMinimapBars 约束，coder 按此实现。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

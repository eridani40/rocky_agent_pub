# v0.0.231 变更计划书 — playground 会话列表：即时排序 + 置顶

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 架构要点（一句话）

- **后端 pinned**：SessionRecord 增 `pinned?: boolean`——复用 unread/titled lazy-default（toSession `=== true`，**无 migration**）；写路径复用现有 `PUT /session/:id`（body 无 workspaceDir → 落 `handleSessionItem`，与 effort/approvalMode 同路径，router 零改动）；写后直调 `metaBroadcaster.broadcast`（同 title 路径）→ `SessionMetaView` 透出 pinned → session_meta 广播多端一致。
- **前端统一排序**：chat-slice 收敛所有写路径（`setSessions` / `applySessionMetaEvent`）到单一比较器 `compareSessionsForList`（先 pinned 降序、同组内 `updatedAt desc`，稳定排序）。后端 GET /session 顺序契约不变（仍 updatedAt desc），置顶分组纯前端展示层归位。
- **置顶 UI**：右键菜单加「置顶/取消置顶」（在「复制 Session ID」之上）→ fire-and-forget PUT（无乐观更新，SSE 驱动归位）；conv-item pinned 视觉 = 最右侧常驻 PinIcon（absolute 零 reflow）+ 常态 `bg-bg-warm` / active `bg-[var(--surface-3)]`（active 最强）。
- **PUT updatedAt 语义（用户裁决 2026-08-01，推翻初版「自然推进」）**：**pinned-only 更新不刷 updatedAt**——置顶是纯标记操作、不算对话活动；取消置顶后该会话按**原对话时间**在非置顶组归位（可能不在顶部）。机制：`PutOptions` 加 `preserveUpdatedAt` → `computeEnvelope` upsert 分支保留 `existing.updatedAt`（双引擎共用此纯函数，version 仍 +1）→ `sessionStoreUpdateSession` 对 pinned-only patch 传该 flag；含任何非 pinned 字段的 patch 仍正常推进（title 改名等现状不变）。

## 文件级变更清单（设计粒度 roll-up）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/server/src/persistence/crud-types.ts | 修改 | PutOptions 加 `preserveUpdatedAt?: boolean` |
| app/server/src/persistence/envelope.ts | 修改 | `computeEnvelope()` upsert 分支支持保 updatedAt |
| app/server/src/agent/schema_defs/session.ts | 修改 | SessionSchema fields 加 `pinned`（boolean, required:false） |
| app/server/src/agent/session-store-types.ts | 修改 | Session interface 加 `pinned?: boolean` |
| app/server/src/agent/session-store-converters.ts | 修改 | `toSession()` 加 pinned lazy-default 规范化 |
| app/server/src/agent/session-store-core-impl.ts | 修改 | `sessionStoreUpdateSession()` patch Pick 加 pinned + 规范化写入 |
| app/server/src/agent/session-event-types.ts | 修改 | SessionMetaView 加 `pinned: boolean` |
| app/server/src/agent/session-meta-broadcaster.ts | 修改 | `sessionToMetaView()` 投影 pinned |
| app/server/src/handlers/session-deps.ts | 修改 | UpdateSessionBody 加 `pinned?: boolean`；新增 `validatePinned()` |
| app/server/src/handlers/session.ts | 修改 | `handleSessionItem()` PUT 分支：校验 + 透传 + broadcast 条件扩展 |
| app/web/src/components/chat-page/types/session.ts | 修改 | 前端 Session 加 `pinned?: boolean` |
| app/web/src/lib/chat-api/session-api.ts | 修改 | `updateSession()` body 类型加 `pinned?: boolean` |
| app/web/src/store/chat-slice.ts | 修改 | 新增 `compareSessionsForList()`；setSessions/applySessionMetaEvent 收敛重排 |
| app/web/src/components/chat-page/use-chat-actions.ts | 修改 | 新增 `handleTogglePin()` |
| app/web/src/components/chat-page/page-chat.tsx | 修改 | 接线 handleTogglePin → SectionConvPanel |
| app/web/src/components/chat-page/section-conv-panel.tsx | 修改 | 右键菜单加置顶项 |
| app/web/src/components/chat-page/component-conversation-item.tsx | 修改 | pinned 视觉（pin 图标 + 背景 + unread 红点右移） |
| app/web/src/components/chat-page/icons.tsx | 修改 | 新增 `PinIcon()` |
| app/web/src/i18n/locales/{zh-CN,en}/chat.json | 修改 | convPanel.pin / convPanel.unpin |
| specs/ui/components/chat-page/_overview.md | 修改 | §4.1 排序契约 + 菜单置顶项 / §4.2 pinned 视觉基线（**architect 已落**） |
| specs/api/overall/04-agent-session.md | 修改 | §2.1 Session.pinned + §2.5 UpdateSessionBody.pinned（**architect 已落**） |
| specs/tech/agent/session/[P0]session_store.md + log.md | 修改 | pinned lazy-default 段 + v0.0.231 log（**architect 已落**） |

## 变更清单（method 级）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| persistence | app/server/src/persistence/crud-types.ts | PutOptions.preserveUpdatedAt | 修改 | PutOptions 加 `preserveUpdatedAt?: boolean`（doc：true 时 upsert 更新保留 existing.updatedAt，version 仍 +1；缺省 false=现状推进） | MUST 缺省 false——存量所有调用方行为零变化；MUST NOT 改 mode/ifVersion 语义 | specs/tech/persistence/[P0]crud_store_interface.md §2.3；用户裁决 2026-08-01 | +5 |
| persistence | app/server/src/persistence/envelope.ts | computeEnvelope() | 修改 | upsert 更新分支（:86-91）`updatedAt: opts?.preserveUpdatedAt === true ? existing!.updatedAt : now`；createdAt 保留 / version+1 逻辑不变 | MUST 只改 upsert 更新分支一行；insert/replace 分支不动；fs-store:122 + sqlite-store:120 双引擎共用本纯函数（改一处两引擎生效） | crud-types.ts PutOptions；fs-store.ts:122 / sqlite-store.ts:120 | +2 |
| server-session | app/server/src/agent/schema_defs/session.ts | SessionSchema.fields.pinned | 修改 | fields 加 `pinned: { type: 'boolean', required: false }`（同 unread/titled 声明风格） | MUST 与 unread:90 / titled:99 同款声明；不加 enum/默认值 | specs/tech/agent/session/[P0]session_store.md §2 | +3 |
| server-session | app/server/src/agent/session-store-types.ts | Session.pinned | 修改 | Session interface 加 `pinned?: boolean` + doc 注释（lazy 默认 false、写路径 PUT、前端展示层归位） | MUST 对齐 spec §2 pinned 段语义；只加类型不加逻辑 | specs/tech/agent/session/[P0]session_store.md §2 | +8 |
| server-session | app/server/src/agent/session-store-converters.ts | toSession() | 修改 | 返回对象加 `pinned: r.pinned === true`（lazy-default，对齐 L76 unread / L80 titled） | MUST 用 `=== true` 规范化（历史 record 无字段 → false）；MUST NOT 跑 migration | session-store-converters.ts:76-80 先例；spec §2 | +2 |
| server-session | app/server/src/agent/session-store-core-impl.ts | sessionStoreUpdateSession() | 修改 | ① patch 类型 Pick 列表加 `'pinned'`；② 规范化 `pinnedVal = patch.pinned !== undefined ? patch.pinned === true : e.pinned`；③ rec 构造加条件覆盖（同 effortVal 模式）；④ **保 updatedAt（用户裁决）**：`providedKeys = Object.keys(patch).filter(k => patch[k] !== undefined)`，当 `providedKeys.length > 0 && providedKeys.every(k => k === 'pinned')`（pinned-only patch）→ `putAsync(SessionSchema, rest, { preserveUpdatedAt: true })`，否则 putAsync 不传 opts（现状推进） | MUST 保持部分更新语义（undefined 不覆盖，existing spread 保留）；MUST pinned-only 判定按「提供的字段」而非「patch 对象 key 全集」（防 `{pinned, title:undefined}` 误判）；含任何非 pinned 字段（title/effort 等）→ 不保 updatedAt（现状推进）；MUST NOT 改 alwaysApprovedKeys merge 逻辑；MUST NOT 改其他调用方（rename/effort/chrome 路径行为不变） | session-store-core-impl.ts:204-260 effort 模式 + :262-266 putAsync 调用点；envelope.ts preserveUpdatedAt；用户裁决 2026-08-01 | +12 |
| server-session | app/server/src/agent/session-event-types.ts | SessionMetaView.pinned | 修改 | SessionMetaView 加 `pinned: boolean`（required，同 unread/titled 位） | MUST 为 required boolean（投影层恒规范化，非 optional） | session-event-types.ts:200-259；api 04 §4.2 SessionMetaView | +4 |
| server-session | app/server/src/agent/session-meta-broadcaster.ts | sessionToMetaView() | 修改 | 投影加 `pinned: s.pinned === true`（同 unread/titled 行） | MUST 用 `=== true` 二次防御（对齐 L73-76 注释先例） | session-meta-broadcaster.ts:72-104 | +2 |
| server-session | app/server/src/handlers/session-deps.ts | UpdateSessionBody.pinned | 修改 | body 类型加 `pinned?: boolean`（doc：非 boolean → 400） | MUST NOT 把 pinned 加进 CreateSessionBody（新建无置顶语义） | api 04 §2.5 | +3 |
| server-session | app/server/src/handlers/session-deps.ts | validatePinned() | 新增 | `(body: UpdateSessionBody): string \| null`——body.pinned 提供但 `typeof !== 'boolean'` → 返错误串，否则 null（同 validateEffortApproval 风格） | MUST 与 validateEffortApproval(:200) 同风格返 string\|null；undefined 放行（部分更新） | session-deps.ts:200-214 先例；api 04 §2.5 | +10 |
| server-session | app/server/src/handlers/session.ts | handleSessionItem() PUT 分支 | 修改 | ① `validateEffortApproval` 后追加 `validatePinned` 校验（非 null → 400）；② updateSession patch spread 加 `...(body.pinned !== undefined ? { pinned: body.pinned } : {})`；③ broadcast 条件 `if (hasTitle && ...)` 扩为 `if ((hasTitle \|\| hasPinned) && deps.metaBroadcaster)` | MUST 走 handleSessionItem（body 无 workspaceDir 时 router 自然落此，dispatchSessionPut 零改动）；MUST NOT 改 workspaceDir 分支（session-update.ts 零改动）；broadcast 直调不 await（同 title 先例） | session.ts:209-229；api 04 §2.5 | +8 |
| ui-chat | app/web/src/components/chat-page/types/session.ts | Session.pinned | 修改 | 前端 Session interface 加 `pinned?: boolean`（doc：lazy 默认 false，列表分组+视觉依据） | MUST 与后端 SessionMetaView 投影对齐 | api 04 §2.1 | +5 |
| ui-chat | app/web/src/lib/chat-api/session-api.ts | updateSession() body | 修改 | body 类型加 `pinned?: boolean` | MUST 保持 fire-and-forget 调用语义（caller .catch warn，不 await 归位） | session-api.ts:68-88 | +2 |
| ui-chat | app/web/src/store/chat-slice.ts | compareSessionsForList() | 新增 | 模块级导出纯函数：`(a: Session, b: Session) => number`——先 pinned 降序（`pinned===true` 前），同组内 `b.updatedAt.localeCompare(a.updatedAt)` | MUST 纯函数无副作用；MUST 用 `=== true` 判 pinned（undefined 安全）；Array.sort 稳定排序保同 updatedAt 插入序 | specs/ui/components/chat-page/_overview.md §4.1 排序契约 | +10 |
| ui-chat | app/web/src/store/chat-slice.ts | setSessions() | 修改 | 写入前 `[...sessions].sort(compareSessionsForList)`（不 mutate 入参） | MUST NOT mutate caller 数组（spread 后 sort） | _overview.md §4.1 | +2 |
| ui-chat | app/web/src/store/chat-slice.ts | applySessionMetaEvent() | 修改 | upsert（map 替换 / unshift 插入）后对结果数组 `sort(compareSessionsForList)` 再 set——原位替换 → 归位重排 | MUST 保留 biz 守卫（:144 studio/academy 拒纳）；MUST 保留整条替换语义（全量 payload 非 diff） | _overview.md §4.1；chat-slice.ts:133-152 | +3 |
| ui-chat | app/web/src/components/chat-page/use-chat-actions.ts | handleTogglePin() | 新增 | `(id: string, pinned: boolean) => void`——`updateSession(id, { pinned }).catch(warn)`；挂入 UseChatActionsReturn | MUST fire-and-forget（无乐观本地更新，归位靠 session_meta 广播 + 比较器）；MUST NOT 直接改 store | use-chat-actions.ts:116-125 handleRenameTitle 先例 | +12 |
| ui-chat | app/web/src/components/chat-page/page-chat.tsx | handleTogglePin 接线 | 修改 | useChatActions 取 handleTogglePin → 传 SectionConvPanel `onTogglePin` prop | MUST 仅 playground page-chat 接线（studio/academy 列表零变化，PRD §6） | PRD v0.0.231 §2.2 | +3 |
| ui-chat | app/web/src/components/chat-page/section-conv-panel.tsx | 右键菜单置顶项 | 修改 | ① ConvPanelProps 加 `onTogglePin?: (id, pinned) => void`；② 菜单在「复制 Session ID」**之上**加置顶项：文案按 `sessions.find(id)?.pinned === true` 派生「取消置顶/置顶」（i18n convPanel.unpin/pin）；③ onClick → `onTogglePin(sessionId, !current)` + 关菜单 | MUST 复用现有浮层（延迟一拍注册关闭，:86-102）；MUST i18n 双语言（禁字面文案）；data-action-key `chat.session.pin` | _overview.md §4.1；memory i18n-key-add-checklist | +22 |
| ui-chat | app/web/src/components/chat-page/component-conversation-item.tsx | pinned 视觉 | 修改 | ① `isPinned = s.pinned === true` 派生；② pin 图标 absolute `top-2 right-2`（PinIcon 12px text-muted）常驻渲染（isPinned 时）；③ 根 className：active → `bg-[var(--surface-3)]`（替换 bg-accent-surface），否则 isPinned → `bg-bg-warm`，否则 `hover:bg-bg-warm`；④ title 行 isPinned 时加 `pr-5` 让位；⑤ unread 红点 `right-2` → `right-[18px]`（统一位移，与 pin 错位共存） | MUST 全走 token（INV-2 禁字面 hex）；MUST absolute 定位 pin（出现/消失零 reflow）；MUST active 保持最强视觉；**文件体量红线：当前 285 行，净增 ≤12 行**（PinIcon 落 icons.tsx，不在本文件内联 SVG） | _overview.md §4.2 pinned 视觉基线 | +12/-2 |
| ui-chat | app/web/src/components/chat-page/icons.tsx | PinIcon() | 新增 | `( { size = 12, ...rest }: IconProps ) => JSX`——图钉 SVG（对齐现有 Icon 函数风格） | MUST 与现有 Icon 函数同签名同风格（icons.tsx:22+）；MUST 无依赖内联 SVG | icons.tsx 现有 18+ Icon 先例 | +8 |
| ui-chat | app/web/src/i18n/locales/zh-CN/chat.json | convPanel.pin / convPanel.unpin | 修改 | convPanel 块加 `"pin": "置顶"` / `"unpin": "取消置顶"` | MUST zh-CN + en 双语同加（parseMissingKeyHandler 会渲染【资源X不存在】）；MUST 渲染走 t() | memory i18n-key-add-checklist | +2 |
| ui-chat | app/web/src/i18n/locales/en/chat.json | convPanel.pin / convPanel.unpin | 修改 | convPanel 块加 `"pin": "Pin"` / `"unpin": "Unpin"` | 同上 | memory i18n-key-add-checklist | +2 |
| test-server | app/server/src/persistence/__tests__/envelope.test.ts | preserveUpdatedAt case | 修改 | 加 case：upsert 更新 + `preserveUpdatedAt:true` → updatedAt 保留 existing、version+1、createdAt 保留；缺省（不传）→ updatedAt 推进（现状回归） | MUST 复用现有 computeEnvelope 纯函数测试模式 | envelope.ts computeEnvelope | +15 |
| test-server | app/server/src/agent/__tests__/session-pinned-field.test.ts | 全文件 | 新增 | UT：① 历史 session（无 pinned 字段）→ toSession 读出 `pinned === false`（lazy default）；② createSession 不传 pinned → 读回 false；③ updateSession `{pinned:true}` 部分更新落盘读回 true；④ updateSession 不传 pinned → 保留原值（不覆盖）；⑤ **pinned-only updateSession → updatedAt 不变**（与写入前一致）；⑥ 含 title 的 patch → updatedAt 仍推进（现状回归） | MUST 对齐 session-effort-approval-fields.test.ts 同款 fixture 模式（tmp dir + 真 store）；case⑤ 写前读一次 updatedAt 作基线断言相等 | session-effort-approval-fields.test.ts 先例；用户裁决 2026-08-01 | +90 |
| test-server | app/server/src/agent/__tests__/session-meta-broadcaster.test.ts | pinned 投影 case | 修改 | 加 case：broadcast 的 SessionMetaView 含 `pinned === true`（pinned session）/ `=== false`（未置顶） | MUST 复用现有 broadcaster fixture | session-meta-broadcaster.ts sessionToMetaView | +15 |
| test-server | app/server/src/handlers/__tests__/session-pinned-put.test.ts | 全文件 | 新增 | UT：① PUT `{pinned:true}` → 200 + 响应 Session.pinned===true + 落盘；② PUT `{pinned:"yes"}`（非 boolean）→ 400；③ PUT pinned 后 metaBroadcaster.broadcast 被调（fake deps 断言）；④ PUT `{}`（无 pinned）→ pinned 不变；⑤ **PUT pinned-only → 响应/落盘 updatedAt 与写前一致**（保 updatedAt 端到端） | MUST 对齐 session-effort-approval-put.test.ts fake-deps 模式（不起真 server） | session-effort-approval-put.test.ts 先例；用户裁决 2026-08-01 | +100 |
| test-web | app/web/src/store/__tests__/chat-slice-sort.test.ts | 全文件 | 新增 | UT：① 比较器：pinned 组在前、组内 updatedAt desc、同 updatedAt 稳定序；② setSessions 乱序入 → 归位；③ applySessionMetaEvent 已存在会话 updatedAt 更新 → 浮到组内顶（原位替换 → 重排）；④ 新会话（无 pinned）插入 → 非置顶组顶；⑤ 置顶会话 meta 更新 → 不跌出置顶组 | MUST 用 createChatSliceStore() 工厂隔离（同现有 UT 模式）；MUST 覆盖 PRD P-A/P-B/P-C 排序不变量 | _overview.md §4.1；chat-slice-meta-broadcast.test.ts 模式 | +90 |
| test-web | app/web/src/store/__tests__/chat-slice-meta-broadcast.test.ts | 重排 case | 修改 | 加 case：meta 广播 pinned false→true → 该会话进置顶组（列表位置变化 + 其余不动） | MUST 不破坏现有 12 case（biz 守卫等） | chat-slice-meta-broadcast.test.ts:47-147 | +20 |

## 影响面评估

- **跨模块**：persistence（PutOptions + computeEnvelope，2 文件小改，缺省行为零变化）+ server-session（store/schema/handler/broadcaster）+ ui-chat（store/组件/i18n）。无 protocol/shared 层改动，无 plugin 改动，无打包护栏触发（不加新依赖、不加 plugin、不加 env 键、不碰 fs 路径）。
- **破坏性变更**：无。pinned lazy-default false 无 migration；GET /session 顺序契约不变；PUT body 新增可选字段（旧 client 不传 → 行为不变）；SessionMetaView 加字段（前端旧 reducer 整条替换天然兼容）；`preserveUpdatedAt` 缺省 false，存量所有 put 调用方行为零变化。
- **依赖顺序**：T1（后端 pinned，含 persistence 2 文件先行）与 T2（前端排序+UI）**可并行**——契约已冻结于 api 04 §2.1/§2.5（本计划书 + architect 已落 spec），T2 编码/UT 不依赖 T1 运行；端到端联调在验证阶段。
- **风险点**：① component-conversation-item.tsx 已 285 行，净增须 ≤12 行（PinIcon 外置 icons.tsx）——review 查体量；② active 背景由 bg-accent-surface(#f4f4f5) 改 bg-[var(--surface-3)](#e4e4e7) 是 conv-item 全局视觉变化（playground 独占组件，studio/academy 不受影响）；③ unread 红点右移 10px（right-2 → right-[18px]）是统一位移，ET 若有位置敏感断言需留意；④ preserveUpdatedAt 是 persistence 契约层新增——`specs/tech/persistence/[P0]crud_store_interface.md` §2.3 由 doc-modifier 阶段 5 同步（本版本先落 change_plan + 代码）。
- **测试口径**：普通 feature 不新增 AT/ET case（PRD §3 裁决）；UT 为主 + 既有 ET 冒烟回归。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

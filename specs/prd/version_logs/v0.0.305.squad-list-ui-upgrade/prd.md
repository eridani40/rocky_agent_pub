# v0.0.305 团队列表 UI 升级（sidebar 视觉 + 排序 + 置顶）— PRD

> version: 1.0 · 引入版本 v0.0.305.squad-list-ui-upgrade · 类型：**Studio sidebar 视觉升级 + 排序/置顶（后端聚合字段 + 纯前端交互）** · 最后更新：2026-08-09
> 权威输入：`reqs/[working] v0.0.305.squad-list-ui-upgrade/req.md`（老板已确认 B 方案）
> 概念权威源（本 PRD 必须对齐，不发明概念）：
> - `specs/ui/components/studio-page/studio-sidebar.md`（sidebar 组件契约，v0.0.168 单行列表）
> - `specs/ui/components/common/member-avatar.md` + `app/web/src/lib/hue-hash.ts`（8 色 hash palette，INV-5 单一实现）
> - `specs/api/overall/11a-squad-endpoints.md §1.2`（SquadSummary 契约）
> - `specs/ui/components/studio-page/component-seats-panel.md` + `use-seats-data.ts`（在线/工作中口径：deployed / busy）
> - 设计稿：`temp/sidebar-design-options.html` **Option B**（彩色字母头像 + 两行）

## 目录

| 章节 | 文件 | 说明 |
|------|------|------|
| §1 目标 + 动机 | 本文 | sidebar 从「图标+名字+数字」升级为「彩色头像+两行状态」 |
| §2 范围 | 本文 | 前端 sidebar 视觉/排序/置顶 + 后端 GET /squad 聚合字段 |
| §3 视觉契约 | 本文 | B 方案对齐（32×32 头像 / 两行 / 选中态 / 脉冲点） |
| §4 数据契约 | 本文 | onlineCount / inProgressCount / lastActiveAt 来源与格式 |
| §5 排序 + 置顶 | 本文 | lastActiveAt desc + localStorage pin |
| §6 边界情况 | 本文 | 无 squad / 全离线 / 置顶多个 / 旧后端降级 |
| §7 关键用户路径（MANDATORY） | 本文 | 打开 studio → 列表 → 置顶 → 刷新保持 |
| §8 PRD ↔ ui/tech spec 对齐 | 本文 | 引用已有概念，不发明 |

---

## 1. 目标 + 动机

### 1.1 问题

Studio 左 sidebar 当前 squad 行只有「accent 图标 + 16px 名字 + 成员数灰色徽章」——信息密度低：看不出团队在线状态、活跃程度，多个 squad 时无法快速识别常用团队；列表固定按 `updatedAt` desc，无用户控制。

### 1.2 目标（老板已确认 B 方案）

1. **视觉升级**：彩色字母头像（32×32 方块圆角）+ 两行布局（团队名 / 「X 在线 · Y 工作中」）
2. **排序**：按「成员最后会话时间」倒序（最新活跃的 squad 排前面）
3. **置顶**：支持 pin 住常用 squad（localStorage 持久化，置顶排最前不受时间排序影响）

---

## 2. 范围

### 2.1 四件事

1. **后端 squad 聚合服务**：`SquadSummary` 加 3 个字段——`onlineCount` / `inProgressCount` / `lastActiveAt`（聚合每个 squad 的 members + sessions；见 §4.1-4.2 契约）；**聚合计算收敛为后端单一服务 `squad-aggregate-service`**（GET 列表 + SSE 推送共用同一计算函数）
2. **后端 squad 聚合 SSE**：新增 `squad_meta` topic（广播 `_all`），squad 聚合状态变化时实时推送（见 §4.4）
3. **前端 sidebar 视觉升级**：`section-studio-sidebar.tsx` SquadRow 重做——彩色字母头像（复用 hue-hash + MemberAvatar 同源 palette）+ 两行布局 + 选中态（见 §3）
4. **前端排序 + 置顶**：按 `lastActiveAt` desc 排序（置顶优先），pin 按钮 hover 显隐，localStorage 持久化（见 §5）

### 2.2 明确不做（边界）

- **不改 seats 面板的 member 粒度展示**：坐席卡/成员列表仍走 `use-seats-data.ts` + stateMap（member 级 presence 需要 session 粒度数据）；**但「在线数/工作中数」统计数字统一消费 squad 聚合数据**（见 §4.3，避免各自算各自）
- **不改 SquadDetail**：详情接口不加字段（仅列表聚合）
- **不改 squad/member schema**：`lastActiveAt` 是**派生字段**（读 sessions 算 max），不落库；聚合状态内存维护（重启后 GET /squad 全量重算兜底）
- **不做拖拽排序 / 分组**：只有 pin 置顶 + 时间倒序两档
- **不做聚合数据持久化**：squad 聚合是实时派生状态（内存 + 每次计算），不写盘（session/member 是持久权威源，聚合可从它们重算）

---

## 3. 视觉契约（B 方案）

> 对齐 `temp/sidebar-design-options.html` Option B + 老板口头修正（15px 半粗 / 橙色脉冲圆点）。

### 3.1 行布局（SquadRow）

```
┌──────────────────────────────────────┐
│ [头像32] 团队名        (15px semibold) │
│          X 在线 · ●Y 工作中 (11px muted)│
└──────────────────────────────────────┘
```

- **容器**：`px-2.5 py-2 rounded-lg` + 选中 `bg-accent-surface` / hover `bg-bg-warm`（沿用现有基线）
- **头像**：32×32（`h-8 w-8`）圆角 8px（`rounded-lg`），团队名**首字符**（trim 后 charAt(0)，中文取首字、英文取首字母大写；空名兜底 `#`），白字 14px font-bold，底色 = `hashHueIndex(squad.id)` 8 色 palette（`var(--hue-{name})`，复用 hue-hash 单例，INV-5 不重复实现）
- **第一行**：团队名 15px `font-semibold`，`truncate`；选中态 `text-accent`（沿用现有）
- **第二行**：`X 在线 · Y 工作中` 11px `text-muted`（i18n 文案，见 §3.3）
  - **Y > 0 时**：「工作中」数字前加**橙色脉冲圆点动画**（8px 圆点 `bg-orange` + `animate-pulse`，`aria-hidden`；仅视觉装饰不参与布局——圆点与数字同行 inline，不导致位移）
- **行高**：两行布局 ~48px（`py-2`），与原单行 `py-3` 视觉高度近似，不追求像素相等（整体视觉升级）

### 3.2 pin 按钮

- **位置**：行右侧（第二行同侧），hover 行时可见；pin 态 = 实心 pin 图标 accent，未 pin = 空心 muted
- **布局稳定性（MANDATORY）**：按钮用 `visibility: hidden` 预留槽位（恒占位不位移），禁 `display:none` 入常规流（对齐 §2.3 布局稳定性铁律）
- **交互**：点击 toggle pin → 写 localStorage + 立即重排（置顶组最前）；不弹确认、不进选中（点击 pin 按钮不触发 onSelectSquad）

### 3.3 i18n

`studio` ns 新增 key（zh/en 双语）：
- `sidebar.status`：`{{online}} 在线 · {{working}} 工作中`
- `sidebar.pin` / `sidebar.unpin`：pin 按钮 aria-label（`置顶` / `取消置顶`）

---

## 4. 数据契约

### 4.1 字段定义（GET /squad → SquadSummary 增量，全部 optional）

```typescript
interface SquadSummary {
  // ... 现有字段不变 ...
  /** [v0.0.305] 在线成员数 = member.state==='deployed' 的成员数（与 seats onlineCount 同口径） */
  onlineCount?: number;
  /** [v0.0.305] 工作中数 = 该 squad 全 session（squadChat + leader + mates）state∈{running,interrupting,suspended} 数（与 seats inProgressCount 同口径） */
  inProgressCount?: number;
  /** [v0.0.305] 成员最后会话时间 = max(squadChatSession.updatedAt, 各 member session.updatedAt)；无 session 时 fallback squad.updatedAt */
  lastActiveAt?: string;
}
```

**语义说明**：
- **在线 = deployed**（在岗成员数，非 session running 数）——与 `use-seats-data.ts:194` `onlineCount = members.filter(deployed).length` 完全一致
- **工作中 = busy**（session state ∈ running/interrupting/suspended）——与 `deriveInProgressCount` 一致（squadChatSessionId + members[].sessionId 全算）
- **lastActiveAt**：成员最后会话时间 = 该 squad 关联 sessions 的 `updatedAt` 最大值（`sessionStore.listSessionsBySquad(squadId)` 已存在，server `session-store.ts:174`）；无任何 session → fallback `squad.updatedAt`（保证恒有值可排序）

### 4.2 后端实现要点（交 architect 细化）

- **新增 `squad-aggregate-service`**（squad 层组件）：单一函数 `computeSquadAggregate(squadId)` → `{ onlineCount, inProgressCount, lastActiveAt }`
  - 数据源：`squadStore.getSquad` + `memberStore.listMembers` + `sessionStore.listSessionsBySquad(squadId)`（`session-store.ts:174` 已存在）
  - **GET 列表与 SSE 推送共用同一函数**（统一口径，杜绝两处算两套）
- `handleListSquads`（`handlers/squad.ts:376`）调聚合服务补 3 字段
- **性能**：squad 数量预期小（不分页），N+1 可接受；或一次 `sessionStore.listSessions({biz:'studio'})` 内存聚合（架构师定）
- **向后兼容**：字段 optional；旧前端忽略新字段无感知

### 4.3 前端消费（统一数据源）

- `squad-api.ts listSquads()` 返回类型同步加 3 字段（类型 optional）
- 排序键：`lastActiveAt ?? updatedAt`（旧后端无字段 → 降级按 updatedAt，行为同现状）
- **sidebar 与 seats 统计数字统一消费 squad 聚合数据**（leader 要求：统一设计，不各自算各自）：
  - sidebar 每行 = `SquadSummary.onlineCount / inProgressCount`（SSE 更新见 §4.4）
  - seats 面板头部统计条 = 同一聚合数据源（`squad_meta` 订阅或 GET /squad 同源）；member 粒度坐席卡仍走 stateMap（粒度不同，不冲突）

---

## 4.4 SSE 实时推送（squad 聚合状态）

> 老板明确要求「要做 SSE」。参考现有模式：`session_meta`（广播 `_all`，全量 payload，replayable=false）+ `session_todo_changed`（轻量信号）。**本版本采用「全量 payload 广播」模式**（同 session_meta）：数据量小（每 squad 3 个数字），推全量让前端直接渲染，省一次 refetch。

### 4.4.1 事件契约

| 项 | 值 |
|----|-----|
| **topic** | `squad_meta`（新增，加入 SSE 白名单 `handlers/sse.ts:19 ALLOWED_TOPICS`） |
| **group** | `_all`（共享广播 group，同 session_meta §10.2 模式） |
| **replayable** | `false`（快照态；初始态走 GET /squad 拉全量，订阅后只收增量——同 session_meta §10.3 理由） |
| **事件类型** | `squad_meta_update`（唯一事件类型） |
| **data** | 全量聚合 payload（非 diff，reducer 整条替换） |

```typescript
interface SquadMetaUpdateEvent {
  id: string;                    // 事件自身 ULID
  type: 'squad_meta_update';
  squadId: string;               // 变更的 squad（与 data.squadId 一致）
  createdAt: string;             // ISO 8601 UTC
  data: {
    squadId: string;
    onlineCount: number;         // member.state==='deployed' 数
    inProgressCount: number;     // busy session 数（running/interrupting/suspended）
    lastActiveAt: string;        // max(session.updatedAt) ?? squad.updatedAt
  };
}
```

**触发方**：`SquadMetaBroadcaster`（新 squad 层组件，仿 SessionMetaBroadcaster 同构）——收到变化信号 → 调 `computeSquadAggregate(squadId)` → emit 到 `(squad_meta, _all)`。

### 4.4.2 后端聚合触发时机（什么操作触发重新计算）

| 触发源 | 触发点 | 说明 |
|--------|--------|------|
| **session 状态变化** | `session_status_update` / `session_usage_update` / `summary_task_update` 等（经 statusBus） | 复用 SessionMetaBroadcaster 的 statusBus wrap 捕获，按 `session.squadId` 路由到对应 squad 重算（**studio session 才触发**；playground session 无 squadId 跳过） |
| **member 增删/状态变化** | hire / bench / deploy / delete member 写成功后 | squad handler 层显式调 `squadMetaBroadcaster.broadcast(squadId)` |
| **squad 建/删** | POST /squad / DELETE /squad 写成功后 | 建 = 推送新 squad 聚合；删 = 推送删除信号（或前端靠 GET /squad 全量刷新兜底） |
| **新会话产生** | 群聊/单聊 session create | 归属 squad 的 session 创建后重算（lastActiveAt 可能变） |

**触发纪律（对齐 session_meta 硬约束）**：
- **状态机 + agent-loop 不感知 squad_meta / 不调 broadcaster**——broadcaster 是 squad 层组件（仿 SessionMetaBroadcaster 订阅 statusBus 自治）
- **同步语义**：触发方必须 await 落盘后再调 broadcast（否则重读到旧值广播错值，v0.0.163 unread red-dot race 教训）

### 4.4.3 前端订阅方式（sidebar + seats 统一）

- **新增 `useSquadMeta` hook**（`useLifecycle` 封装，仿 `useStudioUnreadMeta`）：
  - `onInit`：`subscribe('squad_meta', '_all')` + 初始态由父级 GET /squad 提供
  - `onEvent`：`squad_meta_update` → 按 `data.squadId` 整条替换本地 `Record<squadId, SquadAggregate>`
  - 暴露 `aggregateMap: Record<string, { onlineCount, inProgressCount, lastActiveAt }>`
- **sidebar（`section-studio-sidebar.tsx`）**：消费 `aggregateMap[squad.id]`，SSE 到达即更新行内数字 + 触发重排（lastActiveAt 变 → 活跃序变）
- **seats 面板统计条**：复用同一 `useSquadMeta`（数据源统一，不各自订阅各自 topic）
- **订阅时机**：page-studio 挂载时订阅一次（sidebar + seats 共用，非每组件各自订阅——G1 单例 + 统一 hook）

### 4.4.4 统一数据源设计（单例 vs 每组件订阅）

**方案：page-studio 级单例订阅 + Context/Props 下发**（不是每组件各自订阅）：

```
page-studio（useSquadMeta 订阅一次，持 aggregateMap）
  ├── StudioSidebar（props 传 aggregateMap → 行内数字 + 排序）
  └── SeatsPanel（props 传 aggregateMap → 统计条）
```

理由：
- **避免 N 个组件各自 subscribe 同 topic**（SSE 连接复用但 handler 重复、状态分裂）
- 对齐现有模式：`useStudioUnreadMeta` 就是 page-studio 级单例，sidebar/seats 经 props 消费
- 数据唯一归 page-studio ctx（useLifecycle 契约），组件不持业务态

---

## 5. 排序 + 置顶

### 5.1 排序规则（前端统一）

```
排序 = [置顶组（pin 顺序，最后 pin 的在前）] + [非置顶组（lastActiveAt desc）]
```

- **置顶组**：localStorage `studio.squadPins` = `squadId[]`（顺序 = pin 操作顺序，新 pin 插入头部）；置顶组内部**也按 lastActiveAt desc**（需求「置顶排最前不受时间排序影响」指置顶组整体在最前，组内仍按活跃排序）
- **非置顶组**：`lastActiveAt`（缺失 fallback `updatedAt`）desc
- **未知 squadId 清理**：localStorage 里的 id 不在当前 squads 列表 → 渲染时忽略（不写回，惰性清理）

### 5.2 localStorage 契约

| key | 值 | 说明 |
|-----|-----|------|
| `studio.squadPins` | `string[]`（squadId 数组） | JSON 数组；解析失败/非法 → 视为 `[]`（不 crash） |

- 读写封装：sidebar 内部小 util（或 `lib/studio-pins.ts`），纯前端无后端
- **不跟随 squads 列表整体持久化**：只存 id 集合，squad 删除后残留 id 渲染时忽略

---

## 6. 边界情况

| 场景 | 行为 |
|------|------|
| **无 squad** | 现有 empty 文案不变（`sidebar.empty`） |
| **全部离线** | 每行显示 `0 在线 · 0 工作中`；无脉冲点（Y=0） |
| **Y=0** | 第二行 `X 在线 · 0 工作中`，无橙色脉冲点 |
| **Y>0** | 橙色脉冲圆点出现在「Y 工作中」数字前（inline，不影响布局） |
| **置顶多个** | 全部置顶排最前（组内按活跃 desc）；pin 按钮各自独立 toggle |
| **全部置顶 / 全部不置顶** | 无特殊处理，走通用排序 |
| **旧后端（无 3 新字段）** | 排序降级 `updatedAt` desc（= 现状）；第二行 onlineCount/inProgressCount undefined → 不渲染第二行，仅名字（或显 `–`）；**不 crash** |
| **旧后端（无 squad_meta SSE）** | `useSquadMeta` 订阅失败/无事件 → 静默降级：数字只靠 GET /squad 初始值，无实时更新；**不 crash** |
| **SSE 断连重连** | 复用 SseClient 既有重连机制；重连后 `squad_meta` 非 replayable → 前端靠 `reloadSquads()` 全量拉一次兜底（对齐 session_meta §10.3 模式） |
| **localStorage 损坏** | `JSON.parse` 失败 → 空数组，正常渲染 |
| **pin 的 squad 被删除** | 残留 id 渲染时忽略（列表不显示），不主动清 localStorage |
| **超长团队名** | 第一行 `truncate`；第二行不受影响 |
| **playground session 变化** | 无 squadId → 不触发 squad 聚合重算（后端跳过），前端收不到无关推送 |

---

## 7. 关键用户路径（MANDATORY — 测试最低覆盖）

### 路径 1：查看升级后的团队列表

- 链路：打开 Studio → sidebar 渲染 squad 列表
- 关键断言：每行 = 32×32 彩色字母头像（hash 配色稳定）+ 团队名 15px 半粗 + 第二行「X 在线 · Y 工作中」；选中行 accent 高亮

### 路径 2：活跃排序

- 链路：两个 squad，A 的成员最后会话比 B 新 → 列表 A 在 B 前
- 关键断言：排序按 lastActiveAt desc（旧后端降级 updatedAt desc）

### 路径 3：置顶 + 刷新保持

- 链路：hover 行 → 点 pin 按钮 → 该 squad 跳到列表最前 → 刷新页面 → 仍在最前
- 关键断言：pin 写 localStorage；刷新后置顶组在最前；pin 按钮显示置顶态

### 路径 4：取消置顶

- 链路：已置顶 squad → hover 点 pin（取消）→ 回到按活跃排序的位置
- 关键断言：localStorage 移除 id；列表重排

### 路径 5：工作中脉冲点

- 链路：某 squad 有成员 session running → 列表该行第二行「Y 工作中」数字前有橙色脉冲圆点
- 关键断言：Y>0 显示脉冲点；Y=0 不显示

### 路径 6：SSE 实时状态更新（新增）

- 链路：Studio 开着 → 某 squad 成员 session 变 running（或成员被 bench/deploy）→ sidebar 该行「X 在线 · Y 工作中」**无需刷新自动更新**
- 关键断言：后端收到 session 状态变化 → 重算 squad 聚合 → 推 `squad_meta_update` → 前端行内数字实时更新；Y 从 0→1 时脉冲点出现
- **seats 面板统计条**：同一事件源 → 统计条数字同步更新（统一数据源验证）

### 路径 7：SSE 断连恢复（新增）

- 链路：SSE 断连 → 重连成功 → 重新拉 GET /squad
- 关键断言：重连后 `squad_meta` 非 replayable → 前端 reloadSquads() 全量兜底，数字恢复一致（对齐 session_meta §10.3）

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开 Studio → 看 sidebar squad 列表 | 每行彩色字母头像（32×32 圆角）+ 团队名 + 两行状态；无布局错乱 |
| UC-2 | hover squad 行 → 点 pin 按钮 | 该 squad 跳到列表最前；pin 图标变实心 |
| UC-3 | 刷新页面 → 看列表 | 置顶 squad 仍在最前（localStorage 保持） |
| UC-4 | 置顶 squad hover 点 pin（取消） | 回到按活跃排序的位置；图标变空心 |
| UC-5 | 有成员 running 的 squad | 第二行「Y 工作中」数字前出现橙色脉冲圆点动画 |
| UC-6 | 选中 squad 行 | 行 accent 背景高亮 + 团队名 accent 色（选中态不因置顶/排序变化丢失） |
| UC-7 | Studio 开着 → 成员 session 状态变化（后台跑起/结束） | sidebar 该行数字**自动更新**（不刷新页面）；Y 0→1 时脉冲点出现 |
| UC-8 | Studio 开着 → bench 一个 member | 该 squad 在线数实时 -1（SSE 推送） |
| UC-9 | Studio 开着 → 打开 seats 首页 | 统计条数字与 sidebar 同源一致（同一 SSE 数据） |

---

## 8. PRD ↔ ui/tech spec 对齐

| PRD 引用概念 | 权威来源 | 对齐状态 |
|---|---|---|
| 8 色 hash palette | `lib/hue-hash.ts`（INV-5 单一实现） | ✅ 头像底色复用 `hashHueIndex(id)`，不重复实现 |
| 彩色字母头像 | `common/member-avatar.tsx`（leader/mate hash 派生） | ✅ 同源视觉语言；squad 场景不用 brand-grad 渐变（B 方案要彩色方块，用 hash 色） |
| 在线/工作中口径 | `use-seats-data.ts` derivePresence/deriveInProgressCount | ✅ onlineCount=deployed / inProgressCount=busy 同口径 |
| SquadSummary 契约 | `11a-squad-endpoints.md §1.2` | ✅ 增量 optional 字段，向后兼容 |
| session 聚合 | `session-store.ts listSessionsBySquad` | ✅ 已有方法，直接复用 |
| sidebar 组件契约 | `studio-sidebar.md` | ✅ Props 不变（squads/selectedSquadId/onSelectSquad/onNewSquad），视觉基线升级 |
| 布局稳定性 | `specs/ui/regulation/03-principles.md`（§2.3 铁律） | ✅ pin 按钮 visibility hidden 预留槽位 |
| 置顶交互参考 | playground conv-item pin（v0.0.231 session pinned） | ⚠️ **差异**：playground 置顶走后端 session.pinned；本版本 squad 置顶按需求走 **localStorage**（squad 列表无后端 pin 概念，不引入 schema 变更） |
| SSE 广播模式 | `session_meta`（`sse_channel.md §10` + `session-meta-broadcaster.ts`） | ✅ squad_meta 同构：topic + `_all` 广播 group + 全量 payload + replayable=false + broadcaster 自治订阅 statusBus |
| SSE 白名单 | `handlers/sse.ts:19 ALLOWED_TOPICS` | ✅ 新增 `squad_meta` 加入白名单 + 双向对齐断言（`sse-topic-whitelist.test.ts`） |
| 前端订阅模式 | `useStudioUnreadMeta`（page-studio 级单例 + useLifecycle） | ✅ `useSquadMeta` 同构：page-studio 订阅一次，sidebar/seats props 消费 |
| 聚合计算 | `session-store.ts listSessionsBySquad` | ✅ 已有方法，聚合服务复用 |

**无新概念发明**：三个新字段是既有数据的派生聚合；pin 交互复用既有 hover 显隐按钮模式；squad_meta SSE 是 session_meta 广播模式的 squad 层同构（topic + broadcaster 均仿既有组件，不造新传输机制）。

---

## 9. 验收标准

1. ✅ sidebar squad 行 = 彩色字母头像（32×32 圆角，hash 稳定配色）+ 团队名 15px 半粗 + 第二行「X 在线 · Y 工作中」11px 灰
2. ✅ Y>0 时「工作中」数字前有橙色脉冲圆点动画；Y=0 无
3. ✅ 列表按 lastActiveAt desc 排序（置顶组最前）
4. ✅ pin 按钮 hover 显隐 + 点击置顶/取消 + localStorage 持久化 + 刷新保持
5. ✅ 选中态 accent 高亮不受排序/置顶影响
6. ✅ 旧后端（无新字段）降级：排序按 updatedAt、第二行不渲染、不 crash
7. ✅ 布局稳定性：pin 按钮出现/消失不导致行内位移
8. ✅ 后端 GET /squad 返回 3 个 optional 聚合字段；向后兼容
9. ✅ 后端 `squad_meta` topic（`_all` 广播）注册 + 进 SSE 白名单 + 双向对齐断言
10. ✅ session 状态变化 / member 增删 / squad 建删 → 后端重算 squad 聚合 → 推 `squad_meta_update`（全量 payload）
11. ✅ 前端 `useSquadMeta`（page-studio 级单例）订阅 `squad_meta` → sidebar 行内数字实时更新 + 重排
12. ✅ seats 统计条与 sidebar 同源消费同一聚合数据（统一数据源，不各自算各自）
13. ✅ SSE 断连重连后 reloadSquads() 全量兜底，数字恢复一致

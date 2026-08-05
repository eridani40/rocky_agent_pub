# v0.0.192.delete_cleanup 变更计划书 — 删除链路修正（保留工作数据 + 级联删子孙 session + 清调度）

> **method 级 review 合同**。架构期冻结：planner/coder 按本表切 task 与实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 权威上游：
> - `reqs/[working] v0.0.192.delete_cleanup/req.md`（需求 N1-N4 + 决策原则 + 删除分类）
> - `specs/prd/version_logs/v0.0.192.delete_cleanup.md`（行为契约 + 关键用户路径 A/B/C）
> - `states/v0.0.192.delete_cleanup/context.md`（调查结论 + 数据落点 file:line）

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 根相对） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 核心设计（供 reviewer 理解全局）

1. **N1（保留工作产出）**：dissolveSquad 第④步 `rmSync(squadRootDir, recursive)` 整个目录连根删 → 改为调 `deleteSquadAdministrativeSubpaths(root, squadId)`，只精确 rmSync 管理性子路径（`members/` `charter_history/` `panorama/` `.rocky_squad/` 四目录 + `charter.md` `index.md` `log.md` 三文件），**保留** `workspaces/` `outputs/` `reports/` `board/`（用户工作产出）。判据=用户能看懂的产出留 / 程序才懂的内部数据删（req 决策原则）。
2. **N2（children 级联删）**：
   - **squad 侧**：step②不再枚举 `squadChatSessionId + members[].sessionId`（漏 spawn children），改用 `listSessionsBySquad(squadId)` 平铺查询（按 `Session.squadId` 字段过滤，catch 全部 squad session 含任意深度 spawn child，且不受 parentSessionId 链完整性影响——orphan 也兜住）。
   - **playground 侧**：`handleSessionItem` DELETE 分支补 `collectDescendants(id)` BFS（基于 childrenIndex 递归展开 parent→[child] 任意深度），删 parent 前先快照全部子孙。
   - 两路最终都逐个走 `sessionStore.deleteSession(sid)`（既有：删 record + rm `sessions/{sid}/` + 触发 `onSessionDestroyed`）。
3. **N3（清潜伏调度）**：不写新触发代码——既有 `sessionStoreDeleteSession` 末尾已 `await store.onSessionDestroyed?.(sid)`（session-store-core-impl.ts:296），boot.ts:259 wire 到 `cronStore.removeAllJobs + engine.unregister`。只要 N2 的级联逐个走 deleteSession，每个 descendant 的内存 cron 自动注销。堵住「删 parent 后 child cron 继续烧 token」。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_store | app/server/src/stores/squad-store.ts | deleteSquadAdministrativeSubpaths(root, squadId) | 新增 | 解散时删办公室管理性子路径：rmSync `members/` `charter_history/` `panorama/` `.rocky_squad/` 四目录 + `charter.md` `index.md` `log.md` 三文件（均 force:true 幂等，缺失不报错）。与 `ensureSquadDirSkeleton`/`squadRootDir` 同文件对称（建骨架 vs 删管理性数据）。 | MUST 保留 `workspaces/` `outputs/` `reports/` `board/`（用户工作产出铁律，req 决策原则）；MUST NOT rmSync 整个 squadRootDir；MUST NOT 删过程数据；subpath 用 `join(squadRootDir, sub)` 精确拼接（BUG-004：root 由 caller 展开为绝对路径，禁字面 `~`） | req §N1/决策原则；specs/tech/squad/[P1]squad_workspace.md §1/§2；specs/tech/squad/[P1]squad_okf.md §3（index.md/log.md/charter.md 三主面）；okf-helper.ts:28 `okfRoot` 证实三文件在 squads/{id}/ 根 | +28 |
| session_store | app/server/src/agent/session-children-index.ts | ChildrenIndex.collectDescendants(parent) | 新增 | 纯 BFS 收集 parent 的全部子孙 id（任意深度）：从 parent 起，依 `idx.get(p)` 逐层展开 child set，用 visited Set 去环防重，返回 `string[]`（不含 parent 自身）。索引未建（idx==null）时返 `[]`。 | MUST 为纯索引操作（不读 crud / 不做 I/O）；MUST 用 visited Set 防环（理论无环 parentSessionId，但防御）；MUST NOT 改 onDeleted 语义（仍只清 parent 自己的 set，不级联——级联由 caller 用本方法快照后逐个 deleteSession 完成）；parent 无 children 返 `[]` | specs/tech/multi_agent/[P1]subagent_derivation.md §7；session-children-index.ts:17「不级联删」注释（本方法补级联收集能力，不改既有 onDeleted） | +22 |
| session_store | app/server/src/agent/session-store-children-impl.ts | sessionStoreCollectDescendants(store, parentId) | 新增 | SessionStore.collectDescendants 的 impl：若 `!store.childrenIndex.isReady` 先 warm（crud.query(SessionSchema) 全量 build，与 sessionStoreListChildren 同款 lazy 建）→ 调 `store.childrenIndex.collectDescendants(parentId)` 返回全部子孙 id。 | MUST warm 后再查（否则 idx==null 返空漏删）；MUST 复用既有 build 路径（不重复扫描逻辑）；返回 `string[]`（子孙 only，不含 parent）；空数组合法（无 children） | session-store-children-impl.ts:45-52（listChildren 的 warm 模式，照抄）；session-store.ts:84 childrenIndex readonly | +18 |
| session_store | app/server/src/agent/session-store-children-impl.ts | sessionStoreListSessionsBySquad(store, squadId) | 新增 | SessionStore.listSessionsBySquad 的 impl：调 `sessionStoreListSessions(store)`（无 filter，取全量）→ `.filter(s => s.squadId === squadId).map(s => s.id)`。squad 解散时一次性 catch 全部 squad session（含 spawn child，agent-tool.ts:318 child record 带 squadId）。 | MUST 在删任何 session 前一次性快照（删后 listSessions 不返）；MUST NOT 漏带 squadId 的 spawn child；O(N) 扫描可接受（解散一次性低频操作）；返回 `string[]`（sessionId 列表） | req §N2「按 squadId 查全量 session」；session-store-types.ts:173 `Session.squadId?`；agent-tool.ts:318 spawn child 带 squadId；session-store-core-impl.ts:235 `sessionStoreListSessions` | +12 |
| session_store | app/server/src/agent/session-store.ts | SessionStore.collectDescendants(id) | 修改 | facade 新增 delegate 方法（3 行：注释+签名+`return sessionStoreCollectDescendants(this, id)`）。DELETE /session 级联删用。 | MUST 单行委托 impl（INV-S-3 对齐已有 delegate 模式）；MUST NOT 内联 BFS 逻辑；MUST NOT 改 deleteSession 签名（cascade 在 caller 编排，保持 deleteSession 单点语义） | session-store.ts:144/149/154 既有 delegate 模式 | +6 |
| session_store | app/server/src/agent/session-store.ts | SessionStore.listSessionsBySquad(squadId) | 修改 | facade 新增 delegate 方法（3 行：注释+签名+`return sessionStoreListSessionsBySquad(this, squadId)`）。dissolveSquad squad 侧级联用。 | MUST 单行委托 impl；返回 `Promise<string[]>`（sessionId 列表）；MUST NOT 加 biz/role 过滤（squadId 已足够界定范围） | session-store.ts:144 既有 listSessions delegate | +6 |
| squad_dissolve | app/server/src/squad/squad-dissolve.ts | DissolveSquadDeps | 修改 | sessionStore dep 类型扩 `{ deleteSession }` → `{ deleteSession; listSessionsBySquad }`；移除 memberStore（不再用于枚举 session，改 listSessionsBySquad 平铺查）；squadStore 仍保留 getSquad/deleteSquad。 | MUST 保留 squadRuntime/sessionStore/squadStore/dataDir 四项；MUST NOT 保留 memberStore（避免死代码——req「不遗留死代码」原则）；UT mock 同步更新 | req §N2；squad-dissolve.ts:19-34 现状 | +3/-4 |
| squad_dissolve | app/server/src/squad/squad-dissolve.ts | dissolveSquad(deps) | 修改 | step②改：`sessionIds = await sessionStore.listSessionsBySquad(squadId)`（catch 全部 squad session 含 children），不再读 squadChatSessionId/members；step④改：`rmSync(squadRootDir,...)` → `deleteSquadAdministrativeSubpaths(dataDir, squadId)`。step①（disposeSquad）/step③（deleteSquad）顺序不变。会话快照仍须在 step③ deleteSquad 前完成（listSessionsBySquad 不依赖 squad record，但删 session 后 listSessions 不返，故先快照）。 | MUST 顺序不变 ①disposeSquad→②deleteSession(各)→③deleteSquad→④删管理性子路径（teardown 必须先于删数据，防潜伏调度）；MUST NOT 再 rmSync 整个 squadRootDir；MUST 用 listSessionsBySquad（不用旧 squadChatSessionId+members 枚举，漏 children）；每个 descendant 走 deleteSession（自动触发 onSessionDestroyed→N3） | req §N1/§N2/§N3；squad-dissolve.ts:40-62 现状；PRD §3.1/§3.2；specs/tech/scheduling/[P1]cron_subsystem.md §8 | +12/-15 |
| session_handler | app/server/src/handlers/session.ts | handleSessionItem（DELETE 分支） | 修改 | DELETE 分支补级联：现有 `getSession` 存在校验后、`deleteSession(id)` 前，插入 `const descendants = await deps.store.collectDescendants(id); for (const sid of descendants) await deps.store.deleteSession(sid);`——子孙先删（每个触发 onSessionDestroyed→清内存 cron），parent 最后 `deleteSession(id)`（既有行）。快照须在删任何 session 前（collectDescendants 读 childrenIndex，删 parent 后 idx 失效）。recycleSession/disconnect 仍只针对 parent id（tab/连接器是 parent 维度，子孙无独立 tab）。 | MUST collectDescendants 在任何 deleteSession 之前调用（否则 childrenIndex.onDeleted 清掉 child set 后查空）；MUST 子孙 + parent 全走 deleteSession（堵潜伏调度，PRD §3.2）；MUST NOT 漏最深子孙（BFS 任意深度）；recycleSession/disconnect 仍仅 parent（行为不变） | req §N2/§N3；PRD §3.2；handlers/session.ts:233-247 现状；session-children-index.ts:60 onDeleted 清 parent set 语义 | +10 |
| squad_dissolve | app/server/src/squad/__tests__/squad-dissolve.test.ts | （UT 用例调整） | 修改 | 既有用例「办公室目录被物理删除」断言反转：办公室目录 `existsSync` 改 `toBe(true)`（保留），新增断言 `workspaces/outputs/reports/board` 存活 + `members/charter.md/.rocky_squad/panorama/charter_history/index.md/log.md` 已删；调用序用例的 memberStore mock 改 listSessionsBySquad mock（sessionStore 上）；「teardown 先于删 session」用例保留（顺序不变）。 | MUST 验「保留 workspaces/outputs/reports/board」+「删管理性子项」双断言（PRD §5 验收口径 1）；MUST NOT 保留旧 `existsSync(officeDir)=false` 断言；调用序断言仍校 ①dispose→②deleteSession→③deleteSquad（④不再整目录删） | PRD §5 验收口径 1；req §N1 | +30/-12 |
| session_store | app/server/src/agent/__tests__/session-cascade.test.ts（新文件，名 coder 定位） | （新 UT：级联收集 + squadId 查询） | 新增 | 覆盖：①collectDescendants BFS 多层（A→B→C，删 A 收集 [B,C]）+ 环防御 + 无 children 返空；②listSessionsBySquad 过滤正确（含 spawn child 带 squadId、排除其他 squad）；③DELETE /session 级联每 descendant 触发 onSessionDestroyed（mock onSessionDestroyed 计数 = descendants.length + 1）。 | MUST 覆盖 PRD §3.2 任意深度级联 + §验收口径 2/3；MUST 断言 onSessionDestroyed 触发次数（验 N3 潜伏调度已堵） | PRD §3.2/§5 验收口径 2/3；req §N2/§N3 | +120 |

## 影响面评估

- **跨模块**：squad（squad-dissolve + squad-store）、session_store（children-index + children-impl + facade）、session_handler。三模块通过 SessionStore facade 新方法（collectDescendants / listSessionsBySquad）解耦——handler/dissolve 只依赖 facade，不直触 childrenIndex。
- **依赖顺序**：底层（ChildrenIndex.collectDescendants + impl 函数）→ facade delegate → 上层（dissolveSquad / handleSessionItem）。无 protocol/sdk 改动（纯 server 内部）。
- **破坏性变更**：
  - `dissolveSquad` deps 结构变（drop memberStore、sessionStore 加 listSessionsBySquad）——唯一 caller `handleDeleteSquad` 同步更新（handlers/squad.ts:412），无外部 API 契约变化。
  - DELETE /session 行为变化：现在级联删子孙——这是本版本要修的 bug（PRD §3.2），属期望行为变化，无向下兼容问题（既有客户端不会依赖「孤儿残留」）。
- **文件体量**（300 行阈值）：
  - session-store.ts 当前 328 行（**pre-existing 超阈值**，v0.0.156 拆分遗留）+12 → ~340。coder 须自检：若 reviewer 打回，可把 listChildren 等已有 delegate 合并瘦身（非本版本范围，但允许顺手减行）。
  - session-store-core-impl.ts 306 行（pre-existing 超阈值）——本版本**不动**（新方法落 children-impl.ts）。
  - 其余文件（squad-dissolve 62、squad-store 223、children-index 79、children-impl 94）均在阈值内。
- **packaged 护栏**：`deleteSquadAdministrativeSubpaths` 走 `squadRootDir(dataDir,...)` 绝对路径（dataDir 由 caller 展开，config.resolveDataDir 单一权威）；不读 process.env；不拼字面 `~`。符合 BUG-004。
- **风险点**：①collectDescendants 调用时序（必须先于 deleteSession，否则 idx 被清）——UT 须覆盖；②listSessionsBySquad 性能 O(N) 解散低频可接受；③旧 squad 若有 session 遗漏 squadId 字段（历史数据）会漏删——但 squadId 字段自 v0.0.33.2 起随 spawn 一致写入，风险低。

## doc-sync 待办（architect 识别的 spec 偏离，doc-modifier 阶段 5 处理）

- **`specs/tech/squad/[P1]squad_workspace.md`** 未定义「解散时哪些子目录保留/删除」→ 补「§解散删除边界」一节（保留 workspaces/outputs/reports/board；删 members/charter_history/panorama/.rocky_squad + charter.md/index.md/log.md）。PRD §7 已记。
- **`specs/api/overall/11-squad.md`**（dissolveSquad）+ **`04-agent-session.md`**（DELETE /session）当前只描述单点删除 → 补「子孙 session 级联删 + onSessionDestroyed 触发」语义。PRD §7 已记。
- **`specs/tech/scheduling/[P1]cron_subsystem.md` §8** 现描述「deleteSession 触发 onSessionDestroyed」——本版本不改机制（只让级联路径每 descendant 都走 deleteSession），spec 无需改；若想显式化可补一句「级联删场景每个 descendant 均触发」。coder 实现时确认。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- 核心约束（保留工作产出分类 / children 必删含调度 / 过程数据不动）不可偏离——用户铁律，偏离须先报 orchestrator 确认

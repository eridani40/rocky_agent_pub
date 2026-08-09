# v0.0.271 PRD — workspace fs watch 关注集合模型重构（全量重算 + diff 防泄漏）

> 版本目录：`specs/prd/version_logs/v0.0.271.fs_watch_diff/`
> 需求来源：`reqs/[working] v0.0.271/req.md`（含老板逐字拍板的目标模型）+ `states/bugs/BUG-fs-watch-empty-folder-no-expand-[open].md`
> PRD 边界：产品可感知行为（文件树增量感知范围）+ 服务端 watch 模型；实现细节归架构 change_plan

## 1. 背景

### 1.1 现状问题（BUG-fs-watch-empty-folder-no-expand）

右侧 workspace 文件树，一个文件夹一开始是空的（不可展开/无子节点），后来里面新增了文件（外部或 agent 写入），**文件树感知不到**——文件夹不变成可展开，看不到新文件，体验断裂。

**根因（已定位）**：懒监听机制（v0.0.139）**只 watch 展开节点自身**（depth:0 单层非递归，只感知该目录直接子项）。空文件夹从未被展开 → 没建 watcher → 里面新增文件无事件 → 文件树永远显示「空文件夹不可展开」。漏了「子一级文件夹也 watch」这一半正是 bug 根源。

### 1.2 目标（老板 2026-08-07 逐字拍板）

**关注集合 = 所有「打开节点」的自身 + 它们各自的下一级子文件夹路径**

- **初始**：进 workspace → 打开根目录 → 关注 = { 根目录, 根目录的所有一级子文件夹 }
- **每展开一个节点** → 关注集合新增 { 该节点自身, 该节点的一级子文件夹 }
- **每收起一个节点** → 该节点及其子一级移出关注集合（除非仍被其他打开节点覆盖）
- **每次变化**（展开/收起/初始化）：重新算出当前完整关注集合，与上一次的已关注列表做 diff，再进行增删改查——**比增量配对更不容易泄漏**：任何口径偏差/漏 unwatch 都会被下一次 diff 纠正，不累积

效果：空文件夹作为某打开节点的一级子文件夹，天然在关注集合里 → 新增文件即感知 + 变可展开。

### 1.3 范围

服务端 watch 模型重构（manager/registry/dir-watcher 编排）+ 前端文件树 watch 接线调整 + SSE 事件不变。**核心变更**：增量 watch/unwatch 配对 → **全量重算 + diff** 的声明式模型；物理 watcher 生命周期与关注集合严格挂钩（不在新集合里的一律 close）。**物理实现选型（depth:1 vs 每目录独立 watcher）留给 architect**。

## 2. 核心产品决策（代决）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **关注集合语义 = 老板逐字拍板**：所有「打开节点」的自身 + 它们各自的下一级子文件夹路径（打开节点 = 前端 expanded 展开集合；根目录打开 = 打开根） | 老板原话；「打开节点自身」= depth:0 感知直接子项（文件 + 子文件夹增删），「一级子文件夹」= 感知子文件夹内部文件增删（变可展开）——补上 bug 漏掉的那一半 |
| D2 | **计算方式 = 全量重算 + diff（声明式，取代增量配对）**：每次变化（展开/收起/初始化）前端重算完整关注集合 → 与上次 diff → 增删改查。**口径偏差/漏 unwatch 被下次 diff 纠正，不累积** | 老板拍板核心；防泄漏靠「不在新集合里一律 close」兜底，而非 refcount 记账精确 |
| D3 | **物理 watcher 生命周期与关注集合严格挂钩**：diff 驱动建/关——新集合里没有的物理 watcher 一律 close（不管 refcount 记账）；新集合里有而物理缺的 → 建。**审计现有 4 条回收路径在新模型下的正确性**（见 §3.6） | 老板关注点；全量 diff 模型天然是对账兜底，物理 watcher 无泄漏收敛 |
| D4 | **初始监听 = 打开根目录 → 关注 = { 根, 根一级子文件夹 }**：前端 ws-panel 挂载 watch 根时，把根的一级子文件夹也纳入关注集合（GET tree 返回的子项里有 folder 类型，直接可得） | 老板拍板初始态；根一级子文件夹里的文件增删（如空子文件夹新增文件）从打开 workspace 起即感知 |
| D5 | **「一级子文件夹」清单来源 = GET tree 返回值**：前端展开节点时已有 childrenCache（GET tree?parent= 的返回），从 children 里筛 folder 类型即得一级子文件夹清单 | 复用现有 childrenCache，不新增 API/扫描；与 tree 语义一致（hasChildren 已含 folder 判断） |
| D6 | **空文件夹变可展开的感知链路**：空文件夹作为打开节点的一级子文件夹被 watch → 内部新增文件 → chokidar 'add' 事件 → SSE `session_workspace_file_changed` → 前端文件树标记该文件夹可展开（hasChildren=true） | 正是 bug 修复目标；前端现有 stale 机制能处理（新增文件 → 父目录标 stale → 重新 GET 显示子项） |
| D7 | **收起节点 = 该节点及其子一级移出关注集合，除非仍被其他打开节点覆盖**：收起 src → {src, src 一级子文件夹} 移出；若某子文件夹同时是另一打开节点自身/子一级 → 保留 | 老板拍板；diff 天然处理覆盖（集合去重后仍含则保留） |
| D8 | **前端重算集合的触发点 = 展开/收起/初始化/refresh**：每次 expanded 集合变化或 childrenCache 更新（展开成功拿到子项）后重算完整关注集合 | 「每次变化全量重算」的产品语义；前端持有 expanded + childrenCache，重算成本低（集合大小 = 展开节点数 + 子一级文件夹数，通常 <100） |
| D9 | **diff 计算位置（架构期定，PRD 只提）**：前端算集合发完整列表（声明式 watch-set API）或后端算（前端只发 expanded 集合）；无论哪种，**后端必须持有「上次已关注列表」做 diff 兜底**（前端只发增量则后端无法对账，违背 D2） | 防泄漏必须后端对账；具体 API 形态架构期定 |

## 3. 功能需求

### 3.1 关注集合定义（老板原话）

```
关注集合 = ∪_{打开节点 N} ( { N 自身 } ∪ { N 的一级子文件夹 } )
打开节点 = 前端 expanded 集合（根目录打开 = 根节点在 expanded）
一级子文件夹 = GET tree?parent=N 返回 children 中 type='folder' 的路径
```

- 集合是**路径去重**的（同一子文件夹可能同时是多个打开节点的子一级，只算一次）。
- **覆盖语义**：收起 src 时 {src, src 子一级} 移出；但若其中某路径仍是其他打开节点的自身/子一级 → 保留（D7）。

### 3.2 全量重算 + diff（取代增量配对）

**现状（增量配对）**：前端展开 → `watchPath(path)`；收起 → `unwatchPath(path)`；后端 refcount 记账精确配对。**弱点**：refcount 算错/漏 unwatch → 物理 watcher 永不关闭 = 泄漏，且纯内存记账无对账机制。

**新模型（全量重算 + diff）**：

```
每次变化（展开/收起/初始化/refresh）：
  1. 前端重算完整关注集合 S_new（expanded + childrenCache 派生）
  2. 后端将 S_new 与上次已关注列表 S_old diff：
     - S_new - S_old → 建 watcher（该路径新出现）
     - S_old - S_new → close watcher（该路径消失，一律关）
     - 交集 → 不动（refcount 语义保留给多 tab 合并）
  3. 后端 S_old := S_new
```

- **diff 是权威对账**：即使某次增量漏了 unwatch，下次全量 diff 会把不在集合里的物理 watcher close——**泄漏不累积，被收敛**（老板核心诉求）。
- **多 tab 合并**（同 session 多 ws-panel）：refcount 语义保留（多 tab 展开同一目录 → 1 个物理 watcher）；但 diff 以「session 级关注集合」为准（跨 tab 并集）——架构期定 tab 级 vs session 级集合粒度（§3.6）。

### 3.3 前端 watch 接线调整

- `section-workspace-panel.tsx`：`handleExpand`（L116-131）展开成功后除现有 `watchPath(path)` 外，**同时 watch 该节点的一级子文件夹**（从 GET tree?parent= 返回的 folder 子项筛出）；`handleCollapse`（L133-139）收起时**同时 unwatch 该节点及其一级子文件夹**。
- `use-workspace-watch.ts`：根监听（L37-46）从只 `watchPath('')` 扩展为 **watch 根 + 根一级子文件夹**（初始关注集合）。
- **触发点**（D8）：expanded 集合变化（展开/收起）+ childrenCache 更新（展开成功拿到子项）+ 初始化 + refresh 后重算完整集合 → 提交后端 diff。
- **容错**：任一 watch/unwatch 失败 best-effort（console.warn 不抛，对齐现有风格）；下一轮 diff 自动纠正（D2 兜底）。

### 3.4 空文件夹变可展开（bug 修复核心）

- 空文件夹 B 作为打开节点 A 的一级子文件夹 → B 在关注集合 → B 被 watch（depth:0 感知 B 直接子项）。
- B 内新增文件 → chokidar 'add' → SSE `session_workspace_file_changed`（relPath 相对 workspaceDir）→ 前端文件树：
  - B 是未展开节点（树中显示「空文件夹」）→ 收到 B 内文件变化 → 标记 B hasChildren=true（可展开）→ 用户可展开看到新文件。
  - 若 B 已展开 → 现有 stale 机制 re-fetch 显示新文件。
- **不感知的边界**（lazy 语义保留）：打开节点的**二级及更深**子文件夹不在关注集合（除非被展开）——深度内容变化不感知，用户展开该层时才感知（展开时 GET tree 拉最新，兜底）。

### 3.5 物理 watcher 生命周期（diff 驱动建/关）

- **建**：S_new 中出现的新路径 → openDirWatcher（depth:0 单层，等待 ready）。
- **关**：S_old 中存在但 S_new 中没有的路径 → closeDirWatcher（**一律 close，不管 refcount 记账**——防泄漏兜底）。
- **watcher 句柄与关注集合一一对应**：`dirWatchers` map 的 key 集 == 当前关注集合（诊断 invariant）。
- **选型点（留给 architect）**：
  - **方案 A：depth:1 递归**——一个 watcher 管「父 + 子一级」（chokidar depth:1 = 监听该目录 + 直接子目录一层）；关注集合的「节点自身 + 一级子文件夹」天然一个 watcher 覆盖；watcher 数量 = 打开节点数（更少）。
  - **方案 B：每目录独立 watcher**——现有 registry refcount 模型扩展；关注集合每个路径一个 watcher；watcher 数量 = 关注集合大小（= 打开节点数 + 子一级文件夹数，更多）。
  - **权衡**：目录树深 / 子一级文件夹多时，方案 A watcher 数少（省 inotify 上限），但 depth:1 递归对「子一级里的大目录」会扫描其直接子项（非递归到更深，可接受）；方案 B 保持「每目录一层」最简语义但 watcher 数多。**inotify 上限**（Linux fs.inotify.max_user_watches）与「打开节点数 + 子一级文件夹数」的量级（通常 <100）评估。**PRD 不定，架构期定**。

### 3.6 4 条回收路径审计（新模型下）

| 路径 | 现状（增量） | 新模型（diff） | 审计结论 |
|------|-------------|---------------|---------|
| **unwatch**（收起目录） | `unwatchPath(path)` → refcount-- 归零 close | 收起 → 重算集合 → diff：{src, src 子一级} 移出 → close（除非被其他打开节点覆盖） | ✅ 语义升级：从「单目录 unwatch」→「集合 diff 收敛」 |
| **releaseTab**（tab 卸载/切 session） | `unwatch(clientId)` release-all → takeTabDirs 逐目录 refcount-- | 该 tab 的打开节点集合清空 → 重算 session 级关注集合（其他 tab 的打开节点仍在）→ diff close 消失者 | ⚠️ 需定 tab 级 vs session 级集合粒度（架构期）；**泄漏兜底不变**：diff 收敛 |
| **recycleSession**（session_panel 1→0 / 删 session） | `takeSessionTabs` 逐 tab releaseTab | session 关注集合清空 → diff close 全部 | ✅ 不变（diff 收敛 = close 全部） |
| **stopAll**（shutdown） | 逐 session recycleSession + 兜底清残留 | 全量集合清空 → diff close 全部 | ✅ 不变（diff 收敛 = close 全部） |

**新模型下 4 条路径的共性**：都是「关注集合变化 → 全量 diff → 不在集合里一律 close」。**即使某条路径漏了增量 unwatch，下一次 diff（任何展开/收起/初始化）也会收敛**——这是老板要的对账兜底。

### 3.7 SSE 事件链路（不变）

- chokidar 事件 → `session_workspace_file_changed`（topic=session_panel，relPath 相对 workspaceDir）——payload/契约**零变化**。
- 事件覆盖范围变广：现在除展开节点自身，其一级子文件夹也推事件（这正是 bug 修复目标）。
- debounce（per-session 100ms）不变；前端文件树 stale 处理不变（事件 → 父目录标 stale → re-fetch）。

## 4. 关键用户路径（MANDATORY）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 进入 workspace（打开根目录）→ 根目录下某空子文件夹新增文件（外部/agent 写入） | 文件树感知：该空文件夹变可展开（hasChildren=true），展开可见新文件 |
| UC-2 | 展开一个目录（如 src）→ src 下某空子文件夹（如 src/components）新增文件 | 感知：src/components 变可展开（它在关注集合 = src 的一级子文件夹） |
| UC-3 | 反复展开/收起多个目录（快速连点）→ 查后端物理 watcher 数量 | watcher 数量 == 当前关注集合大小（无泄漏 invariant）；文件树增量感知不丢 |
| UC-4 | 展开 src（关注 {src, src 子一级}）→ 收起 src | {src, src 子一级} 移出关注集合；src 内后续文件增删不再推事件（除非重展开） |
| UC-5 | 展开 src 又展开 src/components（两节点）→ 收起 src | src/components 仍被监听（它是 src/components 打开节点自身，同时是 src 子一级——覆盖语义保留） |
| UC-6 | 打开 workspace → 根一级子文件夹（含空文件夹）内新增文件 | 初始关注集合 = {根, 根一级子文件夹} → 从打开起即感知（不等展开） |
| UC-7 | 切 session / 关 ws-panel tab → 查物理 watcher | 该 tab/session 关注集合清空 → watcher 收敛 close（无泄漏） |
| UC-8 | 展开深目录 A → A 的二级空子文件夹（A/B/C，C 未展开）新增文件 | **不感知**（C 不在关注集合，lazy 边界）——展开 C 时 GET tree 拉到最新（兜底） |
| UC-9 | 展开节点后手动 refresh | 重算完整关注集合 → diff 收敛（任何历史泄漏被纠正） |

## 5. 概念对齐 + 新概念

### 概念对齐（复用现有）

| 概念 | 出处 | 复用方式 |
|------|------|---------|
| 懒监听模型（depth:0 非递归 + tab 监听列表 + refcount） | `[P0]session_workspace_manager.md` §1-§5 | 保留物理 watcher 工厂 + refcount 合并语义；**替换增量配对为全量 diff** |
| chokidar depth:0 单层 + ready 等待 + 非递归（不自动 add 子目录） | `workspace-dir-watcher.ts` §3.1/§4 | 保留；depth:1 递归选型（方案 A）是扩展 |
| childrenCache（GET tree?parent= 子项） | `component-workspace-panel.md` §4.3 / `use-workspace-watch.ts` | 复用：一级子文件夹清单从 children 筛 folder |
| SSE `session_workspace_file_changed` + per-session debounce | `[P0]session_event.md` §2/§3 + `workspace-change-emitter.ts` | 零变化（事件链路不动，仅覆盖范围变广） |
| 4 条回收路径（unwatch/releaseTab/recycleSession/stopAll） | `[P0]session_workspace_manager.md` §3/§6/§10 | 语义升级为「集合变化 → diff 收敛」；stopAll/recycleSession 不变 |
| 关闭串行化 / 防重入（Bun FSEvents） | `[P0]session_workspace_manager.md` §7 | 保留（diff 驱动的建/关同样要走串行队列） |

### 新概念

| 概念 | 说明 | 需落 spec |
|------|------|----------|
| **关注集合（watch set）** | 打开节点自身 + 各自一级子文件夹的路径去重集合；每次变化全量重算 + diff | `[P0]session_workspace_manager.md` §1/§3（重写懒监听模型段） |
| **全量重算 + diff 对账** | 取代增量配对；不在新集合里的物理 watcher 一律 close（防泄漏兜底） | 同上 + `workspace-watch-registry.ts`（记账层语义更新） |
| **前端关注集合重算器**（新） | 从 expanded + childrenCache 派生完整关注集合（纯函数，可 UT） | `component-workspace-panel.md` §4.3 + `use-workspace-watch.ts`（或新 hook） |

## 6. 边界 / 不做

- **不做深目录递归感知**：关注集合只到「打开节点 + 一级子文件夹」；二级及更深不感知（除非展开）——lazy 语义保留，展开时 GET tree 兜底。
- **不做物理 watcher 合并优化**：depth:1 vs 每目录独立 watcher 选型留给 architect；PRD 不定。
- **不做 inotify 上限自动降级**：watcher 数量 = 关注集合大小（通常 <100），超限处理架构期评估（如 warn/降级 depth:0 只 watch 自身）。
- **不做 SSE 事件/API 契约变更**：`session_workspace_file_changed` payload 零变化；watch/unwatch API 形态（增量保留 vs 声明式 watch-set）架构期定，前端/后端同步改。
- **不新增 AT/ET 持久 case**：watch 逻辑是确定性 fs 行为（非 LLM 不确定性）；UT 覆盖 diff 计算 + 物理 watcher 生命周期 + 回收路径；**但本版改了 server watch 逻辑 → AT/ET 按测试标准**（leader req 明确），ET 用真 fs 操作验证空文件夹感知（可一次性，不建持久 case）。

## 7. 验收口径

**能力不变量**：
1. 打开 workspace → 关注集合 = { 根, 根一级子文件夹 }；根一级空子文件夹新增文件 → 变可展开（UC-1）。
2. 展开节点 → 关注集合新增 { 节点自身, 节点一级子文件夹 }；展开目录的一级空子文件夹新增文件 → 变可展开（UC-2）。
3. 收起节点 → { 节点自身, 节点一级子文件夹 } 移出（除非被其他打开节点覆盖）（UC-4/UC-5）。
4. 每次变化全量重算 + diff：物理 watcher 数量 == 关注集合大小（无泄漏 invariant，UC-3/UC-7）。
5. 4 条回收路径（unwatch/releaseTab/recycleSession/stopAll）在新模型下正确收敛（§3.6 审计）。

**回归不变量**：
1. SSE `session_workspace_file_changed` payload/链路零变化（事件覆盖范围变广是预期）。
2. 展开/收起/刷新文件树基本操作零回归（watch 接线调整不破坏 GET tree 主链路）。
3. 多 tab 同 session refcount 合并语义保留（同目录 N tab → 1 物理 watcher）。
4. 切目录（switchDir）recycle 旧 → 前端重算新根关注集合（复用现有流程）。

**性能护栏**：
- 关注集合大小 = 打开节点数 + 一级子文件夹数（通常 <100）；diff 计算是集合运算（O(n)），每次展开/收起触发一次，开销可忽略。
- depth:1 递归选型（方案 A）下 watcher 数 = 打开节点数（比集合大小更少）；方案 B watcher 数 = 集合大小——inotify 上限权衡架构期评估。

## 8. spec 对齐备忘

- `specs/tech/agent/session/[P0]session_workspace_manager.md`：§1 懒监听模型重写（关注集合 = 打开节点 + 一级子文件夹；全量重算 + diff 取代增量配对）；§3 接口（watch 语义扩展为集合 diff）；§5 记账层（refcount 语义保留 + diff 对账）；§6 回收路径审计更新。
- `specs/tech/agent/session/[P0]session_event.md`：确认事件链路零变化（仅覆盖范围变广）。
- `specs/ui/components/chat-page/component-workspace-panel.md`：§4.3 前端接线（展开 watch 自身 + 子一级；收起 unwatch 自身 + 子一级；初始 watch 根 + 根子一级）。
- `specs/ui/components/chat-page/use-workspace-watch.md`（若有）：hook 契约更新（重算集合触发点）。
- `specs/api/overall/04-agent-session.md`：§2.6.5 watch/unwatch 语义更新（若 API 形态变化——架构期定后同步）。
- 新概念 spec：关注集合重算器（纯函数）——前端 `component-workspace-panel.md` 或独立文件。

## 9. 版本总结

- **产品价值**：修复空文件夹新增文件无感知的体验断裂——文件树增量感知范围从「展开节点自身」扩展为「打开节点 + 一级子文件夹」；同时把 watch 记账从脆弱增量配对升级为**全量重算 + diff 对账**，物理 watcher 无泄漏收敛。
- **范围**：服务端 watch 模型重构（manager/registry/dir-watcher 编排改为集合 diff）+ 前端 watch 接线（展开/收起/初始 watch 子一级）+ 4 条回收路径审计；SSE 事件链路零变化。
- **关键决策**：关注集合 = 打开节点 + 一级子文件夹（老板拍板）；全量重算 + diff（防泄漏兜底，不在新集合一律 close）；初始 = {根, 根一级子文件夹}；空文件夹感知 = 一级子文件夹 watch → 变可展开；物理实现选型（depth:1 vs 每目录独立）留 architect。
- **风险/口子**：API 形态（增量 watch/unwatch vs 声明式 watch-set）与集合粒度（tab 级 vs session 级）架构期定；depth:1 递归 vs 每目录独立 watcher 的 inotify 上限权衡架构期评估；「展开节点的一级子文件夹」清单依赖 childrenCache（GET tree 已返回 folder 类型，无新增 API）。

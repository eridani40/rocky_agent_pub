# v0.0.139 — workspace watcher 懒监听重构（展开才监听，tab 显式控制）

> 引入版本：v0.0.139 · 类型：后端 watcher 结构性重构（对齐既有 `ws-panel` 文件树交互；扩展 watch/unwatch 契约 + 前端展开/收起接线）· 概念权威源：`specs/tech/agent/session/[P0]session_workspace_manager.md`（重写目标）+ `specs/ui/components/chat-page/component-workspace-panel.md`（文件树交互）· 需求权威源：`reqs/[working] v0.0.139.lazy-workspace-watch/req.md`
>
> **一句话**：把「点开 session = 对整个 workspace 递归监听」改为「监听 = workspace 根一层 + 当前所有展开的目录（各一层非递归）」，展开=watch、收起=unwatch、tab 消失回收全部监听，让监听成本与树大小彻底解耦。

## 1. 背景与根因（为何重构）

**事故**：用户点击 session 卡顿（DevTools TTFB 31.18s），随后 server 段错误挂死。排查定位两处：

- **卡**：点击 session → SSE `session_panel` subscribe 钩子 → `startWatch` 对整个 workspaceDir **递归** chokidar watch。chokidar v4 的 `ignored` 字符串是全路径精确相等（无 glob），旧 glob 名单静默整体失效 → `.venv`（26,259 文件 / 2,617 目录）全被扫描 + watch → 扫描风暴把主线程打成筛子 → 所有 API 停摆约 31s。
- **崩**：切走 session → `watcher.close()` → Bun 1.3.11 FSEvents use-after-free 竞态 → 段错误。

**已止血（hotfix，dev1 commit `1ef2d61c`）**：`ignored` 改函数匹配目录段（+`.venv`/`__pycache__`）；bun 升 1.3.14。用户实测已变快。

**结构性问题仍在**：点击 session = 全 workspace 递归 watch 的模型没变。ignore 名单永远列不全（下一个大目录可能叫别的名字）；watcher 本来就「仅供文件树 UI 刷新」，**收起的目录 UI 根本不渲染，监听它纯属浪费**（如 `.rocky_squad/state` 每 30s 的写入白白推 SSE 事件）。本版本从模型层根治。

## 2. 目标模型：懒监听（lazy watch）

**监听集合 = workspace 根（一层，非递归）+ 当前所有展开的文件夹（各一层，非递归）**

```
打开 session tab   → watch(根一层)          文件树顶层可用
展开文件夹          → watch(该目录一层)        一次显式操作（acquire）
收起文件夹          → unwatch(该目录)          一次显式操作（release）
tab 消失（关/断连）→ 回收该 tab 名下全部监听   主人死亡自动清算
```

**收益（与树大小彻底解耦）**：

- 监听数 = 展开的目录数（通常 < 50），**不再等于 workspace 文件总数**。
- `.venv` / `node_modules` 等大目录**只要不展开就零成本**——不再依赖 ignore 名单兜性能（ignore 静默失效不再致命）。
- 打开 session tab **零全树扫描**：subscribe 路径不再触发递归扫描，「扫描风暴」概念结构性消失，点击 session 秒开。
- 收起的目录不再产生无效 SSE 事件（收起 = unwatch，其内变化不再推）。

## 3. 用户裁决（设计红线，MANDATORY — 逐条落地）

来自 `req.md` 用户裁决，本版本设计不得弱化或替换：

| # | 裁决 | PRD 落地要点 |
|---|------|-------------|
| 1 | **tab 显式控制监听，不搭便车** | 只有 tab 知道该监听谁。展开/收起各对应一次显式 watch/unwatch（经典 acquire/release）。**「拉 tree 顺势 watch」已被用户明确否决**——GET tree 只取数据，绝不隐式建立监听。 |
| 2 | **tab 对应一个监听列表 + 主人死亡自动清算** | 每个打开工作区面板的 session 视图（tab）持一份监听列表。tab 消失（正常关闭 / 断连 / 崩溃）→ 回收其名下全部监听，不泄漏。兜底复用现有 `session_panel` SSE unsubscribe 钩子（0→1/1→0 计数已存在），异常路径（关标签页 / 断网）同样触发回收。 |
| 3 | **操作幂等（增量，非声明式全量）** | 重复 watch 同一目录不叠加；unwatch 不存在的目录静默 no-op。快速连点展开/收起、重试天然安全，**不需要全量对账**（不维护声明式全量列表，只做增量 watch/unwatch）。 |
| 4 | **收起期间变更不推事件，展开时拉 tree 兜底** | 目录收起 = unwatch，其内变化后端不接、不推。重新展开时拉该目录 tree（GET `?parent=<relPath>&depth=1`）兜底，复用既有「lazy 切回兜底」模式，拉回即最新状态。 |
| 5 | **同 session 多 tab：目录引用计数合并** | 每 tab 一份独立列表；后端按目录做引用计数合并（同一目录被 N 个 tab 展开 → 计数 N，只 1 个物理 watcher）。任一 tab 死只减它那份计数；计数归零才真正 unwatch。 |
| 6 | **范围只优化 watcher** | 见 §5 非目标。观测护栏、子进程隔离、squad-file-watcher 均不动。 |

## 4. 用户可感知行为 + 概念对齐

本版本以后端 watcher 重构为主，但**改变了「展开/收起文件夹」的语义**（从纯前端 UI 状态 → 额外触发后端 watch/unwatch），属用户可感知，需在此登记。

### 4.1 沿用的既有概念（不发明，直接引用）

| 概念 | 权威源 | 本版本关系 |
|------|--------|-----------|
| `ws-panel` 工作区面板 + 文件树 lazy 展开/收起（`expanded` / `childrenCache` / `stalePaths` state；GET tree `?parent=&depth=1`） | `component-workspace-panel.md §3.4/§4.3` | **交互复用**：展开/收起触点不变（点 `ws-item-{path}-expand` twisty），仅在其上叠加 watch/unwatch 调用 |
| `session_workspace_file_changed` / `session_workspace_dir_changed` SSE 事件 + `session_panel` topic | `[P0]session_event.md §2`；`component-workspace-panel.md §3.2` | **不变**：事件类型 / payload / 前端 reducer 分流（已展开局部刷新 / 未展开标 stale）沿用 |
| `session_panel` subscribe/unsubscribe 钩子（tab 生命周期，0→1/1→0 计数） | `[P0]session_workspace_manager.md §7/§9` | **兜底挂点复用**：tab 消失时经此钩子回收该 tab 名下监听 |
| 「切回 GET tree 补回切走期间变化」兜底 | `[P0]session_workspace_manager.md §9` | **模式复用**：收起→展开的兜底与切回兜底同一思路（无 watcher 期间靠重拉 tree） |

### 4.2 需先落 ui/tech spec 的新概念（交 architect，PRD 仅产品化表达）

以下概念是需求既定模型的产品化表达，**具体契约由 architect 落到 tech/ui/api spec 后 PRD 才引用为准**，本 PRD 不擅自定义技术形态：

- **监听单元从「每前台 session 一个递归 watcher」→「每目录一个非递归 watcher + 引用计数」**：`[P0]session_workspace_manager.md` 需重写（`WatchEntry` 从 session 级递归 → 目录集 + refcount + 非递归 watcher；`startWatch/stopWatch/stopAll` 语义调整为 watch/unwatch/回收）。
- **tab 监听列表 + tab 身份**：如何标识一个 tab（订阅/连接身份）并挂其监听列表——tech 契约由 architect 定。
- **watch/unwatch 端点（或既有端点扩展）**：前端展开→watch、收起→unwatch 的 API 契约——由 architect 在 `specs/api/` 定（新端点或扩展现有 workspace 端点组）。
- **前端展开/收起接线**：`component-workspace-panel.md §4.3` 的展开/收起交互需扩展「展开触发 watch、收起触发 unwatch」语义（UI 契约扩展）。

### 4.3 布局稳定性（MANDATORY）

本版本**不新增任何可见 UI 元素**（不加按钮、不改文件树视觉基线），仅在既有展开/收起 twisty 交互上叠加后端调用。因此无按钮出现/消失、无元素位移风险，`component-workspace-panel.md §6` 视觉基线完全沿用，不回退。

## 5. 非目标（明确排除，对齐 req.md「范围只优化 watcher」）

| 排除项 | 理由 |
|--------|------|
| **观测护栏**（event-loop lag watchdog / 请求到达时间戳日志） | 用户裁决明确不做——本版本只做 watcher 结构性优化，不引入可观测性基建 |
| **watcher 子进程隔离** | 用户裁决明确不做——懒监听后监听数已与树大小解耦，风暴概念消失，无需子进程隔离 |
| **`squad-file-watcher`（board/outputs/reports 监听）** | 独立 watcher，spec 边界不同（`specs/tech/squad/[P1]squad_filewatch.md`），本版本不动 |
| **切目录（PUT /session）流程本身** | 切目录的 stop→set→start 顺序契约（`session_workspace.md §4`）沿用，仅其中 watcher 启停语义随本重构调整 |
| **ignore 名单机制** | 懒监听后不再依赖 ignore 兜性能；hotfix 的函数匹配 ignore 保留但不再是性能关键路径 |

## 6. 关键用户路径（MANDATORY — 测试最低覆盖要求）

> 用户路径 = 测试最低覆盖。按核心冒烟集纪律，本版本为普通重构 feature，**不新增持久 AT/ET case**；预期由 UT 覆盖（manager 生命周期 / 引用计数 / 幂等 / 回收）+ 受影响的既有 workspace 冒烟 case 回归。测试计划阶段最终确认。

| 路径 | 用户操作链路 | 涉及概念 | 预期结果 |
|------|-------------|---------|---------|
| **P1：打开 session tab → 根一层监听 + 文件树可用** | 点开某 session（工作区面板可见）→ 前端 GET tree（顶层）→ 建立对 workspace 根一层的监听 | subscribe 钩子 · GET tree 顶层 · watch(根) | 文件树顶层正常显示；后端只监听根一层，**无全树递归扫描**（打开秒开，大目录不卡） |
| **P2：展开目录 → 监听该目录 + 变化实时反映** | 点文件夹 twisty 展开 → GET `?parent=<relPath>` 拉子项 → watch(该目录一层)；外部在该目录内改文件 | 展开交互 · watch(dir) · `session_workspace_file_changed` | 展开后该目录被监听；其内文件变化经 SSE 实时反映到树（新增/删除/修改可见） |
| **P3：收起目录 → 停止监听该目录** | 点已展开文件夹 twisty 收起 → unwatch(该目录) | 收起交互 · unwatch(dir) | 该目录停止被监听；其内后续变化不再产生 SSE 事件（无无效事件） |
| **P4：收起期间变化 → 重新展开看到最新（拉 tree 兜底）** | 收起目录 A → 外部在 A 内新增/删除文件（此时无监听、无 SSE）→ 重新展开 A | unwatch 期间无事件 · 展开时 GET `?parent` 兜底 | 重新展开 A 时拉最新 tree，看到收起期间发生的全部变化（拉回即最新） |
| **P5：关闭 tab（含异常断连）→ 监听全部回收无泄漏** | 关闭 session tab / 直接关浏览器标签 / 网络断开 → unsubscribe 钩子触发 | unsubscribe 钩子 · tab 监听列表回收 | 该 tab 名下所有监听（根 + 展开目录）全部回收；无 watcher 泄漏、无孤儿 inotify/fd |
| **P6：同 session 两 tab 独立 + 全关归零** | 同一 session 开 2 个 tab → 各自独立展开/收起不同目录（互不干扰）→ 逐个关闭 | 每 tab 一份列表 · 目录引用计数合并 | 两 tab 展开/收起互不影响；同一目录被两 tab 展开时只 1 物理 watcher（计数 2）；关一个减其份、计数非零仍监听；全关后监听归零 |

## 7. E2E Use Cases

> 说明：本版本按核心冒烟集纪律不新增持久 ET case（普通重构 feature）。下表为验收视角的端到端用户价值断言，供测试计划阶段选择 UT / 既有冒烟 case 回归覆盖，不逐条建持久 ET。

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开一个含超大目录（如 `.venv`，未展开）的 session → 观察面板加载 | 文件树顶层秒出、页面不卡；后端不对 `.venv` 建监听（监听数 = 顶层可见目录，非文件总数） |
| UC-2 | 展开一个目录 → 外部在该目录内 `touch` 新文件 | 树中该目录下实时出现新文件（无需手动刷新） |
| UC-3 | 收起该目录 → 外部再在其内改文件 → 重新展开 | 收起期间无实时更新；重新展开后一次性看到全部最新变化（拉 tree 兜底） |
| UC-4 | 展开多层目录后直接关闭浏览器标签页 | 后端该 tab 名下所有监听被回收，无残留 watcher（可经 `getStatus` 诊断确认归零） |
| UC-5 | 同 session 开两个标签页，A 展开 `src`、B 展开 `docs`，然后关闭 A | B 的 `docs` 监听不受影响仍实时；A 关闭后 `src` 监听回收；若两者都展开过同一目录则按引用计数只在最后一个关闭时才真正停止监听 |

## 8. 验收口径

- **功能正确**：P1–P6 全部达成——打开不卡、展开实时、收起停推、兜底拉最新、tab 死回收、多 tab 引用计数正确归零。
- **无泄漏 invariant**：任意操作序列（快速连点展开/收起、多 tab 交错开关、异常断连）后，无监听主体存活时物理 watcher 数归零；`watcher.close()` 路径串行/防重入，快速连点不触发段错误（对齐 context.md findings 崩溃面）。
- **成本解耦**：监听数与 workspace 文件总数无关，只与展开目录数相关（大目录不展开零成本）。
- **范围守恒**：§5 非目标项零改动（观测护栏 / 子进程隔离 / squad-file-watcher 未被触碰）。

## 9. 版本

version: 1.0（v0.0.139 新建：workspace watcher 从「每前台 session 一个递归 watcher」重构为「根一层 + 展开目录各一层非递归 + tab 监听列表 + 目录引用计数」的懒监听模型；展开=watch / 收起=unwatch / tab 消失回收；6 条用户裁决红线 + 6 条关键用户路径。对应 tech `[P0]session_workspace_manager.md` 重写 + `component-workspace-panel.md` 展开/收起接线扩展 + api watch/unwatch 契约，具体由 architect 落定）。

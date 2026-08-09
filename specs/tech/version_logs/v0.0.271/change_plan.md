# v0.0.271 变更计划书 — workspace fs watch 关注集合重构（watch-set 声明式 + 全量 diff）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **背景**：BUG-fs-watch-empty-folder-no-expand —— 懒监听只 watch 展开节点自身（depth:0），空文件夹从未展开 → 无 watcher → 新增文件无事件 → 永远显示「空文件夹」。老板拍板目标模型：**关注集合 = 所有打开节点自身 + 各自一级子文件夹**；每次展开/收起/初始化/refresh 后**全量重算 + 与上次 diff 增删 watch**；4 条回收路径都是「集合变化→diff 收敛」。测试全 UT（不新增 AT/ET 持久 case）。

## 架构裁决（PRD D1-D9 落实）

| # | 裁决点 | 结论 | 理由 |
|---|--------|------|------|
| R1 | **D9 diff 计算位置** | **前端算完整关注集合**（expanded + childrenCache 筛 `type==='dir'`）→ **新增声明式 `watch-set` 端点**发完整列表；**后端持有 S_old 做 diff 兜底**（权威源 = 后端 registry，watcher 实际持有者） | 前端已有 expanded + childrenCache（GET tree 返回 dir 节点），筛 dir 即得一级子文件夹清单，零新增 API/扫描；后端懒监听原则「不主动扫描 fs」，让它算子一级违背设计；后端 diff 是权威对账（老板 D2/D9 核心：不在新集合一律 close，泄漏不累积） |
| R2 | **watcher 形态** | **方案 B：每目录独立 watcher（depth:0 工厂零改动）**，子一级文件夹也建独立 watcher | ① 物理层零改动（dir-watcher 保持 depth:0）② 无重复监听（每路径唯一 watcher，多 tab 共享由 refcount 合并）③ 语义最简（addDir 不自动 add 红线保持，深度边界天然正确）④ watcher 数 = 关注集合大小（通常 <100）远低于 inotify 默认 8192+/FSEvents 无硬上限。否决方案 A（depth:1）：父子 watcher 重叠 → 重复事件需去重；收益（watcher 数少）在 <100 量级无意义 |
| R3 | **泄漏对账** | **每次变化全量 diff（结构性收敛）**：不在新集合的物理 watcher 一律 close；**不做周期对账** | diff 每次 applyWatchSet 全量执行 = 天然对账；后端记录 vs 物理 watcher 一致性由 opQueues 串行化保证 + close 幂等兜底；周期对账是「对账的对账」，成本 > 收益 |
| R4 | **集合粒度** | **tab 级集合 + refcount 合并**（session 级并集派生）：registry 保留 tabDirs（tab 持有自己的 expanded 集合）+ dirRefcount（多 tab 同目录 → 1 物理 watcher）；4 条回收路径实现基本不变（已是「清集合 → refcount 归零 → close」） | 最小侵入；releaseTab（tab 卸载）需要「该 tab 集合清空，其他 tab 保留」；收起节点 = 重算集合不含它，仍被其他 tab 持有 → refcount>0 → 不 close |
| R5 | **API 形态** | **新增 `POST /session/:id/workspace/watch-set`**（body `{ clientId, paths: string[] }` 声明式替换该 tab 集合）；**保留 watch/unwatch 增量端点**（向后兼容 + release-all 复用 unwatch 无 path）；新前端不用 watch 单 path | 声明式与「全量重算 + diff」模型对齐；unwatch 无 path（release-all）是前端卸载主路径，保留 |

## 变更清单

<!-- 每行一个函数/符号；相关方法的行放在一起（同模块/同文件相邻） -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| workspace-watch(前端) | app/web/src/components/chat-page/workspace-watch-set.ts | computeWatchSet() | 新增 | 纯函数：输入 `{ tree, expanded, childrenCache }` → 关注集合 `string[]`（根 `''` + 根一级 dir + 每个打开节点自身 + childrenCache[path] 筛 `type==='dir'` 的一级子文件夹；路径去重） | MUST 纯函数零副作用可 UT；MUST 打开节点用 `expandedPathsByDepth`（已有纯函数）；MUST 根恒含 `''`；MUST 子文件夹判定用 `node.type === 'dir'`（PRD 说 folder，实际类型是 dir） | PRD D1/D5/D8；`workspace-slice-reducer.ts` expandedPathsByDepth；`workspace-types.ts` WsTreeNode | +45 |
| workspace-watch(前端) | app/web/src/components/chat-page/use-workspace-watch.ts | useWorkspaceWatch() | 修改 | watchPath/unwatchPath 改为暴露 `applyWatchSet(paths: string[])`（POST watch-set 声明式替换该 tab 集合）；cleanup 仍 release-all（unwatch 无 path） | MUST 每次 applyWatchSet 发**完整集合**（非增量）；MUST cleanup 保留 release-all（闭包捕获 sessionId）；clientId ULID 生成不变 | PRD D2/D9；api §2.6.5 | +20/-15 |
| workspace-watch(前端) | app/web/src/components/chat-page/section-workspace-panel.tsx | handleExpand() | 修改 | 去掉 `watchPath(path)`（L119）——展开只改 state（toggle-expand），watch 由 useEffect 重算触发 | MUST NOT 在 handleExpand 内直接调 watch API（防双发）；GET tree?parent 补 childrenCache 逻辑保留 | PRD D8；本 change_plan useWorkspaceWatch | -1 |
| workspace-watch(前端) | app/web/src/components/chat-page/section-workspace-panel.tsx | handleCollapse() | 修改 | 去掉 `unwatchPath(path)`（L136）——收起只改 state（toggle-expand force:false） | MUST NOT 直接调 unwatch API；收起后 stale 标记/清理逻辑保留 | PRD D8 | -1 |
| workspace-watch(前端) | app/web/src/components/chat-page/section-workspace-panel.tsx | handleSwitchDir() | 修改 | 切目录（workspaceDir 变化）后**清空 expanded**（相对路径基准变了，旧展开态无效）→ 后续 computeWatchSet 不含旧路径 | MUST 切目录时清 expanded；MUST NOT 影响 handleRefresh（同目录刷新保留 expanded 逐层补回） | PRD D8；`workspace-slice-reducer.ts` resetForRefresh 保留 expanded 的行为差异 | +3/-1 |
| workspace-watch(前端) | app/web/src/components/chat-page/section-workspace-panel.tsx | （新增 useEffect） | 新增 | 监听 state.expanded + state.childrenCache + state.tree → useMemo computeWatchSet → 变化时 applyWatchSet | MUST 依赖数组含 expanded/childrenCache/tree；MUST 初始 rootTree 加载后补发（根一级子文件夹依赖 tree，异步）；MUST 展开后 childrenCache 未到先发自身、GET 成功后补子一级（幂等） | PRD D2/D8；本 change_plan | +30 |
| workspace-watch(前端) | app/web/src/lib/chat-api/workspace-api.ts | watchWorkspaceSet() | 新增 | POST `/session/:id/workspace/watch-set`，body `{ clientId, paths: string[] }` → `{ ok: true }` | MUST 复用 req<T> 基座；MUST paths 为字符串数组 | api §2.6.5 新增端点 | +12 |
| workspace-watch(服务端) | app/server/src/agent/workspace-watch-registry.ts | setTabSet() | 新增 | 全量覆盖 (sid, clientId) 目录集 → 返回 `{ added, removed }`（newSet−oldSet / oldSet−newSet）；交集不动；空集删 key | MUST 纯记账零 chokidar 依赖；MUST NOT 直接改 refcount（caller 调 refInc/refDec）；MUST 幂等（同集合再调 → added/removed 全空） | PRD D2/D3；本 change_plan R4 | +25 |
| workspace-watch(服务端) | app/server/src/agent/session-workspace-manager.ts | applyWatchSet() | 新增 | 声明式 watch-set：resolve 全部 relDir → absDir（越界/不存在跳过）→ registry.setTabSet → added 逐个 openIfFirstRef（串行队列建）→ removed 逐个 closeIfZeroRef（串行队列关，refcount 归零才物理 close） | MUST 不在新集合的物理 watcher 一律 close（refcount 归零即关，泄漏不累积）；MUST 走 opQueues 串行化防重入；MUST 多 tab 合并（removed 但其他 tab 持有 → refcount>0 → 不 close）；MUST 返回 Promise\<void\> fire-and-forget | PRD D2/D3/D9；spec §3/§7 | +40 |
| workspace-watch(服务端) | app/server/src/agent/session-workspace-manager.ts | watch() / unwatch() | 修改 | 保留（向后兼容增量语义）；新前端不再调 watch 单 path；unwatch 无 path（release-all）仍被前端卸载路径使用 | MUST 语义不变（增量幂等）；MUST NOT 与 watch-set 混用同一 tab（状态不一致风险，handler 注释注明） | api §2.6.5 兼容 | +0 |
| workspace-watch(服务端) | app/server/src/handlers/session-workspace-watch.ts | handleWorkspaceWatchSet() | 新增 | POST `/session/:id/workspace/watch-set`：body `{ clientId, paths: string[] }` → 校验 clientId → 逐 path resolveWatchTarget（越界 400 / 不存在静默跳过）→ manager.applyWatchSet | MUST paths 数组元素逐个白名单校验（同 watch 的 resolveWatchTarget）；MUST 缺 clientId → 400；MUST 返回 200 `{ ok: true }` | api §2.6.5 新增端点；本 change_plan | +45 |
| workspace-watch(服务端) | app/server/src/agent/workspace-dir-watcher.ts | （零改动） | - | depth:0 单目录工厂保持——方案 B 裁决：每目录独立 watcher，子一级文件夹也建独立 watcher | MUST NOT 改 depth:0 → depth:1（父子重叠重复事件）；MUST NOT 注册 addDir → watcher.add（红线①保持） | 架构裁决 R2；spec §2/§3.1 | +0 |
| workspace-watch(服务端) | app/server/src/agent/workspace-change-emitter.ts | （零改动） | - | per-session 100ms debounce + session_workspace_file_changed payload 契约不变（仅覆盖范围变广） | MUST NOT 改 event 契约 | PRD §SSE 零变化；spec §8 | +0 |
| api-doc | specs/api/overall/04-agent-session.md | §2.6.5 watch-set 端点 | 新增 | 文档新增 watch-set 端点契约（body paths 数组 / 声明式语义 / 安全校验同 watch） | MUST 与 handler 实现一致 | api §2.6.5 | +20 |
| test | app/web/src/components/chat-page/__tests__/workspace-watch-set.test.ts | computeWatchSet 单测 | 新增 | 用例：根 + 根一级 dir；展开节点 + childrenCache 子一级 dir；路径去重；收起移出；切目录 expanded 清空后集合 | MUST 纯函数直测零 mock | PRD §7 验收口径（全 UT） | +60 |
| test | app/server/src/agent/__tests__/workspace-watch-registry.test.ts | setTabSet 单测 | 新增 | 用例：全量替换 diff（added/removed）；交集不动；空集合清 key；幂等 | MUST 纯记账直测零 mock | PRD §7；本 change_plan | +50 |
| test | app/server/src/agent/__tests__/session-workspace-manager.test.ts | applyWatchSet 单测 | 新增 | 用例：新集合建 watcher；移除 close（泄漏收敛——旧有新无 → close）；多 tab 合并（removed 但其他持有 → 不 close）；串行化防重入；4 条回收路径与 applyWatchSet 交互 | MUST mock dir-watcher 工厂；MUST 覆盖「不在新集合一律 close」对账语义 | PRD §7；spec §7 | +70 |
| spec-sync(T3) | specs/tech/agent/session/[P0]session_workspace_manager.md | §1/§3/§5/§6 | 修改 | 懒监听模型更新：关注集合 = 打开节点自身 + 一级子文件夹；watch/unwatch 增量 → watch-set 声明式全量 diff；对账 = 每次变化 diff 收敛（不做周期对账） | MUST 与 change_plan 一致；MUST NOT 改 SSE 契约段（§8）；MUST 验证代码实现 == spec 契约（不绕过） | 本 change_plan | +30/-20 |
| spec-sync(T3) | specs/ui/components/chat-page/component-workspace-panel.md | §4.3 | 修改 | 前端接线更新：展开/收起 → state 变化 → useEffect 重算 computeWatchSet → watch-set | MUST 与前端实现一致 | 本 change_plan | +15/-10 |

## 影响面评估

- **跨模块**：前端（组件 section-workspace-panel + hook use-workspace-watch + 纯函数 workspace-watch-set + api lib）+ 服务端（registry + manager + handler）+ spec 文档（tech/api/ui 三处同步）
- **破坏性变更**：无。watch-set 为**新增端点**；watch/unwatch 增量端点保留兼容（release-all 仍用）；SSE 事件契约零变化；dir-watcher 物理层零改动
- **依赖顺序**：T1（前端）∥ T2（服务端）可并行（watch-set API 契约先定，两端独立实现）；T3（spec 同步）依赖两者完成
- **风险点**：
  1. **切目录 expanded 旧路径**（相对基准变 → 旧路径可能解析到新根错误目录）→ 必须清 expanded（新增行，T1 处理；handleRefresh 不受影响）
  2. **初始根一级子文件夹时序**（依赖 rootTree 异步加载）→ 初始 applyWatchSet 两次（tree-loaded 前只发根、后补根一级），幂等
  3. **展开后 childrenCache 时序**（GET 子项前先发节点自身、成功后补子一级）→ 两次 applyWatchSet，幂等
  4. **watch 增量与 watch-set 混用同一 tab** → 状态不一致（增量改集合，声明式 diff 基于旧集合）；新前端只用 watch-set，文档注明不建议混用
  5. **watcher 数** = 关注集合大小（打开节点 + 一级子文件夹，典型 <100）；Linux inotify 默认 8192/65536、macOS FSEvents 无硬上限，无压力
  6. **前端集合计算正确性** 依赖 childrenCache 完整性（展开成功才有子一级）——childrenCache 缺失时只 watch 自身（保守，不误伤）；刷新/重展开兜底拉最新

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

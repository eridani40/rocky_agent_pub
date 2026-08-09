# v0.0.271 tech change log — workspace fs watch 关注集合重构（watch-set 声明式 + 全量 diff）

> 对应需求：`reqs/[working] v0.0.271/req.md`（BUG-fs-watch-empty-folder-no-expand）。
> 权威契约：`specs/tech/version_logs/v0.0.271/change_plan.md`（5 裁决 R1-R5，frozen）。

## 变更摘要

### 需求与动机

懒监听只 watch 展开节点自身（depth:0），**漏一级子文件夹 → 空文件夹从未展开 → 无 watcher → 新增文件无事件**（空文件夹变可展开修不掉）。目标模型：关注集合 = 所有打开节点自身 + 各自一级子文件夹（**含空文件夹**）；全量重算 + diff（**不在新集合一律 close = 防泄漏对账**）。

### 方案（5 架构裁决 R1-R5，详见 change_plan「架构期裁决」）

1. **R1 diff 计算位置 = 前端算完整关注集合**（expanded + childrenCache 筛 `type==='dir'`）→ 新增声明式 `watch-set` 端点；后端持有 S_old 做 diff 兜底（**权威源 = 后端 registry**）。
2. **R2 watcher 形态 = 每目录独立 watcher**（depth:0 工厂零改动）；一级子文件夹也建独立 watcher（否决 depth:1 父子重叠）。
3. **R3 泄漏对账 = 每次变化全量 diff（结构性收敛）**，不做周期对账。
4. **R4 集合粒度 = tab 级集合 + refcount 合并**（registry 保留 tabDirs + dirRefcount）。
5. **R5 API 形态 = 新增 `POST /session/:id/workspace/watch-set`**（body `{ clientId, paths: string[] }`）；保留 watch/unwatch 增量端点（release-all 仍用）。

### T1 — 前端声明式 watch-set（commit 8f6ba17f）

- **`workspace-watch-set.ts`（新，49 行）**：`computeWatchSet({ tree, expanded, childrenCache })` 纯函数——`paths = new Set([''])` + tree 筛 dir（根一级）+ `expandedPathsByDepth(expanded)` 打开节点自身 + `childrenCache[path]` 筛 dir（一级子文件夹）+ `[...paths].sort()` 去重排序。
- **`use-workspace-watch.ts`**：clientId useRef ULID 稳定 + `applyWatchSet(paths)`（POST watch-set 完整集合）+ cleanup release-all（闭包捕获旧 sessionId）。
- **`section-workspace-panel.tsx`**：handleExpand/handleCollapse 只改 state（去 watchPath/unwatchPath API）+ handleSwitchDir dispatch dir-changed 清 expanded + 重算 effect（L237-239 `applyWatchSet(computeWatchSet({tree, expanded, childrenCache}))` 依赖 tree/expanded/childrenCache/applyWatchSet）+ handleRefresh 保留 expanded。
- **`workspace-api.ts` L107**：`watchWorkspaceSet` POST `/session/:id/workspace/watch-set` body `{ clientId, paths }`。

### T2 — 服务端 watch-set diff + 泄漏收敛（commit 3ce9dc19）

- **`workspace-watch-registry.ts`**：`setTabSet` 全量 diff（added/removed）+ 空集清 key + 幂等 + **纯记账**（不直接改 refcount，caller 调 refInc/refDec）+ takeTabDirs/takeSessionTabs 回收原语。
- **`session-workspace-manager.ts`**：`applyWatchSet`（resolve 全部 relDir → absDir 越界/不存在跳过 → setTabSet diff → added openIfFirstRef / removed closeIfZeroRef）+ **泄漏收敛**（refcount 归零即关）+ 多 tab 合并 + opQueues 串行化 + 4 条回收路径（releaseTab/recycleSession/switchDir/stopAll）。
- **`handlers/session-workspace-watch.ts`**：`handleWorkspaceWatchSet`（clientId 400 + paths 数组校验 + 逐 path resolveWatchTarget 越界 400/不存在跳过 + **realRoot = realpathSync(workspaceDir)** symlink 基准）+ 返回 200 `{ok:true}`。
- **`workspace-dir-watcher.ts` depth:0 零改动** + **`workspace-change-emitter.ts` 100ms debounce 契约不变**（R2 零改动）。

### 测试

`workspace-watch-set.test.ts` / `workspace-watch-registry.test.ts` / `session-workspace-manager.test.ts`（纯函数 + registry diff + manager 收敛路径）。

## 代码↔spec 核实（doc-modifier 阶段 5，14 项）

| # | 契约点 | 核实结果 |
|---|--------|----------|
| 1 | 关注集合 = 打开节点自身 + 一级子文件夹（含空） | ✅ computeWatchSet 根 '' 恒含 + tree 筛 dir 根一级 + expandedPathsByDepth 自身 + childrenCache 筛 dir 子一级 |
| 2 | 全量重算 + diff | ✅ setTabSet `newSet−oldSet` / `oldSet−newSet`，交集不动 |
| 3 | 不在新集合一律 close | ✅ applyWatchSet removed → closeIfZeroRef（refcount 归零即关） |
| 4 | 多 tab refcount 合并 | ✅ registry tabDirs + dirRefcount；removed 但其他 tab 持有 → 不 close |
| 5 | 4 条回收路径 | ✅ releaseTab / recycleSession（session_panel 1→0 兜底）/ switchDir / stopAll |
| 6 | realRoot symlink 基准 | ✅ handler realpathSync(workspaceDir)，watch/unwatch/watch-set 三端点共用 resolveRoot |
| 7 | watch/unwatch 增量兼容保留 | ✅ 增量幂等保留（release-all 无 path 仍用） |
| 8 | 幂等 | ✅ 同集合再调 → diff 全空 → no-op（前端两次 applyWatchSet 场景安全） |
| 9 | 时序幂等（rootTree/childrenCache 未到） | ✅ 先发 {根} 后补 {根一级}；展开后先发 {自身}、GET 成功后补 {子一级} |
| 10 | 切目录清 expanded | ✅ handleSwitchDir dir-changed → applyWorkspaceDirChanged 清 expanded/tree/childrenCache/stalePaths + loading |
| 11 | handleRefresh 保留 expanded | ✅ resetForRefresh 保留 expanded + 逐层补 childrenCache |
| 12 | watchPath/unwatchPath 零残留 | ✅ 前端 grep 零引用（声明式替换验证） |
| 13 | handler 校验 | ✅ 缺 clientId 400 / paths 非数组 400 / 元素非 string 400 / 逐 path 越界 400 / 不存在静默跳过 / 200 {ok:true} |
| 14 | depth:0 + emitter 契约不变 | ✅ dir-watcher L52 depth:0 / emitter 100ms debounce + session_workspace_file_changed 不变 |

## 偏离记录

1. **路由落点补接线（coder3 偏离 ①，已报）**：change_plan 未列，但 watch-set 端点需路由——`session-routes.ts` L147-149 + `router-helpers.ts` L97-99 regex 补 watch-set。**必要等价**（不加则端点 404），非行为偏离。
2. **realRoot symlink 发现（coder3 findings）**：handler 用 `realpathSync(workspaceDir)` 作 realRoot——macOS `/var` vs `/private/var` symlink 记账一致；三端点（watch/unwatch/watch-set）共用 resolveRoot。change_plan 未显式列，属实现正确性增强。

## 文档同步（doc-modifier T3）

- `specs/tech/agent/session/[P0]session_workspace_manager.md`：§1/§3/§5/§6/§9/§10/§11 更新（声明式 watch-set 模型）+ frontmatter updated。
- `specs/tech/agent/session/index.md`：概念行 10 + 导航行（v0.0.139+v0.0.271）；`log.md` 加 v0.0.271 条目。
- `specs/api/overall/04-agent-session.md`：§2.6.5 加 watch-set 端点契约 + version 头 2.7。
- `specs/ui/components/chat-page/component-workspace-panel.md`：§4.3 前端接线（展开/收起 → state → 重算 effect → watch-set）+ 关注集合语义 + 时序幂等 + 切目录清 expanded。
- `specs/ui/overall/00-app-guide.md`：ws-panel 操作路径补「空文件夹感知」（内部新增内容实时可见）。

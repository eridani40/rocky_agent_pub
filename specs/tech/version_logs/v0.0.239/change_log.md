# v0.0.239 tech change_log — session 工作区 file tab 文件自然排序（numeric-aware，对齐 VSCode）

> 类型：纯前端 UI 改动（web/ 渲染层 lib util + store reducer ingest）。无 schema / EP / 插件 manifest / 后端 / API 契约变更。
> 权威变更契约见同目录 `change_plan.md`（method 级 5 行：natural-sort.ts NEW 2 函数 + reducer 两 ingest 各 +sort + spec §4.5 新增小节）。PRD：`specs/prd/version_logs/v0.0.239/change_log.md`。

## 影响子系统 KB

| KB | 改什么 |
|----|--------|
| `specs/tech/app/frontend/` | `index.md` ① 加「workspace 文件树自然排序」概念行（`lib/natural-sort.ts` 比较器 + reducer ingest 落点）+ ④ 加原则 24（排序落 reducer ingest = state invariant，非渲染层）+ frontmatter `updated`；`log.md` v0.0.239 条目（含代码↔spec 一致核查结论 + OUT OF SCOPE 明示）+ frontmatter `updated` |

> 未触其他 tech KB：后端零变更（D2 排序纯前端）→ `agent/session/` workspace handler 零动；`persistence/` / `plugin_system/` / `config/` 等均不沾。

## 摘要

### ① natural-sort.ts 自定义分段比较器（change_plan 行 1-2）

`app/web/src/lib/natural-sort.ts` NEW——两个纯函数：

- `compareNaturalNames(a, b)`：拆交替「文字段 + 数字段」chunk 序列逐段比较——文字段大小写不敏感字符串序 / 数字段数值序（`90<100`）/ **同值不同格式按原 digit 字符串兜底**（`'09'<'9'` 因 `'0'<'9'`，与 VSCode 一致）。返回 -1/0/1。
- `compareWorkspaceNodes(a, b)`：先按 `node.type` 分组（`type==='dir'` 置顶，dir<file）再同组内 `compareNaturalNames(name)`。

**为何不用 `localeCompare(b, undefined, {numeric:true})`**：orchestrator 实测该 API 对 `9.txt` vs `09.txt` 返 0（不兜底）；用户要确定性文字兜底（D 决策基线）→ 自定义分段实现。`noUncheckedIndexedAccess` 下用 `s.charCodeAt(i)` 封 `isDigitAt`（越界返 NaN，比较全 false 天然安全）替代 `s[i]>='0'` 字符比较。UT 21 case 覆盖边界。

### ② 排序落 reducer ingest = state invariant（change_plan 行 3-4）

`app/web/src/store/workspace-slice-reducer.ts` 两 ingest 点各 `[...arr].sort(compareWorkspaceNodes)` 复制后排序（不突变 caller 入参）：

- `setTreeLoaded`（L99）：ingest 顶层 `state.tree`
- `setChildrenLoaded`（L118）：ingest 子目录 `state.childrenCache[parentPath]`

把「已排序」升级为 state invariant，满足 PRD §6.3 三条件：① 数据进渲染前必经排序（reducer 是 state 写入唯一入口）；② 缓存命中也有序（`childrenCache` 写入时已排，折叠再展开走缓存直接有序）；③ SSE stale 重取走同一 ingest（`applyWorkspaceFileChanged` 标 stale → 组件 effect 监测已展开父 → `onStaleRefetch` 重 GET → 又走 setTreeLoaded/setChildrenLoaded → 自动有序，无额外分支）。渲染层 `component-ws-file-tree.tsx TreeLevel` 零 `.sort`（grep 核实 0 命中，避免双重排序）。

### ③ spec 同步（change_plan 行 5）

`specs/ui/components/chat-page/component-workspace-panel.md §4.5`（coder 编码前置已补）声明排序规则 + type 枚举 + 三条件 + 不变更项；`specs/ui/overall/00-app-guide.md §3.1` workspace panel 行加自然序观察口径（用户手册准确）。

## 代码↔spec 一致性核查（doc-modifier 阶段 5）

| spec 声明（§4.5） | 代码实现 | 结论 |
|---|---|---|
| reducer ingest（setTreeLoaded/setChildrenLoaded）排序 | grep `sort(compareWorkspaceNodes)` 命中 2 处（L99 + L118） | ✓ |
| dir<file 文件夹置顶 | `compareWorkspaceNodes` `aIsDir ? -1 : 1` | ✓ |
| type 枚举 `'file' \| 'dir'` | `workspace-types.ts` L17 + 后端 `session-workspace.ts` + `component-ws-file-tree.tsx` 三处一致 | ✓ |
| 三条件（必经/缓存命中/SSE 同 ingest） | reducer 唯一写入入口 + childrenCache 写入已排 + onStaleRefetch→同 ingest | ✓ |
| 渲染层零排序 | `component-ws-file-tree.tsx` grep `.sort` = 0 命中 | ✓ |

无静默偏离。

## 显式不变（OUT OF SCOPE）

| 文件 / 接口 | 不变原因 |
|---|---|
| `app/server/src/handlers/session-workspace.ts` `handleWorkspaceTree`（`readdirSync` 原样返） | 后端零变更（D2：排序纯前端）；OS 字节序根源不动 |
| `app/web/src/lib/chat-api/workspace-api.ts` `getWorkspaceTree` | HTTP 客户端纯透传 |
| `app/web/src/components/chat-page/component-ws-file-tree.tsx` `TreeLevel` | 渲染层零排序（落点在 reducer） |
| `app/web/src/components/common/file-tree.ts`（技能管理页） | OUT OF SCOPE（同问题但用户铁律「只做 query 要求的」） |
| `specs/api/overall/04-agent-session.md` §2.6 workspace 端点 | API 契约零变更（排序不进接口） |
| chokidar watch / SSE event payload / stalePaths 机制 | watch/SSE 行为零变更 |

## 持续可打包护栏自检

纯前端 UI 改动（lib util + reducer），不触后端 / 不触 plugin / 不触 runtime-config / 不触路径展开——packaged 专属四陷阱（依赖归属 / plugin asar / 运行时配置注入 / 路径展开）全部不沾，dev=packaged 行为一致，无需 packaged 版验证。

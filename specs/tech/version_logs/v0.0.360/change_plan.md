# v0.0.360 变更计划书 — workspace 搜索 symlink 受控跟随 + 单一后端语义收敛

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 0. 需求与拍板（老板 2026-08-15 19:07 报 + 19:23 立项）

squad 形态下项目代码经 `project` symlink 进入团队盘（workspaceDir = squads/{sid}/），workspace 搜索核心对 symlink→目录一律剪枝 → 全员 mention @ 搜索 + 工作区搜索对项目文件整体失效。老板拍板：**所有文件发现入口（mention/搜索/文件树）复用同一个 workspace 搜索服务**。req：`reqs/[working] v0.0.360.workspace-search-symlink-follow.md`；根因：`outputs/bugs/mention-search-missing-log-files-root-cause.md`。

## 1. 方案设计

### 1.1 安全模型：对齐树端点「链式授权」（老板需过目）

v0.0.320 搜索剪枝的设计初衷是防越权/防循环，但与 v0.0.263 树端点已确立的授权模型冲突。树端点安全模型（spec §2.6.5/§2.6.6 已冻结，穿越攻击语义不变）：

> workspace 内存在的 symlink = 用户放置 = 用户显式意图 = **授权**（链式授权解析：逐段 lstat 判 symlink → realpath 授权目标为继续解析根）。

搜索侧对齐同一模型（**方案 A 受控跟随**）：

| # | 约束 | 实现 |
|---|---|---|
| C1 | symlink→dir **跟随递归** | walkSearch 对 symlink→dir 与普通目录同递归（`!isSymlink` 门移除） |
| C2 | **防循环** | `Set<string>` visited（realpath 归一化绝对路径）；每 dir（含经 symlink 进入的）递归前 add+查重，重复 → skip。祖先/自指链接 realpath 归一后同路径 → 天然剪掉 |
| C3 | **授权语义**（防越权） | workspace 内 symlink = 授权（与树链式授权同模型）。**无 root 子树强制约束**——squad 的 project symlink 目标（项目根）必然在 squad 盘外，强制「目标在 root 子树内」字面执行则 bug 修不了。防越权由「symlink 必须出现在 workspace 内才能被遍历到」这一结构性约束承担（与树端点一致：用户不放置链接，搜索不可达 workspace 外） |
| C4 | **broken symlink** | realpathSync 失败 → skip（沿用现有 statSync 失败 skip 语义） |
| C5 | IGNORED_NAMES | 不变（node_modules/.git 不遍历——项目内 node_modules 依然排除，搜索面不爆炸） |
| C6 | symlink→file | 不变（可列入 files，现状已支持） |

> 需向老板报告的取舍：C3 未强制「目标必须在 workspace root 子树内」。若强制子树约束，squad project symlink（目标=外部项目根）会被跳过 → 主诉求（项目文件可搜）落空。对齐树端点「放置即授权」模型是唯一能同时满足需求与既有安全语义的解。攻击面评估：用户能写 workspace 即能建 symlink 指向任意目录（树端点 v0.0.263 起已可浏览），搜索跟随不引入新攻击面——读面 = 树可浏览面（一致性而非扩大）。

### 1.2 收敛判定：树端点不合并（语义不同，非重复实现）

| 入口 | 语义 | 结论 |
|---|---|---|
| mention @ 搜索 / 工作区搜索框 | **递归全量搜索**（match→返回路径） | 已共用 `searchWorkspace`（v0.0.346 收敛），本版只改核心 symlink 语义，两链同时修复 ✅ |
| 文件树端点 | **单层懒加载列举**（parent 指定层 + isSymlink/linkTarget 元数据 + whitelistResolve 逐段授权） | **不合并**。搜索=递归匹配、树=单层导航+节点元数据（isSymlink/linkTarget/hasChildren），API 形状与语义都不同；树本就跟随 symlink，与修复后搜索语义自然一致 |

老板口径「复用同一个后端服务」的落点 = 搜索两链共用核心（已达成）+ symlink 语义统一（本版 C1-C6）。「遍历/搜索合一」评估结论：**不合理也不需要**——合一会把单层导航（树）强扭成递归匹配或反之，破坏两端 API 契约；语义一致后两者已是「同一文件发现模型」的两个投影视图。此判定为架构决策，不再分期实施树合并。

### 1.3 实现切面（单文件核心 + 两消费方零改动）

`searchWorkspace(rootDir, q, opts)` 内部 walkSearch 增加 visited 传递（参数追加或闭包捕获，实现自选，接口签名不变）。`session-workspace-search.ts` / `file-provider.ts` **零改动**（同为 `searchWorkspace` 调用方，语义随核心升级）。walkSearch 是纯函数 DFS + `Set` 参数追加，无状态引入。

## 2. 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| search | app/server/src/search/workspace-search-core.ts | walkSearch | 修改 | 移除 `!isSymlink` 递归门（L86-90）→ symlink→dir 同普通目录递归；新增 `visited: Set<string>` 防循环（递归前 realpathSync 归一化 add+查重，失败=broken → skip）；文件头注释 §安全面措辞同步 | MUST：C1-C6 六约束全落地；MUST NOT：接口签名/返回形状/IGNORED_NAMES/pathMode/早停逻辑零改动 | 本表 §1.1；树链式授权 spec §2.6.5 | +18/-4 |
| search | app/server/src/search/__tests__/workspace-search-core.test.ts | it('symlink 目录不递归…') | 修改 | 翻转为两分支：①「symlink→dir 递归跟随：link/secret-helper.txt 经 workspace 内 symlink 可命中」（含出 workspace 目标跟随，授权语义）；②「循环引用 self 不死循环：realpath 去重生效，正常返回」 | MUST：断言出 workspace 目标内文件**可**命中（语义翻转核心）；afterEach 清理 tmpRoots 沿用 | 既有 :135 用例 | +30/-8 |
| search | app/server/src/search/__tests__/workspace-search-core.test.ts | it 新增 | 新增 | 「多级 symlink 链」：a→b→file（链式授权逐段跟随）+「符号链回到祖先」（realpath 去重剪枝）双断言 | MUST：真实 fs（mkdtemp+symlinkSync），不 mock | 同上 | +22 |
| handlers | app/server/src/handlers/__tests__/session-workspace-search.test.ts | it('[安全] symlink 目录不跟随递归…') | 修改 | 翻转：出 workspace 目标内文件可搜到（授权）+ 循环不死循环 两断言；用例名改「[安全] symlink 受控跟随（防循环；目标跟随=链式授权）」 | MUST：走真实 handler（deps stub 沿用） | 既有 :195 用例 | +12/-6 |
| api-spec | specs/api/overall/04-agent-session.md | §2.6.8 行为 6 | 修改 | 措辞改：「symlink 目录**受控跟随**（v0.0.360 起与 tree 链式授权同模型：workspace 内 symlink = 用户放置 = 授权，目标可在 workspace 外）；realpath visited 防循环；broken symlink 跳过；symlink→file 可列入」+ 行为 8 上限 200→100 勘误（代码 SEARCH_LIMIT=100 单一源） | MUST：与本表 §1.1 C1-C6 逐条对齐 | 本表 §1.1 | +6/-3 |
| api-spec | specs/api/overall/04-agent-session.md | §2.6.8 示例后 AT 注记 | 修改 | 补一句：v0.0.360 symlink 跟随语义由 UT 覆盖（handler 层 session-workspace-search.test.ts），AT case 不新增（既有 workspace_search_tc3 搜索行为回归即可） | — | 本表 §3 | +1 |

## 3. 影响面评估

- **跨模块**：仅 search 核心单文件语义升级，两消费方（mention file-provider / 工作区搜索 handler）零改动自动受益。无新依赖、无接口变化、无循环依赖。
- **破坏性变更**：行为语义翻转（搜索可见面扩大 = bug 修复本体）。既有 UT 3 处断言翻转（core :135 / handler :195 / file-provider 无 symlink 断言仅注释核对）。
- **风险点**：①搜索耗时上升——大目录树（项目经 symlink 进入）首次全量 DFS 变慢；早停 limit=100 + IGNORED_NAMES 排除 node_modules 兜底，可控；②realpath per-dir 开销——每目录一次 realpathSync，实测 fs 常数级，可接受；③spec 旧措辞「不跟随出 workspace」在 v0.0.320 change_log 等历史文档中存在——历史版本日志不改写（版本轴历史禁改写），仅 overall 现行契约同步。
- **验证**：UT 必须（3 文件翻转+新增）；AT 豁免新增 case（确定性契约，UT 覆盖足够）；ET 豁免（无 UI 变化）。验证在 worktree 跑 `bun run test` 全量 + tsc -b。

## 4. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

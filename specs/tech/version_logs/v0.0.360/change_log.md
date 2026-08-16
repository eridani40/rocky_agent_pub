# v0.0.360 change_log — workspace 搜索 symlink 受控跟随（链式授权对齐树语义）

> 需求：老板 2026-08-15 19:07 报 + 19:23 立项（`reqs/[working] v0.0.360.workspace-search-symlink-follow.md`）。
> 根因：`outputs/bugs/mention-search-missing-log-files-root-cause.md`（两链已共用 searchWorkspace，分叉在树跟随 vs 搜索剪枝语义）。
> 权威契约：`specs/tech/version_logs/v0.0.360/change_plan.md`（frozen，§1.1 安全模型 C1-C6 + §2 六行变更清单）。
> commit：`94f87dde7`（T1 实现）/ `665a2b405`（T1 code-review 报告，CONDITIONAL PASS）/ `f6bc306e8`（review Minor×2 修复）。

## 变更摘要

squad 形态下项目代码经 `project` symlink 进入团队盘（workspaceDir = `squads/{sid}/`），搜索核心对 symlink→dir 一律剪枝 → 全员 mention @ 搜索 + 工作区搜索对项目文件整体失效。老板拍板所有文件发现入口复用同一搜索服务；本版将搜索核心 symlink 语义对齐树端点 v0.0.263 链式授权。

| 决策 | 内容 |
|---|---|
| ① 受控跟随（方案 A） | symlink→dir 与普通目录同递归；授权 = 「workspace 内 symlink = 用户放置 = 授权」（目标可在 workspace 外，如 squad `project` 链接）；与树端点链式授权同模型，读面 = 树可浏览面（一致性而非扩大） |
| ② 防循环（非剪枝） | `visited: Set<string>`（realpathSync 归一化绝对路径）；祖先/自指/环归一后同路径 → 跳过；visited 单实例贯穿整棵搜索 |
| ③ 条目路径基于 realDir 拼接 | absDir 经链接进入时 `absDir/name` 不可达，`realDir/name` 才是真实文件系统位置——review 论证为唯一正确解，非优化 |
| ④ 树端点不合并 | 搜索=递归匹配、树=单层懒加载导航+节点元数据，API 形状与语义都不同；语义一致后两者是「同一文件发现模型」的两个投影视图（架构决策，不再分期） |
| ⑤ 消费方零改动 | `file-provider.ts` / `session-workspace-search.ts` 同为 `searchWorkspace` 调用方，语义随核心升级自动受益 |

## 实现核对（T1）

| 计划项 | 实现一致性 |
|---|---|
| walkSearch 递归门移除（C1） | ✅ `!isSymlink` 门删除；`statSync` 跟随链接的 `isDirectory()` 为唯一分支判据，isSymlink/lstatSync 死代码全删 |
| visited 防循环（C2/C4） | ✅ 每目录入口 `realpathSync` → `visited.has/add`；readdir/stat/realpath 失败 → 跳过该分支（broken 链两路兜住）；条目路径改 `join(realDir, name)` |
| 链式授权（C3） | ✅ 无 root 子树强制约束；防越权由「symlink 必须出现在 workspace 内才可达」结构性约束承担（与树端点一致） |
| C5/C6 不变 | ✅ IGNORED_NAMES 原样；symlink→file 走 files 分支无区分 |
| UT 翻转+新增 | ✅ core `:135` 翻转为「受控跟随」+「循环」两分支 + 新增多级链/祖先回环（真实 fs：mkdtemp+symlinkSync 无 mock）；handler `:195` 用例名改「[安全] symlink 受控跟随」+ 断言翻转 |
| api-spec §2.6.8 | ✅ 行为 6 受控跟随措辞 + 行为 8 上限 200→100 勘误（SEARCH_LIMIT=100 单一源，v0.0.324 下调）+ AT 注记（symlink 语义 UT 覆盖，AT 不新增） |
| 影响行 | ✅ core +18/-4 与计划精确吻合；消费方 `git diff 3771246c8..94f87dde7 -- <两消费方>` 为空 |

## 实现偏差（以代码为准）

1. **UT 布局偏离**（coder 报备，review 判定合理必要）：翻转用例删去旧版 `self`+`inside-helper` 与新增 `link` 的共存布局——readdir 顺序非确定时「目录命中不递归」规则可能吞掉 link 下结果造成闪烁；改为受控跟随用例单入口、循环用例独立自包含，断言全部不依赖 readdir 顺序。
2. **review Minor×2**（`f6bc306e8`，reviewer 直接修复）：① `workspace-search-core.ts` lstatSync 死 import + 头注释 fs API 清单同步；② `session-workspace-search.ts` 两处「symlink 目录不跟随出 workspace」过时注释更新为受控跟随语义。
3. **知悉项（review §3，无需行动）**：DFS 先序 + visited 全局去重 ⇒ 多入口链接到同一真实目录时仅首个链接名下返回，其余链接名不展开（去重语义自然结果，change_plan 未规定逐入口独立展开；对主诉求 squad 单 `project` 链接无影响）。

## 根因边界声明

本版修复「搜索核心 symlink 剪枝与树端点链式授权语义分叉」这一根因（v0.0.320 搜索引入时的保守设计），受控跟随 + realpath 防循环覆盖祖先回环/自指/多入口共享目标/broken 链全部已知形态（UT+probe 实证）。不承诺消除符号链接相关的全部边界行为（如上述多入口去重语义属设计选择而非缺陷）；长期方向：文件发现入口（mention/搜索/树）语义模型继续以链式授权为基准演进。

## 验证

UT 必须（已跑）：全量 890 文件 / 10844 tests 绿 + 定向 23/23（reviewer 独立复跑）+ tsc exit 0；reviewer 另做独立实证 probe（三层链/兄弟链接/alias 场景）。AT/ET 豁免（确定性契约 + 无 UI 变化，change_plan §3 拍板）。

## 标准沉淀

- **symlink 语义单基准**：文件发现三入口（mention @ 搜索 / 工作区搜索 / 文件树）symlink 语义统一为链式授权（workspace 内放置 = 授权，目标可在外）；后续任何新文件发现入口必须复用 `workspace-search-core.searchWorkspace` 或对齐该模型，禁止回退剪枝措辞。
- **防循环范式**：递归遍历目录树防 symlink 循环用 realpath 归一化 visited 集合（不用 lstat 剪枝）。

## 关键文件

| 文件 | 变更 |
|---|---|
| `app/server/src/search/workspace-search-core.ts` | walkSearch 受控跟随 + realpath visited + realDir 拼接 + 头注释（+50/-39 累计含 Minor） |
| `app/server/src/search/__tests__/workspace-search-core.test.ts` | 翻转两分支 + 多级链/祖先回环新增（+52） |
| `app/server/src/handlers/__tests__/session-workspace-search.test.ts` | 授权跟随断言翻转 + 用例名改（+15/-7） |
| `app/server/src/handlers/session-workspace-search.ts` | 仅注释（Minor-2，受控跟随措辞） |
| `specs/api/overall/04-agent-session.md` | §2.6.8 行为 6/8 + AT 注记（+8/-8 段内） |

## 文档同步（doc-modifier，本版本）

- **`specs/api/overall/04-agent-session.md` §2.6.8**：coder 随 T1 已同步（行为 6/8/AT 注记），doc-modifier 复核与代码一致 ✅，无追加改动。
- **`specs/tech/mention/provider-interface.md` §5**：FileProvider 共用核心段的「symlink 目录不递归防越权/循环」→ 受控跟随措辞（同步 fs API 清单：lstatSync→realpathSync）。
- **`specs/tech/mention/search-api.md` §5**：FileProvider 适配层段补 symlink 受控跟随一句（此前未提，现补齐与 API 契约一致）。
- **`specs/tech/mention/log.md`**：加 v0.0.360 变更块（KB 位置轴）。
- **全局 change_log 索引**：specs/ 无全局索引文件（历史版本同样无），不新建——per-KB log + version_logs 目录即索引，与既有惯例一致。
- **消费方一致性**：树端点 spec §2.6.1/§2.6.2 链式授权措辞（v0.0.263 冻结）与本版搜索 §2.6.8 行为 6 同语义模型，无矛盾表述 ✅。
- **历史 version_logs 不改写**：v0.0.320 change_log「不跟随出 workspace」等旧措辞按「版本轴历史禁改写」保留（change_plan §3 风险点 ③ 已拍板）。

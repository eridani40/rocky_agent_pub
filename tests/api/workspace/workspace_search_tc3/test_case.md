# workspace_search_tc3

- 版本：v0.0.320 文件预览区
- 模块：workspace
- 设计：api-test-designer
- 契约依据：specs/api/version_logs/v0.0.320/change_log.md §1.3 + specs/api/overall/04-agent-session.md §2.6

## 目标

验证 `GET /session/:id/workspace/search?q=`：
命中文件/目录返回相对 workspaceDir 的 POSIX 全路径、忽略 node_modules/ 与 .git/、
空 q → 400、无匹配 → 200 空数组（非 404）。

## 前置（setup）

1. `POST /session {title}` → 200，取 `sid`（workspaceDir 自动建）
2. files 原语植入 fixture：
   - `workspaces/{sid}/src/helper.ts`（命中 q=helper）
   - `workspaces/{sid}/src/utils/helper-utils.ts`（命中 q=helper）
   - `workspaces/{sid}/src/helper-dir/readme.md`（目录 src/helper-dir 命中 q=helper）
   - `workspaces/{sid}/node_modules/pkg/helper.js`（**若不忽略会命中** —— 验证 ignore）
   - `workspaces/{sid}/.git/helper-config`（**若不忽略会命中** —— 验证 ignore）

## 步骤与断言

| # | 请求 | 断言 |
|---|------|------|
| 1 | `GET search?q=helper` | 200；`.files exists` + `.dirs exists`；`.files[] any . == "src/helper.ts"`；`.files[] any . == "src/utils/helper-utils.ts"`；`.dirs[] any . == "src/helper-dir"`；`.files[] all !~= "node_modules"`；`.files[] all !~= ".git"` |
| 2 | `GET search?q=` | **400**；`.error exists` |
| 3 | `GET search?q=zzz-no-match` | 200；`.files exists` + `.dirs exists`（空数组，非 404） |

## teardown

- `DELETE /session/{sid}`（204/404 容忍）

## 设计权衡（AT 边界）

- **ignore 验证是强断言**：node_modules/pkg/helper.js 与 .git/helper-config 的 basename 均含
  "helper"，若 ignore 失效会出现在 files[] 中 → `all !~= "node_modules"` / `all !~= ".git"` 必 fail。
- **dirs 命中**：src/helper-dir 目录 basename 含 "helper" → dirs[] 应含 "src/helper-dir"。
- **truncated（200 条上限）不断言**：需 200+ 文件 fixture，超出 AT 合理范围 → UT 覆盖。
- **大小写不敏感子串匹配**：q 用小写 "helper"，fixture 用全小写 basename，
  不专门构造大小写混合（契约语义由 UT 覆盖）。
- 不调 LLM，全确定性。

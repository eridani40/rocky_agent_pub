# v0.0.324 API Change Log — 文件树搜索交互升级

> 对应 PRD：`specs/prd/version_logs/v0.0.324-file-tree-search-filter-tree.md`
> 对应 change_plan：`specs/tech/version_logs/v0.0.324/change_plan.md` D1

## §1 变更摘要

### §1.1 GET /session/:id/workspace/search — 搜索语义升级

| 项 | v0.0.320（现状） | v0.0.324（变更后） |
|----|------------------|-------------------|
| 匹配模式 | basename substring（大小写不敏感） | q 不含 `/` → basename 不变；q 含 `/` → 完整相对路径 substring |
| 上限 | 200 条（files+dirs 合计） | **100 条** |
| 返回格式 | `{files: string[], dirs: string[], truncated?: boolean}` | **不变** |
| 安全面 | whitelistResolve + ignore node_modules/.git | **不变** |

### §1.2 行为变化明细

**路径匹配**（q 含 `/`）：
- 匹配目标从 `name`（basename）切换为 `relChild`（相对 workspaceDir 的完整 POSIX 路径）
- 示例：q=`auth/login` 命中 `src/auth/login.ts`（relChild=`src/auth/login.ts` 含子串 `auth/login`）
- 示例：q=`src/auth` 命中 `src/auth/` 及其路径含 `src/auth` 的所有后代
- 文件和目录都覆盖

**上限降低**：
- `SEARCH_LIMIT` 常量 200→100
- 达到 100 条时 `walkSearch` 返回 true（停止递归）→ `truncated: true`

### §1.3 不变项

- 端点路径：`GET /session/:id/workspace/search?q=`
- 请求参数：`q`（必填非空，trim 后空串 → 400）
- 响应格式：`{files: string[], dirs: string[], truncated?: boolean}`
- 错误码：405 非 GET / 404 session / 400 q 空 / 500 workspaceDir 不可读
- 安全面：realpath + whitelistResolve 根校验 + IGNORED_NAMES（node_modules/.git）
- symlink→dir 一律不递归（防越权/循环）
- 目录命中后不递归其下层（返 dir 路径本身）

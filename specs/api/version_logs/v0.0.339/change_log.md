# v0.0.339 — API Change Log（文件打开分流：workspace stat 端点）

> 增量变更。全量权威：`specs/api/overall/04-agent-session.md` §2.6。
> 权威输入：`specs/prd/version_logs/v0.0.339-file-open-strategy.md` + `specs/tech/version_logs/v0.0.339-file-open-strategy/change_plan.md`（A1-A3）。
> **后端边界（MANDATORY）**：仅 1 处变更——新增 `GET /session/:id/workspace/stat`。其余（tree/watch/file/save/search/open）零改。

## §1 变更端点

### 1.1 `GET /session/:id/workspace/stat` — workspace 文件大小判定（v0.0.339 新增）

**动机**：前端打开分流（`openLocalPath` 文本分支）需在打开前判定文件大小——`>5MB` 系统打开 / `≤5MB` 内置编辑。独立 stat 端点最小且只返 size 不读内容（>5MB 大文件先读再判大小 = 本末倒置）。

**契约变更**：

| 方法 | 路径 | 语义 | query | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/session/:id/workspace/stat` | workspace 文件 stat（大小判定用；只 stat 不读内容） | `path`（相对 workspaceDir） | `200` + `{ size: number }` |

```typescript
// GET query param
path: string;   // 相对 workspaceDir（同 §2.6.7 file read path）

// 成功响应
interface WorkspaceStatResponse {
  size: number;   // 文件字节数（statSync st.size）
}
```

**错误码**：

| 状态 | 场景 |
|------|------|
| `400` | query `path` 缺失/空串；路径穿越（`../` / 绝对路径，whitelistResolve traversal） |
| `404` | session 不存在；路径 whitelist not_found；statSync 失败（不存在/无权限）；**目录**（stat 端点只服务文件大小判定） |
| `405` | 非 GET（Allow: GET） |
| `500` | session 无 workspaceDir / workspaceDir 不可读 / realpath 异常 |

> 路径解析复用 `resolveWsFilePath` 白名单安全链（与 §2.6.7 file read 同一安全面，不新写路径解析）；只 `statSync` 不读文件内容。

## §2 文件变更清单

| 文件 | 类型 | 变更 |
|------|------|------|
| `app/server/src/handlers/session-workspace-file.ts` | 修改 | +`handleWorkspaceStat`（GET 校验 → getSession → path 校验 → resolveWsFilePath → statSync → {size}） |
| `app/server/src/routes/router-helpers.ts` | 修改 | workspace alternation 加 `stat` → sub `workspace_stat` |
| `app/server/src/routes/session-routes.ts` | 修改 | +`workspace_stat` 分发分支 |

## §3 前端消费

| 消费方 | 调用 |
|--------|------|
| `app/web/src/lib/chat-api/workspace-api.ts` | +`statWorkspaceFile(sessionId, path, base?)` → `req<{size:number}>(...)` |
| `app/web/src/lib/open-local-path.ts` | 文本分支 `getSize` → workspace 源走 `statWorkspaceFile`（absolute 源走 `shell:stat` IPC，非本 spec 范围） |

## §4 AT 覆盖

| 用例 | 端点 | 断言 |
|------|------|------|
| stat 正常 | GET stat?path= | 200 + `{size}` 匹配 seed 文件字节数 |
| stat 不存在 | GET stat?path=missing | 404 |
| stat 越界 | GET stat?path=../x | 400 |
| stat 非 GET | POST stat | 405 |
| stat path 缺失 | GET stat | 400 |

> AT 实现：`tests/api/workspace/workspace_stat_tc4/case.yaml`（v0.0.339 新增，5 态断言）。

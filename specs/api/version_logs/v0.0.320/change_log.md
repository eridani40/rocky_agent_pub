# v0.0.320 — API Change Log（文件预览区：file version + save 冲突 + workspace 搜索）

> 增量变更。全量权威：`specs/api/overall/04-agent-session.md` §2.6。
> 权威输入：`specs/prd/version_logs/v0.0.320-file-preview.md` §3.3（后端仅 3 处变更）+ `specs/tech/version_logs/v0.0.320/change_plan.md`（D9/D10）。
> **后端边界（PRD §3.3 MANDATORY）**：仅 3 处变更——①GET file 加 version ②POST save 加 expectedVersion/force/409 ③新增 GET search。其余（tree/watch/read binary/open）零改。

## §1 变更端点

### 1.1 `GET /session/:id/workspace/file` — 响应加 `version`（v0.0.320）

**动机**：预览区编辑需 VSCode 式冲突检测——前端保存时带读到的版本标记，后端比对当前文件版本，不一致 → 409 提示用户取消（重载）/覆盖（force）。

**契约变更**：

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id/workspace/file` | 读 workspace 内文件内容（**新增 version 字段**） | `200` + `{ content: string, version: string }` |

```typescript
// GET query param（不变）
path: string;      // 相对 workspaceDir 的路径
binary?: string;   // '1' = 二进制通道（base64）；缺省/非 '1' = UTF-8 文本

// 成功响应（v0.0.320 新增 version）
interface ReadFileResponse {
  content: string;   // UTF-8 文本内容（binary=1 时 base64）
  version: string;   // [v0.0.320] 文件版本标记 = `${mtimeMs}:${size}`（如 "1750000000000:1234"）
}
```

**约束**：
- `version` = `statSync(absPath).mtimeMs + ':' + statSync(absPath).size`（mtimeMs 毫秒时间戳 + 字节数，冒号拼接；mtime 变化或 size 变化均导致 version 变化）。
- **binary=1 分支不加 version**（image viewer 无冲突语义，保持 `{ content }` 不变）。
- **向后兼容**：version 为**新增字段**，旧消费方忽略即可；旧后端缺 version 字段 → 前端跳过冲突检测降级 last-write-wins（PRD §5.3）。
- 其余行为（405/404/400/500 + 路径白名单）零改。

**示例**：
```bash
curl "http://127.0.0.1:3710/session/01KV.../workspace/file?path=docs/notes.md"
# → 200 {"content":"# Notes\n\n...","version":"1750000000000:1234"}
```

### 1.2 `POST /session/:id/workspace/file/save` — 加 `expectedVersion`/`force` + 409 冲突（v0.0.320）

**动机**：保存时校验版本，检测外部（他人/agent）改动。VSCode 参考。

**契约变更**：

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `POST` | `/session/:id/workspace/file/save` | 覆盖写（**带可选版本校验 + 强制覆盖**） | `200` + `{ ok: true, version: string }` |

```typescript
interface SaveFileBody {
  path: string;             // 相对 workspaceDir 的路径（不变）
  content: string;          // 新全文内容（覆盖写，不变）
  expectedVersion?: string; // [v0.0.320] 前端读时拿到的 version；匹配当前文件 → 保存成功；不匹配 → 409
  force?: boolean;          // [v0.0.320] true = 跳过校验强制覆盖（last-write-wins）
}

// 成功响应（v0.0.320 返回 version）
interface SaveFileResponse {
  ok: true;
  version: string;          // [v0.0.320] 写后重新 stat 的新版本标记
}

// 409 冲突响应
interface ConflictResponse {
  error: 'conflict';
  currentVersion: string;   // 当前磁盘文件最新 version（前端可展示/重载用）
}
```

**校验逻辑（MANDATORY 顺序）**：
1. `expectedVersion` 缺失 **或** `force === true` → **跳过校验**，直接覆盖写（last-write-wins，向后兼容旧调用方）。
2. `expectedVersion` 存在且非 force → `statSync` 当前 version → 与 expectedVersion 比对：
   - 匹配 → writeFileSync 覆盖 → `200 { ok: true, version: 写后新version }`。
   - **不匹配 → `409 { error: 'conflict', currentVersion }`，不写盘**（文件内容保持外部改动后的最新状态）。

**约束**：
- `force: true` 或 `expectedVersion` 缺失 → 不校验（向后兼容；academy 旧调用方零影响）。
- 409 响应体固定 `{ error: 'conflict', currentVersion: string }`（error 非人类可读文案，前端据 `error==='conflict'` 分支弹冲突 modal）。
- 写成功响应新增 `version`（写后 stat），前端保存后更新 tab 版本标记（PRD §2.6「保存成功后 tab 版本标记更新为返回的新 version」）。
- `expectedVersion` / `force` 非 string/boolean → 忽略（宽松解析，不 400；对齐现有 path/content 严格校验风格之外的宽松扩展）。
- 路径白名单 / 404 / 405 / 500 零改。

**示例**：
```bash
# 无版本（向后兼容，last-write-wins）
curl -X POST http://127.0.0.1:3710/session/01KV.../workspace/file/save \
  -H 'content-type: application/json' \
  -d '{"path":"docs/notes.md","content":"# New"}'
# → 200 {"ok":true,"version":"1750000000123:456"}

# 带 expectedVersion（匹配 → 成功）
curl -X POST ... -d '{"path":"docs/notes.md","content":"# New","expectedVersion":"1750000000000:1234"}'
# → 200 {"ok":true,"version":"1750000000123:456"}

# 带 expectedVersion（不匹配 → 409 conflict，不写盘）
curl -X POST ... -d '{"path":"docs/notes.md","content":"# New","expectedVersion":"1750000000000:9999"}'
# → 409 {"error":"conflict","currentVersion":"1750000000123:456"}

# force 强制覆盖（last-write-wins）
curl -X POST ... -d '{"path":"docs/notes.md","content":"# New","force":true}'
# → 200 {"ok":true,"version":"1750000000123:456"}
```

### 1.3 `GET /session/:id/workspace/search?q=` — 新增（v0.0.320）

**动机**：工作区搜索框后端补全量——文件树只懒加载已展开层，前端无法全量匹配；后端递归全量搜索文件名/文件夹名。

**契约**：

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id/workspace/search` | 递归全量搜索（文件名 + 文件夹名 substring 匹配，大小写不敏感） | `200` + `{ files: string[], dirs: string[], truncated?: boolean }` |

```typescript
// GET query param
q: string;   // 搜索关键词（非空；空 → 400）

// 成功响应
interface WorkspaceSearchResponse {
  files: string[];        // 文件名匹配的全路径（相对 workspaceDir，POSIX 风格，如 "src/app.ts"）
  dirs: string[];         // 文件夹名匹配的全路径（相对 workspaceDir，如 "src/components"）
  truncated?: boolean;    // [v0.0.320] files+dirs 合计达 200 上限截断时 true（前端提示「结果过多」）
}
```

**行为（MANDATORY）**：
1. method 非 GET → 405（Allow: GET）。
2. `deps.store.getSession(id)` 未命中 → 404。
3. query `q` 缺失 / 空串（trim 后）→ 400 `{ error: 'q required' }`。
4. 取 `session.workspaceDir` 缺失 → 500。
5. `realpathSync(workspaceDir)` → realRoot（异常 → 500）；`whitelistResolve(realRoot, '')` 校验根可读（复用 tree 安全面）。
6. 递归遍历（BFS/DFS 均可）：**跳过 `node_modules` / `.git` 目录**（复用 `session-workspace.ts` IGNORED_NAMES 集合——导出复用或迁移至共享模块）；symlink 目录**跟随**（与 tree 语义一致：workspace 内 symlink = 授权，同 whitelistResolve 授权模型——但搜索仅列出相对路径，不 resolve 目标，**不跟随到 workspace 外**——目录递归时遇 symlink→dir 目标在 workspace 外 → 跳过该 symlink（不递归出界，防循环/越权）；symlink→file 可列入 files）。
7. 匹配规则：`basename(path)` 大小写不敏感 substring 包含 q（`name.toLowerCase().includes(q.toLowerCase())`）。
   - 文件命中 → `files.push(relPath)`
   - 目录命中 → `dirs.push(relPath)`（**不递归其下层**——PRD §2.5「文件夹名匹配的全路径（其下层内容前端一并展示）」= 前端拿到 dir 后展示该目录展开内容，后端只返 dir 路径本身）
8. 上限：files+dirs 合计 **200 条**；超限截断 + `truncated: true`（超限后停止继续遍历）。
9. 无匹配 → `200 { files: [], dirs: [] }`（非 404）。

**约束**：
- MUST ignore `node_modules` / `.git`（与 tree/watch 一致）。
- MUST 上限 200 条 + truncated 标记。
- MUST 空 q → 400。
- MUST 返相对 workspaceDir 的 POSIX 路径（同 tree node.path 语义）。
- MUST 复用 whitelistResolve 根校验（安全面与 tree 一致）；MUST NOT 跟随 symlink 出 workspace 递归（防越权/循环）。
- 错误：404 session / 400 q 缺失 / 405 非 GET / 500 workspaceDir 不可读。

**示例**：
```bash
curl "http://127.0.0.1:3710/session/01KV.../workspace/search?q=helper"
# → 200 {"files":["src/utils/helper.ts"],"dirs":["src/components"],"truncated":false}
```

## §2 不变契约（本版显式确认）

| 端点 | 状态 | 说明 |
|------|------|------|
| `GET /session/:id/workspace/tree` | 不变 | lazy 一层 |
| `POST /session/:id/workspace/open` | 不变 | 系统打开（folder/file） |
| `POST /session/:id/workspace/pick-directory` | 不变 | 原生 dialog |
| `POST /session/:id/workspace/watch` / `unwatch` / `watch-set` | 不变 | 懒监听 |
| `POST /session/:id/workspace/save-image` | 不变 | 粘贴图片 |
| `GET /session/:id/workspace/file?binary=1` | 不变 | 二进制通道（**不加 version**） |
| absolute IPC（`shell:readFileText` / `writeFileText`） | 不变 | **v1 不做冲突检测**（PRD §1.3/§2.7 边界：absolute 保持 last-write-wins，IPC 层零改） |

## §3 文件变更

| 文件 | 类型 | 变更 |
|------|------|------|
| `app/server/src/handlers/session-workspace-file.ts` | 修改 | `computeFileVersion`（新增）+ read 加 version + save 加 expectedVersion/force/409 |
| `app/server/src/handlers/session-workspace-search.ts` | 新增 | `handleWorkspaceSearch`（递归全量搜索） |
| `app/server/src/routes/router-helpers.ts` | 修改 | workspace alternation 加 `search` |
| `app/server/src/routes/session-routes.ts` | 修改 | 加 `workspace_search` 分发分支 |
| `app/web/src/lib/chat-api/workspace-api.ts` | 修改 | readWorkspaceFile 返回 version? / saveWorkspaceFile body+version? / searchWorkspaceFiles 新增 |

## §4 AT 覆盖建议

| 用例 | 端点 | 断言 |
|------|------|------|
| file read 返 version | GET file | 200 + version 匹配 `${mtimeMs}:${size}` 格式（正则 `^\d+:\d+$`） |
| save 无版本（兼容） | POST save | 200 + `{ok:true, version}` |
| save expectedVersion 匹配 | POST save | 200 + 新 version |
| save expectedVersion 不匹配 | POST save | 409 + `{error:'conflict', currentVersion}`（断言文件内容未被覆盖 = 外部内容保留） |
| save force 覆盖 | POST save | 200（覆盖外部改动） |
| search 命中文件名 | GET search?q= | 200 + files 含全路径 |
| search 命中文件夹名 | GET search?q= | 200 + dirs 含全路径 |
| search 空 q | GET search?q= | 400 |
| search ignore node_modules/.git | GET search?q= | node_modules 内文件不出现 |
| search 上限 | GET search?q= | 超 200 截断 + truncated:true |

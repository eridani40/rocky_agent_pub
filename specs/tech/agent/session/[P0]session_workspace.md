---
type: interface
title: Session Workspace（workspaceDir 字段 + 切换）
priority: P0
status: active
updated: 2026-07-14
since: v0.0.17
---

# Session Workspace（工作目录字段 + 初始目录 + 切换）

> 关联：`[P0]session_store.md`（Session interface / createSession 入参 + SessionStore）+ `[P0]session_state.md`（运行态，正交）+ `[P0]session_workspace_manager.md`（fs watch + 切目录换 watch）+ `../context/[P0]system_reminder.md`（workspace provider 读 `config.workdir`）+ `../../../api/overall/04-agent-session.md`（HTTP 端点）。
> 本文是 `session.workspaceDir` 字段（持久化）+ 初始目录策略 + 切换语义的**概念权威源**。fs watcher 本身（生命周期 / chokidar / event 发射）归 `session_workspace_manager.md`。

## 1. 定位

每个 Session 关联一个**真实文件系统工作目录** `workspaceDir`（绝对路径，持久化字段）。该目录既是：

1. **LLM 工具默认根**：loop 构造期 `SessionConfig.workdir = session.workspaceDir`（沿用现有机制，`context-types.ts` workdir 字段不变语义），bash/file 工具默认 cwd。
2. **workspace reminder 数据源**：`workspace` provider 读 `config.workdir`（= session.workspaceDir）生成「Working directory: …」提醒（`system_reminder.md §3`）。
3. **workspace 面板展示根**：右侧 WorkspacePanel 渲染该目录文件树 + 切换 + 打开（`specs/ui/components/chat-page/component-workspace-panel.md`）。
4. **fs watch 监听根**：[v0.0.139] 懒监听——前端 ws-panel 挂载时显式 `POST watch{clientId, path:''}` → `SessionWorkspaceManager.watch(sid, clientId, workspaceDir, '')` 监听根一层（非递归；`session_workspace_manager.md §3/§10`）。

**与 `SessionConfig.workdir` 的关系**（解耦设计，不混淆）：

| 字段 | 类型 | 归属 | 持久化 | 何时设 |
|------|------|------|--------|--------|
| `session.workspaceDir` | `string` | Session schema（落 `<root>/session/<id>.json`） | ✅ | createSession 时设；PATCH 切换时更新 |
| `SessionConfig.workdir` | `string?` | loop 运行时 config（`context-types.ts`） | ❌（每次 loop 启动重建） | loop 启动时 `config.workdir = session.workspaceDir` |

> 一句话：**workspaceDir 是 session 的持久化真相源，workdir 是 loop 运行时的快照**（从 workspaceDir 复制）。本版本不改 workdir 语义，只在 loop 启动时接线 `workdir = session.workspaceDir`。

## 2. Session.workspaceDir 字段

### 2.1 字段定义（进 Session interface + SessionSchema）

```typescript
interface Session {
  // ...（既有字段，见 session_store.md §2）
  /** [v0.0.17] session 关联的真实工作目录（绝对路径）。
   *  - 用途：LLM 工具默认根（loop 启动 → SessionConfig.workdir）+ workspace reminder 数据源 + WorkspacePanel 展示根 + fs watch 根。
   *  - 持久化：落 <root>/session/<id>.json，required: true（新 session 必填）。
   *  - 历史兼容：读取时若缺失 → lazy 修复（按 §3 初始目录策略补建 + 回填）。 */
  workspaceDir: string;
}
```

### 2.2 SessionStore 接口扩展（见 `session_store.md §4`）

```typescript
interface SessionStore {
  // 既有 ...
  /** [v0.0.17] 切换 session 工作目录（更新 workspaceDir 字段 + 持久化）。
   *  - 不负责重启 watch（由 SessionWorkspaceManager 协调，见 §4）。
   *  - 通知机制：写完后 emit `session_workspace_dir_changed`（复用 session_panel topic；前端据此刷新路径栏 + 重拉 tree）。 */
  setWorkspaceDir(sessionId: string, newDir: string): Promise<void>;
}
```

> `createSession(session)` 不改签名——caller（POST /session handler）负责在入参 Session 里填好 workspaceDir（按 §3 策略）。

## 3. 初始目录策略（createSession 时建独立目录）

**决策（已定）**：新 session 在全局 data dir 下自动建独立目录 `<DATA_DIR>/workspaces/<sessionId>`。

```
<DATA_DIR>/                       # 见 app/envs/[P0]environments.md
└── workspaces/
    └── <sessionId>/              # ULID，全局唯一不冲突
```

**createSession 流程**（POST /session handler，权威见 api spec §2）：

```
1. sid = ULID()
2. 若 body.workspaceDir 提供：
   - 校验 abs + exists + isDir（`validateCallerWorkspaceDir`，任一失败 400）→ workspaceDir = body.workspaceDir
   - caller 负责建好目录（POST handler 不自动建）；典型场景：测试 seed / 外部工具预建
   否则（未提供）：
   - workspaceDir = path.resolve(DATA_DIR, 'workspaces', sid)
   - fs.mkdir(workspaceDir, { recursive: true })   // 幂等（已存在不报错）
3. session = { id: sid, ..., workspaceDir }      // workspaceDir 必填
4. SessionStore.createSession(session)           // 落盘
5. （[v0.0.139] 懒监听：不主动 watch——等前端 ws-panel 挂载显式 POST watch 监听根，见 manager spec §10）
```

> **[BUG-001 修复，v0.0.17 v1.1]** body.workspaceDir 提供时**用该值**（不强制默认）。原实现忽略 body 字段强制走默认路径，导致测试无法预建目录验证切目录 flow。校验失败一律 400（不静默回退默认），保证调用方拿到错误反馈。`validateCallerWorkspaceDir` 集中在 `app/server/src/handlers/session-workspace-seed.ts` 导出，POST /session + PUT /session/:id 切目录共用单一权威实现。

**约束**：
- 目录名 = sessionId（ULID），全局唯一，无冲突。
- 幂等：目录已存在不报错（极端情况：崩溃后重启重试创建同 sid session）。
- **caller 提供场景不自动建**（POST handler 不 mkdir，目录必须 caller 预建）。
- **不在本版本做「全局默认目录配置项」**（用户要换就点切换）。

## 4. 切换工作目录（PATCH/PUT /session/:id）

### 4.1 流程（后端 handler + Manager 协调）

```
1. 收到 PUT /session/:id { workspaceDir: newDir }
2. 校验 newDir：path.isAbsolute(newDir) && fs.existsSync(newDir) && fs.statSync(newDir).isDirectory()
   - 不存在 / 非目录 → 400 拒绝（不在此建目录；目录由系统 dialog 选/建时产生）
3. SessionWorkspaceManager.switchDir(sid, newDir, setDirCb)：
     a. recycleSession(sid)                          // [v0.0.139] 回收旧目录全部 tab 监听（相对路径基准=旧 dir，切后失效）
     b. setDirCb = SessionStore.setWorkspaceDir(sid, newDir)  // 更新字段 + 持久化 + emit dir_changed event
   //  不重启 watch：前端收 dir_changed → 重置 tree + 重新 watch 新目录根（同新 tab 打开路径）
4. 响应 200 + Session（新 workspaceDir）
```

> **顺序保证**（MANDATORY）：先 recycleSession（回收旧监听）→ 再 setWorkspaceDir。避免旧 watcher 在 set 窗口继续推旧目录变化。**[v0.0.139]** 懒监听下不再 startWatch 新目录（旧递归模型的 start 步骤取消）——切目录后监听由前端在 ws-panel 收到 `dir_changed` 后重新 `POST watch{clientId,path:''}` 建立。详见 `session_workspace_manager.md §9`。

### 4.2 切换后的下游影响

| 下游 | 何时反映新 workspaceDir |
|------|------------------------|
| workspace reminder | **下一轮 ingest**（新 user message → 注入 `Working directory: <newDir>`；旧 message 的 reminder 不动） |
| LLM 工具默认根 | **下一个 run**（loop 启动重建 SessionConfig，`workdir = newDir`） |
| WorkspacePanel | **即时**（前端收 `session_workspace_dir_changed` event → 刷新路径栏 + GET tree 重拉） |
| fs watch | **即时**（已 recycleSession 旧目录全部监听，见 §4.1；新目录监听由前端收 dir_changed 后重新 watch，[v0.0.139] 懒监听不再后端 startWatch 新目录） |

> **不在切换时主动 abort 当前 run**——如果切换时 session 正 running，新 workspace 对当前 run 不生效（当前 run 用的是旧 SessionConfig）；下一轮 ingest/run 才生效。这是简化设计（避免切换即 abort 的副作用）。

## 5. 历史兼容（lazy 修复）

读取历史 session（v0.0.16 及之前，无 workspaceDir 字段）时：

```
session = SessionStore.getSession(sid)
if (!session.workspaceDir) {
  workspaceDir = path.resolve(DATA_DIR, 'workspaces', sid)
  fs.mkdir(workspaceDir, { recursive: true })   // 幂等
  SessionStore.setWorkspaceDir(sid, workspaceDir)
  session.workspaceDir = workspaceDir            // 回填返回值
}
```

> 触发点：`getSession` 读取层（SessionStore 实现内部）或 API handler 读后补建（实现定，spec 不强约束）。保证调用方拿到的 Session 一定有 workspaceDir。

## 6. 安全

- **workspaceDir 必须是绝对路径**（createSession 时 `path.resolve` 规范化）。
- **打开文件/文件夹**（POST /session/:id/workspace/open）：`path.resolve(workspaceDir, relPath)` 后必须 `startsWith(workspaceDir)`，防目录穿越（详见 api spec）。
- **切换目录**（§4.1）：newDir 必须存在且是目录（防用户手输错误路径；系统 dialog 选出的天然合法）。
- **fs watch**：仅监听 workspaceDir 内（chokidar root = workspaceDir，ignore `node_modules`/`.git`），不监听任意路径。

## 7. 边界

| 零件 | 归属 |
|---|---|
| `workspaceDir` 字段定义 + 初始目录策略 + 切换语义 + 历史兼容 | 本文 ✅ |
| Session interface / createSession 入参 / SessionStore | `session_store.md §2/§4`（加字段 + setWorkspaceDir） |
| fs watcher 生命周期 + chokidar + event 发射 | `session_workspace_manager.md` |
| workspace reminder provider 实现（读 config.workdir） | `../context/[P0]system_reminder.md §3`（不改 provider 实现，只接线） |
| HTTP 端点（POST /session / PUT /session/:id） | `../../../api/overall/04-agent-session.md` |
| WorkspacePanel UI | `specs/ui/components/chat-page/component-workspace-panel.md` |

## 8. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。

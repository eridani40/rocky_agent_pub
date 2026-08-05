/**
 * session-workspace-store —— SessionStore workspace 相关操作扩展（v0.0.17 新建）
 * 参考: specs/tech/agent/session/[P0]session_workspace.md §2.2（setWorkspaceDir）§3（初始目录）§5（历史兼容）
 *       specs/tech/agent/session/[P0]session_store.md §4（setWorkspaceDir 接口）
 *
 * 从 session-store.ts 拆出（≤300 行约束 + 单一职责：workspace 字段操作独立）。
 * 本文件只含 workspace 字段相关的 store 级操作；fs watch 协调（懒监听下 recycleSession→setDir）
 * 由 SessionWorkspaceManager 负责，本文件不涉及。
 *
 * 设计：
 *   - setWorkspaceDir：纯字段更新 + 持久化 + emit session_workspace_dir_changed event；
 *     不校验 newDir 存在性（handler 层校验，spec §4.1 step2）；不重启 watch（caller 协调）
 *   - lazy 修复 helper：旧 session 反序列化无 workspaceDir → 建默认目录 + 回填 + 持久化
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompositeStore } from '../persistence/composite';
import type { ReplayableEventBus } from './event-bus';
import { ulid } from '../config/ulid';
import { SessionSchema } from './schema_defs';
import type { SessionRecord } from './schema_defs';
import { SessionNotFoundError } from './session-store-converters';

/**
 * v0.0.17：切换 session 工作目录（更新 workspaceDir 字段 + 持久化 + emit event）。
 *
 * 职责边界（spec session_workspace.md §4.1 + session_store.md §4）：
 *   - 仅做字段更新 + 持久化 + event 发射
 *   - **不校验 newDir**（绝对路径 / 存在 / 是目录由 handler 层校验，spec §4.1 step2）
 *   - **不重启 fs watch**（懒监听下调用方先 recycleSession 回收旧目录全部监听 → 再 setWorkspaceDir；
 *     不重启新目录监听，由前端收 dir_changed 后重新 watch 新根）
 *
 * @param crud     CrudStore（session schema 已 mount）
 * @param statusBus session_panel topic 的 bus（推送 session_workspace_dir_changed）；可空
 * @param sessionId 目标 session
 * @param newDir   新工作目录绝对路径
 * @throws SessionNotFoundError session 不存在
 */
export async function setWorkspaceDirOp(
  // [v0.0.38 T4] crud 类型由 CrudStore 收紧为 CompositeStore（spec §6.1：走 putAsync）
  crud: CompositeStore,
  statusBus: ReplayableEventBus | undefined,
  sessionId: string,
  newDir: string,
): Promise<void> {
  const rec = crud.get(SessionSchema, sessionId);
  if (!rec) throw new SessionNotFoundError(sessionId);
  // 记录 prevDir（emit 用；spec [P0]session_event.md §2 prevDir 首次设为 null）
  const prevDir = (rec as SessionRecord & { workspaceDir?: string }).workspaceDir || null;
  // spread existing 保留运行态字段 + 覆盖 workspaceDir（spec §2.2 setWorkspaceDir 语义）
  // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）：workspaceDir 是后续路径依赖，须确认完成
  await crud.putAsync(SessionSchema, stripEnvelope({
    ...rec,
    workspaceDir: newDir,
  }));
  // emit session_workspace_dir_changed（spec session_store.md §4 + session_event.md §2）
  // topic=session_panel, group=`session_id:<sid>`（复用 session_panel topic）
  // data: { workspaceDir, prevDir }（spec [P0]session_event.md §2 SessionWorkspaceDirChangedEvent）
  if (statusBus) {
    const e = {
      id: ulid(),
      type: 'session_workspace_dir_changed',
      sessionId,
      createdAt: new Date().toISOString(),
      data: { workspaceDir: newDir, prevDir },
    };
    statusBus.emit(`session_id:${sessionId}`, {
      data: e,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * v0.0.17：历史 session 兼容（spec session_workspace.md §5）。
 * 旧 session（无 workspaceDir 字段）→ 建默认 <dataDir>/workspaces/<sid> + 回填 + 持久化。
 *
 * 幂等：mkdir recursive（已存在不报错）。
 * 仅在 workspaceDir 缺失/空时触发；新 session 已有 workspaceDir 时直接返回。
 *
 * [v0.0.38 T4] 改 async——走 putAsync（spec §6.1 [wait]）
 *
 * @param crud      CompositeStore（已 mount session schema）
 * @param dataDir   DATA_DIR 绝对路径（建默认 <dataDir>/workspaces/<sid>）
 * @param sessionId 目标 session
 * @returns 修复后的 workspaceDir（绝对路径）；session 不存在返 null
 */
export async function ensureWorkspaceDirOp(
  crud: CompositeStore,
  dataDir: string,
  sessionId: string,
): Promise<string | null> {
  const rec = crud.get(SessionSchema, sessionId);
  if (!rec) return null;
  const existing = (rec as SessionRecord & { workspaceDir?: string }).workspaceDir;
  if (existing && existing.length > 0) return existing;
  // lazy 修复：建默认目录 + 持久化（spec §5）
  const workspaceDir = resolve(dataDir, 'workspaces', sessionId);
  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch {
    // 忽略：已存在或权限（运行时再报）
  }
  // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）
  await crud.putAsync(SessionSchema, stripEnvelope({
    ...rec,
    workspaceDir,
  }));
  return workspaceDir;
}

/** CrudStore.put 禁 record 自带信封字段（createdAt/updatedAt/version）—— 此函数剥除 */
function stripEnvelope<T extends Record<string, unknown>>(rec: T): T {
  const { createdAt, updatedAt, version, ...rest } = rec as unknown as {
    createdAt?: unknown; updatedAt?: unknown; version?: unknown;
  };
  void createdAt; void updatedAt; void version;
  return rest as T;
}

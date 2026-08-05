/**
 * WorkspaceChangeEmitter —— per-session 100ms debounce 聚合 + emit session_workspace_file_changed
 * （v0.0.139 新建）
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md §8（文件变化 → emit event）
 *       specs/tech/agent/session/[P0]session_event.md §2/§3（payload 契约）
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1 change-emitter 行
 *
 * 职责：接收来自任意目录 watcher（workspace-dir-watcher.ts openDirWatcher 的 onEvent 回调）
 *   的原始 chokidar 'all' 事件，按 **session** 聚合到同一个 100ms debounce 窗口（一个 session
 *   下即使同时有多个目录 watcher 在推事件，也共用一个 debounce 定时器与 pending buffer），
 *   窗口到期后把每个 relPath+kind 各发一条 `session_workspace_file_changed`（不合并成总
 *   event，前端按 relPath 局部 re-fetch 子目录，spec §8）。
 *
 * relPath 计算相对「该 session 当前 workspaceDir」（调用方传入，非被监听的 absDir——一个
 * session 可能同时监听根 + 若干展开子目录，relPath 必须相对统一的根基准）。
 */
import { relative, sep } from 'node:path';
import { ulid } from '../config/ulid';
import type { ReplayableEventBus } from './event-bus';
import { mapKind, type FsChangeKind } from './workspace-dir-watcher';

const DEBOUNCE_MS = 100;

interface PendingChange {
  relPath: string;
  kind: FsChangeKind;
  isDir: boolean;
}

interface SessionBuffer {
  pending: Map<string, PendingChange>;
  timer: NodeJS.Timeout | null;
}

export class WorkspaceChangeEmitter {
  private readonly buffers = new Map<string, SessionBuffer>();
  private readonly statusBus: ReplayableEventBus;

  constructor(opts: { statusBus: ReplayableEventBus }) {
    this.statusBus = opts.statusBus;
  }

  /**
   * 接收一条原始 chokidar 事件，归入该 sessionId 的 100ms debounce 窗口。
   * - eventName 非 5 类文件变化事件（mapKind 返回 null，如 'ready'/'raw'）→ 忽略。
   * - relPath = path.relative(workspaceDir, absPath)，跨平台 sep 归一 '/'（防泄漏绝对路径）。
   * - key 去重：同 kind+relPath 在窗口内只保留最新一条（chokidar 对同一文件可能多次触发）。
   */
  push(sessionId: string, workspaceDir: string, eventName: string, absPath: string): void {
    const kind = mapKind(eventName);
    if (!kind) return;
    let relPath = relative(workspaceDir, absPath);
    if (sep !== '/') relPath = relPath.split(sep).join('/');
    const isDir = kind === 'addDir' || kind === 'unlinkDir';

    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { pending: new Map(), timer: null };
      this.buffers.set(sessionId, buf);
    }
    const key = `${kind}:${relPath}:${isDir}`;
    buf.pending.set(key, { relPath, kind, isDir });
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => this.flush(sessionId), DEBOUNCE_MS);
  }

  /**
   * flush 该 sessionId 的 pending buffer：每条 pending 变化各 emit 一条
   * `session_workspace_file_changed` 到 `session_id:<sid>`（topic=session_panel）。
   * 由 debounce timer 到期自动调用；也可直接调用做确定性测试（跳过等待窗口）。
   */
  flush(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    const changes = Array.from(buf.pending.values());
    buf.pending.clear();
    const now = new Date().toISOString();
    for (const c of changes) {
      this.statusBus.emit(`session_id:${sessionId}`, {
        data: {
          id: ulid(),
          type: 'session_workspace_file_changed',
          sessionId,
          createdAt: now,
          data: { path: c.relPath, kind: c.kind, isDir: c.isDir },
        },
        timestamp: now,
      });
    }
  }

  /**
   * 清除该 sessionId 的 debounce timer + pending buffer（不 emit）——recycleSession/stopAll
   * 时防止残留 timer 在 session 已回收后仍触发 flush（timer 泄漏/野指针 emit）。幂等。
   */
  clear(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (!buf) return;
    if (buf.timer) clearTimeout(buf.timer);
    this.buffers.delete(sessionId);
  }
}

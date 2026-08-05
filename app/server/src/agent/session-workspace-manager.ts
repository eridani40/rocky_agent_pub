/**
 * SessionWorkspaceManager —— 懒监听编排器（v0.0.139 结构性重写）
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md（v1.1 lazy 权威源）
 *       specs/tech/agent/session/[P0]session_event.md §2/§3（session_workspace_file_changed payload）
 *       specs/tech/agent/session/[P0]session_workspace.md §4（切目录 recycle→set 顺序）
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1 manager 行
 *
 * 职责：编排三个懒监听单元——registry（tab 目录集 + 目录引用计数纯记账）、dir-watcher
 *   （chokidar 单目录 depth:0 工厂）、change-emitter（per-session debounce + emit）。本类
 *   不自持递归 watcher、不直接操作 chokidar（全部委托 dir-watcher 工厂），只负责：
 *   ① 决策「何时该建/该关物理 watcher」（引用计数 0→1 / →0）② 同 (sid,absDir) create/close
 *   串行化防重入（Bun FSEvents 崩溃面，spec §7）③ fs 事件转发给 emitter。
 *
 * **watch/unwatch 4 参签名（含 workspaceDir）的动机**：本 manager **不持有 SessionStore**（沿用旧
 *   设计边界：store 由 caller 持有，见 spec §12 边界表 + §3 接口注）。relDir 是相对 workspaceDir 的
 *   路径，不传入 workspaceDir 本体就无法把 relDir resolve 成 absDir，也无法给 emitter.push() 提供
 *   「该 session 当前 workspaceDir」这个 relPath 计算基准（一个 session 可能同时监听根 + 多个展开子
 *   目录，relPath 必须始终相对 workspaceDir 根算，见 workspace-change-emitter.ts 顶部注释）。故
 *   handler 从 `session.workspaceDir` realpath 后传入，与 handler 自己的 whitelistResolve 用同一
 *   基准，避免 symlink 场景下两处 resolve 结果不一致。
 */
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ReplayableEventBus } from './event-bus';
import { WorkspaceWatchRegistry } from './workspace-watch-registry';
import { openDirWatcher, closeDirWatcher, type DirWatcher } from './workspace-dir-watcher';
import { WorkspaceChangeEmitter } from './workspace-change-emitter';

/** 诊断快照（spec §3 WatcherStatus） */
export interface WatcherStatus {
  sessionId: string;
  absDir: string;
  ready: boolean;
  refcount: number;
}

export class SessionWorkspaceManager {
  private readonly registry = new WorkspaceWatchRegistry();
  private readonly emitter: WorkspaceChangeEmitter;
  /** 物理 watcher 句柄，key=`${sessionId}:${absDir}` */
  private readonly dirWatchers = new Map<string, DirWatcher>();
  /** 同 (sessionId,absDir) 的 create/close 串行队列（spec §7 防重入） */
  private readonly opQueues = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(opts: { statusBus: ReplayableEventBus }) {
    this.emitter = new WorkspaceChangeEmitter({ statusBus: opts.statusBus });
  }

  private dirKey(sessionId: string, absDir: string): string {
    return `${sessionId}:${absDir}`;
  }

  /** 把 task 挂到 key 对应的串行队列尾部；前一 task 失败也不阻塞后续（catch 隔离）。 */
  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.opQueues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.opQueues.set(key, next.catch(() => {}));
    return next;
  }

  /** relDir → absDir，二次越界防御（handler 已用 whitelistResolve 挡真实穿越攻击，此处只兜底）。 */
  private resolveAbsDir(workspaceDir: string, relDir: string): string | null {
    const root = resolve(workspaceDir);
    const abs = relDir && relDir !== '.' ? resolve(root, relDir) : root;
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (abs !== root && !abs.startsWith(rootWithSep)) return null;
    return abs;
  }

  private isValidDir(absDir: string): boolean {
    try {
      return statSync(absDir).isDirectory();
    } catch {
      return false;
    }
  }

  /** absDir 首引用（0→1）时真正建物理 watcher；串行段内执行，防重入。 */
  private async openIfFirstRef(sessionId: string, workspaceDir: string, absDir: string): Promise<void> {
    const key = this.dirKey(sessionId, absDir);
    await this.enqueue(key, async () => {
      if (this.stopped) return;
      const isFirstRef = this.registry.refInc(sessionId, absDir);
      if (!isFirstRef) return;
      const handle = await openDirWatcher({
        sessionId,
        absDir,
        onEvent: (sid, _dir, eventName, absPath) => {
          this.emitter.push(sid, workspaceDir, eventName, absPath);
        },
        // 无 onError：dir-watcher 自身已无条件挂 'error' 监听防崩（T1 交付），懒监听场景下
        // 目录被删/inotify 满属边角，不做自动重开（重开需要重新校验 addTabDir 幂等状态，
        // 复杂度/收益不对等）——用户重新展开会走正常 watch() 路径自愈。
      });
      this.dirWatchers.set(key, handle);
    });
  }

  /** absDir 归零（→0）时真正关物理 watcher；串行段内执行，防重入（幂等，无 handle 则 no-op）。 */
  private async closeIfZeroRef(sessionId: string, absDir: string): Promise<void> {
    const key = this.dirKey(sessionId, absDir);
    await this.enqueue(key, async () => {
      const zero = this.registry.refDec(sessionId, absDir);
      if (!zero) return;
      const handle = this.dirWatchers.get(key);
      if (!handle) return;
      this.dirWatchers.delete(key);
      await closeDirWatcher(handle);
    });
  }

  /**
   * 展开目录 / 打开 tab（watch 根，relDir=''）时调用（spec §3 watch）。
   * 幂等：该 (sid,clientId) 已持有 relDir 对应 absDir → no-op（不叠加 refcount）。
   * 目标不存在/非目录 → 静默忽略（不报错，等重试）；越界 → 静默忽略（handler 层已 400 挡真实攻击）。
   */
  async watch(sessionId: string, clientId: string, workspaceDir: string, relDir: string): Promise<void> {
    if (this.stopped) return;
    const absDir = this.resolveAbsDir(workspaceDir, relDir);
    if (!absDir || !this.isValidDir(absDir)) return;
    const isNewForTab = this.registry.addTabDir(sessionId, clientId, absDir);
    if (!isNewForTab) return; // 该 tab 已持有，Set 幂等 no-op
    await this.openIfFirstRef(sessionId, workspaceDir, absDir);
  }

  /**
   * 收起目录时调用（spec §3 unwatch）。幂等：该 tab 未持有 relDir → 静默 no-op。
   */
  async unwatch(sessionId: string, clientId: string, workspaceDir: string, relDir: string): Promise<void> {
    if (this.stopped) return;
    const absDir = this.resolveAbsDir(workspaceDir, relDir);
    if (!absDir) return;
    const removed = this.registry.removeTabDir(sessionId, clientId, absDir);
    if (!removed) return;
    await this.closeIfZeroRef(sessionId, absDir);
  }

  /**
   * 回收一个 tab 名下全部监听（ws-panel 卸载 / 切 session，spec §3/§6①）。幂等：无记录 no-op。
   */
  async releaseTab(sessionId: string, clientId: string): Promise<void> {
    const dirs = this.registry.takeTabDirs(sessionId, clientId);
    await Promise.all(dirs.map((absDir) => this.closeIfZeroRef(sessionId, absDir)));
  }

  /**
   * 回收一个 session 名下全部 tab 的监听（session_panel 订阅 1→0 兜底 / DELETE session /
   * switchDir 前置步骤，spec §3/§6②）。幂等：无记录 no-op。同时清 emitter 的 debounce timer，
   * 防止 session 已回收后残留 timer 仍 flush 出野指针 emit。
   */
  async recycleSession(sessionId: string): Promise<void> {
    const tabs = this.registry.takeSessionTabs(sessionId);
    await Promise.all(
      tabs.flatMap((tab) => tab.dirs.map((absDir) => this.closeIfZeroRef(sessionId, absDir))),
    );
    this.emitter.clear(sessionId);
  }

  /**
   * 切目录（PUT /session/:id）：recycleSession(旧目录全部监听) → setDirCb。签名不变（call site
   * 零改）。不重启 watch——前端收 dir_changed 后重置 tree + 重新 watch 新根（spec §9）。
   */
  async switchDir(
    sessionId: string,
    newDir: string,
    setDirCb: (sid: string, dir: string) => Promise<void>,
  ): Promise<void> {
    await this.recycleSession(sessionId);
    await setDirCb(sessionId, newDir);
  }

  /**
   * app shutdown（bootstrap shutdown hook）：close 全部物理 watcher + 清全部记账 + 清全部
   * emitter timer。走 recycleSession 逐 session 串行 close（尊重 §7 防重入），再兜底清空
   * 残留引用（正常路径下应已为空，防御性收口）。
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    const sids = this.registry.listSessions();
    await Promise.all(sids.map((sid) => this.recycleSession(sid)));
    for (const handle of this.dirWatchers.values()) {
      await closeDirWatcher(handle).catch(() => {});
    }
    this.dirWatchers.clear();
    this.opQueues.clear();
    this.registry.clear();
  }

  /** 当前物理 watcher 快照（诊断/测试用；无监听主体存活时应为空数组 —— 无泄漏 invariant）。 */
  getStatus(): WatcherStatus[] {
    const result: WatcherStatus[] = [];
    for (const sid of this.registry.listSessions()) {
      for (const { absDir, refcount } of this.registry.listSessionDirs(sid)) {
        const handle = this.dirWatchers.get(this.dirKey(sid, absDir));
        result.push({ sessionId: sid, absDir, ready: handle?.ready ?? false, refcount });
      }
    }
    return result;
  }
}

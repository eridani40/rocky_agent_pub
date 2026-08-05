/**
 * TodoStore — session 级双层 todo 持久化（独立 store，仿 CronPersistenceAdapter）。
 * 参考: specs/tech/agent/tools/[P1]todo_tools.md §2/§4（数据模型 + 存储路线 B 权威）
 *       specs/tech/agent/session/[P0]session_event.md §2/§3（写成功后 emit session_todo_changed）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §3（独立 store 范式）
 *       CLAUDE.md 持续可打包护栏 #4（DATA_DIR 经 resolveDataDir 展开，禁字面 `~`）
 *
 * 设计：
 *   - 路径 {fsRoot}/sessions/{sessionId}/todos.json（与 cron.json 同 session 级分片约定）
 *   - schema {version:1, sessionId, items:TodoItem[]}（原子写）
 *   - read-modify-write 全量；复用 persistence/fs-io.ts:atomicWriteSync / readJsonFileSync / removeFileSync
 *   - fsRoot 由 caller 经 resolveDataDir() 展开绝对路径后传入（packaged cwd=`/` 护栏）
 *
 * todo ≠ task（todo_tools.md §1）：session 级、无角色、无 DAG/CAS、5 态 free-form 状态机。
 */
import { join } from 'node:path';
import { ulid } from '../../config/ulid';
import {
  atomicWriteSync,
  readJsonFileSync,
  removeFileSync,
} from '../../persistence/fs-io';
import type { ReplayableEventBus } from '../event-bus';
import type { SessionTodoChangedEvent } from '../session-event-types';

/** todo 5 态 enum（free-form：仅校验 enum，不校验跃迁路径，todo_tools.md §2.3） */
export type TodoStatus = 'not_started' | 'in_progress' | 'done' | 'skipped' | 'error';

/** 合法状态集合（工具层 enum 校验权威） */
export const TODO_STATUSES: readonly TodoStatus[] = [
  'not_started', 'in_progress', 'done', 'skipped', 'error',
];

/** 判定字符串是否合法 TodoStatus（工具层入参校验用） */
export function isTodoStatus(s: string): s is TodoStatus {
  return (TODO_STATUSES as readonly string[]).includes(s);
}

/** 主 item 的 source（任务从哪来，todo_tools.md §2.1） */
export interface TodoSource {
  type: 'task' | 'user_message' | 'agent';
  refId?: string;
}

/** 主 item 的 output（要产出什么，todo_tools.md §2.1） */
export interface TodoOutput {
  type: 'file' | 'reply_session' | 'reply_agent';
  refId?: string;
}

/** 步骤（layer 2，todo_tools.md §2.2） */
export interface TodoStep {
  /** ULID（item 内唯一） */
  id: string;
  desc: string;
  status: TodoStatus;
}

/** 主 item（layer 1，todo_tools.md §2.1） */
export interface TodoItem {
  /** ULID（session 内唯一） */
  id: string;
  desc: string;
  status: TodoStatus;
  source?: TodoSource;
  output?: TodoOutput;
  memo?: string;
  steps: TodoStep[];
  createdAt: string;
  updatedAt: string;
}

/** todos.json 文件 schema（self-describing） */
export interface TodoFile {
  version: 1;
  sessionId: string;
  items: TodoItem[];
}

/** 已结束状态集合（cleanup_finished 清理目标，todo_tools.md §2.4） */
const FINISHED_STATUSES: ReadonlySet<TodoStatus> = new Set(['done', 'skipped']);

/** TodoStore 依赖（构造注入；bootstrap 装配，UT 用 tmpdir） */
export interface TodoStoreDeps {
  /** fs root（与 session-store.fsRoot 同源；todos.json 落 {root}/sessions/{sid}/todos.json） */
  fsRoot: string;
  /**
   * session_panel topic 的 bus（推送 session_todo_changed 轻量信号）；可空。
   * optional——UT / 无 bus 场景 no-op 不炸（session_event.md §3 三不 emit 原则）。
   * bootstrap 注入 wrapStatusBusForUnread 之前的 raw bus（不触发 session_meta broadcast）。
   */
  statusBus?: ReplayableEventBus;
}

/**
 * TodoStore — session 级 todo 持久化 store。
 * 方法 listBySession / upsertItem / removeItem / removeAll / cleanupFinished。
 * 与 reminder provider 鸭子类型兼容（TodoStorePort 只读 listBySession）。
 */
export class TodoStore {
  constructor(private readonly deps: TodoStoreDeps) {}

  /** todos.json 绝对路径（{fsRoot}/sessions/{sessionId}/todos.json） */
  private filePath(sessionId: string): string {
    return join(this.deps.fsRoot, 'sessions', sessionId, 'todos.json');
  }

  /** 生成新 ULID（add_item / add_step 用） */
  nextId(): string {
    return ulid();
  }

  /**
   * 列 session 全部 todo item（reminder provider + HTTP GET + 工具 list 调）。
   * 无文件 → 空；schema 异常静默降级空（不抛，避免 reminder 链中断）。
   */
  async listBySession(sessionId: string): Promise<TodoItem[]> {
    const file = this.readSafe(sessionId);
    return file?.items ?? [];
  }

  /**
   * 写/替单 item（工具 add_item/update_item/add_step/update_step + HTTP POST/PATCH 调）。
   * read-modify-write 全量 + 原子写；updatedAt 自动刷新。
   */
  async upsertItem(sessionId: string, item: TodoItem): Promise<void> {
    const filePath = this.filePath(sessionId);
    const existing = this.readSafe(sessionId);
    const items: TodoItem[] = existing?.items ?? [];
    const idx = items.findIndex((it) => it.id === item.id);
    const stamped = { ...item, updatedAt: new Date().toISOString() };
    if (idx >= 0) items[idx] = stamped;
    else items.push(stamped);
    atomicWriteSync(filePath, JSON.stringify(serializeFile(sessionId, items), null, 2));
    this.emitChanged(sessionId);
  }

  /**
   * 删单 item（工具 delete_item + HTTP DELETE 调）。
   * read-modify-write filter out + 原子写；文件不存在静默 no-op；空 → 删文件。
   */
  async removeItem(sessionId: string, itemId: string): Promise<boolean> {
    const filePath = this.filePath(sessionId);
    const existing = this.readSafe(sessionId);
    if (!existing || !Array.isArray(existing.items)) return false;
    const next = existing.items.filter((it) => it.id !== itemId);
    if (next.length === existing.items.length) return false; // 无变化不刷盘
    if (next.length === 0) {
      removeFileSync(filePath);
      this.emitChanged(sessionId);
      return true;
    }
    atomicWriteSync(filePath, JSON.stringify(serializeFile(sessionId, next), null, 2));
    this.emitChanged(sessionId);
    return true;
  }

  /**
   * 清理已结束主 item（status ∈ {done, skipped}，todo_tools.md §2.4 cleanup_finished）。
   * 步骤不独立清理（随主 item 一起删）。
   * @returns 删除条数
   */
  async cleanupFinished(sessionId: string): Promise<number> {
    const filePath = this.filePath(sessionId);
    const existing = this.readSafe(sessionId);
    if (!existing || !Array.isArray(existing.items)) return 0;
    const next = existing.items.filter((it) => !FINISHED_STATUSES.has(it.status));
    const removed = existing.items.length - next.length;
    if (removed === 0) return 0;
    if (next.length === 0) {
      removeFileSync(filePath);
      this.emitChanged(sessionId);
      return removed;
    }
    atomicWriteSync(filePath, JSON.stringify(serializeFile(sessionId, next), null, 2));
    this.emitChanged(sessionId);
    return removed;
  }

  /**
   * 删 session 全部 todo（session 销毁 hook 调，与 cron removeAllJobs 同模式）。
   * 直接删整个 todos.json 文件；不存在静默 no-op。
   */
  async removeAll(sessionId: string): Promise<void> {
    removeFileSync(this.filePath(sessionId));
  }

  /** 读文件（ENOENT / schema 异常均降级 undefined，不抛） */
  private readSafe(sessionId: string): TodoFile | undefined {
    const file = readJsonFileSync<TodoFile>(this.filePath(sessionId));
    if (!file || !Array.isArray(file.items)) return undefined;
    return file;
  }

  /**
   * 写成功后发 session_todo_changed 轻量信号（session_event.md §2/§3）。
   * topic=session_panel, group=`session_id:<sid>`；data=空对象（消费方收后重拉 GET 全量）。
   * 三不 emit 原则：statusBus 未注入 no-op；无实际变更不调本方法（调用方保证）；
   * emit 异常吞错 console.warn 不影响写路径语义（写已成功，事件是附加通知）。
   * removeAll（session 销毁 hook）不 emit——session 销毁时订阅方已退订，无消费场景。
   */
  private emitChanged(sessionId: string): void {
    const bus = this.deps.statusBus;
    if (!bus) return;
    try {
      const e: SessionTodoChangedEvent = {
        id: ulid(),
        type: 'session_todo_changed',
        sessionId,
        createdAt: new Date().toISOString(),
        data: {},
      };
      bus.emit(`session_id:${sessionId}`, { data: e, timestamp: e.createdAt });
    } catch (err) {
      console.warn('[TodoStore] emit session_todo_changed failed', err);
    }
  }
}

/** 序列化 TodoFile（统一字段顺序） */
function serializeFile(sessionId: string, items: TodoItem[]): TodoFile {
  return { version: 1, sessionId, items };
}

/**
 * 解析 source 入参（{type, refId?}；type 非 enum → undefined）。
 * 工具层（todo-tool）与 HTTP 层（todo-handler）共享，避免两处重复实现。
 */
export function parseTodoSource(raw: unknown): TodoSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as { type?: unknown; refId?: unknown };
  if (s.type !== 'task' && s.type !== 'user_message' && s.type !== 'agent') return undefined;
  const out: TodoSource = { type: s.type };
  if (typeof s.refId === 'string') out.refId = s.refId;
  return out;
}

/** 解析 output 入参（{type, refId?}；type 非 enum → undefined）。工具层与 HTTP 层共享。 */
export function parseTodoOutput(raw: unknown): TodoOutput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as { type?: unknown; refId?: unknown };
  if (o.type !== 'file' && o.type !== 'reply_session' && o.type !== 'reply_agent') return undefined;
  const out: TodoOutput = { type: o.type };
  if (typeof o.refId === 'string') out.refId = o.refId;
  return out;
}

/**
 * ReminderQueueStore — per-session 有序 reminder 队列（v0.0.361 T1 基建）。
 * 参考: specs/tech/version_logs/v0.0.361/change_plan.md §1.2（queue 设计）+ §1.8（载体分层）
 *       specs/tech/agent/tools/[P1]todo_tools.md §2/§4（独立 store 范式）
 *       CLAUDE.md 持续可打包护栏 #4（DATA_DIR 经 resolveDataDir 展开，禁字面 `~`）
 *
 * 定位（老板 20:24 拍板）：queue = 通用开放通道，非注册制。任何业务想进提醒直接
 * `write(key, value)`，下轮 ingest 即进 reminder——没有 provider 注册、没有类型绑定、
 * 没有写入方身份追踪（queue 不挂「谁来的」）。本期接线的 todo/presence/task/member
 * 状态只是已知调用点样例，不是 queue 的封闭成员表；后续新业务零改造接入。
 *
 * 设计：
 *   - 路径 {fsRoot}/sessions/{sessionId}/reminder_queue.json（与 todos.json 同 session 级分片约定）
 *   - 内部结构 = 有序 entries 数组（持久化形态）；运行时以 Map<key,index> 索引去重
 *   - 同 key 写入 = 删旧 value + 新 value 追加队尾（有序队列语义：最新变化总在队尾）
 *   - 删除语义 = 显式空 value 行（不用 tombstone；value 即注入内容，写入方定义删除行文案）
 *   - drain() 拿锁按队列顺序读 value + 清空（incremental ingest 消费）
 *   - clearAll() 拿锁清空（full 模式消费）
 *   - 锁：进程内 per-sid Promise mutex（写/drain/clear 全走锁，单进程独占 sessions 目录）
 *   - 原子写：复用 persistence/fs-io.ts:atomicWriteSync（tmp+fsync+rename，防半文件）
 *   - fsRoot 由 caller 经 resolveDataDir() 展开绝对路径后传入（packaged cwd=`/` 护栏）
 */
import { join } from 'node:path';
import {
  atomicWriteSync,
  readJsonFileSync,
} from '../persistence/fs-io';

/** 单条 queue 记录（value = 已渲染注入行，drain 时直接拼块不再二次渲染） */
export interface ReminderQueueEntry {
  /** 去重寻址键：`{栏目}:{实体id}`（如 todo:{itemId} / presence:{memberId}）；不注入 */
  key: string;
  /** 注入内容（人类可读原文）；删除/清空类变化 = 显式空 value 行 */
  value: string;
  /** 记录时间（ISO；写入方 upsert 时打点） */
  recordedAt: string;
}

/** reminder_queue.json 文件 schema（self-describing） */
export interface ReminderQueueFile {
  version: 1;
  sessionId: string;
  entries: ReminderQueueEntry[];
}

/** ReminderQueueStore 依赖（构造注入；bootstrap 装配，UT 用 tmpdir） */
export interface ReminderQueueStoreDeps {
  /** fs root（与 session-store.fsRoot 同源；reminder_queue.json 落 {root}/sessions/{sid}/reminder_queue.json） */
  fsRoot: string;
}

/**
 * ReminderQueueStore — per-session 有序 reminder 队列 store。
 * 方法 write / drain / clearAll（全走 per-sid Promise mutex + 原子写）。
 * 与注入方解耦：本类只提供队列基建，不承载渲染/栏目分派业务逻辑（§1.8 载体分层）。
 */
export class ReminderQueueStore {
  constructor(private readonly deps: ReminderQueueStoreDeps) {}

  /** reminder_queue.json 绝对路径（{fsRoot}/sessions/{sessionId}/reminder_queue.json） */
  private filePath(sessionId: string): string {
    return join(this.deps.fsRoot, 'sessions', sessionId, 'reminder_queue.json');
  }

  /** per-sid 锁链尾（Promise mutex：prev 无论成败都执行 fn，错误不阻塞后续排队） */
  private locks = new Map<string, Promise<unknown>>();

  /** 串行化 per-sid 操作（写/drain/clear 全走锁；单进程内互斥） */
  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 存 settled 版本作链尾（防 unhandled rejection 告警）
    this.locks.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  /** 读文件；缺失/损坏 → 空队列（防半损坏文件阻断注入链） */
  private readFile(sessionId: string): ReminderQueueFile {
    const file = readJsonFileSync<ReminderQueueFile>(this.filePath(sessionId));
    if (!file || !Array.isArray(file.entries)) {
      return { version: 1, sessionId, entries: [] };
    }
    return file;
  }

  /** 原子写（atomicWriteSync：tmp+fsync+rename；自动 mkdir sessions/{sid}/） */
  private writeFile(sessionId: string, file: ReminderQueueFile): void {
    atomicWriteSync(this.filePath(sessionId), JSON.stringify(file, null, 2));
  }

  /**
   * upsert 一条 queue 记录：同 key 删旧 + 新 value 追加队尾（有序队列语义）。
   * 通用开放通道：不校验写入方身份、不限制 key 格式（§1.2 定位）。
   */
  async write(sessionId: string, key: string, value: string): Promise<void> {
    return this.withLock(sessionId, async () => {
      const file = this.readFile(sessionId);
      // Map<key,index> 索引去重：同 key 定位旧条目删除
      const index = new Map<string, number>();
      file.entries.forEach((e, i) => {
        if (e.key === key) index.set(key, i);
      });
      const entries = [...file.entries];
      const oldIdx = index.get(key);
      if (oldIdx !== undefined) entries.splice(oldIdx, 1);
      entries.push({ key, value, recordedAt: new Date().toISOString() });
      this.writeFile(sessionId, { version: 1, sessionId, entries });
    });
  }

  /**
   * 按队列顺序读全部 value 并清空（incremental ingest 消费；拿锁保证与写互斥）。
   * 「只记变化」：drain 后队列空，直到新变化再进。
   */
  async drain(sessionId: string): Promise<string[]> {
    return this.withLock(sessionId, async () => {
      const file = this.readFile(sessionId);
      if (file.entries.length === 0) return [];
      const values = file.entries.map((e) => e.value);
      this.writeFile(sessionId, { version: 1, sessionId, entries: [] });
      return values;
    });
  }

  /** 清空队列（full 模式消费；拿锁；幂等——空队列不写盘） */
  async clearAll(sessionId: string): Promise<void> {
    return this.withLock(sessionId, async () => {
      const file = this.readFile(sessionId);
      if (file.entries.length === 0) return;
      this.writeFile(sessionId, { version: 1, sessionId, entries: [] });
    });
  }
}

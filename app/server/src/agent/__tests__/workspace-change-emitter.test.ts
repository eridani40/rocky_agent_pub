/**
 * WorkspaceChangeEmitter 单元测试 —— per-session debounce 聚合 + emit 载荷
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md §8
 *       specs/tech/agent/session/[P0]session_event.md §2/§3（payload 契约）
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块1/模块5 change-emitter 行
 *
 * 覆盖：单条 push → flush 后 emit 正确 payload（relPath/kind/isDir）/ 跨平台 relPath 归一 '/' /
 *   同 kind+relPath 窗口内去重只发一条 / 不同 relPath 各自一条（不合并成总 event）/
 *   非文件变化事件（mapKind null）被忽略 / clear(sid) 取消 pending 不 emit / debounce 100ms 时序。
 *
 * 不涉及真实 chokidar/fs——push() 直接喂合成的 (eventName, absPath)，emitter 内部逻辑用真实
 * setTimeout（100ms 窗口很短，真实定时器 + 轮询足够稳定，不引入 vi.useFakeTimers 复杂度）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ReplayableEventBus } from '../event-bus';
import { WorkspaceChangeEmitter } from '../workspace-change-emitter';

let statusBus: ReplayableEventBus;
let emitter: WorkspaceChangeEmitter;

beforeEach(() => {
  statusBus = new ReplayableEventBus({ replayable: false });
  emitter = new WorkspaceChangeEmitter({ statusBus });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FileChangedPayload {
  type: string;
  sessionId: string;
  data: { path: string; kind: string; isDir: boolean };
}

/** 订阅 statusBus 收集某 sid 的全部 event（同既有 workspace-test-helpers 风格）。 */
function collect(sid: string): { events: FileChangedPayload[]; cancel: () => void } {
  const events: FileChangedPayload[] = [];
  const iter = statusBus.subscribe(`session_id:${sid}`)[Symbol.asyncIterator]();
  const stopSignal = { stopped: false };
  const consume = async () => {
    while (!stopSignal.stopped) {
      const r = await iter.next();
      if (r.done) break;
      events.push((r.value as { data: FileChangedPayload }).data);
    }
  };
  void consume();
  return {
    events,
    cancel: () => {
      stopSignal.stopped = true;
      void iter.return?.();
    },
  };
}

async function waitForCount(events: unknown[], minCount: number, maxMs = 1000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (events.length < minCount && Date.now() < deadline) {
    await sleep(10);
  }
}

describe('WorkspaceChangeEmitter — push → 100ms debounce → emit payload', () => {
  it('单条 add 事件 → emit session_workspace_file_changed，payload 含 path/kind/isDir', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'add', '/ws/root/a.txt');
    await waitForCount(col.events, 1);
    col.cancel();

    expect(col.events).toHaveLength(1);
    const ev = col.events[0]!;
    expect(ev.type).toBe('session_workspace_file_changed');
    expect(ev.sessionId).toBe('s1');
    expect(ev.data).toEqual({ path: 'a.txt', kind: 'add', isDir: false });
  });

  it('addDir/unlinkDir → isDir:true', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'addDir', '/ws/root/newDir');
    await waitForCount(col.events, 1);
    col.cancel();

    expect(col.events[0]!.data).toEqual({ path: 'newDir', kind: 'addDir', isDir: true });
  });

  it('relPath 相对传入的 workspaceDir 计算，跨平台归一 "/"（子目录场景含斜杠）', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'change', '/ws/root/sub/deep/file.py');
    await waitForCount(col.events, 1);
    col.cancel();

    expect(col.events[0]!.data.path).toBe('sub/deep/file.py');
  });

  it('非文件变化事件（ready/raw，mapKind 返回 null）被忽略，不 emit', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'ready', '/ws/root');
    emitter.push('s1', '/ws/root', 'raw', '/ws/root/x');
    await sleep(200);
    col.cancel();
    expect(col.events).toHaveLength(0);
  });

  it('同 kind+relPath 在 100ms 窗口内多次 push → 只发一条（去重合并）', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'change', '/ws/root/a.txt');
    emitter.push('s1', '/ws/root', 'change', '/ws/root/a.txt');
    emitter.push('s1', '/ws/root', 'change', '/ws/root/a.txt');
    await waitForCount(col.events, 1);
    await sleep(150); // 确认窗口内确实只发了一条，不会延迟再冒出第二条
    col.cancel();
    expect(col.events).toHaveLength(1);
  });

  it('窗口内不同 relPath 各自一条（不合并成总 event，spec §8）', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'add', '/ws/root/f1.txt');
    emitter.push('s1', '/ws/root', 'add', '/ws/root/f2.txt');
    await waitForCount(col.events, 2);
    col.cancel();

    expect(col.events).toHaveLength(2);
    expect(col.events.map((e) => e.data.path).sort()).toEqual(['f1.txt', 'f2.txt']);
  });

  it('不同 sessionId 互不干扰（各自独立 debounce buffer）', async () => {
    const col1 = collect('s1');
    const col2 = collect('s2');
    emitter.push('s1', '/ws/root1', 'add', '/ws/root1/a.txt');
    emitter.push('s2', '/ws/root2', 'add', '/ws/root2/b.txt');
    await waitForCount(col1.events, 1);
    await waitForCount(col2.events, 1);
    col1.cancel();
    col2.cancel();

    expect(col1.events).toHaveLength(1);
    expect(col1.events[0]!.data.path).toBe('a.txt');
    expect(col2.events).toHaveLength(1);
    expect(col2.events[0]!.data.path).toBe('b.txt');
  });

  it('flush() 可被直接调用立即 flush（跳过 100ms 等待窗口，emit 本身仍是异步队列投递）', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'add', '/ws/root/a.txt');
    emitter.flush('s1'); // 不等 100ms debounce timer，直接同步 flush 触发 statusBus.emit
    // statusBus 内部走异步队列投递给订阅者（非同步回调），故仍需等一拍，但远快于 100ms 窗口
    await waitForCount(col.events, 1, 200);
    expect(col.events).toHaveLength(1);
    col.cancel();
  });
});

describe('WorkspaceChangeEmitter — clear(sessionId) 取消 pending，不 emit', () => {
  it('push 后 clear → 不会在窗口到期时 emit（timer 被清）', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'add', '/ws/root/a.txt');
    emitter.clear('s1');
    await sleep(200); // 覆盖原 debounce 窗口，确认没有延迟 emit
    col.cancel();
    expect(col.events).toHaveLength(0);
  });

  it('clear 对没有 pending 的 sessionId 是安全 no-op（幂等）', () => {
    expect(() => emitter.clear('never-pushed')).not.toThrow();
  });

  it('clear 后再次 push 仍正常工作（buffer 已被完全清除重建）', async () => {
    const col = collect('s1');
    emitter.push('s1', '/ws/root', 'add', '/ws/root/a.txt');
    emitter.clear('s1');
    emitter.push('s1', '/ws/root', 'add', '/ws/root/b.txt');
    await waitForCount(col.events, 1);
    col.cancel();
    expect(col.events).toHaveLength(1);
    expect(col.events[0]!.data.path).toBe('b.txt');
  });
});

/**
 * file-lock 单测 — 进程内 async mutex（spec §3 锁原语）
 * 参考: specs/tech/persistence/[P1]file_write_lock.md §3 + §3.4 伪码 + §7（C1/C2/C10）
 *
 * 覆盖：同 path FIFO 串行（C1 互斥、C2 N=10 顺序+无交错）、key 规范化、错误隔离
 *      （中间 reject 不污染链）、enqueueFileWrite fire-and-forget（C10）、不同 path 并行、entry GC。
 * 时序控制：用 gate promise 阻塞 fn，精确断言「前者未 settle 时后者不启动」。
 */
import { describe, it, expect, vi } from 'vitest';
import { withFileLock, enqueueFileWrite, getLockSize } from '../file-lock';

/** 让出微任务队列（含 finally handler），用于等待 entry GC 完成 */
const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 构造可控 gate：返回 release 函数 + 等待中的 promise */
function makeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
}

// ============================================================
// 同 path FIFO 串行
// ============================================================
describe('withFileLock — 同 path FIFO 串行', () => {
  it('C1: 前者未 settle 时后者不启动（精确互斥）', async () => {
    const events: string[] = [];
    const { gate, release } = makeGate();
    let secondStarted = false;

    const p1 = withFileLock('/fl/c1/foo.json', async () => {
      events.push('s1');
      await gate;
      events.push('e1');
    });
    const p2 = withFileLock('/fl/c1/foo.json', async () => {
      secondStarted = true;
      events.push('s2');
      events.push('e2');
    });

    // 让微任务跑两轮：p1 应启动（被 gate 挂住），p2 应排队未启动
    await flushMicrotasks();
    expect(events).toEqual(['s1']);
    expect(secondStarted).toBe(false);

    release();
    await Promise.all([p1, p2]);
    expect(events).toEqual(['s1', 'e1', 's2', 'e2']);
  });

  it('C2: N=10 并发同 path，按入队顺序执行，事件无交错', async () => {
    const events: string[] = [];
    const N = 10;
    // 每个 fn 让出一次微任务（模拟 await 点），若锁失效则会交错
    const make = (i: number) => async () => {
      events.push(`s${i}`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`e${i}`);
    };

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(withFileLock('/fl/c2/foo.json', make(i)));
    }
    await Promise.all(promises);

    // 期望事件流：s0,e0,s1,e1,...,s9,e9（每项 end 紧跟其 start，无交错）
    const expected: string[] = [];
    for (let i = 0; i < N; i++) {
      expected.push(`s${i}`, `e${i}`);
    }
    expect(events).toEqual(expected);
  });

  it('key 规范化：path.resolve 归一后，y/../foo.json 与 foo.json 共用同一锁', async () => {
    const events: string[] = [];
    const { gate, release } = makeGate();

    // /fl/key/y/../foo.json resolve 后 = /fl/key/foo.json
    const p1 = withFileLock('/fl/key/y/../foo.json', async () => {
      events.push('s1');
      await gate;
      events.push('e1');
    });
    const p2 = withFileLock('/fl/key/foo.json', async () => {
      events.push('s2');
      events.push('e2');
    });

    await flushMicrotasks();
    expect(events).toEqual(['s1']); // p2 被 p1 挡住（证明归一到同 key）

    release();
    await Promise.all([p1, p2]);
    expect(events).toEqual(['s1', 'e1', 's2', 'e2']);
  });
});

// ============================================================
// 错误隔离
// ============================================================
describe('withFileLock — 错误隔离', () => {
  it('中间一项 reject → 后续项仍执行且按序', async () => {
    const events: string[] = [];

    const p1 = withFileLock('/fl/ei/foo.json', async () => {
      events.push('s1');
      events.push('e1');
      return 1;
    });
    const p2 = withFileLock('/fl/ei/foo.json', async () => {
      events.push('s2');
      events.push('e2');
      throw new Error('boom-mid');
    });
    const p3 = withFileLock('/fl/ei/foo.json', async () => {
      events.push('s3');
      events.push('e3');
      return 3;
    });

    await expect(p1).resolves.toBe(1);
    await expect(p2).rejects.toThrow('boom-mid');
    await expect(p3).resolves.toBe(3);

    // 关键：p2 reject 没有让链断裂，p3 照常执行
    expect(events).toEqual(['s1', 'e1', 's2', 'e2', 's3', 'e3']);
  });

  it('首项 reject 不短路后续项', async () => {
    const events: string[] = [];

    const p1 = withFileLock('/fl/ei2/foo.json', async () => {
      events.push('s1');
      throw new Error('boom-first');
    });
    const p2 = withFileLock('/fl/ei2/foo.json', async () => {
      events.push('s2');
      return 'ok';
    });

    await expect(p1).rejects.toThrow('boom-first');
    await expect(p2).resolves.toBe('ok');
    expect(events).toEqual(['s1', 's2']);
  });
});

// ============================================================
// enqueueFileWrite — fire-and-forget
// ============================================================
describe('enqueueFileWrite — fire-and-forget（C10）', () => {
  it('C10: 返回 void 不阻塞调用方', () => {
    const ret = enqueueFileWrite('/fl/ef/foo.json', async () => 'whatever');
    expect(ret).toBeUndefined();
  });

  it('写仍串行落盘（FIFO，与 withFileLock 共享同一队列）', async () => {
    const events: string[] = [];
    const { gate, release } = makeGate();

    enqueueFileWrite('/fl/ef2/foo.json', async () => {
      events.push('s1');
      await gate;
      events.push('e1');
    });
    enqueueFileWrite('/fl/ef2/foo.json', async () => {
      events.push('s2');
      events.push('e2');
    });

    await flushMicrotasks();
    expect(events).toEqual(['s1']); // 第二项被第一项挡住

    release();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(events).toEqual(['s1', 'e1', 's2', 'e2']);
  });

  it('错误被吞（不抛 unhandledRejection）', async () => {
    let unhandled: unknown = null;
    const handler = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', handler);
    try {
      enqueueFileWrite('/fl/ef3/foo.json', async () => {
        throw new Error('boom-enqueue');
      });
      // 等足够微任务让 fn 执行 + 错误被 catch
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('错误经 console.error("[file-lock]", e) 输出', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    enqueueFileWrite('/fl/ef4/foo.json', async () => {
      throw new Error('boom-log');
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const call = errSpy.mock.calls[0]!;
    expect(call[0]).toBe('[file-lock]');
    expect((call[1] as Error).message).toBe('boom-log');
    errSpy.mockRestore();
  });
});

// ============================================================
// 不同 path 并行
// ============================================================
describe('不同 path 并行', () => {
  it('两个不同 path 可同时启动（不互相等待）', async () => {
    const events: string[] = [];
    const { gate: gate1, release: release1 } = makeGate();
    const { gate: gate2, release: release2 } = makeGate();
    let p1Started = false;
    let p2Started = false;

    const p1 = withFileLock('/fl/par/a.json', async () => {
      p1Started = true;
      events.push('s1');
      await gate1;
      events.push('e1');
    });
    const p2 = withFileLock('/fl/par/b.json', async () => {
      p2Started = true;
      events.push('s2');
      await gate2;
      events.push('e2');
    });

    await flushMicrotasks();
    // 两个不同 path 都已启动（并行），不会被对方挡住
    expect(p1Started).toBe(true);
    expect(p2Started).toBe(true);
    expect(events).toContain('s1');
    expect(events).toContain('s2');

    release1();
    release2();
    await Promise.all([p1, p2]);
  });
});

// ============================================================
// entry GC
// ============================================================
describe('entry GC', () => {
  it('全部完成后 Map 不残留（getLockSize===0）', async () => {
    const before = getLockSize();
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        withFileLock('/fl/gc/foo.json', async () => {
          await Promise.resolve();
          return i;
        }),
      );
    }
    await Promise.all(promises);
    // 让 finally handler 跑完
    await flushMicrotasks();

    // 链尾 entry 应已删除（不残留）
    expect(getLockSize()).toBe(before);
  });

  it('执行期间 entry 存在；全部 settle 后归零', async () => {
    const before = getLockSize();
    const { gate, release } = makeGate();

    const p = withFileLock('/fl/gc2/foo.json', async () => {
      await gate;
    });
    await flushMicrotasks();
    // 持锁期间 entry 存在
    expect(getLockSize()).toBe(before + 1);

    release();
    await p;
    await flushMicrotasks();
    // settle 后 entry 被删
    expect(getLockSize()).toBe(before);
  });
});

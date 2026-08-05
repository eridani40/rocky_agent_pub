/**
 * EventStore UT — append + read + subscribe + seq 单调递增.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../events';

let tmpDir: string;
let store: EventStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-evt-'));
  store = new EventStore({ panoramaDir: tmpDir, now: () => '2026-07-22T00:00:00.000Z' });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('EventStore — append + read', () => {
  it('append 返回 seq=1', () => {
    const ev = store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    expect(ev.seq).toBe(1);
    expect(ev.ts).toBe('2026-07-22T00:00:00.000Z');
  });

  it('seq 单调递增', () => {
    const e1 = store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    const e2 = store.append({ type: 'entity.updated', entity: 'e1', payload: {} });
    const e3 = store.append({ type: 'entity.transition', entity: 'e1', payload: {} });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it('read 返回全部', () => {
    store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    store.append({ type: 'entity.updated', entity: 'e1', payload: {} });
    const events = store.read();
    expect(events).toHaveLength(2);
  });

  it('read(since=1) 跳过 seq≤1', () => {
    store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    store.append({ type: 'entity.updated', entity: 'e1', payload: {} });
    store.append({ type: 'entity.transition', entity: 'e1', payload: {} });
    const events = store.read(1);
    expect(events).toHaveLength(2);
    expect(events[0]!.seq).toBe(2);
  });

  it('read limit 截断', () => {
    for (let i = 0; i < 5; i++) {
      store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    }
    const events = store.read(0, 3);
    expect(events).toHaveLength(3);
    expect(events[0]!.seq).toBe(3); // slice(-3)
  });

  it('空文件 read → []', () => {
    expect(store.read()).toHaveLength(0);
  });
});

describe('EventStore — allocateSeq + appendWithSeq', () => {
  it('allocateSeq 不写事件但推进 seq', () => {
    const seq = store.allocateSeq();
    expect(seq).toBe(1);
    expect(store.readAll()).toHaveLength(0); // 无事件写入
  });

  it('allocateSeq + appendWithSeq 用同一 seq', () => {
    const seq = store.allocateSeq();
    store.appendWithSeq(seq, { type: 'board.defined', entity: '*', payload: {} });
    const events = store.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBe(seq);
  });

  it('allocateSeq 后 append 继续递增', () => {
    const seq1 = store.allocateSeq(); // seq=1（预分配）
    store.appendWithSeq(seq1, { type: 'board.defined', entity: '*', payload: {} });
    const ev = store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    expect(ev.seq).toBe(2);
  });
});

describe('EventStore — subscribe', () => {
  it('append 触发订阅回调', () => {
    const received: number[] = [];
    const unsub = store.subscribe(ev => received.push(ev.seq));
    store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    store.append({ type: 'entity.updated', entity: 'e1', payload: {} });
    expect(received).toEqual([1, 2]);
  });

  it('unsubscribe 后不再触发', () => {
    const received: number[] = [];
    const unsub = store.subscribe(ev => received.push(ev.seq));
    store.append({ type: 'entity.created', entity: 'e1', payload: {} });
    unsub();
    store.append({ type: 'entity.updated', entity: 'e1', payload: {} });
    expect(received).toEqual([1]);
  });
});

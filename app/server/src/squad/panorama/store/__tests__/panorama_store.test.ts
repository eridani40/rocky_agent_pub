/**
 * PanoramaEntityStore UT — 泛化 KV CRUD + board.yaml + ID 生成 + 信封 + lastWriteMessageId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PanoramaEntityStore } from '../panorama_store';

let tmpDir: string;
let store: PanoramaEntityStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-store-'));
  store = new PanoramaEntityStore({ root: tmpDir, squadId: 'sq1', now: () => '2026-07-22T00:00:00.000Z' });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PanoramaEntityStore — 泛化 KV CRUD', () => {
  it('putInstance 创建实例 + 信封', () => {
    const rec = store.putInstance('pipeline_run', 'pr-001', { status: 'queued' });
    expect(rec.id).toBe('pr-001');
    expect((rec._envelope as { createdAt: string }).createdAt).toBe('2026-07-22T00:00:00.000Z');
    expect((rec._envelope as { version: number }).version).toBe(1);
  });

  it('getInstance 读回', () => {
    store.putInstance('pipeline_run', 'pr-001', { status: 'queued' });
    const got = store.getInstance('pipeline_run', 'pr-001');
    expect(got).toBeDefined();
    expect(got!.status).toBe('queued'); // status is accessible on Record<string, unknown>
  });

  it('getInstance 不存在 → undefined', () => {
    expect(store.getInstance('pipeline_run', 'nope')).toBeUndefined();
  });

  it('listInstances 扫描目录', () => {
    store.putInstance('pipeline_run', 'pr-001', { status: 'queued' });
    store.putInstance('pipeline_run', 'pr-002', { status: 'running' });
    const list = store.listInstances('pipeline_run');
    expect(list).toHaveLength(2);
  });

  it('listInstances 空目录 → []', () => {
    expect(store.listInstances('pipeline_run')).toHaveLength(0);
  });

  it('putInstance 更新 → version 自增', () => {
    store.putInstance('pipeline_run', 'pr-001', { status: 'queued' });
    store.putInstance('pipeline_run', 'pr-001', { status: 'running' });
    const got = store.getInstance('pipeline_run', 'pr-001');
    expect(got!.status).toBe('running');
    expect((got!._envelope as { version: number }).version).toBe(2);
  });

  it('deleteInstance → true', () => {
    store.putInstance('pipeline_run', 'pr-001', { status: 'queued' });
    expect(store.deleteInstance('pipeline_run', 'pr-001')).toBe(true);
    expect(store.getInstance('pipeline_run', 'pr-001')).toBeUndefined();
  });

  it('deleteInstance 不存在 → false', () => {
    expect(store.deleteInstance('pipeline_run', 'nope')).toBe(false);
  });

  it('hasId 检查', () => {
    store.putInstance('pipeline_run', 'pr-001', { status: 'queued' });
    expect(store.hasId('pipeline_run', 'pr-001')).toBe(true);
    expect(store.hasId('pipeline_run', 'pr-002')).toBe(false);
  });
});

describe('PanoramaEntityStore — lastWriteMessageId', () => {
  it('putInstance 带 messageId → 写入 lastWriteMessageId', () => {
    store.putInstance('pipeline_run', 'pr-001', { status: 'queued' }, { messageId: '01JTEST' });
    const got = store.getInstance('pipeline_run', 'pr-001');
    expect(got!.lastWriteMessageId).toBe('01JTEST');
  });

  it('putInstance 不带 messageId → 无 lastWriteMessageId 字段', () => {
    store.putInstance('pipeline_run', 'pr-001', { status: 'queued' });
    const got = store.getInstance('pipeline_run', 'pr-001');
    expect(got!.lastWriteMessageId).toBeUndefined();
  });

  it('createInstance 带 source=agent + messageId', () => {
    store.createInstance('pipeline_run', 'pr-001', { status: 'queued' }, { source: 'agent', messageId: '01JMSG' });
    const got = store.getInstance('pipeline_run', 'pr-001');
    expect(got!.lastWriteMessageId).toBe('01JMSG');
    const events = store.readEvents();
    expect(events[0]!.source).toBe('agent');
    expect(events[0]!.messageId).toBe('01JMSG');
  });
});

describe('PanoramaEntityStore — board.yaml', () => {
  it('readBoard 不存在 → null', () => {
    expect(store.readBoard()).toBeNull();
  });

  it('writeBoard + readBoard 往返', () => {
    const schema = {
      meta: { version: '1.0' },
      entities: { e1: { label: 'E', id_field: 'id', fields: { id: { type: 'string' as const } } } },
      views: [],
    };
    store.writeBoard(schema);
    const read = store.readBoard();
    expect(read).not.toBeNull();
    expect(read!.entities.e1).toBeDefined();
  });
});

describe('PanoramaEntityStore — ID 生成', () => {
  it('nextId 格式 {entity}-{seq}，4 位 padded', async () => {
    const id1 = await store.nextId('pipeline_run');
    expect(id1).toBe('pipeline_run-0001');
    const id2 = await store.nextId('pipeline_run');
    expect(id2).toBe('pipeline_run-0002');
  });

  it('不同 entity 独立计数', async () => {
    const a1 = await store.nextId('entity_a');
    const b1 = await store.nextId('entity_b');
    const a2 = await store.nextId('entity_a');
    expect(a1).toBe('entity_a-0001');
    expect(b1).toBe('entity_b-0001');
    expect(a2).toBe('entity_a-0002');
  });
});

describe('PanoramaEntityStore — 便捷写入', () => {
  it('transitionInstance 写跃迁事件', () => {
    store.createInstance('pipeline_run', 'pr-001', { status: 'queued' });
    store.transitionInstance('pipeline_run', 'pr-001', 'status', 'queued', 'running', { source: 'drag' });
    const events = store.readEvents();
    const trans = events.find(e => e.type === 'entity.transition');
    expect(trans).toBeDefined();
    expect(trans!.payload.from).toBe('queued');
    expect(trans!.payload.to).toBe('running');
    expect(trans!.source).toBe('drag');
  });

  it('removeInstance 写删除事件', () => {
    store.createInstance('pipeline_run', 'pr-001', { status: 'queued' });
    store.removeInstance('pipeline_run', 'pr-001');
    const events = store.readEvents();
    expect(events.find(e => e.type === 'entity.deleted')).toBeDefined();
    expect(store.getInstance('pipeline_run', 'pr-001')).toBeUndefined();
  });
});

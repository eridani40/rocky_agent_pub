/**
 * applyMigration UT — 原子性 + 备份 + 审计 + handler 6 策略覆盖：
 *   纯增量自动落盘 / major 需审批 throw / 审批通过执行 / backup 创建 /
 *   mapping handler / drop handler / transform handler / clip handler /
 *   dryRun 不落盘 / audit entry 写入 events.jsonl.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyMigration } from '../apply_migration';
import { PanoramaEntityStore } from '../../store/panorama_store';
import type { PanoramaSchema } from '../../dsl/types';
import { BreakingChangeRequiresApprovalError } from '../types';

let tmpDir: string;

function makeStore(): PanoramaEntityStore {
  return new PanoramaEntityStore({ root: tmpDir, squadId: 'sq1' });
}

function ciCdSchema(): PanoramaSchema {
  return {
    meta: { version: '1.0', author: 's1' },
    entities: {
      pipeline_run: {
        label: 'Pipeline',
        id_field: 'id',
        fields: {
          id: { type: 'string' },
          status: { type: 'enum', values: ['queued', 'running', 'success', 'failed'] },
          triggered_by: { type: 'string' },
          duration_sec: { type: 'number', min: 0, max: 600 },
        },
        states: {
          field: 'status',
          initial: 'queued',
          transitions: { queued: [{ to: 'running' }], running: [{ to: 'success' }, { to: 'failed' }] },
          terminal: ['success', 'failed'],
        },
      },
    },
    views: [],
  };
}


function ent(s: PanoramaSchema) {
  return s.entities.pipeline_run!;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-mig-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('applyMigration — 纯增量', () => {
  it('加字段 → 自动落盘 + 审计', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    const next = ciCdSchema();
    ent(next).fields.env = { type: 'string' };

    const result = applyMigration(store, { oldSchema: old, newSchema: next });
    expect(result.applied).toBe(true);
    expect(result.operationsExecuted).toBe(0);

    // board.yaml 已更新
    const board = store.readBoard();
    expect(board!.entities.pipeline_run!.fields.env).toBeDefined();

    // 审计事件写入
    const events = store.readEvents();
    const defined = events.find(e => e.type === 'board.defined');
    expect(defined).toBeDefined();
  });
});

describe('applyMigration — 重大变更审批', () => {
  it('有数据的重大变更未审批 → throw BreakingChangeRequiresApprovalError', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued', triggered_by: 'bot' });

    const next = ciCdSchema();
    delete ent(next).fields.triggered_by;

    expect(() => applyMigration(store, { oldSchema: old, newSchema: next })).toThrow(BreakingChangeRequiresApprovalError);
  });

  it('approved=true → 执行迁移', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued', triggered_by: 'bot' });

    const next = ciCdSchema();
    delete ent(next).fields.triggered_by;

    const result = applyMigration(store, { oldSchema: old, newSchema: next, approved: true });
    expect(result.applied).toBe(true);
    expect(result.operationsExecuted).toBeGreaterThan(0);

    // 字段已删
    const inst = store.getInstance('pipeline_run', 'pr-001');
    expect(inst!.triggered_by).toBeNull();
  });
});

describe('applyMigration — handler 策略', () => {
  it('mapping handler — enum 收窄值映射', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued' });
    store.putInstance('pipeline_run', 'pr-002', { id: 'pr-002', status: 'running' });

    const next = ciCdSchema();
    ent(next).fields = {
      id: { type: 'string' },
      status: { type: 'enum', values: ['pending', 'in_progress', 'done'] },
      triggered_by: { type: 'string' },
      duration_sec: { type: 'number', min: 0, max: 600 },
    };
    ent(next).states = {
      field: 'status', initial: 'pending',
      transitions: { pending: [{ to: 'in_progress' }] }, terminal: ['done'],
    };

    const result = applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [
          {
            operation: 'narrow_enum',
            target: { entity: 'pipeline_run', field: 'status' },
            from: ['queued', 'running', 'success', 'failed'],
            to: ['pending', 'in_progress', 'done'],
            handler: {
              strategy: 'mapping',
              mapping: { queued: 'pending', running: 'in_progress', success: 'done', failed: 'done' },
            },
          },
          {
            operation: 'expand_terminal',
            target: { entity: 'pipeline_run' },
            handler: { strategy: 'default' },
          },
        ],
      },
    });

    expect(result.applied).toBe(true);
    expect((store.getInstance('pipeline_run', 'pr-001') as Record<string, unknown>)!.status).toBe('pending');
    expect((store.getInstance('pipeline_run', 'pr-002') as Record<string, unknown>)!.status).toBe('in_progress');
  });

  it('drop handler — 字段删除设 null', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued', triggered_by: 'ci-bot' });

    const next = ciCdSchema();
    delete ent(next).fields.triggered_by;

    applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'delete_field',
          target: { entity: 'pipeline_run', field: 'triggered_by' },
          handler: { strategy: 'drop' },
        }],
      },
    });

    expect(store.getInstance('pipeline_run', 'pr-001')!.triggered_by).toBeNull();
  });

  it('transform handler — 类型变更 parseFloat', () => {
    const store = makeStore();
    const old = ciCdSchema();
    // 旧 schema：duration_sec 是 string（模拟类型从 string→number）
    ent(old).fields.duration_sec = { type: 'string' };
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued', duration_sec: '120' });

    const next = ciCdSchema();
    // 新 schema：duration_sec 是 number
    ent(next).fields.duration_sec = { type: 'number', min: 0, max: 600 };

    applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'change_field_type',
          target: { entity: 'pipeline_run', field: 'duration_sec' },
          from: 'string', to: 'number',
          handler: { strategy: 'transform', transform: 'parseFloat(value)' },
        }],
      },
    });

    expect((store.getInstance('pipeline_run', 'pr-001') as Record<string, unknown>)!.duration_sec).toBe(120);
  });

  it('clip handler — 约束收紧截断', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued', duration_sec: 900 });

    const next = ciCdSchema();
    ent(next).fields.duration_sec = { type: 'number', min: 0, max: 300 };

    const result = applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'tighten_constraint',
          target: { entity: 'pipeline_run', field: 'duration_sec' },
          handler: { strategy: 'clip', default_value: 0 },
        }],
      },
    });

    expect(result.applied).toBe(true);
    expect((store.getInstance('pipeline_run', 'pr-001') as Record<string, unknown>)!.duration_sec).toBe(300);
  });

  it('archive handler — delete_entity 标记 _archived 并保留实例', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued' });

    const next: PanoramaSchema = { ...old, entities: {} };

    applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'delete_entity',
          target: { entity: 'pipeline_run' },
          handler: { strategy: 'archive' },
        }],
      },
    });

    const inst = store.getInstance('pipeline_run', 'pr-001') as Record<string, unknown>;
    expect(inst).toBeDefined();
    expect(inst._archived).toBe(true);
  });

  it('purge handler — delete_entity 物理删除实例', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued' });
    store.putInstance('pipeline_run', 'pr-002', { id: 'pr-002', status: 'running' });

    const next: PanoramaSchema = { ...old, entities: {} };

    applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'delete_entity',
          target: { entity: 'pipeline_run' },
          handler: { strategy: 'purge' },
        }],
      },
    });

    expect(store.getInstance('pipeline_run', 'pr-001')).toBeUndefined();
    expect(store.getInstance('pipeline_run', 'pr-002')).toBeUndefined();
  });

  it('default handler — change_field_type 设默认值', () => {
    const store = makeStore();
    const old = ciCdSchema();
    ent(old).fields.duration_sec = { type: 'number' };
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued', duration_sec: 42 });

    const next = ciCdSchema();
    ent(next).fields.duration_sec = { type: 'string' };

    applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'change_field_type',
          target: { entity: 'pipeline_run', field: 'duration_sec' },
          from: 'number', to: 'string',
          handler: { strategy: 'default', default_value: '0' },
        }],
      },
    });

    expect((store.getInstance('pipeline_run', 'pr-001') as Record<string, unknown>)!.duration_sec).toBe('0');
  });

  it('change_state_field — status 值迁移到 phase，旧字段置 null', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'running' });
    store.putInstance('pipeline_run', 'pr-002', { id: 'pr-002', status: 'queued' });

    const next = ciCdSchema();
    ent(next).states = {
      field: 'phase', initial: 'queued',
      transitions: { queued: [{ to: 'running' }] }, terminal: ['success'],
    };

    applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'change_state_field',
          target: { entity: 'pipeline_run' },
          from: 'status', to: 'phase',
          handler: { strategy: 'default' },
        }],
      },
    });

    const inst1 = store.getInstance('pipeline_run', 'pr-001') as Record<string, unknown>;
    const inst2 = store.getInstance('pipeline_run', 'pr-002') as Record<string, unknown>;
    expect(inst1.phase).toBe('running');
    expect(inst1.status).toBeNull();
    expect(inst2.phase).toBe('queued');
    expect(inst2.status).toBeNull();
  });
});

describe('applyMigration — 备份 + 原子性', () => {
  it('破坏性变更前创建备份目录', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued' });

    const next = ciCdSchema();
    delete ent(next).fields.triggered_by;

    const result = applyMigration(store, { oldSchema: old, newSchema: next, approved: true });
    expect(result.backupPath).toBeDefined();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(fs.existsSync(path.join(result.backupPath!, 'board.yaml.bak'))).toBe(true);
  });

  it('无存量数据的破坏性变更 → minor 不需审批', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    // 无实例

    const next = ciCdSchema();
    delete ent(next).fields.triggered_by;

    const result = applyMigration(store, { oldSchema: old, newSchema: next });
    expect(result.applied).toBe(true);
  });

  it('rollback 原子性 — operation 中途失败 → 恢复 board.yaml + 实例数据', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued', triggered_by: 'bot' });
    store.putInstance('pipeline_run', 'pr-002', { id: 'pr-002', status: 'running', triggered_by: 'ci' });

    const next = ciCdSchema();
    delete ent(next).fields.triggered_by;

    // monkey-patch putInstance：第 2 次调用抛错（模拟 operation 中途失败），后续正常（供 rollback 恢复）
    let callCount = 0;
    const realPut = store.putInstance.bind(store);
    vi.spyOn(store, 'putInstance').mockImplementation((...args) => {
      callCount++;
      if (callCount === 2) throw new Error('simulated mid-operation failure');
      return realPut(...args);
    });

    expect(() => applyMigration(store, {
      oldSchema: old, newSchema: next, approved: true,
      plan: {
        operations: [{
          operation: 'delete_field',
          target: { entity: 'pipeline_run', field: 'triggered_by' },
          handler: { strategy: 'drop' },
        }],
      },
    })).toThrow('simulated mid-operation failure');

    // rollback 恢复 board.yaml（triggered_by 字段仍在）
    const board = store.readBoard();
    expect(board!.entities.pipeline_run!.fields.triggered_by).toBeDefined();

    // rollback 恢复实例数据（原始值完好）
    const inst1 = store.getInstance('pipeline_run', 'pr-001') as Record<string, unknown>;
    const inst2 = store.getInstance('pipeline_run', 'pr-002') as Record<string, unknown>;
    expect(inst1.triggered_by).toBe('bot');
    expect(inst2.triggered_by).toBe('ci');
  });
});

describe('applyMigration — dryRun', () => {
  it('dryRun 不落盘不审计', () => {
    const store = makeStore();
    const old = ciCdSchema();
    store.writeBoard(old);
    store.putInstance('pipeline_run', 'pr-001', { id: 'pr-001', status: 'queued' });

    const next = ciCdSchema();
    ent(next).fields.env = { type: 'string' };

    const result = applyMigration(store, { oldSchema: old, newSchema: next, dryRun: true });
    expect(result.applied).toBe(false);

    // board.yaml 未变（没有 env 字段）
    const board = store.readBoard();
    expect(board!.entities.pipeline_run!.fields.env).toBeUndefined();
  });
});

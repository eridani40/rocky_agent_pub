/**
 * panorama define 演进闭环 + delete action UT（BUG-001 教训：公开入口端到端覆盖）.
 * 参考: specs/tech/squad/[P1]panorama_tools.md §2.1 / specs/tech/squad/[P1]panorama_migration.md §4/§6
 *       states/v0.0.189.dsl_board/bugs/BUG-001（L4 堵死 applyMigration）
 * 覆盖：裸提交被 L4 data_safety 拦 / approved:true 引擎自动迁移（archive）/
 *       migration narrow_enum+mapping 成功 / 缺 mapping → postcheck 回滚 /
 *       delete action / number Infinity 拒绝 / 字段 label round-trip。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { panoramaTool } from '../tool/panorama-tool';
import type { AgentToolRuntimeContext } from '../../../agent/tools/runtime-context';
import type { ToolInput } from '../../../tools/types';

/** 双实体 DSL：ticket（priority enum 供收窄 + score number）+ note（陪跑实体） */
const DSL_TWO = `
version:
  id: ev
  name: Ev
  board_name: EvBoard
entities:
  ticket:
    label: 工单
    id_field: id
    fields:
      id:       { type: string }
      title:    { type: string, label: 标题 }
      priority: { type: enum, values: [low, mid, high] }
      score:    { type: number }
  note:
    label: 笔记
    id_field: id
    fields:
      id: { type: string }
views:
  - id: ticket_table
    label: 工单
    entity: ticket
    component: table
    columns: [id, priority]
`;

/** 删掉 ticket 实体后的 DSL（view 同步移除，否则 L3 语义校验报 unknown entity） */
const DSL_NO_TICKET = `
version:
  id: ev
  name: Ev
  board_name: EvBoard
entities:
  note:
    label: 笔记
    id_field: id
    fields:
      id: { type: string }
views:
  - id: note_table
    label: 笔记
    entity: note
    component: table
    columns: [id]
`;

/** priority 收窄 [low,mid,high] → [low,high]（states 不涉及，免状态机联动变更） */
const DSL_NARROW = DSL_TWO.replace('values: [low, mid, high]', 'values: [low, high]');

let tmpDir: string;
let dataDir: string;
const squadId = 'sq-ev';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-ev-'));
  dataDir = tmpDir;
  fs.mkdirSync(path.join(dataDir, 'squads', squadId, 'panorama', 'entities'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'squads', squadId, 'panorama', '.state'), { recursive: true });
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function rtc(): AgentToolRuntimeContext {
  return {
    parentSessionId: 's1', parentRunId: 'r1', parentType: 'leader', parentName: 'L', parentScope: 'session',
    selfSessionId: 's1', selfType: 'leader', selfName: 'L',
    selfSquadId: squadId, selfMemberId: 'm1',
    agentManager: {} as never, store: {} as never, sessionDeps: {} as never,
    currentMessageId: 'msg-1',
  } as AgentToolRuntimeContext;
}

async function run(input: ToolInput) {
  return await panoramaTool.run(input, { config: { dataDir, agentToolContext: rtc() }, workdir: tmpDir } as never);
}

function textOf(res: { content: unknown[] }): string {
  return (res.content[0] as { text?: string }).text as string;
}

function jsonOf(res: { content: unknown[] }): unknown {
  return JSON.parse(textOf(res));
}

/** 直读实例文件（验证 archive 标记等磁盘整存） */
function readInst(entity: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(
    path.join(dataDir, 'squads', squadId, 'panorama', 'entities', entity, `${id}.json`), 'utf8'));
}

describe('panorama define — 演进闭环（BUG-001）', () => {
  beforeEach(async () => {
    await run({ action: 'define', dsl: DSL_TWO });
    await run({ action: 'create', entity: 'ticket', fields: { id: 't1', priority: 'mid' } });
  });

  it('裸提交删实体（有存量）→ L4 data_safety 拦 + board 不变', async () => {
    const res = await run({ action: 'define', dsl: DSL_NO_TICKET });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('panorama_dropping_entity_data');
    // board 未被改动
    const gs = jsonOf(await run({ action: 'get_schema' })) as { dsl: string };
    expect(gs.dsl).toContain('ticket');
  });

  it('approved:true 删实体（有存量）→ 成功 + 实例 archive', async () => {
    const res = await run({ action: 'define', dsl: DSL_NO_TICKET, approved: true });
    expect(jsonOf(res)).toEqual({ ok: true });
    const gs = jsonOf(await run({ action: 'get_schema' })) as { dsl: string };
    expect(gs.dsl).not.toContain('ticket');
    // 实例被标记 _archived（保留数据）
    expect(readInst('ticket', 't1')._archived).toBe(true);
  });

  it('migration narrow_enum + mapping → 成功，存量值已映射', async () => {
    await run({ action: 'create', entity: 'ticket', fields: { id: 't2', priority: 'low' } });
    const migration = {
      operations: [{
        operation: 'narrow_enum',
        target: { entity: 'ticket', field: 'priority' },
        from: ['low', 'mid', 'high'],
        to: ['low', 'high'],
        handler: { strategy: 'mapping', mapping: { mid: 'low' } },
      }],
    };
    const res = await run({ action: 'define', dsl: DSL_NARROW, migration, approved: true });
    expect(jsonOf(res)).toEqual({ ok: true });
    expect(readInst('ticket', 't1').priority).toBe('low'); // mid → low
    expect(readInst('ticket', 't2').priority).toBe('low'); // 幂等
  });

  it('narrow_enum 缺 mapping → panorama_migration_postcheck + 全回滚', async () => {
    const migration = {
      operations: [{
        operation: 'narrow_enum',
        target: { entity: 'ticket', field: 'priority' },
        from: ['low', 'mid', 'high'],
        to: ['low', 'high'],
        handler: { strategy: 'mapping' },
      }],
    };
    const res = await run({ action: 'define', dsl: DSL_NARROW, migration, approved: true });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('panorama_migration_postcheck');
    // 回滚：board 仍是旧 DSL，实例值未动
    const gs = jsonOf(await run({ action: 'get_schema' })) as { dsl: string };
    expect(gs.dsl).toContain('mid');
    expect(readInst('ticket', 't1').priority).toBe('mid');
  });
});

describe('panorama tool — delete action', () => {
  beforeEach(async () => {
    await run({ action: 'define', dsl: DSL_TWO });
    await run({ action: 'create', entity: 'ticket', fields: { id: 't1' } });
  });

  it('delete 删实例成功', async () => {
    const res = await run({ action: 'delete', entity: 'ticket', id: 't1' });
    expect(jsonOf(res)).toEqual({ ok: true, id: 't1' });
    const q = jsonOf(await run({ action: 'query', entity: 'ticket' })) as { instances: unknown[] };
    expect(q.instances).toHaveLength(0);
  });

  it('delete 实例不存在 → panorama_instance_not_found', async () => {
    const res = await run({ action: 'delete', entity: 'ticket', id: 'nope' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('panorama_instance_not_found');
  });
});

describe('panorama 实例校验 — number Infinity + 字段 label', () => {
  beforeEach(async () => {
    await run({ action: 'define', dsl: DSL_TWO });
  });

  it('number 字段 Infinity → panorama_type_mismatch', async () => {
    const res = await run({ action: 'create', entity: 'ticket', fields: { id: 't9', score: Infinity } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('panorama_type_mismatch');
  });

  it('number 字段 NaN → panorama_type_mismatch（回归）', async () => {
    const res = await run({ action: 'create', entity: 'ticket', fields: { id: 't9', score: NaN } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('panorama_type_mismatch');
  });

  it('字段 label 过 server round-trip（get_schema 保留）', async () => {
    const gs = jsonOf(await run({ action: 'get_schema' })) as { dsl: string };
    expect(gs.dsl).toContain('label: 标题');
  });
});

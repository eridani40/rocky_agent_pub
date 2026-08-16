/**
 * panorama 工具 UT — 7 action + 权限 + 错误码（panorama_tools.md §2/§3/§4）.
 * 参考: specs/tech/squad/[P1]panorama_tools.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from '../../../config/ulid';
import { SquadStore, MemberStore } from '../../../stores/squad-store';
import { panoramaTool, PANORAMA_TOOL_DEFINITION } from '../tool/panorama-tool';
import { emitPanoramaEvent, panoramaGroup } from '../http/sse';
import type { AgentToolRuntimeContext } from '../../../agent/tools/runtime-context';
import type { ReplayableEventBus } from '../../../agent/event-hub';
import type { ToolInput } from '../../../tools/types';

const DSL = `
version:
  id: dev
  name: Dev
  board_name: CI/CD
entities:
  pipeline_run:
    label: Pipeline
    id_field: id
    fields:
      id:     { type: string }
      status: { type: enum, values: [queued, running, success, failed] }
    states:
      field: status
      initial: queued
      transitions:
        queued:  [running]
        running: [success, failed]
      terminal: [success, failed]
views:
  - id: run_kanban
    label: Kanban
    entity: pipeline_run
    component: kanban
    group_by: status
    columns: [queued, running, success, failed]
    card:
      title: "{id}"
`;

let tmpDir: string;
let dataDir: string;
const squadId = 'sq-ut';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-tool-'));
  dataDir = tmpDir;
  // squad 目录骨架（ensureSquadDirSkeleton 等价：panorama/entities + events.jsonl）
  fs.mkdirSync(path.join(dataDir, 'squads', squadId, 'panorama', 'entities'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'squads', squadId, 'panorama', '.state'), { recursive: true });
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** 构造 mock rtc（leader / mate / 缺 bus 等场景） */
function rtc(opts: { selfType?: AgentToolRuntimeContext['selfType']; panoramaBus?: ReplayableEventBus | null } = {}): AgentToolRuntimeContext {
  return {
    parentSessionId: 's1', parentRunId: 'r1', parentType: 'leader', parentName: 'L', parentScope: 'session',
    selfSessionId: 's1', selfType: opts.selfType ?? 'leader', selfName: 'L',
    selfSquadId: squadId, selfMemberId: 'm1',
    agentManager: {} as never, store: {} as never, sessionDeps: {} as never,
    currentMessageId: 'msg-1',
    ...(opts.panoramaBus === null ? {} : opts.panoramaBus !== undefined ? { panoramaBus: opts.panoramaBus } : {}),
  } as AgentToolRuntimeContext;
}

/** 构造最小 ctx（dataDir + agentToolContext） */
function ctx(r: AgentToolRuntimeContext) {
  return { config: { dataDir, agentToolContext: r }, workdir: tmpDir } as never;
}

async function run(input: ToolInput, r: AgentToolRuntimeContext) {
  return await panoramaTool.run(input, ctx(r));
}

/** mock bus：记录 emit 调用 */
function mockBus(): ReplayableEventBus & { calls: { group: string; data: unknown }[] } {
  const calls: { group: string; data: unknown }[] = [];
  return { calls, emit: (group: string, event: { data: unknown }) => calls.push({ group, data: event.data }) } as never;
}

function jsonOf(res: { content: unknown[] }): unknown {
  const txt = (res.content[0] as { text?: string }).text;
  return JSON.parse(txt as string);
}

describe('panorama tool — definition', () => {
  it('name + flat properties + 仅 action required', () => {
    expect(PANORAMA_TOOL_DEFINITION.name).toBe('panorama');
    const props = PANORAMA_TOOL_DEFINITION.inputSchema.properties!;
    expect(Object.keys(props).sort()).toEqual(
      ['action', 'approved', 'dsl', 'dryRun', 'entity', 'events', 'fields', 'filter', 'id', 'limit', 'migration', 'patch', 'since', 'sort', 'to', 'query', 'transition', 'get_schema', 'create', 'update'].filter((k) => k in props).sort(),
    );
    expect(PANORAMA_TOOL_DEFINITION.inputSchema.required).toEqual(['action']);
  });
});

describe('panorama tool — define / get_schema', () => {
  it('define dryRun 只校验不落盘', async () => {
    const res = await run({ action: 'define', dsl: DSL, dryRun: true }, rtc());
    expect(jsonOf(res)).toMatchObject({ ok: true });
    // dryRun 不落盘 leader 的 DSL：get_schema 返 task-only schema（ensureSystemEntities 兜底建表），
    // 不含 leader 的 pipeline_run
    const gs = await run({ action: 'get_schema' }, rtc());
    const dsl = (jsonOf(gs) as { dsl: string }).dsl;
    expect(dsl).not.toBeNull();
    expect(dsl).toContain('task');
    expect(dsl).not.toContain('pipeline_run');
  });

  it('define 落盘后 get_schema 返 DSL', async () => {
    const res = await run({ action: 'define', dsl: DSL }, rtc());
    expect(jsonOf(res)).toEqual({ ok: true });
    const gs = await run({ action: 'get_schema' }, rtc());
    expect((jsonOf(gs) as { dsl: string }).dsl).toContain('pipeline_run');
  });

  it('define 非法 DSL → ok:false + errors', async () => {
    const res = await run({ action: 'define', dsl: 'not: valid\n  - broken', dryRun: true }, rtc());
    expect(jsonOf(res)).toMatchObject({ ok: false });
  });

  it('mate 调 define → forbidden', async () => {
    const res = await run({ action: 'define', dsl: DSL, dryRun: true }, rtc({ selfType: 'mate' }));
    expect((res.content[0] as { text: string }).text).toContain('forbidden');
  });
});

describe('panorama tool — create / update / transition / query', () => {
  beforeEach(async () => {
    await run({ action: 'define', dsl: DSL }, rtc());
  });

  it('create + query', async () => {
    const c = await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    expect(jsonOf(c)).toEqual({ ok: true, id: 'pr-1', created: true });
    // 状态缺省用 initial=queued
    const q = await run({ action: 'query', entity: 'pipeline_run' }, rtc());
    const inst = (jsonOf(q) as { instances: Record<string, unknown>[] }).instances;
    expect(inst).toHaveLength(1);
    expect(inst[0]!.status).toBe('queued');
  });

  it('create 缺 id → error', async () => {
    const c = await run({ action: 'create', entity: 'pipeline_run', fields: {} }, rtc());
    expect((c.content[0] as { text: string }).text).toContain('id field');
  });

  it('create 重复 id → created:false 幂等短路（不写库/不 emit）', async () => {
    const bus = mockBus();
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc({ panoramaBus: bus }));
    const evtsBefore = bus.calls.length;
    const c = await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc({ panoramaBus: bus }));
    expect(jsonOf(c)).toEqual({ ok: true, id: 'pr-1', created: false });
    // 短路：不写库（仍只有 1 条实例）+ 不 emit entity.created
    const q = await run({ action: 'query', entity: 'pipeline_run' }, rtc());
    expect((jsonOf(q) as { instances: unknown[] }).instances).toHaveLength(1);
    const newCreates = bus.calls
      .map(c => c.data as { type?: string; action?: string })
      .filter(d => d.type === 'panorama_entity_update' && d.action === 'created').length;
    expect(newCreates).toBe(1); // 仅第一次 create emit 一次
    expect(bus.calls.length).toBe(evtsBefore); // 第二次 create 未增加任何 emit
  });

  it('create 字段类型拧巴 → coerce 后写库成功（req §C）', async () => {
    // DSL 中 id 是 string；这里传 number 1928 → coerce 成 "1928" 写库
    const c = await run({ action: 'create', entity: 'pipeline_run', fields: { id: 1928 } }, rtc());
    expect(jsonOf(c)).toEqual({ ok: true, id: '1928', created: true });
    const q = await run({ action: 'query', entity: 'pipeline_run' }, rtc());
    const inst = (jsonOf(q) as { instances: Record<string, unknown>[] }).instances;
    expect(inst[0]!.id).toBe('1928');
  });

  it('update patch', async () => {
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    const u = await run({ action: 'update', entity: 'pipeline_run', id: 'pr-1', patch: { status: 'running' } }, rtc());
    expect(jsonOf(u)).toEqual({ ok: true });
    const q = await run({ action: 'query', entity: 'pipeline_run' }, rtc());
    expect((jsonOf(q) as { instances: Record<string, unknown>[] }).instances[0]!.status).toBe('running');
  });

  it('update 不存在 id → panorama_instance_not_found', async () => {
    const u = await run({ action: 'update', entity: 'pipeline_run', id: 'nope', patch: {} }, rtc());
    expect((u.content[0] as { text: string }).text).toContain('panorama_instance_not_found');
  });

  it('transition 合法跃迁', async () => {
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    const t = await run({ action: 'transition', entity: 'pipeline_run', id: 'pr-1', to: 'running' }, rtc());
    expect(jsonOf(t)).toEqual({ ok: true, from: 'queued', to: 'running' });
  });

  it('transition 非法跃迁 → panorama_illegal_transition', async () => {
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    const t = await run({ action: 'transition', entity: 'pipeline_run', id: 'pr-1', to: 'success' }, rtc());
    expect((t.content[0] as { text: string }).text).toContain('panorama_illegal_transition');
  });

  it('update patch 状态字段同值 → 幂等放行（BUG-003）', async () => {
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    const u = await run({ action: 'update', entity: 'pipeline_run', id: 'pr-1', patch: { status: 'queued' } }, rtc());
    expect(jsonOf(u)).toEqual({ ok: true });
  });

  it('update patch 状态字段非法跃迁 → panorama_illegal_transition + 值不变（BUG-003）', async () => {
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    const u = await run({ action: 'update', entity: 'pipeline_run', id: 'pr-1', patch: { status: 'success' } }, rtc());
    expect((u.content[0] as { text: string }).text).toContain('panorama_illegal_transition');
    const q = await run({ action: 'query', entity: 'pipeline_run' }, rtc());
    expect((jsonOf(q) as { instances: Record<string, unknown>[] }).instances[0]!.status).toBe('queued');
  });

  it('query filter', async () => {
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-2', status: 'running' } }, rtc());
    const q = await run({ action: 'query', entity: 'pipeline_run', filter: { status: 'running' } }, rtc());
    expect((jsonOf(q) as { instances: unknown[] }).instances).toHaveLength(1);
  });

  it('mate 可 create（数据面全员）', async () => {
    const c = await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc({ selfType: 'mate' }));
    expect(jsonOf(c)).toEqual({ ok: true, id: 'pr-1', created: true });
  });
});

describe('panorama tool — events + 上下文错误', () => {
  it('events 读事件流', async () => {
    await run({ action: 'define', dsl: DSL }, rtc());
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-1' } }, rtc());
    const e = await run({ action: 'events' }, rtc());
    const evs = (jsonOf(e) as { events: { type: string }[] }).events;
    expect(evs.length).toBeGreaterThanOrEqual(2);
    expect(evs.some((x) => x.type === 'entity.created')).toBe(true);
  });

  it('未 define 直接 create → panorama_schema_not_defined', async () => {
    const c = await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'x' } }, rtc());
    expect((c.content[0] as { text: string }).text).toContain('panorama_schema_not_defined');
  });

  it('entity 不存在 → panorama_entity_not_found', async () => {
    await run({ action: 'define', dsl: DSL }, rtc());
    const c = await run({ action: 'create', entity: 'nope', fields: { id: 'x' } }, rtc());
    expect((c.content[0] as { text: string }).text).toContain('panorama_entity_not_found');
  });

  it('非法 action → error', async () => {
    const c = await run({ action: 'bogus' }, rtc());
    expect((c.content[0] as { text: string }).text).toContain('invalid action');
  });

  it('缺 squad 上下文 → error', async () => {
    const r = rtc();
    delete (r as { selfSquadId?: string }).selfSquadId;
    const c = await run({ action: 'get_schema' }, r);
    expect((c.content[0] as { text: string }).text).toContain('squad context');
  });
});

describe('panorama SSE — emitPanoramaEvent', () => {
  it('emit 到 per-squad group，shape 含 type/squadId', () => {
    const bus = mockBus();
    emitPanoramaEvent(bus, squadId, { type: 'panorama_entity_update', squadId, entity: 'pipeline_run', action: 'created', id: 'pr-1', record: {}, source: 'agent', seq: 1 });
    expect(bus.calls).toHaveLength(1);
    expect(bus.calls[0]!.group).toBe(panoramaGroup(squadId));
    expect((bus.calls[0]!.data as { type: string }).type).toBe('panorama_entity_update');
  });

  it('bus 未注入 → 静默跳过不抛', () => {
    expect(() => emitPanoramaEvent(null, squadId, { type: 'panorama_schema_update', squadId, seq: 1 })).not.toThrow();
  });
});

// ============================================================
// [v0.0.361 T4] task transition → reminder queue 写入（change_plan §1.5/§2 样例 E）
// ============================================================
describe('panorama tool — task transition reminder 写入', () => {
  /** 建 squad + members fixture（真实 store）→ 返回 rtc + 各 session id */
  async function seedSquad(): Promise<{
    r: AgentToolRuntimeContext;
    leaderSid: string; ownerSid: string; otherSid: string; chatSid: string; ownerId: string;
  }> {
    const sqId = ulid();
    fs.mkdirSync(path.join(dataDir, 'squads', sqId, 'panorama', 'entities'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'squads', sqId, 'panorama', '.state'), { recursive: true });
    const leaderId = ulid();
    const ownerId = ulid();
    const otherId = ulid();
    const leaderSid = ulid();
    const ownerSid = ulid();
    const otherSid = ulid();
    const chatSid = ulid();
    const squadStore = new SquadStore({ root: dataDir });
    const memberStore = new MemberStore({ root: dataDir });
    await squadStore.putSquad({
      id: sqId, name: 'S', modelDefault: 'm', leaderId,
      memberIds: [leaderId, ownerId, otherId], squadChatSessionId: chatSid, enableHeartBeat: false,
    } as Parameters<SquadStore['putSquad']>[0]);
    const base = { squadId: sqId, role: 'mate', tools: [], skillConfig: { mode: 'inherit' }, state: 'deployed' };
    await memberStore.putMember({ id: leaderId, ...base, sessionId: leaderSid, name: 'darvin', role: 'leader' } as never);
    await memberStore.putMember({ id: ownerId, ...base, sessionId: ownerSid, name: 'coder' } as never);
    await memberStore.putMember({ id: otherId, ...base, sessionId: otherSid, name: 'other' } as never);
    return { r: { ...rtc(), selfSquadId: sqId } as AgentToolRuntimeContext, leaderSid, ownerSid, otherSid, chatSid, ownerId };
  }

  /** 读 {sid} 的 reminder queue entries */
  function readQueue(sid: string): Array<{ key: string; value: string }> {
    const p = path.join(dataDir, 'sessions', sid, 'reminder_queue.json');
    if (!fs.existsSync(p)) return [];
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { entries: Array<{ key: string; value: string }> }).entries;
  }

  it('transition task → task:{id} 渲染行写 audience（owner+leader；无关 member/squadChat 不写）', async () => {
    const { r, leaderSid, ownerSid, otherSid, chatSid, ownerId } = await seedSquad();
    await run({ action: 'create', entity: 'task', fields: { id: 't-1', title: '写入方接线', owner: ownerId } }, r);
    const tr = await run({ action: 'transition', entity: 'task', id: 't-1', to: 'in_progress' }, r);
    expect(jsonOf(tr)).toEqual({ ok: true, from: 'todo', to: 'in_progress' });
    const line = { key: 'task:t-1', value: '[task] t-1「写入方接线」→ 进行中（owner: coder）' };
    expect(readQueue(ownerSid).map((e) => [e.key, e.value])).toEqual([[line.key, line.value]]);
    expect(readQueue(leaderSid).map((e) => [e.key, e.value])).toEqual([[line.key, line.value]]);
    expect(readQueue(otherSid)).toEqual([]);
    expect(readQueue(chatSid)).toEqual([]);
  });

  it('done 也是状态变化照写 + 非 task entity 不写', async () => {
    const { r, ownerSid, ownerId } = await seedSquad();
    await run({ action: 'create', entity: 'task', fields: { id: 't-2', title: '收尾', owner: ownerId } }, r);
    await run({ action: 'transition', entity: 'task', id: 't-2', to: 'in_progress' }, r);
    const done = await run({ action: 'transition', entity: 'task', id: 't-2', to: 'done' }, r);
    expect(jsonOf(done)).toEqual({ ok: true, from: 'in_progress', to: 'done' });
    expect(readQueue(ownerSid).map((e) => [e.key, e.value])).toEqual([
      ['task:t-2', '[task] t-2「收尾」→ 已结束（owner: coder）'],
    ]);
    // 非 task entity（pipeline_run）transition 不写 reminder
    await run({ action: 'define', dsl: DSL }, r);
    await run({ action: 'create', entity: 'pipeline_run', fields: { id: 'pr-9' } }, r);
    await run({ action: 'transition', entity: 'pipeline_run', id: 'pr-9', to: 'running' }, r);
    expect(readQueue(ownerSid)).toHaveLength(1); // 仍只有 task:t-2 一行
  });

  it('squad record 不存在 → notify 静默 no-op（transition 主路径不受影响）', async () => {
    // ghost squad：panorama 目录骨架在但 SquadStore 无 record（fanout audience 解析为空集）
    const ghost = ulid();
    fs.mkdirSync(path.join(dataDir, 'squads', ghost, 'panorama', 'entities'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'squads', ghost, 'panorama', '.state'), { recursive: true });
    const r = { ...rtc(), selfSquadId: ghost } as AgentToolRuntimeContext;
    await run({ action: 'create', entity: 'task', fields: { id: 't-3', title: 'X' } }, r);
    const tr = await run({ action: 'transition', entity: 'task', id: 't-3', to: 'in_progress' }, r);
    expect(jsonOf(tr)).toEqual({ ok: true, from: 'todo', to: 'in_progress' });
    expect(fs.existsSync(path.join(dataDir, 'sessions'))).toBe(false);
  });
});

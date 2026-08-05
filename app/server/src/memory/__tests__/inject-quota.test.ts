/**
 * selectMemoriesByQuota 纯函数单测（v0.0.238 分层配额：各 scope 独立计数独立截断）
 * 参考: specs/tech/version_logs/v0.0.238/change_plan.md 模块 E + 架构决策 O3
 *       specs/prd/overall/14-prompt-quality-governance.md §14.2.3
 *       app/server/src/memory/inject-quota.ts
 *
 * 覆盖：
 *   - 各 scope 独立截断（session/group/global 配额互不影响；覆盖旧「三源共享总量」语义）
 *   - 层内 manual（source='user'）→ agent（source='agent'）+ 各组 updatedAt 倒序 + name 升序
 *   - 边界（某层 quota<=0 → 该层空；三层全 0 / 刚好 / 超 / 空源 / 单一源）
 *   - 纯函数确定性 + 无副作用 + 输出行形状
 */
import { describe, it, expect } from 'vitest';
import { selectMemoriesByQuota, type MemoryEntryRow, type MemoryInjectQuotas } from '../inject-quota';

/** 造 MemoryEntryRow（默认 updatedAt='' 让排序可预期）+ 带 _scope 标记方便分流 */
function row(
  name: string,
  scope: 'global' | 'session' | 'group',
  source: 'user' | 'agent',
  updatedAt = '',
): MemoryEntryRow & { _scope: 'global' | 'session' | 'group' } {
  return { name, intro: `intro-${name}`, source, updatedAt, _scope: scope };
}

/** 按 _scope 分流到 3 段（喂入 selectMemoriesByQuota） */
function split(
  rows: Array<MemoryEntryRow & { _scope: 'global' | 'session' | 'group' }>,
): { global: MemoryEntryRow[]; session: MemoryEntryRow[]; group: MemoryEntryRow[] } {
  const global: MemoryEntryRow[] = [];
  const session: MemoryEntryRow[] = [];
  const group: MemoryEntryRow[] = [];
  for (const r of rows) {
    const { _scope, ...rest } = r;
    void _scope;
    if (r._scope === 'global') global.push(rest);
    else if (r._scope === 'session') session.push(rest);
    else group.push(rest);
  }
  return { global, session, group };
}

/** 三层同配额（方便「全要」场景） */
const Q50: MemoryInjectQuotas = { global: 50, session: 50, group: 50 };

describe('selectMemoriesByQuota（分层：各 scope 独立截断 + 层内 manual→agent 排序）', () => {
  it('三层 quota<=0 → 三段全空', () => {
    const { global, session, group } = split([
      row('a', 'global', 'user'),
      row('b', 'session', 'agent'),
      row('c', 'group', 'user'),
    ]);
    const zero: MemoryInjectQuotas = { global: 0, session: 0, group: 0 };
    expect(selectMemoriesByQuota(global, session, group, zero)).toEqual({
      global: [],
      session: [],
      group: [],
    });
    const neg: MemoryInjectQuotas = { global: -5, session: -1, group: -3 };
    expect(selectMemoriesByQuota(global, session, group, neg)).toEqual({
      global: [],
      session: [],
      group: [],
    });
  });

  it('单层 quota<=0 → 仅该层空，其他层照常', () => {
    const { global, session, group } = split([
      row('u', 'global', 'user'),
      row('s', 'session', 'user'),
      row('q', 'group', 'user'),
    ]);
    // session 层配额 0，global/group 默认 50
    const q: MemoryInjectQuotas = { global: 50, session: 0, group: 50 };
    const out = selectMemoriesByQuota(global, session, group, q);
    expect(out.global.map((r) => r.name)).toEqual(['u']);
    expect(out.session).toEqual([]);
    expect(out.group.map((r) => r.name)).toEqual(['q']);
  });

  it('层内顺序：manual→agent（同 scope 内 user source 优先）', () => {
    const { global, session, group } = split([
      row('u-agent', 'global', 'agent'),
      row('u-manual', 'global', 'user'),
      row('s-agent', 'session', 'agent'),
      row('s-manual', 'session', 'user'),
      row('q-agent', 'group', 'agent'),
      row('q-manual', 'group', 'user'),
    ]);
    const out = selectMemoriesByQuota(global, session, group, Q50);
    expect(out.session.map((r) => r.name)).toEqual(['s-manual', 's-agent']);
    expect(out.group.map((r) => r.name)).toEqual(['q-manual', 'q-agent']);
    expect(out.global.map((r) => r.name)).toEqual(['u-manual', 'u-agent']);
  });

  it('层内 updatedAt 倒序（新在前；各组 manual/agent 内独立排）', () => {
    const { global, session, group } = split([
      row('old-m', 'group', 'user', '2026-01-01T00:00:00.000Z'),
      row('new-m', 'group', 'user', '2026-07-01T00:00:00.000Z'),
      row('mid-a', 'group', 'agent', '2026-04-01T00:00:00.000Z'),
      row('old-a', 'group', 'agent', '2026-01-01T00:00:00.000Z'),
    ]);
    const out = selectMemoriesByQuota(global, session, group, Q50);
    // manual 组：new-m > old-m；agent 组：mid-a > old-a；manual 整组在 agent 前
    expect(out.group.map((r) => r.name)).toEqual(['new-m', 'old-m', 'mid-a', 'old-a']);
  });

  it('updatedAt 缺省 → 该组内最末（空串排末）', () => {
    const { global, session, group } = split([
      row('no-ts', 'group', 'user'),
      row('has-ts', 'group', 'user', '2026-01-01T00:00:00.000Z'),
    ]);
    const out = selectMemoriesByQuota(global, session, group, Q50);
    expect(out.group.map((r) => r.name)).toEqual(['has-ts', 'no-ts']);
  });

  it('tiebreak：同 updatedAt → name 升序（组内）', () => {
    const { global, session, group } = split([
      row('charlie', 'group', 'user'),
      row('alpha', 'group', 'user'),
      row('bravo', 'group', 'user'),
    ]);
    const out = selectMemoriesByQuota(global, session, group, Q50);
    expect(out.group.map((r) => r.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('各 scope 独立截断：session=1 / group=2 / global=1 互不影响', () => {
    const { global, session, group } = split([
      row('sm1', 'session', 'user', '2026-07-03T00:00:00.000Z'),
      row('sm2', 'session', 'user', '2026-07-02T00:00:00.000Z'),
      row('qm1', 'group', 'user', '2026-07-03T00:00:00.000Z'),
      row('qm2', 'group', 'user', '2026-07-02T00:00:00.000Z'),
      row('qm3', 'group', 'user', '2026-07-01T00:00:00.000Z'),
      row('um1', 'global', 'user', '2026-07-03T00:00:00.000Z'),
      row('um2', 'global', 'user', '2026-07-02T00:00:00.000Z'),
    ]);
    const q: MemoryInjectQuotas = { global: 1, session: 1, group: 2 };
    const out = selectMemoriesByQuota(global, session, group, q);
    // session 取最新 1（sm1），group 取最新 2（qm1/qm2），global 取最新 1（um1）——互不抢占
    expect(out.session.map((r) => r.name)).toEqual(['sm1']);
    expect(out.group.map((r) => r.name)).toEqual(['qm1', 'qm2']);
    expect(out.global.map((r) => r.name)).toEqual(['um1']);
  });

  it('层内 manual 配额用尽不溢出到 agent（manual→agent 是组内拼接，跨组共享同一 quota）', () => {
    // group 层：3 manual + 3 agent，quota=2 → 取前 2 manual（agent 全截）
    const { global, session, group } = split([
      row('m1', 'group', 'user', '2026-07-03T00:00:00.000Z'),
      row('m2', 'group', 'user', '2026-07-02T00:00:00.000Z'),
      row('m3', 'group', 'user', '2026-07-01T00:00:00.000Z'),
      row('a1', 'group', 'agent', '2026-07-03T00:00:00.000Z'),
    ]);
    const q: MemoryInjectQuotas = { global: 50, session: 50, group: 2 };
    const out = selectMemoriesByQuota(global, session, group, q);
    expect(out.group.map((r) => r.name)).toEqual(['m1', 'm2']);
  });

  it('层内 manual 不足时 agent 补位（manual→agent 拼接后整体 slice）', () => {
    const { global, session, group } = split([
      row('m1', 'group', 'user', '2026-07-01T00:00:00.000Z'),
      row('a1', 'group', 'agent', '2026-07-03T00:00:00.000Z'),
      row('a2', 'group', 'agent', '2026-07-02T00:00:00.000Z'),
    ]);
    const q: MemoryInjectQuotas = { global: 50, session: 50, group: 2 };
    const out = selectMemoriesByQuota(global, session, group, q);
    // manual m1 + agent 最新 a1 → 共 2 条
    expect(out.group.map((r) => r.name)).toEqual(['m1', 'a1']);
  });

  it('groupEntries=[] → group 段空（向后兼容）', () => {
    const { global, session } = split([
      row('u-agent', 'global', 'agent'),
      row('u-manual', 'global', 'user'),
      row('s-agent', 'session', 'agent'),
      row('s-manual', 'session', 'user'),
    ]);
    const out = selectMemoriesByQuota(global, session, [], Q50);
    expect(out.session.map((r) => r.name)).toEqual(['s-manual', 's-agent']);
    expect(out.global.map((r) => r.name)).toEqual(['u-manual', 'u-agent']);
    expect(out.group).toEqual([]);
  });

  it('quota>层总数 → 全要（不报错，不补 null）', () => {
    const { global, session, group } = split([row('only', 'group', 'user', '2026-01-01T00:00:00.000Z')]);
    const out = selectMemoriesByQuota(global, session, group, Q50);
    expect(out.group.map((r) => r.name)).toEqual(['only']);
    expect(out.global).toEqual([]);
    expect(out.session).toEqual([]);
  });

  it('三源均空 → 三段全空', () => {
    expect(selectMemoriesByQuota([], [], [], Q50)).toEqual({ global: [], session: [], group: [] });
  });

  it('仅 group 源 → global/session 切片为空（不串扰）', () => {
    const { global, session, group } = split([row('q1', 'group', 'user')]);
    const out = selectMemoriesByQuota(global, session, group, Q50);
    expect(out.group.map((r) => r.name)).toEqual(['q1']);
    expect(out.global).toEqual([]);
    expect(out.session).toEqual([]);
  });

  it('纯函数确定性：同输入两次调用结果 deep equal', () => {
    const { global, session, group } = split([
      row('a', 'session', 'user', '2026-07-01T00:00:00.000Z'),
      row('b', 'global', 'agent', '2026-06-01T00:00:00.000Z'),
      row('c', 'group', 'user', '2026-07-01T00:00:00.000Z'),
    ]);
    const r1 = selectMemoriesByQuota(global, session, group, Q50);
    const r2 = selectMemoriesByQuota(global, session, group, Q50);
    expect(r1).toEqual(r2);
  });

  it('纯函数无副作用：输入数组不被 mutate', () => {
    const { global, session, group } = split([
      row('a', 'session', 'user', '2026-07-01T00:00:00.000Z'),
      row('b', 'global', 'agent'),
      row('c', 'group', 'user'),
    ]);
    const globalSnap = global.map((r) => ({ ...r }));
    const sessionSnap = session.map((r) => ({ ...r }));
    const groupSnap = group.map((r) => ({ ...r }));
    selectMemoriesByQuota(global, session, group, Q50);
    expect(global).toEqual(globalSnap);
    expect(session).toEqual(sessionSnap);
    expect(group).toEqual(groupSnap);
  });

  it('输出行形状：仅 name/intro/source/updatedAt（不带内部字段泄漏）', () => {
    const { global, session, group } = split([row('a', 'group', 'user', '2026-07-01T00:00:00.000Z')]);
    const out = selectMemoriesByQuota(global, session, group, Q50);
    expect(out.group[0]).toEqual({
      name: 'a',
      intro: 'intro-a',
      source: 'user',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(Object.keys(out.group[0]!).sort()).toEqual(['intro', 'name', 'source', 'updatedAt']);
  });
});

/**
 * team-write-actions UT（v0.0.128 T5 白盒）
 * 参考: team-write-actions.ts（被测）/ team-tool.ts（dispatch+权限门）/
 *       change_plan 模块 D / prd §5 UC-5/UC-6
 * 覆盖：权限矩阵 UC-5 / dispatch / inputSchema enum / runHire fresh+derive /
 *   runBench（UC-6 leader_not_benchable + 不发 send_message）/ runEdit / runDeploy / resolveMemberId。
 * mock：vi.mock 拦 4 service + 手工 fake memberStore + 全 mock rtc。禁真盘。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { teamTool } from '../team-tool';
import {
  TEAM_INPUT_SCHEMA, runHire, runDeploy, runBench, runEdit, resolveMemberId,
} from '../team-write-actions';
import type { ToolCtx, ToolInput } from '../../../tools/types';
import type { AgentToolRuntimeContext } from '../runtime-context';

// vi.mock 路径用 __dirname 派生绝对路径（避免 bun+jsdom 全量并发下相对路径静默失效，
// memory test-vitest-mock-absolute-path）；require('path') inline，__dirname hoisting 时可用
vi.mock(require('path').resolve(__dirname, '../../../services/member-service'), async (importActual) => {
  const actual = await importActual<typeof import('../../../services/member-service')>();
  return { ...actual, createMemberService: vi.fn() };
});
vi.mock(require('path').resolve(__dirname, '../../../services/member-mutations'), async (importActual) => {
  const actual = await importActual<typeof import('../../../services/member-mutations')>();
  return { ...actual, deployMemberService: vi.fn(), benchMemberService: vi.fn(), patchMemberService: vi.fn() };
});

import { createMemberService, MemberNameConflictError } from '../../../services/member-service';
import {
  deployMemberService, benchMemberService, patchMemberService,
  MemberNotFoundError, LeaderNotBenchableError,
} from '../../../services/member-mutations';


/** fake rtc：selfType/selfSquadId/members/currentMessageId/deliverTo 可控；memberStore 内嵌 mock */
function makeRtc(opts: {
  selfType?: AgentToolRuntimeContext['selfType'];
  selfSquadId?: string;
  members?: Array<Record<string, unknown>>;
  currentMessageId?: string;
  deliverTo?: ReturnType<typeof vi.fn>;
} = {}): AgentToolRuntimeContext {
  const stored = new Map((opts.members ?? [
    { id: 'M-LEADER', name: 'leader', role: 'leader', state: 'deployed' },
    { id: 'M-MATE', name: 'mate1', role: 'mate', state: 'deployed' },
  ]).map((m) => [m.id as string, m]));
  const memberStore = {
    listMembers: vi.fn(async () => Array.from(stored.values()) as never[]),
    getMember: vi.fn(async (_s: string, mid: string) => (stored.get(mid) as never) ?? undefined),
    putMember: vi.fn(async (rec: Record<string, unknown>) => { stored.set(rec.id as string, rec); return rec as never; }),
  };
  return {
    parentSessionId: 'P', parentRunId: 'r', parentType: undefined, parentName: 'p', parentScope: undefined,
    selfSessionId: 'SELF', selfType: opts.selfType, selfName: 'self',
    selfSquadId: opts.selfSquadId ?? 'SQUAD-A',
    squadStore: { getSquad: async () => ({ id: 'SQUAD-A' }) } as never,
    memberStore: memberStore as never,
    agentManager: { deliverTo: opts.deliverTo ?? vi.fn() } as never,
    store: {} as never, sessionDeps: {} as never,
    ...(opts.currentMessageId !== undefined ? { currentMessageId: opts.currentMessageId } : {}),
  };
}

function parseResult(res: { content?: unknown; isError: boolean }) {
  const blocks = (res.content ?? []) as Array<{ text?: string }>;
  const text = blocks.map((b) => b?.text ?? '').join('');
  let parsed: unknown = undefined;
  try { parsed = JSON.parse(text); } catch { /* keep undefined */ }
  return { text, isError: res.isError, parsed };
}

async function runTeam(rtc: AgentToolRuntimeContext, fields: Record<string, unknown>) {
  const ctx: ToolCtx = { config: { agentToolContext: rtc } } as unknown as ToolCtx;
  return parseResult(await teamTool.run(fields as unknown as ToolInput, ctx));
}

async function runAction(fn: typeof runHire, rtc: AgentToolRuntimeContext, fields: Record<string, unknown>) {
  return parseResult(await fn(fields as unknown as ToolInput, rtc));
}

/** 权限/dispatch 默认 mock（leader 走完整路径，避免权限过后 mock 未设而抛） */
function mockAllServicesOk() {
  vi.mocked(createMemberService).mockResolvedValue({
    member: { id: 'M', name: 'n', state: 'deployed' } as never, sessionId: 'S',
  });
  vi.mocked(deployMemberService).mockResolvedValue({ id: 'M', state: 'deployed' } as never);
  vi.mocked(benchMemberService).mockResolvedValue({ id: 'M', state: 'benched', benchReason: 'r' } as never);
  vi.mocked(patchMemberService).mockResolvedValue({ id: 'M', name: 'n' } as never);
}

beforeEach(() => {
  vi.mocked(createMemberService).mockReset();
  vi.mocked(deployMemberService).mockReset();
  vi.mocked(benchMemberService).mockReset();
  vi.mocked(patchMemberService).mockReset();
});

describe('team 写 action 权限矩阵（UC-5）', () => {
  beforeEach(mockAllServicesOk);

  it('leader → hire 允许（不被 forbidden 拦截）', async () => {
    const { isError, text } = await runTeam(makeRtc({ selfType: 'leader' }),
      { action: 'hire', mode: 'fresh', name: 'x', intro: 'y' });
    expect(isError).toBe(false);
    expect(text).not.toMatch(/forbidden/i);
    expect(createMemberService).toHaveBeenCalledOnce();
  });

  it.each([
    ['mate', 'hire'], ['mate', 'deploy'], ['mate', 'bench'], ['mate', 'edit'],
    ['subagent', 'hire'], ['subagent', 'deploy'], ['subagent', 'bench'], ['subagent', 'edit'],
  ] as const)('selfType=%s → action=%s forbidden', async (selfType, action) => {
    const { isError, text } = await runTeam(makeRtc({ selfType }), { action });
    expect(isError).toBe(true);
    expect(text).toBe(`team.${action}: forbidden (caller selfType=${selfType}, leader/user only)`);
  });

  it('squad → 拒（门控先于 write_action 门）', async () => {
    const { isError, text } = await runTeam(makeRtc({ selfType: 'squad' }), { action: 'hire' });
    expect(isError).toBe(true);
    expect(text).toMatch(/squad.*cannot use team tool/i);
  });
});

describe('team 工具 dispatch', () => {
  beforeEach(mockAllServicesOk);

  it('4 写 action 各进对应 service', async () => {
    const rtc = makeRtc({ selfType: 'leader' });
    await runTeam(rtc, { action: 'hire', mode: 'fresh', name: 'n', intro: 'i' });
    await runTeam(rtc, { action: 'deploy', roleId: 'mate1' });
    await runTeam(rtc, { action: 'bench', roleId: 'mate1', reason: 'r' });
    await runTeam(rtc, { action: 'edit', roleId: 'mate1', patch: { intro: 'x' } });
    expect(createMemberService).toHaveBeenCalledOnce();
    expect(deployMemberService).toHaveBeenCalledOnce();
    expect(benchMemberService).toHaveBeenCalledOnce();
    expect(patchMemberService).toHaveBeenCalledOnce();
  });

  it('只读 2 action 不触 4 service', async () => {
    const rtc = makeRtc({ selfType: 'leader' });
    await runTeam(rtc, { action: 'list' });
    await runTeam(rtc, { action: 'query', query: { ref: 'mate1' } });
    expect(createMemberService).not.toHaveBeenCalled();
    expect(deployMemberService).not.toHaveBeenCalled();
    expect(benchMemberService).not.toHaveBeenCalled();
    expect(patchMemberService).not.toHaveBeenCalled();
  });
});

describe('TEAM_INPUT_SCHEMA', () => {
  it('action.enum = 6 元素', () => {
    const a = TEAM_INPUT_SCHEMA.properties!.action as { enum?: string[] };
    expect(a?.enum).toEqual(['list', 'query', 'hire', 'deploy', 'bench', 'edit']);
  });

  it('含 7 flat 顶层 properties（hire 6 + roleId；v0.0.155 model 硬删；v0.0.250 inheritMemory 删）', () => {
    const keys = new Set(Object.keys(TEAM_INPUT_SCHEMA.properties!));
    // v0.0.155：member.model 硬删（A4），hire/edit 不再让 LLM 指模型；model 从 schema 移除
    // v0.0.250：inheritMemory dead field 清理（schema + service + UI），从 schema 移除
    for (const f of ['mode', 'name', 'intro', 'skillConfig', 'deriveFrom', 'overrides', 'roleId']) {
      expect(keys, `缺 flat 顶层 property "${f}"`).toContain(f);
    }
    expect(keys, 'v0.0.155 model 应已从 schema 剔除').not.toContain('model');
    expect(keys, 'v0.0.250 inheritMemory 应已从 schema 剔除').not.toContain('inheritMemory');
  });
});

describe('runHire（D5 复用 createMemberService）', () => {
  it('fresh → svcInput 含 mode/name/intro（v0.0.155 model 硬删，不再传）', async () => {
    vi.mocked(createMemberService).mockResolvedValue({
      member: { id: 'M-NEW', name: 'alice', state: 'deployed' } as never, sessionId: 'SID-NEW',
    });
    const rtc = makeRtc({ selfType: 'leader', currentMessageId: 'MSG-HIRE' });
    const { isError, parsed } = await runAction(runHire, rtc,
      { action: 'hire', mode: 'fresh', name: 'alice', intro: '探索' });
    expect(isError).toBe(false);
    expect(parsed).toMatchObject({ memberId: 'M-NEW', name: 'alice', state: 'deployed' });
    expect(createMemberService).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ squadId: 'SQUAD-A', mode: 'fresh', name: 'alice', intro: '探索' }));
  });

  it('derive → deriveFrom name 解析成 id 后传 service（v0.0.128 fix；v0.0.250 起 inheritMemory 删）', async () => {
    vi.mocked(createMemberService).mockResolvedValue({
      member: { id: 'M-D', name: 'child', state: 'deployed' } as never, sessionId: 'SID-D',
    });
    // rtc default members: leader(M-LEADER) / mate1(M-MATE)；deriveFrom='leader' (name) → 解析成 'M-LEADER'
    await runAction(runHire, makeRtc({ selfType: 'leader' }),
      { action: 'hire', mode: 'derive', deriveFrom: 'leader', overrides: { intro: '改' } });
    expect(createMemberService).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ mode: 'derive', deriveFrom: 'M-LEADER', overrides: { intro: '改' } }));
  });

  it('derive → deriveFrom 直接传 id 也正常（id 优先匹配）', async () => {
    vi.mocked(createMemberService).mockResolvedValue({
      member: { id: 'M-D', name: 'child', state: 'deployed' } as never, sessionId: 'SID-D',
    });
    await runAction(runHire, makeRtc({ selfType: 'leader' }),
      { action: 'hire', mode: 'derive', deriveFrom: 'M-MATE' });
    expect(createMemberService).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ mode: 'derive', deriveFrom: 'M-MATE' }));
  });

  // [v0.0.169] workStyle 仅用户可编辑：LLM 在 derive overrides 里塞 workStyle 也须被剔除（同 runEdit 模式）
  it('derive overrides 带 workStyle（LLM 尝试写）→ 被剔除，不透传给 createMemberService', async () => {
    vi.mocked(createMemberService).mockResolvedValue({
      member: { id: 'M-D', name: 'child', state: 'deployed' } as never, sessionId: 'SID-D',
    });
    const { isError } = await runAction(runHire, makeRtc({ selfType: 'leader' }),
      { action: 'hire', mode: 'derive', deriveFrom: 'leader', overrides: { intro: '改', workStyle: '恶意注入的工作方式' } });
    expect(isError).toBe(false);
    expect(createMemberService).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ mode: 'derive', overrides: expect.not.objectContaining({ workStyle: expect.anything() }) }));
  });

  it('derive → deriveFrom name 找不到 → "team.hire: deriveFrom member not found"', async () => {
    const { isError, text } = await runAction(runHire, makeRtc({ selfType: 'leader' }),
      { action: 'hire', mode: 'derive', deriveFrom: 'ghost' });
    expect(isError).toBe(true);
    expect(text).toBe('team.hire: deriveFrom member not found');
    expect(createMemberService).not.toHaveBeenCalled();
  });

  it('derive → deriveFrom 缺/空 → "team.hire: deriveFrom required"', async () => {
    const { isError, text } = await runAction(runHire, makeRtc({ selfType: 'leader' }),
      { action: 'hire', mode: 'derive', deriveFrom: '  ' });
    expect(isError).toBe(true);
    expect(text).toBe('team.hire: deriveFrom required');
    expect(createMemberService).not.toHaveBeenCalled();
  });

  it.each([
    ['MemberNameConflictError', new MemberNameConflictError('x'), 'team.hire: member_name_conflict'],
    ["'intro required' msg", new Error('intro required'), 'team.hire: intro required'],
  ] as const)('catch %s → "%s"', async (_label, err, expected) => {
    vi.mocked(createMemberService).mockRejectedValue(err);
    const { isError, text } = await runAction(runHire, makeRtc({ selfType: 'leader' }),
      { action: 'hire', mode: 'fresh', name: 'x', intro: 'i' });
    expect(isError).toBe(true);
    expect(text).toBe(expected);
  });
});

describe('runBench（D2 不发 send_message）', () => {
  it.each([
    ['roleId', { action: 'bench', reason: 'r' }, 'team.bench: roleId required'],
    ['reason', { action: 'bench', roleId: 'M-MATE' }, 'team.bench: reason required'],
  ] as const)('%s 空 → "%s"', async (_f, fields, expected) => {
    const { isError, text } = await runAction(runBench, makeRtc({ selfType: 'leader' }), fields);
    expect(isError).toBe(true);
    expect(text).toBe(expected);
    expect(benchMemberService).not.toHaveBeenCalled();
  });

  it.each([
    ['LeaderNotBenchableError', new LeaderNotBenchableError('x'), 'team.bench: leader_not_benchable'],
    ['MemberNotFoundError', new MemberNotFoundError('x'), 'team.bench: member not found'],
  ] as const)('catch %s → "%s"（UC-6 文案对齐 HTTP 403）', async (_label, err, expected) => {
    vi.mocked(benchMemberService).mockRejectedValue(err);
    const { isError, text } = await runAction(runBench, makeRtc({ selfType: 'leader' }),
      { action: 'bench', roleId: 'M-LEADER', reason: 'r' });
    expect(isError).toBe(true);
    expect(text).toBe(expected);
  });

  it('成功 → 调 service + currentMessageId 透传 + 不发 send_message', async () => {
    vi.mocked(benchMemberService).mockResolvedValue({ id: 'M-MATE', state: 'benched', benchReason: '休整' } as never);
    const deliverTo = vi.fn();
    const { isError, parsed } = await runAction(runBench,
      makeRtc({ selfType: 'leader', currentMessageId: 'MSG-B', deliverTo }),
      { action: 'bench', roleId: 'mate1', reason: '休整' });
    expect(isError).toBe(false);
    expect(benchMemberService).toHaveBeenCalledWith(expect.anything(), 'SQUAD-A', 'M-MATE', '休整', 'MSG-B');
    expect(deliverTo).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({ memberId: 'M-MATE', state: 'benched', benchReason: '休整' });
  });
});

describe('runEdit（D3 patch = name/intro/skillConfig/model）', () => {
  it('patch 缺失/非对象/空 → "team.edit: patch invalid"', async () => {
    const rtc = makeRtc({ selfType: 'leader' });
    for (const patch of [undefined, 'notobj', {}]) {
      const { isError, text } = await runAction(runEdit, rtc, { action: 'edit', roleId: 'M-MATE', patch });
      expect(isError).toBe(true);
      expect(text).toMatch(/patch invalid/);
    }
  });

  it('patch 仅 dead 字段（tools/heartbeat） → patch invalid（dead 不计有效字段）', async () => {
    const { isError, text } = await runAction(runEdit, makeRtc({ selfType: 'leader' }),
      { action: 'edit', roleId: 'M-MATE', patch: { tools: ['x'], heartbeat: { x: 1 } } });
    expect(isError).toBe(true);
    expect(text).toMatch(/patch invalid/);
    expect(patchMemberService).not.toHaveBeenCalled();
  });

  it('valid + dead 字段 → 透传 patch 给 service（warn 由 patchMemberService 单源负责）', async () => {
    vi.mocked(patchMemberService).mockResolvedValue({ id: 'M-MATE', name: 'new' } as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { isError } = await runAction(runEdit, makeRtc({ selfType: 'leader' }),
      { action: 'edit', roleId: 'mate1', patch: { name: 'new', tools: ['x'] } });
    expect(isError).toBe(false);
    expect(patchMemberService).toHaveBeenCalledWith(expect.anything(), 'SQUAD-A', 'M-MATE',
      expect.objectContaining({ name: 'new', tools: ['x'] }), undefined);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // [v0.0.142] workStyle 仅用户可编辑：即使 LLM 在 patch 里塞入 workStyle 也须被剔除，不透传给 service
  it('patch 带 workStyle（LLM 尝试写）→ 被剔除，不透传给 patchMemberService（仅用户可编辑，不进 agent 工具）', async () => {
    vi.mocked(patchMemberService).mockResolvedValue({ id: 'M-MATE', name: 'new' } as never);
    const { isError } = await runAction(runEdit, makeRtc({ selfType: 'leader' }),
      { action: 'edit', roleId: 'mate1', patch: { name: 'new', workStyle: '恶意注入的工作方式' } });
    expect(isError).toBe(false);
    expect(patchMemberService).toHaveBeenCalledWith(expect.anything(), 'SQUAD-A', 'M-MATE',
      expect.not.objectContaining({ workStyle: expect.anything() }), undefined);
  });
});

describe('runDeploy', () => {
  it.each([
    ['roleId 空', { action: 'deploy' }, 'team.deploy: roleId required'],
    ['MemberNotFound（resolveMemberId 拦）', { action: 'deploy', roleId: 'NOPE' }, 'team.deploy: member not found'],
  ] as const)('%s → "%s"', async (_label, fields, expected) => {
    vi.mocked(deployMemberService).mockRejectedValue(new MemberNotFoundError('service throw'));
    const { isError, text } = await runAction(runDeploy, makeRtc({ selfType: 'leader' }), fields);
    expect(isError).toBe(true);
    expect(text).toBe(expected);
  });

  it('成功 → 调 deployMemberService（service 兜底幂等 no-op）', async () => {
    vi.mocked(deployMemberService).mockResolvedValue({ id: 'M-MATE', state: 'deployed' } as never);
    const { isError, parsed } = await runAction(runDeploy,
      makeRtc({ selfType: 'leader', currentMessageId: 'MSG-D' }),
      { action: 'deploy', roleId: 'mate1' });
    expect(isError).toBe(false);
    expect(deployMemberService).toHaveBeenCalledWith(expect.anything(), 'SQUAD-A', 'M-MATE', 'MSG-D');
    expect(parsed).toMatchObject({ memberId: 'M-MATE', state: 'deployed' });
  });
});

describe('resolveMemberId', () => {
  // 与 query.ref 同语义：id 优先，name 唯一匹配
  const ms = { listMembers: async () => [{ id: '01ABC', name: 'alice' }] } as never;
  it('id 精确匹配 → 返该 id', async () => {
    await expect(resolveMemberId(ms, 'SQUAD-A', '01ABC')).resolves.toBe('01ABC');
  });
  it('name 匹配 → 返对应 member.id', async () => {
    await expect(resolveMemberId(ms, 'SQUAD-A', 'alice')).resolves.toBe('01ABC');
  });
  it('无匹配 → throw MemberNotFoundError', async () => {
    await expect(resolveMemberId(ms, 'SQUAD-A', 'nobody')).rejects.toBeInstanceOf(MemberNotFoundError);
  });
});

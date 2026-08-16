/**
 * presence 工具 UT — set/clear/越权防护（[v0.0.116] 新增）
 * 参考: specs/tech/squad/[P1]squad_tools.md §6a（presence：set/clear，leader/mate 可用）
 *       specs/tech/version_logs/v0.0.116/change_plan-part2.md §6
 *
 * 覆盖：
 *   - action=set，有 text → ok=true + memberStore.putMember 写 currentWork
 *   - action=clear → ok=true + putMember 写 currentWork=null
 *   - action=set，text 空 → isError（text_required）
 *   - 无 selfMemberId → isError（非 member session）
 *   - 无 selfSquadId → isError（非 squad session）
 *   - memberStore 不存在 → isError
 *   - member 不存在 → isError
 *
 * 白盒：mock rtc（selfSquadId + selfMemberId + memberStore），验证 action 分派 + 越权防护。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../../config/ulid';
import { SquadStore, MemberStore } from '../../../stores/squad-store';
import { presenceTool } from '../presence-tool';
import type { ToolCtx, ToolInput } from '../../../tools/types';
import type { AgentToolRuntimeContext } from '../runtime-context';

// ── helpers ─────────────────────────────────────────────────────────

interface FakeMember {
  id: string;
  squadId: string;
  sessionId: string;
  name: string;
  role: string;
  currentWork: { text: string; updatedAt: string } | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * 构造 mock rtc（selfSquadId + selfMemberId + memberStore mock）。
 * memberStore 在内存中维护单条 member record，putMember 直接覆写。
 */
function makeRtc(opts: {
  selfSquadId?: string;
  selfMemberId?: string;
  memberStore?: AgentToolRuntimeContext['memberStore'];
  noMemberStore?: boolean;
  selfName?: string;
  dataDir?: string;
}): { rtc: AgentToolRuntimeContext; putSpy: ReturnType<typeof vi.fn> } {
  const currentMember: FakeMember = {
    id: opts.selfMemberId ?? 'M-1',
    squadId: opts.selfSquadId ?? 'SQ-1',
    sessionId: 'SID-1',
    name: 'alice',
    role: 'mate',
    currentWork: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
  const putSpy = vi.fn(async (rec: unknown) => {
    Object.assign(currentMember, rec);
  });

  const memberStore = opts.noMemberStore
    ? undefined
    : opts.memberStore ?? ({
        getMember: vi.fn(async (squadId: string, memberId: string) => {
          if (squadId === (opts.selfSquadId ?? 'SQ-1') && memberId === (opts.selfMemberId ?? 'M-1')) {
            return { ...currentMember };
          }
          return null;
        }),
        putMember: putSpy,
      } as unknown as AgentToolRuntimeContext['memberStore']);

  const rtc: AgentToolRuntimeContext = {
    parentSessionId: 'PARENT-1',
    parentRunId: 'r',
    parentType: undefined,
    parentName: 'p',
    parentScope: undefined,
    selfSessionId: 'SID-1',
    selfType: 'mate',
    selfName: opts.selfName ?? 'alice',
    ...(opts.selfSquadId !== undefined ? { selfSquadId: opts.selfSquadId } : {}),
    ...(opts.selfMemberId !== undefined ? { selfMemberId: opts.selfMemberId } : {}),
    memberStore,
    agentManager: {} as never,
    store: {} as never,
    sessionDeps: (opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}) as never,
  };
  return { rtc, putSpy };
}

/** 调 presenceTool.run 并返回 { text, isError } */
async function runPresence(
  rtc: AgentToolRuntimeContext,
  inputFields: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const ctx: ToolCtx = { config: { agentToolContext: rtc } } as unknown as ToolCtx;
  const input: ToolInput = inputFields as unknown as ToolInput;
  const res = await presenceTool.run(input, ctx);
  const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = blocks.map((b) => b?.text ?? '').join('');
  return { text, isError: !!res.isError };
}

// ── 正常路径 ────────────────────────────────────────────────────────

describe('presence 工具 — 正常路径', () => {
  it('action=set，有 text → ok=true + putMember 写 currentWork', async () => {
    const { rtc, putSpy } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1' });
    const { text, isError } = await runPresence(rtc, { action: 'set', text: '正在写 UT' });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(putSpy).toHaveBeenCalledTimes(1);
    const written = putSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.currentWork).toMatchObject({ text: '正在写 UT' });
    expect(typeof (written.currentWork as Record<string, string>).updatedAt).toBe('string');
  });

  it('action=clear → ok=true + putMember 写 currentWork=null', async () => {
    const { rtc, putSpy } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1' });
    const { text, isError } = await runPresence(rtc, { action: 'clear' });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(putSpy).toHaveBeenCalledTimes(1);
    const written = putSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.currentWork).toBeNull();
  });

  it('set + clear 串行：先标记后清空，putMember 各调一次', async () => {
    const { rtc, putSpy } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1' });
    await runPresence(rtc, { action: 'set', text: '写代码' });
    await runPresence(rtc, { action: 'clear' });
    expect(putSpy).toHaveBeenCalledTimes(2);
    const lastCall = putSpy.mock.calls[1]![0] as Record<string, unknown>;
    expect(lastCall.currentWork).toBeNull();
  });

  it('set text 有空格前后 → trim 后写入', async () => {
    const { rtc, putSpy } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1' });
    await runPresence(rtc, { action: 'set', text: '  review PR  ' });
    const written = putSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect((written.currentWork as Record<string, string>).text).toBe('review PR');
  });
});

// ── 越权防护 / 错误路径 ──────────────────────────────────────────────

describe('presence 工具 — 越权防护 / 错误路径', () => {
  it('action=set，text 为空字符串 → isError（presence_text_required）', async () => {
    const { rtc } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1' });
    const { isError, text } = await runPresence(rtc, { action: 'set', text: '' });
    expect(isError).toBe(true);
    expect(text).toMatch(/text.*required|presence_text_required/i);
  });

  it('action=set，无 text 字段 → isError（text_required）', async () => {
    const { rtc } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1' });
    const { isError, text } = await runPresence(rtc, { action: 'set' });
    expect(isError).toBe(true);
    expect(text).toMatch(/text.*required|presence_text_required/i);
  });

  it('无 selfMemberId → isError（非 member session）', async () => {
    // squad-chat session：有 selfSquadId 但无 selfMemberId
    const { rtc } = makeRtc({ selfSquadId: 'SQ-1' });
    const { isError, text } = await runPresence(rtc, { action: 'set', text: 'hello' });
    expect(isError).toBe(true);
    expect(text).toMatch(/selfMemberId|member/i);
  });

  it('无 selfSquadId → isError（非 squad session）', async () => {
    // standalone session：无 selfSquadId
    const { rtc } = makeRtc({ selfMemberId: 'M-1' });
    const { isError, text } = await runPresence(rtc, { action: 'set', text: 'hello' });
    expect(isError).toBe(true);
    expect(text).toMatch(/squad.*session|only.*squad/i);
  });

  it('无 memberStore → isError', async () => {
    const { rtc } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1', noMemberStore: true });
    const { isError, text } = await runPresence(rtc, { action: 'set', text: 'hello' });
    expect(isError).toBe(true);
    expect(text).toMatch(/memberStore|not.*available/i);
  });

  it('member 不存在 → isError', async () => {
    // memberStore.getMember 返 null（找不到 member）
    const memberStore = {
      getMember: vi.fn(async () => null),
      putMember: vi.fn(async () => {}),
    } as unknown as AgentToolRuntimeContext['memberStore'];
    const { rtc } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-NOT-EXIST', memberStore });
    const { isError, text } = await runPresence(rtc, { action: 'set', text: 'hello' });
    expect(isError).toBe(true);
    expect(text).toMatch(/not found/i);
  });

  it('action 未知 → isError', async () => {
    const { rtc } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-1' });
    const { isError, text } = await runPresence(rtc, { action: 'publish' });
    expect(isError).toBe(true);
    expect(text).toMatch(/unknown action|valid.*set.*clear/i);
  });
});

// ── 只写自己（UC-14 越权防护） ──────────────────────────────────────

describe('presence 工具 — 只写自己（selfMemberId，UC-14）', () => {
  it('写入的 currentWork 来自 selfMemberId 对应 member（不接受 memberId 入参）', async () => {
    const { rtc, putSpy } = makeRtc({ selfSquadId: 'SQ-1', selfMemberId: 'M-SELF' });
    await runPresence(rtc, { action: 'set', text: '正在调研', memberId: 'M-OTHER' });
    // 即便传了 memberId 入参，写的是 selfMemberId 对应的 member（不越权）
    expect(putSpy).toHaveBeenCalledTimes(1);
    const written = putSpy.mock.calls[0]![0] as Record<string, unknown>;
    // member id 应为 self（getMember 使用了 selfMemberId）
    expect(written.id).toBe('M-SELF');
  });
});

// ── [v0.0.361 T4] reminder queue fanout（change_plan §1.5/§2 样例 C） ──

describe('presence 工具 — reminder queue fanout', () => {
  let root: string;
  let squadId: string;
  let selfMemberId: string;
  let leaderSid: string;
  let selfSid: string;
  let chatSid: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'presence-ut-'));
    const leaderId = ulid();
    squadId = ulid();
    selfMemberId = ulid();
    leaderSid = ulid();
    selfSid = ulid();
    chatSid = ulid();
    const squadStore = new SquadStore({ root });
    const memberStore = new MemberStore({ root });
    await squadStore.putSquad({
      id: squadId, name: 'S', modelDefault: 'm', leaderId,
      memberIds: [leaderId, selfMemberId], squadChatSessionId: chatSid, enableHeartBeat: false,
    } as Parameters<SquadStore['putSquad']>[0]);
    const base = { squadId, role: 'mate', tools: [], skillConfig: { mode: 'inherit' }, state: 'deployed' };
    await memberStore.putMember({ id: leaderId, ...base, sessionId: leaderSid, name: 'darvin', role: 'leader' } as never);
    await memberStore.putMember({ id: selfMemberId, ...base, sessionId: selfSid, name: 'bob' } as never);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** 读 {sid} 的 reminder queue entries */
  function readQueue(sid: string): Array<{ key: string; value: string }> {
    const p = join(root, 'sessions', sid, 'reminder_queue.json');
    if (!existsSync(p)) return [];
    return (JSON.parse(readFileSync(p, 'utf8')) as { entries: Array<{ key: string; value: string }> }).entries;
  }

  it('set → presence:{memberId} 渲染行 fanout 全员 + squadChat', async () => {
    const { rtc } = makeRtc({ selfSquadId: squadId, selfMemberId, selfName: 'bob', dataDir: root });
    const { isError } = await runPresence(rtc, { action: 'set', text: '正在写 UT' });
    expect(isError).toBe(false);
    const expectLine = [`[squad:agents] bob presence: 正在写 UT`];
    for (const sid of [leaderSid, selfSid, chatSid]) {
      expect(readQueue(sid).map((e) => [e.key, e.value])).toEqual(
        expectLine.map((v) => [`presence:${selfMemberId}`, v]),
      );
    }
  });

  it('clear → 「presence 已清除」行', async () => {
    const { rtc } = makeRtc({ selfSquadId: squadId, selfMemberId, selfName: 'bob', dataDir: root });
    await runPresence(rtc, { action: 'set', text: 'x' });
    const { isError } = await runPresence(rtc, { action: 'clear' });
    expect(isError).toBe(false);
    expect(readQueue(leaderSid).map((e) => [e.key, e.value])).toEqual([
      [`presence:${selfMemberId}`, '[squad:agents] bob presence 已清除'],
    ]);
  });

  it('dataDir 缺省 → fanout no-op（工具主路径不受影响）', async () => {
    const { rtc } = makeRtc({ selfSquadId: squadId, selfMemberId, selfName: 'bob' });
    const { isError } = await runPresence(rtc, { action: 'set', text: 'no dir' });
    expect(isError).toBe(false);
    expect(readQueue(leaderSid)).toEqual([]);
    expect(readQueue(selfSid)).toEqual([]);
  });

  it('fanout 写失败（squad 不存在）→ 吞错不阻断工具返回', async () => {
    const { rtc } = makeRtc({ selfSquadId: ulid(), selfMemberId, selfName: 'bob', dataDir: root });
    const { isError, text } = await runPresence(rtc, { action: 'set', text: 'ghost squad' });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ ok: true });
  });
});

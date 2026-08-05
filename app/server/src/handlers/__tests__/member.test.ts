/**
 * MemberHandler 单测（白盒）—— hire/edit/deploy/bench 路由 + leader 403 + 不可改字段
 * 参考: specs/api/overall/11a-squad-endpoints.md §2（payload + 响应 + 错误码）
 *       specs/tech/squad/[P1]squad_definition.md §8（leader 永远 deployed）
 *
 * 覆盖：
 *   - hire fresh + derive 经 handler（201）
 *   - name 冲突 → 409 member_name_conflict
 *   - bench mate → 200 state=benched；deploy → 恢复 deployed
 *   - bench leader → 403 leader_not_benchable
 *   - edit 不可改字段（role/state/squadId/sessionId）保留
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleMemberRoute } from '../member';
import type { SquadHandlerDeps } from '../squad';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let sessionStore: SessionStore;
let deps: SquadHandlerDeps;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'member-handler-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  deps = { sessionStore, dataDir: tmpRoot };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function req(method: string, body?: unknown): Request {
  return new Request('http://test/squad/x/member', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** 读响应 JSON（r.json() 返 unknown，helper 返 any 便于断言） */
async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

async function buildSquad(): Promise<{ squadId: string; leaderId: string }> {
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  // [v0.0.33.3 step3] leader.systemPrompt 移除（身份正文迁 squad_role mapper）
  const created = await createSquadService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { name: 's1', modelDefault: 'm', leader: { name: 'lead' } },
  );
  return { squadId: created.squad.id, leaderId: created.leaderMember.id };
}

describe('MemberHandler — hire', () => {
  it('POST fresh → 201 + member role=mate state=deployed + sessionId', async () => {
    const { squadId } = await buildSquad();
    const r = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm1', intro: 'i', tools: ['read'],
    }), 'POST', `/squad/${squadId}/member`, deps);
    expect(r.status).toBe(201);
    const body = await jsonBody(r);
    expect(body.member.role).toBe('mate');
    expect(body.member.state).toBe('deployed');
    expect(body.sessionId).toBeTruthy();
  });

  it('name 冲突 → 409 member_name_conflict', async () => {
    const { squadId } = await buildSquad();
    // leader.name='lead' 已存在
    const r = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'lead', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    expect(r.status).toBe(409);
    const body = await jsonBody(r);
    expect(body.error).toBe('member_name_conflict');
  });

  // [v0.0.114] fresh 建 mate intro 必填
  it('fresh 缺 intro → 400 intro required；有 intro → 201 + member.intro 落库', async () => {
    const { squadId } = await buildSquad();
    // 缺 intro → 400
    const bad = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'no-intro',
    }), 'POST', `/squad/${squadId}/member`, deps);
    expect(bad.status).toBe(400);
    expect((await jsonBody(bad)).error).toBe('intro required');
    // 有 intro → 201 + 落库
    const ok = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'with-intro', intro: '负责数据管道',
    }), 'POST', `/squad/${squadId}/member`, deps);
    expect(ok.status).toBe(201);
    expect((await jsonBody(ok)).member.intro).toBe('负责数据管道');
  });
});

describe('MemberHandler — bench / deploy', () => {
  it('bench mate → 200 state=benched + benchReason；deploy → 恢复 deployed', async () => {
    const { squadId } = await buildSquad();
    // hire mate
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm1', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const mateId = (await jsonBody(hireR)).member.id;

    // bench
    const benchR = await handleMemberRoute(req('POST', { reason: 'testing' }),
      'POST', `/squad/${squadId}/member/${mateId}/bench`, deps);
    expect(benchR.status).toBe(200);
    const benched = await jsonBody(benchR);
    expect(benched.member.state).toBe('benched');
    expect(benched.member.benchReason).toBe('testing');
    expect(benched.member.benchedAt).toBeTruthy();

    // deploy 恢复
    const deployR = await handleMemberRoute(req('POST'),
      'POST', `/squad/${squadId}/member/${mateId}/deploy`, deps);
    expect(deployR.status).toBe(200);
    const deployed = await jsonBody(deployR);
    expect(deployed.member.state).toBe('deployed');
    expect(deployed.member.benchReason).toBeUndefined();
  });

  it('bench leader → 403 leader_not_benchable', async () => {
    const { squadId, leaderId } = await buildSquad();
    const r = await handleMemberRoute(req('POST', { reason: 'try' }),
      'POST', `/squad/${squadId}/member/${leaderId}/bench`, deps);
    expect(r.status).toBe(403);
    const body = await jsonBody(r);
    expect(body.error).toBe('leader_not_benchable');
  });

  it('bench reason 缺 → 400', async () => {
    const { squadId } = await buildSquad();
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm1', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const mateId = (await jsonBody(hireR)).member.id;
    const r = await handleMemberRoute(req('POST', { reason: '' }),
      'POST', `/squad/${squadId}/member/${mateId}/bench`, deps);
    expect(r.status).toBe(400);
  });

  it('deploy 幂等：已 deployed → 200 no-op', async () => {
    const { squadId } = await buildSquad();
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm1', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const mateId = (await jsonBody(hireR)).member.id;
    // 已 deployed 直接 deploy
    const r = await handleMemberRoute(req('POST'),
      'POST', `/squad/${squadId}/member/${mateId}/deploy`, deps);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).member.state).toBe('deployed');
  });
});

describe('MemberHandler — edit (PATCH)', () => {
  it('PATCH 改 skillConfig → 200 整体替换快照；tools 被忽略（v0.0.48 accept-and-ignore）', async () => {
    // [v0.0.33.3 step3] PATCH 不再支持改 systemPrompt（字段已删）
    // [v0.0.48] PATCH 带 tools → accept-and-ignore（不 400、不写盘）
    // [v0.0.113] skills → skillConfig（overlay 快照整体替换，含 mode 切换 + overrides）
    const { squadId } = await buildSquad();
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm1', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const hired = (await jsonBody(hireR)).member;
    const mateId = hired.id;
    const preTools = hired.tools; // hire 后基线（accept-and-ignore → []）
    // hire 默认 skillConfig=inherit
    expect(hired.skillConfig).toEqual({ mode: 'inherit', overrides: {} });

    const r = await handleMemberRoute(req('PATCH', {
      tools: ['read', 'write'],       // v0.0.48：被忽略
      skillConfig: { mode: 'custom', overrides: { alpha: false, beta: true } }, // 整体替换
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    expect(r.status).toBe(200); // 不返 400（向后兼容）
    const body = await jsonBody(r);
    // skillConfig 整体替换（含 false/true 两值保真）
    expect(body.member.skillConfig).toEqual({ mode: 'custom', overrides: { alpha: false, beta: true } });
    // 旧 skills 数组字段不再存在（破坏性重构）
    expect(body.member.skills).toBeUndefined();
    // tools 不变（未采纳 PATCH 传值）
    expect(body.member.tools).toEqual(preTools);
    expect(body.member.tools).not.toEqual(['read', 'write']);
  });

  // [v0.0.114] intro 可编辑（PATCH）：成功更新 / 空串 400 / 不传 intro 不影响其他字段
  it('PATCH intro：成功更新落库 / 空串 400 / 不传 intro 不影响 skillConfig 更新', async () => {
    const { squadId } = await buildSquad();
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm1', intro: '原始介绍',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const mateId = (await jsonBody(hireR)).member.id;

    // 成功更新 intro（含首尾空白 → trim 落库）
    const okR = await handleMemberRoute(req('PATCH', {
      intro: '  负责数据管道  ',
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    expect(okR.status).toBe(200);
    expect((await jsonBody(okR)).member.intro).toBe('负责数据管道');

    // 空串 intro → 400 intro required（与创建口径一致）
    const emptyR = await handleMemberRoute(req('PATCH', {
      intro: '   ',
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    expect(emptyR.status).toBe(400);
    expect((await jsonBody(emptyR)).error).toBe('intro required');

    // 不传 intro → 其他字段（skillConfig）正常更新，intro 保留上次值
    const scR = await handleMemberRoute(req('PATCH', {
      skillConfig: { mode: 'custom', overrides: { research: true } },
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    expect(scR.status).toBe(200);
    const patched = (await jsonBody(scR)).member;
    expect(patched.skillConfig).toEqual({ mode: 'custom', overrides: { research: true } });
    expect(patched.intro).toBe('负责数据管道'); // intro 不受影响
  });

  it('PATCH skillConfig custom → 回 inherit 整体替换（旧 overrides 清空，R6）', async () => {
    const { squadId } = await buildSquad();
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm-r6', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const mateId = (await jsonBody(hireR)).member.id;

    // 先置 custom + overrides
    await handleMemberRoute(req('PATCH', {
      skillConfig: { mode: 'custom', overrides: { x: false } },
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    // 回 inherit（overrides 应被整体替换清空，后端不合并旧快照）
    const r = await handleMemberRoute(req('PATCH', {
      skillConfig: { mode: 'inherit', overrides: {} },
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    const body = await jsonBody(r);
    expect(body.member.skillConfig).toEqual({ mode: 'inherit', overrides: {} });
  });

  it('edit 不可改字段保留（role/state/squadId/sessionId 不变）', async () => {
    const { squadId } = await buildSquad();
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'm1', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const hired = (await jsonBody(hireR)).member;
    const mateId = hired.id;

    // 尝试改 role/state/squadId/sessionId（body 带这些字段，但 handler 应忽略——不写 patch）
    const r = await handleMemberRoute(req('PATCH', {
      tools: ['read'],
      // 这些字段不在 PatchMemberBody，handler 不读 → 保留 existing
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    const updated = (await jsonBody(r)).member;
    expect(updated.role).toBe('mate'); // 不可改
    expect(updated.state).toBe('deployed'); // 不可改（state 走 bench/deploy）
    expect(updated.squadId).toBe(hired.squadId); // 不可改
    expect(updated.sessionId).toBe(hired.sessionId); // 不可改
  });
});

// [v0.0.142] workStyle 字段：PATCH 端到端落库 + 空串清空（非 400，区别 intro）
describe('MemberHandler — PATCH workStyle', () => {
  it('PATCH workStyle → 200 落库；PATCH 空串 → 200 清空（非 400）', async () => {
    const { squadId } = await buildSquad();
    const hireR = await handleMemberRoute(req('POST', {
      mode: 'fresh', name: 'ws-member', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const mateId = (await jsonBody(hireR)).member.id;

    // 提供 workStyle → 200 + 落库
    const okR = await handleMemberRoute(req('PATCH', {
      workStyle: '喜欢直接给结论',
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    expect(okR.status).toBe(200);
    expect((await jsonBody(okR)).member.workStyle).toBe('喜欢直接给结论');

    // 空串 → 200 清空（非 400，区别 intro）
    const clearR = await handleMemberRoute(req('PATCH', {
      workStyle: '',
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    expect(clearR.status).toBe(200);
    expect((await jsonBody(clearR)).member.workStyle).toBe('');
  });
});

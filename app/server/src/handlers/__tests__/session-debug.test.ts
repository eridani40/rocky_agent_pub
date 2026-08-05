/**
 * handleSessionDebugSystemPrompt — [v0.0.33.3] debug endpoint studioContext 注入 UT
 * 参考: specs/tech/version_logs/v0.0.33.3/change_log.md（debug endpoint gap side-finding）
 *       specs/tech/squad/[P1]prompt_sections.md §3.1（squad_role mapper）
 *
 * 验证范围：
 *   1. standalone session：systemPrompt 含 Rocky identity（identity mapper standalone 分支，不变）
 *   2. studio leader session：systemPrompt 含 squad_role leader fragment（非 standalone Rocky）
 *      —— 修前 bug：debug handler 没传 studioContext → isStudio=false → identity 走 standalone
 *   3. studio mate session：systemPrompt 含 squad_role mate fragment（非 standalone Rocky）
 *
 * 文件系统隔离：tmpdir + afterEach rmSync。不读写真实 ~/.oobt-desktop/。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { ulid } from '../../config/ulid';
import { handleSessionDebugSystemPrompt } from '../session-debug';
import type { SessionHandlerDeps } from '../session';
import type { SquadRecord, MemberRecord } from '../../agent/schema_defs/squad';
import { buildRealSessionTypePolicy } from '../../agent/__helpers__/session-type-policy-test-helper';

let tmpRoot: string;
let deps: SessionHandlerDeps;
let savedAppEnv: string | undefined;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-debug-studio-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: tmpRoot });
  const appConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(mkdtempSync(join(tmpdir(), 'debug-bs-')));
  // 单 mock provider + 2 model（default + member-model 覆盖 D5 回退链）
  appConfig.set('providers', 'mock-prov', {
    id: 'mock-prov', name: 'mock', enabled: true, kind: 'mock',
    credential: {},
    models: [
      { modelId: 'mock-model' },
      { modelId: 'member-model' },
    ],
  });
  deps = {
    store, agentManager: bs.agentManager, appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: bs.contextEngine, dataDir: tmpRoot,
    sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot),
  };
  // test gate：APP_ENV=test 放行 debug 端点（session-debug.ts:39）
  savedAppEnv = process.env.APP_ENV;
  process.env.APP_ENV = 'test';
});

afterEach(() => {
  if (savedAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = savedAppEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造 squad record（id/leaderId 必须是合法 ULID——putSquad 触发 schema validation） */
function makeSquad(squadId: string, leaderId: string): SquadRecord {
  return {
    id: squadId, name: 'squad', description: '', modelDefault: 'mock-model',
    leaderId, memberIds: [leaderId],
    squadChatSessionId: ulid(),
    enableHeartBeat: false,
  };
}

/** 造 member record（leader/mate 通用；[v0.0.33.3 step3] systemPrompt 字段已移除；[v0.0.155] model 字段已硬删 A4） */
function makeMember(role: 'leader' | 'mate', memberId: string, squadId: string): MemberRecord {
  return {
    id: memberId, squadId, sessionId: ulid(),
    name: role === 'leader' ? 'alice' : 'bob', role,
    tools: ['send_message'], skillConfig: { mode: 'inherit', overrides: {} }, state: 'deployed',
  };
}

/** 调 debug handler 并解析 JSON body */
async function debugRequest(id: string): Promise<{ status: number; body: { systemPrompt?: string; error?: string } }> {
  const res = await handleSessionDebugSystemPrompt(
    new Request(`http://x/session/${id}/debug/system-prompt`),
    'GET', id, deps,
  );
  return { status: res.status, body: await res.json() as { systemPrompt?: string; error?: string } };
}

describe('handleSessionDebugSystemPrompt — [v0.0.33.3] studio session studioContext 注入', () => {
  it('[v0.0.56] standalone session：identity mapper 返空（role=rocky 走 else 分支，squad_role 接管）', async () => {
    const s = await deps.store.createSession({
      id: ulid(), providerId: 'mock-prov', modelId: 'mock-model',
      workspaceDir: join(tmpRoot, 'ws-standalone'),
    });
    const { status, body } = await debugRequest(s.id);
    expect(status).toBe(200);
    // [v0.0.56] identity mapper 对 role='rocky' 返空（非 !sessionType 旧 standlone 分支）
    // system prompt 仍包含其他 mapper 产出（tool_guidance 等）
    expect(typeof body.systemPrompt).toBe('string');
    expect(body.systemPrompt!.length).toBeGreaterThan(0);
  });

  it('studio leader session：systemPrompt 含 squad_role leader fragment（非 standalone Rocky）', async () => {
    // 建 squad + member entity（debug handler 内部按 squadId/memberId 读取）
    const squadStore = new SquadStore({ root: tmpRoot });
    const memberStore = new MemberStore({ root: tmpRoot });
    const squadId = ulid();
    const leaderId = ulid();
    await squadStore.putSquad(makeSquad(squadId, leaderId));
    await memberStore.putMember(makeMember('leader', leaderId, squadId));
    // 建 studio leader session（bizType=studio + type=leader + squadId + memberId）
    const s = await deps.store.createSession({
      id: ulid(), providerId: 'mock-prov', modelId: 'mock-model',
      workspaceDir: join(tmpRoot, 'ws-leader'),
      biz: 'studio', role: 'leader', derivation: 'parent', squadId, memberId: leaderId,
    });
    const { status, body } = await debugRequest(s.id);
    expect(status).toBe(200);
    // squad_role mapper 注入 leader.md fragment（含 "leader" / "队长"）
    expect(body.systemPrompt).toContain('leader');
    expect(body.systemPrompt).toContain('队长');
    // identity mapper studio 分支返空 → 不含 standalone Rocky identity
    //   （修前 bug：debug 没传 studioContext → isStudio=false → identity 走 standalone 假象）
    expect(body.systemPrompt).not.toContain('You are Rocky');
  });

  it('studio mate session：systemPrompt 含 squad_role mate fragment（非 standalone Rocky）', async () => {
    const squadStore = new SquadStore({ root: tmpRoot });
    const memberStore = new MemberStore({ root: tmpRoot });
    const squadId = ulid();
    const leaderId = ulid();
    const mateId = ulid();
    const squad = makeSquad(squadId, leaderId);
    squad.memberIds = [leaderId, mateId];
    await squadStore.putSquad(squad);
    await memberStore.putMember(makeMember('mate', mateId, squadId));
    const s = await deps.store.createSession({
      id: ulid(), providerId: 'mock-prov', modelId: 'mock-model',
      workspaceDir: join(tmpRoot, 'ws-mate'),
      biz: 'studio', role: 'mate', derivation: 'parent', squadId, memberId: mateId,
    });
    const { status, body } = await debugRequest(s.id);
    expect(status).toBe(200);
    // squad_role mapper 注入 mate.md fragment（含 "mate" / "执行者"）
    expect(body.systemPrompt).toContain('mate');
    expect(body.systemPrompt).toContain('执行者');
    expect(body.systemPrompt).not.toContain('You are Rocky');
  });
});

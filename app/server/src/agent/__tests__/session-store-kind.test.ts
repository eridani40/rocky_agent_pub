/**
 * SessionStore 单元测试（slim SessionKind + SessionContext + 两层校验）
 * 参考: specs/tech/agent/session/[P0]session_kind.md §1-§5
 *
 * 覆盖：
 *   - getSessionKind：slim kind（biz/role/derivation；runKind 缺省 'main'）
 *   - getSessionContext：实例 ID 投影
 *   - createSession：两层校验（K1/K3/K5 + C1-C3）+ enabled 门（T2 补）
 *   - subAgentConfig 写入
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { SessionKind, SessionKindValidationError } from '@app/shared';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-kind-204-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getSessionKind（v0.0.204 slim）', () => {
  it('playground parent → kind 4 字段 + runKind 缺省 main', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, biz: 'playground', role: 'rocky', derivation: 'parent' });
    const kind = await store.getSessionKind(sid);
    expect(kind).toBeInstanceOf(SessionKind);
    expect(kind.biz).toBe('playground');
    expect(kind.role).toBe('rocky');
    expect(kind.derivation).toBe('parent');
    expect(kind.runKind).toBe('main'); // 缺省
    expect(kind.canonicalId()).toBe('playground-rocky:parent:main');
  });

  it('subagent → isSubagent=true', async () => {
    const parentSid = ulid();
    const childSid = ulid();
    await store.createSession({ id: parentSid, biz: 'playground', role: 'rocky', derivation: 'parent' });
    await store.createSession({
      id: childSid, biz: 'playground', role: 'rocky',
      derivation: 'subagent', parentSessionId: parentSid,
    });
    const kind = await store.getSessionKind(childSid);
    expect(kind.isSubagent).toBe(true);
    expect(kind.derivation).toBe('subagent');
  });

  it('session 不存在 → throw SessionNotFoundError', async () => {
    await expect(store.getSessionKind('nonexistent-sid')).rejects.toThrow('session not found');
  });
});

describe('getSessionContext（v0.0.204 新增）', () => {
  it('实例 ID 投影（studio squadId/memberId）', async () => {
    const sid = ulid();
    const squadId = ulid();
    const memberId = ulid();
    await store.createSession({
      id: sid, biz: 'studio', role: 'leader', derivation: 'parent',
      squadId, memberId,
    });
    const ctx = await store.getSessionContext(sid);
    expect(ctx.squadId).toBe(squadId);
    expect(ctx.memberId).toBe(memberId);
    expect(ctx.parentSessionId).toBeUndefined();
  });

  it('subagent → parentSessionId 投影', async () => {
    const parentSid = ulid();
    const childSid = ulid();
    await store.createSession({ id: parentSid, biz: 'playground', role: 'rocky', derivation: 'parent' });
    await store.createSession({
      id: childSid, biz: 'playground', role: 'rocky',
      derivation: 'subagent', parentSessionId: parentSid,
    });
    const ctx = await store.getSessionContext(childSid);
    expect(ctx.parentSessionId).toBe(parentSid);
  });
});

describe('createSession 两层校验（K1/K3/K5 / C1-C3）', () => {
  it('K1: role=leader biz=playground → throw', async () => {
    await expect(
      store.createSession({ id: ulid(), biz: 'playground', role: 'leader', derivation: 'parent' }),
    ).rejects.toThrow(SessionKindValidationError);
  });

  it('C1: subagent 无 parentSessionId → throw', async () => {
    await expect(
      store.createSession({ id: ulid(), biz: 'playground', role: 'rocky', derivation: 'subagent' }),
    ).rejects.toThrow(/parentSessionId/);
  });

  it('C2: studio parent 无 squadId → throw', async () => {
    await expect(
      store.createSession({ id: ulid(), biz: 'studio', role: 'squad', derivation: 'parent' }),
    ).rejects.toThrow(/squadId/);
  });
});

describe('createSession subAgentConfig 写入', () => {
  it('subAgentConfig 字段持久化', async () => {
    const parentSid = ulid();
    const childSid = ulid();
    await store.createSession({
      id: parentSid, biz: 'studio', role: 'leader', derivation: 'parent',
      squadId: ulid(), memberId: ulid(),
    });
    await store.createSession({
      id: childSid, biz: 'studio', role: 'leader',
      derivation: 'subagent', parentSessionId: parentSid,
      squadId: ulid(),
      subAgentConfig: { systemPrompt: 'test', tools: ['browser'], maxIter: 5 },
    });
    const ses = await store.getSession(childSid);
    expect(ses?.subAgentConfig).toBeDefined();
    expect(ses!.subAgentConfig!.systemPrompt).toBe('test');
    expect(ses!.subAgentConfig!.tools).toEqual(['browser']);
    expect(ses!.subAgentConfig!.maxIter).toBe(5);
  });
});

describe('SessionKind.canonicalId（v0.0.204 T2-B2 替原 deriveToolPolicyRole）', () => {
  it('canonicalId 4 段纯拼接覆盖', async () => {
    // playground parent main → playground-rocky:parent:main
    const sid1 = ulid();
    await store.createSession({ id: sid1, biz: 'playground', role: 'rocky', derivation: 'parent' });
    expect((await store.getSessionKind(sid1)).canonicalId()).toBe('playground-rocky:parent:main');

    // playground subagent → playground-rocky:subagent:main
    const psid1 = ulid();
    await store.createSession({ id: psid1, biz: 'playground', role: 'rocky', derivation: 'parent' });
    const sid2 = ulid();
    await store.createSession({
      id: sid2, biz: 'playground', role: 'rocky',
      derivation: 'subagent', parentSessionId: psid1,
    });
    expect((await store.getSessionKind(sid2)).canonicalId()).toBe('playground-rocky:subagent:main');

    // studio-squad / leader / mate parent
    const sid3 = ulid();
    await store.createSession({ id: sid3, biz: 'studio', role: 'squad', derivation: 'parent', squadId: ulid() });
    expect((await store.getSessionKind(sid3)).canonicalId()).toBe('studio-squad:parent:main');

    const sid4 = ulid();
    await store.createSession({
      id: sid4, biz: 'studio', role: 'leader', derivation: 'parent',
      squadId: ulid(), memberId: ulid(),
    });
    expect((await store.getSessionKind(sid4)).canonicalId()).toBe('studio-leader:parent:main');

    const sid5 = ulid();
    await store.createSession({
      id: sid5, biz: 'studio', role: 'mate', derivation: 'parent',
      squadId: ulid(), memberId: ulid(),
    });
    expect((await store.getSessionKind(sid5)).canonicalId()).toBe('studio-mate:parent:main');
  });
});

/**
 * createSession enabled 门（v0.0.204 T2-B5，STP §8）
 * 参考: specs/tech/version_logs/v0.0.204/change_plan.md 行#49
 *
 * 仅 main-run 类型（derivation='parent'）走门：profile 必须存在且 enabled!==false。
 * summary/consolidate runKind 不经此门。缺省 loader（UT fixture）门跳过——本组测试注入 mock loader。
 */
describe('createSession enabled 门（T2-B5）', () => {
  it('缺省 loader → 门跳过（UT fixture / dev misconfig 容忍）', async () => {
    // store 默认无 sessionTypeProfileLoader（beforeEach 不注）→ createSession 应正常建
    const sid = ulid();
    const session = await store.createSession({ id: sid, biz: 'playground', role: 'rocky', derivation: 'parent' });
    expect(session.id).toBe(sid);
  });

  it('loader 注入 + main-run 类型已登记 + enabled!==false → 创建成功', async () => {
    const sid = ulid();
    store.sessionTypeProfileLoader = {
      has: (id: string) => id === 'playground-rocky:parent:main',
      profile: (id: string) => ({ enabled: true } as never),
    } as never;
    const session = await store.createSession({ id: sid, biz: 'playground', role: 'rocky', derivation: 'parent' });
    expect(session.id).toBe(sid);
  });

  it('loader 注入 + main-run 类型未登记 profile → fail fast SessionKindValidationError', async () => {
    store.sessionTypeProfileLoader = {
      has: () => false,
      profile: () => { throw new Error('unexpected'); },
    } as never;
    // 用 playground biz 但 loader.has 返 false 模拟「类型未登记」（绕过 Role enum 校验需走真实未登记组合）
    // 此处用 role=rocky + biz=playground 但 loader 拒识别 → 走 enabled 门 fail 路径
    await expect(
      store.createSession({ id: ulid(), biz: 'playground', role: 'rocky', derivation: 'parent' }),
    ).rejects.toThrow(SessionKindValidationError);
    await expect(
      store.createSession({ id: ulid(), biz: 'playground', role: 'rocky', derivation: 'parent' }),
    ).rejects.toThrow(/未登记 profile/);
  });

  it('loader 注入 + profile.enabled===false → fail fast SessionKindValidationError', async () => {
    store.sessionTypeProfileLoader = {
      has: () => true,
      profile: () => ({ enabled: false } as never),
    } as never;
    await expect(
      store.createSession({ id: ulid(), biz: 'playground', role: 'rocky', derivation: 'parent' }),
    ).rejects.toThrow(SessionKindValidationError);
    await expect(
      store.createSession({ id: ulid(), biz: 'playground', role: 'rocky', derivation: 'parent' }),
    ).rejects.toThrow(/已禁用/);
  });

  it('derivation=subagent 不走门（仅 main-run parent 走门）', async () => {
    // subagent 创建不应触发 enabled 门——profile 检查仅对 parent:main
    store.sessionTypeProfileLoader = {
      has: () => { throw new Error('门不应被调用 for subagent'); },
      profile: () => { throw new Error('门不应被调用 for subagent'); },
    } as never;
    const sid = ulid();
    const parentSid = ulid();
    // 先建 parent（this test 内 store 注入的 loader 会拒，所以临时清空建 parent 再注回）
    store.sessionTypeProfileLoader = undefined;
    await store.createSession({ id: parentSid, biz: 'playground', role: 'rocky', derivation: 'parent' });
    store.sessionTypeProfileLoader = {
      has: () => { throw new Error('门不应被调用 for subagent'); },
      profile: () => { throw new Error('门不应被调用 for subagent'); },
    } as never;
    const sub = await store.createSession({
      id: sid, biz: 'playground', role: 'rocky', derivation: 'subagent',
      parentSessionId: parentSid,
    });
    expect(sub.id).toBe(sid);
  });
});

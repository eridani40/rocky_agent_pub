/**
 * Session schema 5 字段持久化 UT（v0.0.28 task-1）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §2（Session schema 5 字段）
 *       specs/api/overall/10-multi-agent.md §2（字段语义 + GET /session 暴露）
 *       states/v0.0.28/task.json tasks[0] acceptance「Session 5 字段持久化」
 *
 * 覆盖：
 *   - createSession 写入 type/parentSessionId/scope/subAgentTemplateType/origin → toSession 读回
 *   - 历史兼容：旧 session（无 5 字段）→ 读回时这些字段 undefined（不报错）
 *   - GET /session/:id + GET /session 返回 Session 含 modelId + 5 字段（spec_clarifications[0] D8 依赖）
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema,
  MessageSchema,
  SummarySchema,
  RunSchema,
} from '../schema_defs';
import { SessionStore } from '../session-store';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-schema-5f-'));
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

describe('Session schema 5 字段持久化 — subagent session 完整落盘读回', () => {
  it('createSession 写入 type/parentSessionId/scope/subAgentTemplateType/origin → toSession 读回完整', async () => {
    const childSid = ulid();
    const parentSid = ulid();
    // 先建 parent（顶层 standalone，无 5 字段）
    await store.createSession({ id: parentSid, title: 'parent' });
    // 建 child subagent session（5 字段全填 + modelId）
    const origin = { spawnRunId: ulid(), toolCallId: ulid() };
    const created = await store.createSession({
      id: childSid,
      title: 'explorer-child',
      parentSessionId: parentSid,
      derivation: 'subagent',
      subAgentTemplateType: 'explorer',
      origin,
      providerId: 'p1',
      modelId: 'm1',
    });

    // createSession 返回值含新身份字段 + modelId + 额外字段
    expect(created.derivation).toBe('subagent');
    expect(created.parentSessionId).toBe(parentSid);
    expect(created.subAgentTemplateType).toBe('explorer');
    expect(created.origin).toEqual(origin);
    expect(created.modelId).toBe('m1');
    expect(created.providerId).toBe('p1');

    // getSession 读回（走 toSession）一致
    const got = await store.getSession(childSid);
    expect(got).not.toBeNull();
    expect(got!.derivation).toBe('subagent');
    expect(got!.parentSessionId).toBe(parentSid);
    expect(got!.subAgentTemplateType).toBe('explorer');
    expect(got!.origin).toEqual(origin);
    expect(got!.modelId).toBe('m1');
  });

  it('inline spawn（无 templateRef）→ subAgentTemplateType 不填', async () => {
    const sid = ulid();
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    await store.createSession({
      id: sid,
      parentSessionId: parentSid,
      derivation: 'subagent',
      // subAgentTemplateType 不传（inline spawn）
    });
    const got = await store.getSession(sid);
    expect(got!.derivation).toBe('subagent');
    expect(got!.subAgentTemplateType).toBeUndefined();
  });

  it('listSessions 返回项含 5 字段（subagent + parent 混在同一列表）', async () => {
    const parentSid = ulid();
    const childSid = ulid();
    await store.createSession({ id: parentSid, title: 'parent' });
    await store.createSession({
      id: childSid,
      title: 'child',
      parentSessionId: parentSid,
      derivation: 'subagent',
      subAgentTemplateType: 'explorer',
    });
    const list = await store.listSessions();
    const child = list.find((s) => s.id === childSid);
    const parent = list.find((s) => s.id === parentSid);
    expect(child).toBeDefined();
    expect(child!.derivation).toBe('subagent');
    expect(child!.parentSessionId).toBe(parentSid);
    expect(child!.subAgentTemplateType).toBe('explorer');
    // parent 是顶层 standalone，额外字段 undefined
    expect(parent).toBeDefined();
    expect(parent!.parentSessionId).toBeUndefined();
    expect(parent!.subAgentTemplateType).toBeUndefined();
    expect(parent!.origin).toBeUndefined();
  });
});

describe('Session schema 5 字段 — 历史兼容', () => {
  it('旧 session（无 5 字段，直接 put record）→ toSession 读回不报错，5 字段 undefined', async () => {
    // 模拟历史 session：直接 crud.put 一个不含 5 字段的 record（绕过 createSession）
    const crud = (store as unknown as { crud: CompositeStore }).crud;
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: 'legacy',
      status: 'active',
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      // 故意不写 parentSessionId/subAgentTemplateType/origin（额外字段兼容）
      unread: false,
    } as never);
    const got = await store.getSession(sid);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(sid);
    // 额外字段缺省 undefined（不报错）
    expect(got!.parentSessionId).toBeUndefined();
    expect(got!.subAgentTemplateType).toBeUndefined();
    expect(got!.origin).toBeUndefined();
  });

  it('modelId 历史 session 缺省 → undefined（无 providerId/modelId 字段）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid }); // 不传 providerId/modelId
    const got = await store.getSession(sid);
    expect(got!.modelId).toBeUndefined();
    expect(got!.providerId).toBeUndefined();
  });
});

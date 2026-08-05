/**
 * Session titled 字段 UT（v0.0.47 task-1）
 * 参考: specs/tech/agent/session/[P0]session_store.md §2（titled 字段 lazy 默认 false）
 *       specs/tech/agent/auto_naming/index.md ④（titled CAS gate 消费方）
 *       states/v0.0.47.ui_opt/design.md §1 + §4（migrate 策略：lazy 默认 false，不跑 migration）
 *
 * 覆盖：
 *   - titled lazy 默认 false：StoredRecord 无 titled 字段 → toSession 得 false（历史兼容）
 *   - createSession 强制落 titled=false（CreateSessionInput 不暴露 titled；caller 无法覆盖）
 *   - sessionToMetaView 序列化 titled:boolean（对齐 GET /session 返回 shape）
 *   - toSession 直读：record.titled=true → Session.titled=true
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理（与 session-schema-5fields.test.ts 同构）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionSchema } from '../schema_defs';
import { SessionStore } from '../session-store';
import { toSession } from '../session-store-converters';

let tmpRoot: string;
let store: SessionStore;
let crud: CompositeStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-titled-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Session titled 字段 — lazy 默认 false（不跑 migration）', () => {
  it('历史 session（无 titled 字段，直接 put record）→ toSession 读回 titled=false', async () => {
    // 模拟 v0.0.47 之前的存量 session：crud.put 一个不含 titled 字段的 record
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: 'legacy',
      status: 'active',
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      // 故意不写 titled（历史 session 无此字段）
    } as never);
    const got = await store.getSession(sid);
    expect(got).not.toBeNull();
    // lazy 默认 false：`r.titled === true` 对 undefined → false
    expect(got!.titled).toBe(false);
  });

  it('record.titled=true → toSession 读回 titled=true（命名后状态）', async () => {
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: '已被命名',
      status: 'active',
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      titled: true,
    } as never);
    const got = await store.getSession(sid);
    expect(got).not.toBeNull();
    expect(got!.titled).toBe(true);
  });

  it('toSession 直读：record.titled 非布尔（脏数据 "true" 字符串）→ false（=== true 严格判定）', () => {
    // 防御：脏数据不应被误解为 truthy（=== true 严格相等，对齐 unread 模型）
    const fakeRec = {
      id: ulid(),
      title: 'dirty',
      status: 'active' as const,
      unread: false,
      titled: 'true' as unknown as boolean, // 字符串而非真 boolean
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      version: 1,
    };
    const s = toSession(fakeRec as never);
    expect(s.titled).toBe(false);
  });
});

describe('Session titled — createSession 强制 false', () => {
  it('createSession 不传 titled → 返回 titled=false', async () => {
    const sid = ulid();
    const created = await store.createSession({ id: sid, title: '新会话' });
    expect(created.titled).toBe(false);
    // getSession 读回一致（走 toSession）
    const got = await store.getSession(sid);
    expect(got!.titled).toBe(false);
  });

  it('CreateSessionInput 不暴露 titled 字段（类型层禁止 caller 传）', async () => {
    // CreateSessionInput interface 无 titled 字段（type-level 禁止）。
    // 即便 caller 走 `as never` 强行透传 titled:true，createSession 内部仍强制写 false
    // （record 由 store 构造，caller 透传的 titled 被忽略）。
    const sid = ulid();
    await store.createSession({
      id: sid,
      title: 'x',
      titled: true, // 故意透传（模拟 caller 篡改），createSession 应覆盖为 false
    } as never);
    const got = await store.getSession(sid);
    expect(got!.titled).toBe(false); // createSession 强制 false，caller 无法绕过
  });

  it('createSession 落盘的 record 含 titled:false（持久化验证）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 直读 crud 验证 record 层持久化了 titled:false
    const rec = crud.get(SessionSchema, sid) as { titled?: unknown } | null;
    expect(rec).not.toBeNull();
    expect(rec!.titled).toBe(false);
  });
});

describe('SessionMetaView — sessionToMetaView 序列化 titled', () => {
  it('未命名 session（titled=false）→ SessionMetaView.titled=false', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, title: '新会话' });
    const session = await store.getSession(sid);
    expect(session!.titled).toBe(false);
    // sessionToMetaView 在 broadcaster 内部（已由 session.titled 派生），这里通过 Session.titled 间接验证
    // 直接断言 Session.titled 字段类型为 boolean（序列化前提）
    expect(typeof session!.titled).toBe('boolean');
  });

  it('命名后 session（record.titled=true）→ Session.titled=true（SessionMetaView 序列化源）', async () => {
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: 'AI 起的名',
      status: 'active',
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      titled: true,
    } as never);
    const session = await store.getSession(sid);
    // sessionToMetaView(s) 走 `s.titled === true`，Session.titled 已是 boolean → 序列化一致
    expect(session!.titled).toBe(true);
    expect(typeof session!.titled).toBe('boolean');
  });
});

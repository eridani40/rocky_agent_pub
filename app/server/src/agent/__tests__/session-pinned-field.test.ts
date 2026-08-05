/**
 * [v0.0.231] session pinned 字段（会话置顶）UT
 * 参考: specs/tech/agent/session/[P0]session_store.md §2（pinned lazy-default）
 *       specs/tech/version_logs/v0.0.231/change_plan.md（pinned-only 保 updatedAt，用户裁决）
 *
 * 覆盖：
 *   - toSession lazy 默认：历史 session（无 pinned 字段）→ pinned=false（无 migration）
 *   - createSession 不传 pinned → 读回 false
 *   - updateSession {pinned:true} 部分更新落盘读回 true；不传 pinned → 保留原值
 *   - pinned-only updateSession → updatedAt 不变（version 仍 +1）
 *   - 含 title 的 patch → updatedAt 仍推进（现状回归）
 *   - {pinned, title:undefined} 形态不误判 pinned-only（按「提供的字段」判定）
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理（对齐 session-effort-approval-fields.test.ts）。
 * 时钟注入：FsCrudStore now 可控，updatedAt 断言精确到注入值（零毫秒级 flake）。
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

const T1 = '2026-08-01T01:00:00.000Z';
const T2 = '2026-08-01T02:00:00.000Z';
const T3 = '2026-08-01T03:00:00.000Z';

let tmpRoot: string;
let store: SessionStore;
let crud: CompositeStore;
let currentNow: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-pinned-'));
  currentNow = T1;
  const fs = new FsCrudStore({ root: tmpRoot, now: () => currentNow });
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

describe('Session.pinned — toSession lazy 默认（历史 session 兼容，无 migration）', () => {
  it('历史 session（无 pinned 字段）→ 读出 pinned=false', async () => {
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: 'legacy',
      status: 'active',
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      // 故意不写 pinned（历史 record 形态）
    } as never);
    const got = await store.getSession(sid);
    expect(got).not.toBeNull();
    expect(got!.pinned).toBe(false);
  });

  it('toSession 直读：record 有 pinned → 映射正确', () => {
    const base = {
      id: ulid(),
      title: 'x',
      status: 'active' as const,
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      createdAt: T1,
      updatedAt: T1,
      version: 1,
    };
    expect(toSession({ ...base, pinned: true } as never).pinned).toBe(true);
    expect(toSession({ ...base, pinned: false } as never).pinned).toBe(false);
    // 缺省/脏值 → false（=== true 规范化）
    expect(toSession(base as never).pinned).toBe(false);
    expect(toSession({ ...base, pinned: 'yes' } as never).pinned).toBe(false);
  });
});

describe('Session.pinned — createSession / updateSession 部分更新', () => {
  it('createSession 不传 pinned → 读回 false', async () => {
    const sid = ulid();
    const created = await store.createSession({ id: sid, title: '新会话' });
    expect(created.pinned).toBe(false);
    const got = await store.getSession(sid);
    expect(got!.pinned).toBe(false);
  });

  it('updateSession {pinned:true} → 落盘读回 true；再 {pinned:false} → 读回 false', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { pinned: true });
    let got = await store.getSession(sid);
    expect(got!.pinned).toBe(true);
    await store.updateSession(sid, { pinned: false });
    got = await store.getSession(sid);
    expect(got!.pinned).toBe(false);
  });

  it('updateSession 不传 pinned → 保留原值（部分更新语义，undefined 不覆盖）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { pinned: true });
    // 改 title 不传 pinned → pinned 保留 true
    await store.updateSession(sid, { title: '改名' });
    const got = await store.getSession(sid);
    expect(got!.pinned).toBe(true);
    expect(got!.title).toBe('改名');
  });
});

describe('Session.pinned — pinned-only 保 updatedAt（用户裁决 2026-08-01）', () => {
  it('pinned-only updateSession → updatedAt 不变、version 仍 +1', async () => {
    const sid = ulid();
    await store.createSession({ id: sid }); // T1 落盘
    const before = await store.getSession(sid);
    expect(before!.updatedAt).toBe(T1);
    // 时钟推进后做 pinned-only 写
    currentNow = T2;
    await store.updateSession(sid, { pinned: true });
    const after = await store.getSession(sid);
    expect(after!.pinned).toBe(true);
    expect(after!.updatedAt).toBe(before!.updatedAt); // 保 updatedAt
    expect(after!.version).toBe(before!.version + 1); // version 仍 +1
  });

  it('取消置顶（pinned:false）同样保 updatedAt', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { pinned: true }); // T1（pinned-only 保）
    const before = await store.getSession(sid);
    currentNow = T2;
    await store.updateSession(sid, { pinned: false });
    const after = await store.getSession(sid);
    expect(after!.pinned).toBe(false);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });

  it('含 title 的 patch → updatedAt 仍推进（现状回归）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    currentNow = T2;
    await store.updateSession(sid, { title: '改名' });
    const got = await store.getSession(sid);
    expect(got!.updatedAt).toBe(T2); // 推进
  });

  it('pinned + title 同 patch（非 pinned-only）→ updatedAt 推进', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    currentNow = T2;
    await store.updateSession(sid, { pinned: true, title: '改名' });
    const got = await store.getSession(sid);
    expect(got!.pinned).toBe(true);
    expect(got!.updatedAt).toBe(T2); // 含非 pinned 字段 → 推进
  });

  it('{pinned, title:undefined} 形态 → 按「提供的字段」判定为 pinned-only → 保 updatedAt', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const before = await store.getSession(sid);
    currentNow = T3;
    await store.updateSession(sid, { pinned: true, title: undefined });
    const after = await store.getSession(sid);
    expect(after!.pinned).toBe(true);
    expect(after!.updatedAt).toBe(before!.updatedAt); // undefined 字段不计入判定
  });
});

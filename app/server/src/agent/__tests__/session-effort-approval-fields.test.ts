/**
 * [v0.0.148 链路 B] session schema 3 字段（effort/approvalMode/alwaysApprovedKeys）UT
 * 参考: specs/tech/version_logs/v0.0.148/change_plan.md 链路 B
 *       specs/tech/agent/session/[P0]session_store.md §2（Session 字段 lazy 默认）
 *
 * 覆盖：
 *   - toSession lazy 默认：历史 session（无 3 字段）→ effort=default / approvalMode=normal / keys=[]
 *   - toSession 直读：record 有字段 → Session 字段映射正确
 *   - createSession：不传 effort/approvalMode → 读回 default/normal；传 effort → 持久化
 *   - updateSession effort/approvalMode 部分更新（undefined 不覆盖）
 *   - updateSession alwaysApprovedKeys read-modify-write 去重（Set 语义，merge existing）
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理（与 session-titled-field.test.ts 同构）。
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
import { toSession, normalizeKeyArray } from '../session-store-converters';

let tmpRoot: string;
let store: SessionStore;
let crud: CompositeStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-effort-'));
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

describe('Session 3 字段 — toSession lazy 默认（历史 session 兼容）', () => {
  it('历史 session（无 3 字段）→ effort=default / approvalMode=normal / keys=[]', async () => {
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: 'legacy',
      status: 'active',
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      // 故意不写 effort/approvalMode/alwaysApprovedKeys
    } as never);
    const got = await store.getSession(sid);
    expect(got).not.toBeNull();
    expect(got!.effort).toBe('default');
    expect(got!.approvalMode).toBe('normal');
    expect(got!.alwaysApprovedKeys).toEqual([]);
  });

  it('record 有字段 → toSession 直读映射', () => {
    const fakeRec = {
      id: ulid(),
      title: 'x',
      status: 'active' as const,
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      effort: 'high',
      approvalMode: 'greenlight',
      alwaysApprovedKeys: ['bash:rm-wildcard', 'file:write'],
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
      version: 1,
    };
    const s = toSession(fakeRec as never);
    expect(s.effort).toBe('high');
    expect(s.approvalMode).toBe('greenlight');
    expect(s.alwaysApprovedKeys).toEqual(['bash:rm-wildcard', 'file:write']);
  });

  it('alwaysApprovedKeys 脏数据（非数组 / 非 string 元素）→ normalizeKeyArray 兜底 []', () => {
    expect(normalizeKeyArray(undefined)).toEqual([]);
    expect(normalizeKeyArray(null)).toEqual([]);
    expect(normalizeKeyArray('not-array')).toEqual([]);
    expect(normalizeKeyArray([1, 2, 'ok', null])).toEqual(['ok']);
  });
});

describe('Session 3 字段 — createSession 持久化', () => {
  it('createSession 不传 effort/approvalMode → 读回 default/normal', async () => {
    const sid = ulid();
    const created = await store.createSession({ id: sid, title: '新会话' });
    expect(created.effort).toBe('default');
    expect(created.approvalMode).toBe('normal');
    expect(created.alwaysApprovedKeys).toEqual([]);
  });

  it('createSession 传 effort=high → 持久化读回 high', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, title: 'x', effort: 'high', approvalMode: 'greenlight' });
    const got = await store.getSession(sid);
    expect(got!.effort).toBe('high');
    expect(got!.approvalMode).toBe('greenlight');
  });

  it('alwaysApprovedKeys 不进 CreateSessionInput（新建缺省 []）', async () => {
    // CreateSessionInput 类型层无 alwaysApprovedKeys（新建无「已批准」语义）
    const sid = ulid();
    await store.createSession({ id: sid });
    const got = await store.getSession(sid);
    expect(got!.alwaysApprovedKeys).toEqual([]);
  });
});

describe('Session 3 字段 — updateSession 部分更新 + alwaysApprovedKeys 去重', () => {
  it('updateSession effort 覆盖（undefined 不改）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, effort: 'low' });
    // 改 high
    await store.updateSession(sid, { effort: 'high' });
    let got = await store.getSession(sid);
    expect(got!.effort).toBe('high');
    // 不传 effort → 保留 high
    await store.updateSession(sid, { title: '改名' });
    got = await store.getSession(sid);
    expect(got!.effort).toBe('high');
  });

  it('updateSession approvalMode 覆盖（undefined 不改）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { approvalMode: 'greenlight' });
    let got = await store.getSession(sid);
    expect(got!.approvalMode).toBe('greenlight');
    // 不传 → 保留
    await store.updateSession(sid, { title: 'x' });
    got = await store.getSession(sid);
    expect(got!.approvalMode).toBe('greenlight');
  });

  it('updateSession alwaysApprovedKeys read-modify-write 去重 merge（Set 语义）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    // 初始空；add 两个 key
    await store.updateSession(sid, { alwaysApprovedKeys: ['bash:rm-wildcard', 'file:write'] });
    let got = await store.getSession(sid);
    expect(got!.alwaysApprovedKeys).toEqual(['bash:rm-wildcard', 'file:write']);
    // 再 add 一个新的 + 一个重复的 → 去重 merge（非覆盖式）
    await store.updateSession(sid, {
      alwaysApprovedKeys: ['file:write', 'web:fetch'],
    });
    got = await store.getSession(sid);
    expect(got!.alwaysApprovedKeys!.sort()).toEqual(['bash:rm-wildcard', 'file:write', 'web:fetch']);
  });

  it('updateSession alwaysApprovedKeys 保留 existing（未提供时不改）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { alwaysApprovedKeys: ['bash:rm-wildcard'] });
    // 改 title 不传 keys → keys 保留
    await store.updateSession(sid, { title: '改名' });
    const got = await store.getSession(sid);
    expect(got!.alwaysApprovedKeys).toEqual(['bash:rm-wildcard']);
  });

  it('updateSession effort + alwaysApprovedKeys 同 patch 共存', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, {
      effort: 'max',
      approvalMode: 'greenlight',
      alwaysApprovedKeys: ['bash:rm-wildcard'],
    });
    const got = await store.getSession(sid);
    expect(got!.effort).toBe('max');
    expect(got!.approvalMode).toBe('greenlight');
    expect(got!.alwaysApprovedKeys).toEqual(['bash:rm-wildcard']);
  });
});

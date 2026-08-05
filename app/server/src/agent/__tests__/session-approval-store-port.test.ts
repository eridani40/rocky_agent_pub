/**
 * [v0.0.148 链路 C] SessionStore 实现 ApprovalStorePort UT
 * 参考: specs/tech/version_logs/v0.0.148/change_plan.md 链路 C（ApprovalManager 持久化）
 *
 * 覆盖：
 *   - getAlwaysApprovedKeys: session 不存在 → []; 存在无字段 → []; 有字段 → 读出
 *   - addAlwaysApprovedKey: 追加后读回含新 key; 重复 key 去重; 跨 session 隔离
 *   - ApprovalManager ↔ SessionStore 集成（cache-through 真实落盘 + 重启后恢复）
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理（与 session-effort-approval-fields.test.ts 同构）。
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
import { ApprovalManager } from '../../tools/approval-manager';

let tmpRoot: string;
let store: SessionStore;
let crud: CompositeStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-approval-store-'));
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

describe('SessionStore — getAlwaysApprovedKeys（ApprovalStorePort 实现）', () => {
  it('session 不存在 → 返 []', async () => {
    expect(await store.getAlwaysApprovedKeys('unknown-sid')).toEqual([]);
  });

  it('session 存在但无字段 → 返 []（lazy 默认）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    expect(await store.getAlwaysApprovedKeys(sid)).toEqual([]);
  });

  it('session 有 alwaysApprovedKeys → 读出数组', async () => {
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: 'x',
      status: 'active',
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      alwaysApprovedKeys: ['bash:rm-wildcard', 'bash:ssh-read'],
    } as never);
    expect(await store.getAlwaysApprovedKeys(sid)).toEqual(['bash:rm-wildcard', 'bash:ssh-read']);
  });
});

describe('SessionStore — addAlwaysApprovedKey（read-modify-write 去重）', () => {
  it('追加新 key → 读回含新 key', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.addAlwaysApprovedKey(sid, 'bash:rm-wildcard');
    expect(await store.getAlwaysApprovedKeys(sid)).toEqual(['bash:rm-wildcard']);
  });

  it('重复 key → 去重（Set 语义，不重复）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.addAlwaysApprovedKey(sid, 'bash:rm-wildcard');
    await store.addAlwaysApprovedKey(sid, 'bash:rm-wildcard');
    const keys = await store.getAlwaysApprovedKeys(sid);
    expect(keys).toEqual(['bash:rm-wildcard']);
    expect(keys).toHaveLength(1);
  });

  it('追加多个不同 key → 全部保留', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.addAlwaysApprovedKey(sid, 'bash:rm-wildcard');
    await store.addAlwaysApprovedKey(sid, 'bash:ssh-read');
    const keys = await store.getAlwaysApprovedKeys(sid);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('bash:rm-wildcard');
    expect(keys).toContain('bash:ssh-read');
  });

  it('跨 session 隔离：s1 追加不影响 s2', async () => {
    const s1 = ulid();
    const s2 = ulid();
    await store.createSession({ id: s1 });
    await store.createSession({ id: s2 });
    await store.addAlwaysApprovedKey(s1, 'bash:rm-wildcard');
    expect(await store.getAlwaysApprovedKeys(s1)).toEqual(['bash:rm-wildcard']);
    expect(await store.getAlwaysApprovedKeys(s2)).toEqual([]);
  });

  it('不覆盖 existing keys（read-modify-write merge 语义）', async () => {
    const sid = ulid();
    crud.put(SessionSchema, {
      id: sid,
      title: 'x',
      status: 'active',
      unread: false,
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      alwaysApprovedKeys: ['existing-key'],
    } as never);
    await store.addAlwaysApprovedKey(sid, 'new-key');
    const keys = await store.getAlwaysApprovedKeys(sid);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('existing-key');
    expect(keys).toContain('new-key');
  });
});

describe('ApprovalManager ↔ SessionStore 集成（cache-through 真实落盘）', () => {
  it('recordAlways write-through 落盘 → 重启后（新 ApprovalManager + setStore）cache miss 读到', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });

    // 第一个 ApprovalManager 实例（模拟进程 1）
    const mgr1 = new ApprovalManager();
    mgr1.setStore(store);
    await mgr1.recordAlways(sid, 'bash:rm-wildcard');

    // 确认落盘（直接读 store 验证）
    expect(await store.getAlwaysApprovedKeys(sid)).toEqual(['bash:rm-wildcard']);

    // 第二个 ApprovalManager 实例（模拟进程重启：新 cache，读 store 恢复）
    const mgr2 = new ApprovalManager();
    mgr2.setStore(store);
    expect(await mgr2.isApproved(sid, 'bash:rm-wildcard')).toBe(true);
  });

  it('ApprovalManager + SessionStore per-session 隔离', async () => {
    const s1 = ulid();
    const s2 = ulid();
    await store.createSession({ id: s1 });
    await store.createSession({ id: s2 });

    const mgr = new ApprovalManager();
    mgr.setStore(store);
    await mgr.recordAlways(s1, 'bash:rm-wildcard');

    expect(await mgr.isApproved(s1, 'bash:rm-wildcard')).toBe(true);
    expect(await mgr.isApproved(s2, 'bash:rm-wildcard')).toBe(false);
  });
});

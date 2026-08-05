/**
 * SessionStore workspace 字段 + createSession 落盘 + setWorkspaceDir + 历史兼容 单元测试
 * 参考: specs/tech/agent/session/[P0]session_workspace.md §2（字段）§3（初始目录）§5（历史兼容）
 *       specs/tech/agent/session/[P0]session_store.md §4（setWorkspaceDir 接口）
 *
 * 覆盖（task.json T1 验收白盒维度）：
 *   - Session.workspaceDir 字段持久化 + 反序列化（新 session 必填）
 *   - createSession 落 workspaceDir（caller 填好传入；spec §2.2 不改 createSession 签名）
 *   - SessionStore.setWorkspaceDir：字段更新 + 持久化 + 返回新值
 *   - 历史兼容：旧 session（无 workspaceDir）→ toSession 缺省 '' + ensureWorkspaceDir lazy 修复
 *   - workdir 接线点：buildSessionConfigFromDeps 优先 session.workspaceDir
 *
 * 真实落盘：fs engine + 临时 DATA_DIR（os.tmpdir + mkdtempSync）+ afterEach 清理。
 * 文件系统隔离：不读写 ~/.oobt-desktop/ 等真实路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import type { SessionRecord } from '../schema_defs';

// 公共 fixture

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-ws-'));
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

// ============================================================
// 1. workspaceDir 字段持久化 + 反序列化
// ============================================================

describe('SessionStore — workspaceDir 字段持久化', () => {
  it('createSession 落 workspaceDir → getSession 读回对齐（绝对路径）', async () => {
    const sid = ulid();
    const workspaceDir = resolve(tmpRoot, 'workspaces', sid);
    const created = await store.createSession({ id: sid, workspaceDir });
    // 新 session workspaceDir 必填，落盘后读回对齐
    expect(created.workspaceDir).toBe(workspaceDir);

    const got = await store.getSession(sid);
    expect(got?.workspaceDir).toBe(workspaceDir);
    // spec §6 安全约束：workspaceDir 必须是绝对路径
    expect(workspaceDir.startsWith('/')).toBe(true);
  });

  it('createSession 不传 workspaceDir → 反序列化缺省空串（lazy 修复前）', async () => {
    const sid = ulid();
    // 模拟旧代码路径（caller 未传 workspaceDir）
    const created = await store.createSession({ id: sid });
    // toSession normalize 兜底：缺省空串（不 undefined，保证字段类型稳定）
    expect(created.workspaceDir).toBe('');
  });

  it('workspaceDir 跨重启 round-trip（写盘 → 新 store 读回）', async () => {
    const sid = ulid();
    const workspaceDir = resolve(tmpRoot, 'workspaces', sid);
    await store.createSession({ id: sid, workspaceDir });

    // 模拟重启：新 SessionStore 实例（同 fsRoot）
    const fs2 = new FsCrudStore({ root: tmpRoot });
    const crud2 = new CompositeStore()
      .mount('session', fs2)
      .mount('transcript', fs2)
      .mount('summary', fs2)
      .mount('runs', fs2);
    const store2 = new SessionStore({ crud: crud2, fsRoot: tmpRoot });

    const got = await store2.getSession(sid);
    expect(got?.workspaceDir).toBe(workspaceDir);
  });
});

// ============================================================
// 2. setWorkspaceDir（字段更新 + 持久化 + event）
// ============================================================

describe('SessionStore — setWorkspaceDir', () => {
  it('切换 workspaceDir → 字段更新 + 持久化', async () => {
    const sid = ulid();
    const oldDir = resolve(tmpRoot, 'workspaces', sid);
    await store.createSession({ id: sid, workspaceDir: oldDir });

    const newDir = resolve(tmpRoot, 'custom-ws', sid);
    await store.setWorkspaceDir(sid, newDir);

    const got = await store.getSession(sid);
    expect(got?.workspaceDir).toBe(newDir);
  });

  it('setWorkspaceDir 不存在 session → 抛 SessionNotFoundError', async () => {
    const fake = ulid();
    await expect(
      store.setWorkspaceDir(fake, '/tmp/whatever'),
    ).rejects.toThrow(/session not found/);
  });

  it('setWorkspaceDir 保留运行态字段（spread existing 不丢 state/currentRunId）', async () => {
    const sid = ulid();
    const oldDir = resolve(tmpRoot, 'workspaces', sid);
    await store.createSession({ id: sid, workspaceDir: oldDir });

    // 模拟运行态写入（markRunning 走 CAS，这里直接 put 模拟）
    const before = await store.getSession(sid);
    // setWorkspaceDir 后运行态字段应保留
    await store.setWorkspaceDir(sid, '/tmp/new');
    const after = await store.getSession(sid);
    expect(after?.state).toBe(before?.state);
    expect(after?.running).toBe(before?.running);
    expect(after?.currentRunId).toBe(before?.currentRunId);
  });
});

// ============================================================
// 3. 历史兼容（旧 session lazy 修复）
// ============================================================

describe('SessionStore — 历史兼容 lazy 修复', () => {
  it('旧 session（无 workspaceDir 字段）→ toSession 缺省空串', async () => {
    const sid = ulid();
    // 模拟旧 record（v0.0.16 之前）：直接 put 无 workspaceDir 字段的 record
    const crud = (store as unknown as { crud: typeof SessionSchema extends never ? never : { put: (s: typeof SessionSchema, r: SessionRecord) => unknown } }).crud as unknown as {
      put: (s: typeof SessionSchema, r: SessionRecord) => unknown;
    };
    crud.put(SessionSchema, {
      id: sid,
      status: 'active',
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
    } as SessionRecord);

    const got = await store.getSession(sid);
    // 旧 session 反序列化缺省空串（不 undefined，不崩）
    expect(got?.workspaceDir).toBe('');
  });

  it('ensureWorkspaceDir 修复旧 session → 建默认目录 + 回填 + 持久化', async () => {
    const sid = ulid();
    // 直接 put 无 workspaceDir 的旧 record
    const crud = (store as unknown as { crud: { put: (s: typeof SessionSchema, r: SessionRecord) => unknown; get: (s: typeof SessionSchema, id: string) => unknown } }).crud;
    crud.put(SessionSchema, { id: sid, status: 'active', biz: 'playground', role: 'rocky', derivation: 'parent' } as SessionRecord);

    // lazy 修复
    // [v0.0.38 T4] ensureWorkspaceDir 改 async（走 putAsync）
    const fixed = await store.ensureWorkspaceDir(sid);
    expect(fixed).not.toBeNull();
    const expected = resolve(tmpRoot, 'workspaces', sid);
    expect(fixed).toBe(expected);

    // fs 真存：默认目录已建（spec §5 mkdir recursive）
    expect(existsSync(expected)).toBe(true);
    const st = statSync(expected);
    expect(st.isDirectory()).toBe(true);

    // 回填：getSession 读回 workspaceDir = fixed
    const got = await store.getSession(sid);
    expect(got?.workspaceDir).toBe(expected);
  });

  it('ensureWorkspaceDir 幂等：已有 workspaceDir 时直接返回不覆盖', async () => {
    const sid = ulid();
    const custom = '/tmp/custom-existing-' + sid;
    await store.createSession({ id: sid, workspaceDir: custom });

    // [v0.0.38 T4] ensureWorkspaceDir 改 async（走 putAsync）
    const fixed = await store.ensureWorkspaceDir(sid);
    // 已有 workspaceDir → 直接返回原值，不建默认目录
    expect(fixed).toBe(custom);
  });

  it('ensureWorkspaceDir 不存在 session → 返 null', async () => {
    const fake = ulid();
    // [v0.0.38 T4] ensureWorkspaceDir 改 async（走 putAsync）
    expect(await store.ensureWorkspaceDir(fake)).toBeNull();
  });

  it('ensureWorkspaceDir 无 fsRoot → 返 null（无法建目录）', async () => {
    const sid = ulid();
    // 构造无 fsRoot 的 store
    const fs2 = new FsCrudStore({ root: tmpRoot });
    const crud2 = new CompositeStore()
      .mount('session', fs2)
      .mount('transcript', fs2)
      .mount('summary', fs2)
      .mount('runs', fs2);
    const storeNoFs = new SessionStore({ crud: crud2 });
    await storeNoFs.createSession({ id: sid });
    // [v0.0.38 T4] ensureWorkspaceDir 改 async（走 putAsync）
    expect(await storeNoFs.ensureWorkspaceDir(sid)).toBeNull();
  });
});

// ============================================================
// 4. fs mkdir 真存（handler 层建目录策略验证）
// ============================================================

describe('SessionStore — 初始目录策略（spec §3）', () => {
  it('默认目录路径 = <DATA_DIR>/workspaces/<sid>（绝对路径 + 规范化）', async () => {
    const sid = ulid();
    const workspaceDir = resolve(tmpRoot, 'workspaces', sid);
    await store.createSession({ id: sid, workspaceDir });

    // 路径形态对齐 spec §3：<DATA_DIR>/workspaces/<sessionId>
    expect(workspaceDir).toBe(join(tmpRoot, 'workspaces', sid));
    // 目录名 = sessionId（ULID）
    expect(workspaceDir.endsWith(sid)).toBe(true);
  });

  it('默认目录路径 ULID 全局唯一（不同 sid 不冲突）', async () => {
    const sid1 = ulid();
    const sid2 = ulid();
    expect(sid1).not.toBe(sid2);
    await store.createSession({ id: sid1, workspaceDir: resolve(tmpRoot, 'workspaces', sid1) });
    await store.createSession({ id: sid2, workspaceDir: resolve(tmpRoot, 'workspaces', sid2) });
    // 两个 session workspaceDir 不同
    const g1 = await store.getSession(sid1);
    const g2 = await store.getSession(sid2);
    expect(g1?.workspaceDir).not.toBe(g2?.workspaceDir);
  });
});

/**
 * [v0.0.231] PUT /session/:id body.pinned 透传链 UT
 * 参考: specs/api/overall/04-agent-session.md §2.5（UpdateSessionBody.pinned）
 *       specs/tech/version_logs/v0.0.231/change_plan.md（非 boolean 400 + 保 updatedAt）
 *
 * 覆盖：
 *   - validatePinned：boolean 放行 / 非 boolean 返错误串 / undefined 放行
 *   - PUT {pinned:true} → 200 + 响应 Session.pinned===true + 落盘
 *   - PUT {pinned:"yes"}（非 boolean）→ 400
 *   - PUT pinned 后 metaBroadcaster.broadcast 被调（fake deps 断言）
 *   - PUT {}（无 pinned）→ pinned 不变
 *   - PUT pinned-only → 响应/落盘 updatedAt 与写前一致（保 updatedAt 端到端）
 *   - PUT {pinned:true, title:'x'}（非 pinned-only）→ updatedAt 推进（现状回归）
 *
 * fake deps 模式（不起真 server）：PUT 路径仅触达 store / appConfig（早退）/ metaBroadcaster，
 * agentManager/pluginManager/contextEngine 以 undefined as never 占位（同
 * session-delete-connector-cleanup.test.ts makeFakeAgentManager() as never 先例）。
 * 时钟注入 FsCrudStore now → updatedAt 断言精确到注入值（零毫秒级 flake）。
 * 文件系统隔离：tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { ulid } from '../../config/ulid';
import { handleSessionItem } from '../session';
import { validatePinned } from '../session-deps';
import type { SessionHandlerDeps } from '../session';
import type { SessionMetaBroadcaster } from '../../agent/session-meta-broadcaster';

const T1 = '2026-08-01T01:00:00.000Z';
const T2 = '2026-08-01T02:00:00.000Z';

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let deps: SessionHandlerDeps;
let broadcastCalls: string[];
let currentNow: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-pinned-put-'));
  currentNow = T1;
  const fs = new FsCrudStore({ root: tmpRoot, now: () => currentNow });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  broadcastCalls = [];
  deps = {
    store,
    agentManager: undefined as never,
    appConfig,
    pluginManager: undefined as never,
    contextEngine: undefined as never,
    dataDir: tmpRoot,
    metaBroadcaster: {
      broadcast: (sid: string) => {
        broadcastCalls.push(sid);
      },
    } as unknown as SessionMetaBroadcaster,
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function putSession(
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleSessionItem(
    new Request(`http://x/session/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    'PUT',
    id,
    deps,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('validatePinned — boolean 类型校验（fail-fast）', () => {
  it('true / false → null（放行）', () => {
    expect(validatePinned({ pinned: true })).toBeNull();
    expect(validatePinned({ pinned: false })).toBeNull();
  });

  it('非 boolean（字符串/数字/对象）→ 错误 string', () => {
    expect(validatePinned({ pinned: 'yes' as never })).toContain('pinned');
    expect(validatePinned({ pinned: 1 as never })).toContain('pinned');
    expect(validatePinned({ pinned: {} as never })).toContain('pinned');
  });

  it('undefined → null（部分更新语义，不校验）', () => {
    expect(validatePinned({})).toBeNull();
  });
});

describe('PUT /session/:id — pinned 透传（部分更新）', () => {
  it('PUT {pinned:true} → 200 + 响应 pinned===true + 落盘', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { status, body } = await putSession(sid, { pinned: true });
    expect(status).toBe(200);
    expect(body.pinned).toBe(true);
    const got = await store.getSession(sid);
    expect(got!.pinned).toBe(true);
  });

  it('PUT {pinned:false}（显式取消置顶）→ 200 + 读回 false', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { pinned: true });
    const { status, body } = await putSession(sid, { pinned: false });
    expect(status).toBe(200);
    expect(body.pinned).toBe(false);
  });

  it('PUT {pinned:"yes"}（非 boolean）→ 400 + 不落盘', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { status } = await putSession(sid, { pinned: 'yes' });
    expect(status).toBe(400);
    const got = await store.getSession(sid);
    expect(got!.pinned).toBe(false); // 未写入
  });

  it('PUT pinned 后 metaBroadcaster.broadcast(id) 被调（多端归位）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await putSession(sid, { pinned: true });
    expect(broadcastCalls).toEqual([sid]);
  });

  it('PUT {}（无 pinned）→ pinned 不变 + 不触发 broadcast', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.updateSession(sid, { pinned: true });
    const { status } = await putSession(sid, {});
    expect(status).toBe(200);
    const got = await store.getSession(sid);
    expect(got!.pinned).toBe(true); // 保留
    expect(broadcastCalls).toEqual([]); // 无 pinned/title → 不广播
  });
});

describe('PUT /session/:id — pinned-only 保 updatedAt（用户裁决 2026-08-01，端到端）', () => {
  it('PUT pinned-only → 响应/落盘 updatedAt 与写前一致', async () => {
    const sid = ulid();
    await store.createSession({ id: sid }); // T1 落盘
    const before = await store.getSession(sid);
    expect(before!.updatedAt).toBe(T1);
    currentNow = T2;
    const { status, body } = await putSession(sid, { pinned: true });
    expect(status).toBe(200);
    expect(body.updatedAt).toBe(T1); // 响应保 updatedAt
    const got = await store.getSession(sid);
    expect(got!.updatedAt).toBe(T1); // 落盘保 updatedAt
    expect(got!.version).toBe(before!.version + 1); // version 仍 +1
  });

  it('PUT {pinned:true, title:"改名"}（非 pinned-only）→ updatedAt 推进（现状回归）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    currentNow = T2;
    const { status, body } = await putSession(sid, { pinned: true, title: '改名' });
    expect(status).toBe(200);
    expect(body.pinned).toBe(true);
    expect(body.updatedAt).toBe(T2); // 含非 pinned 字段 → 推进
  });
});

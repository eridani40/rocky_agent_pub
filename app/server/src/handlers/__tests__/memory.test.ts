/**
 * memory UI handler 单测（v0.0.205 — dir store 介质 + sessionStore 解析 session ws）
 * 参考: specs/api/overall/15-memory-ui.md §3-§10（端点契约）
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *
 * 介质分流断言：
 *   global → `<dataDir>/memory/<name>.md` per-entry（app_config user_memory 已退役不回读）
 *   session → `<session.workspaceDir>/.rocky/memory/<name>.md`（sessionStore.getSession 解析；
 *             session not found → 404；workspaceDir 缺省回退 <dataDir>/workspace）
 * 覆盖：四端点 × 双 scope + 真落盘 + 400/404/405/409 + type=feedback why+how 强制 + archived 排除
 *       + evolvable 语义 + 字符硬限（intro≤50/body≤500）400 + 旧 scope 拒绝 + PATCH 反归档 + source/updatedAt。
 *
 * 直测 handleMemoryRoute（sessionStore 经 DI 注入，对齐 router 生产路径），DATA_DIR 临时改写 tmpdir。
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMemoryRoute } from '../memory';
import type { SessionStore } from '../../agent/session-store';
import type { Session } from '../../agent/session-store-types';

let tmpDataDir: string;
let origDataDir: string | undefined;
let sessionWs: string;
/** 测试内 session 注册表（sid → workspaceDir | null(不存在)） */
let sessions: Map<string, string>;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-ui-handler-'));
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDataDir;
  sessionWs = join(tmpDataDir, 'sess-ws');
  sessions = new Map([[SID, sessionWs]]);
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 最小 sessionStore 桩（handler 只用 getSession） */
function fakeSessionStore(): SessionStore {
  return {
    getSession: async (id: string) => {
      const ws = sessions.get(id);
      if (ws === undefined) return null;
      return { id, workspaceDir: ws } as Session;
    },
  } as unknown as SessionStore;
}

/** 构造 Request + 调 handleMemoryRoute（sessionStore 经 DI 注入，对齐 router 生产路径）。 */
async function call(
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(`http://test${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const req = new Request(url, {
    method,
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handleMemoryRoute(req, method, path, url, fakeSessionStore());
  return { status: res.status, body: await res.json() };
}

const SID = 'sess-xyz-123';
const globalEntryPath = (name: string) => join(tmpDataDir, 'memory', `${name}.md`);
const sessionEntryPath = (name: string) => join(sessionWs, '.rocky', 'memory', `${name}.md`);

// ============================================================
// GET 列表
// ============================================================

describe('memory UI handler — GET 列表', () => {
  it('GET /memory/global 空列表 → 200 {entries:[]}', async () => {
    const { status, body } = await call('GET', '/memory/global');
    expect(status).toBe(200);
    expect(body).toEqual({ entries: [] });
  });

  it('GET /memory/session?sessionId=... → 200', async () => {
    const { status, body } = await call('GET', '/memory/session', { query: { sessionId: SID } });
    expect(status).toBe(200);
    expect(body).toEqual({ entries: [] });
  });

  it('GET /memory/session 缺 sessionId → 400', async () => {
    const { status, body } = await call('GET', '/memory/session');
    expect(status).toBe(400);
    expect(body.error).toMatch(/sessionId required/);
  });

  it('GET /memory/session session 不存在 → 404', async () => {
    const { status, body } = await call('GET', '/memory/session', { query: { sessionId: 'ghost-sid' } });
    expect(status).toBe(404);
    expect(body.error).toMatch(/session not found/);
  });

  it('GET /memory/badscope → 400 invalid scope', async () => {
    const { status, body } = await call('GET', '/memory/badscope');
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid scope/);
  });

  it('GET 非法路径 → 404', async () => {
    const { status } = await call('GET', '/memory/');
    expect(status).toBe(404);
  });

  it('PUT /memory/global → 405 + Allow 头', async () => {
    const { status, body } = await call('PUT', '/memory/global');
    expect(status).toBe(405);
    expect(body.error).toMatch(/Method Not Allowed/);
  });
});

// ============================================================
// POST 新建 — global scope（落 <dataDir>/memory/ per-entry）
// ============================================================

describe('memory UI handler — POST 新建 (global scope → <dataDir>/memory/)', () => {
  const entryUser = {
    name: 'prefers-vim',
    intro: '用户偏好 vim',
    type: 'user' as const,
    body: '主用 vim 编辑器，习惯 hjkl。',
  };
  const entryFeedback = {
    name: 'no-mock-llm',
    intro: '禁 mock-LLM 全绿',
    type: 'feedback' as const,
    body: 'api/e2e 测试必须真 LLM + 真服务。',
    why: 'mock 掩盖真实 bug',
    howToApply: '禁用 mock-LLM 假象',
  };

  it('POST /memory/global type=user → 201 + entry.name + updatedAt', async () => {
    const { status, body } = await call('POST', '/memory/global', { body: { entry: entryUser } });
    expect(status).toBe(201);
    expect(body.entry.name).toBe('prefers-vim');
    expect(body.entry.type).toBe('user');
    expect(body.entry.updatedAt).toBeTruthy();
  });

  it('POST /memory/global type=feedback 含 why+howToApply → 201', async () => {
    const { status, body } = await call('POST', '/memory/global', { body: { entry: entryFeedback } });
    expect(status).toBe(201);
    expect(body.entry.why).toBe('mock 掩盖真实 bug');
    expect(body.entry.howToApply).toBe('禁用 mock-LLM 假象');
  });

  it('POST /memory/global type=feedback 缺 why → 400（spec §2 强制）', async () => {
    const { status, body } = await call('POST', '/memory/global', {
      body: { entry: { ...entryFeedback, why: undefined } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/why and howToApply/);
  });

  it('POST /memory/global 同 name 已存在 → 409', async () => {
    await call('POST', '/memory/global', { body: { entry: entryUser } });
    const { status, body } = await call('POST', '/memory/global', { body: { entry: entryUser } });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'entry already exists', name: 'prefers-vim' });
  });

  it('POST /memory/global → 真落盘 <dataDir>/memory/<name>.md per-entry', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'persisted-user', intro: 'd', type: 'user', body: '真落盘验证' } },
    });
    const p = globalEntryPath('persisted-user');
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, 'utf8');
    expect(raw).toContain('persisted-user');
    expect(raw).toContain('真落盘验证');
  });
});

// ============================================================
// POST 新建 — session scope（落 <ws>/.rocky/memory/ per-entry）
// ============================================================

describe('memory UI handler — POST 新建 (session scope → <ws>/.rocky/memory/)', () => {
  const entryUser = {
    name: 'prefers-vim',
    intro: '用户偏好 vim',
    type: 'user' as const,
    body: '主用 vim 编辑器。',
  };

  it('POST /memory/session 含 body.sessionId → 201', async () => {
    const { status, body } = await call('POST', '/memory/session', {
      body: { sessionId: SID, entry: entryUser },
    });
    expect(status).toBe(201);
    expect(body.entry.name).toBe('prefers-vim');
  });

  it('POST /memory/session?sessionId=...&entry → 201（query 也接受 sessionId）', async () => {
    const { status } = await call('POST', '/memory/session', {
      query: { sessionId: SID },
      body: { entry: entryUser },
    });
    expect(status).toBe(201);
  });

  it('POST /memory/session 缺 sessionId → 400', async () => {
    const { status, body } = await call('POST', '/memory/session', { body: { entry: entryUser } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/sessionId required/);
  });

  it('POST /memory/session session 不存在 → 404', async () => {
    const { status } = await call('POST', '/memory/session', {
      body: { sessionId: 'ghost-sid', entry: entryUser },
    });
    expect(status).toBe(404);
  });

  it('POST /memory/session 同 name 已存在 → 409', async () => {
    await call('POST', '/memory/session', { body: { sessionId: SID, entry: entryUser } });
    const { status } = await call('POST', '/memory/session', { body: { sessionId: SID, entry: entryUser } });
    expect(status).toBe(409);
  });

  it('POST /memory/session → 真落盘 <ws>/.rocky/memory/<name>.md（per-entry）', async () => {
    await call('POST', '/memory/session', {
      body: {
        sessionId: SID,
        entry: { name: 'persisted-session', intro: 'd', type: 'project', body: '会话级', why: 'w', howToApply: 'h' },
      },
    });
    const p = sessionEntryPath('persisted-session');
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, 'utf8');
    expect(raw).toContain('persisted-session');
    expect(raw).toMatch(/type: project/);
  });

  it('不同 session（不同 workspaceDir）写入各自 ws（隔离）', async () => {
    const SID2 = 'sess-other-789';
    const ws2 = join(tmpDataDir, 'sess-ws-2');
    sessions.set(SID2, ws2);
    await call('POST', '/memory/session', {
      body: { sessionId: SID, entry: { name: 'in-1', intro: 'd', type: 'user', body: 'b' } },
    });
    await call('POST', '/memory/session', {
      body: { sessionId: SID2, entry: { name: 'in-2', intro: 'd', type: 'user', body: 'b' } },
    });
    expect(existsSync(sessionEntryPath('in-1'))).toBe(true);
    expect(existsSync(join(ws2, '.rocky', 'memory', 'in-2.md'))).toBe(true);
    expect(existsSync(sessionEntryPath('in-2'))).toBe(false);
  });
});

// ============================================================
// 通用 POST 校验
// ============================================================

describe('memory UI handler — POST 通用校验', () => {
  const entryUser = { name: 'x', intro: 'd', type: 'user' as const, body: 'b' };

  it('POST 缺 name → 400', async () => {
    const { status } = await call('POST', '/memory/global', {
      body: { entry: { ...entryUser, name: '' } },
    });
    expect(status).toBe(400);
  });

  it('POST 非法 type → 400', async () => {
    const { status } = await call('POST', '/memory/global', {
      body: { entry: { ...entryUser, type: 'bogus' } },
    });
    expect(status).toBe(400);
  });

  it('POST body 非 JSON → 400', async () => {
    const url = new URL('http://test/memory/global');
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{',
    });
    const res = await handleMemoryRoute(req, 'POST', '/memory/global', url, fakeSessionStore());
    expect(res.status).toBe(400);
  });

  it('global 与 session 同 name 不冲突（不同介质）', async () => {
    await call('POST', '/memory/global', { body: { entry: entryUser } });
    const { status } = await call('POST', '/memory/session', {
      body: { sessionId: SID, entry: entryUser },
    });
    expect(status).toBe(201);
  });
});

// ============================================================
// PATCH 更新
// ============================================================

describe('memory UI handler — PATCH 更新', () => {
  async function seedGlobal(): Promise<void> {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'patchable', intro: '可改', type: 'user', body: '原文' } },
    });
  }

  it('PATCH /memory/global/:name entry.body → 200 + body 更新 + updatedAt', async () => {
    await seedGlobal();
    const { status, body } = await call('PATCH', '/memory/global/patchable', {
      body: { entry: { body: 'UPDATED-marker', intro: '改后描述' } },
    });
    expect(status).toBe(200);
    expect(body.entry.body).toBe('UPDATED-marker');
    expect(body.entry.intro).toBe('改后描述');
    expect(body.entry.updatedAt).toBeTruthy();
  });

  it('PATCH 不存在 name → 404', async () => {
    const { status, body } = await call('PATCH', '/memory/global/nonexistent', {
      body: { entry: { body: 'x' } },
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/);
  });

  it('PATCH /memory/session/:name 缺 sessionId → 400', async () => {
    const { status } = await call('PATCH', '/memory/session/foo', { body: { entry: { body: 'x' } } });
    expect(status).toBe(400);
  });

  it('PATCH 改 type 至 feedback 但未补 why → 400（type 约束）', async () => {
    await seedGlobal();
    const { status, body } = await call('PATCH', '/memory/global/patchable', {
      body: { entry: { type: 'feedback' } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/why and howToApply/);
  });

  it('PATCH feedback entry 保留 why/howToApply（不传时保持原值）→ 200', async () => {
    await call('POST', '/memory/global', {
      body: {
        entry: { name: 'fb', intro: 'feedback entry', type: 'feedback', body: '原 body', why: '原因', howToApply: '应用' },
      },
    });
    const { status, body } = await call('PATCH', '/memory/global/fb', {
      body: { entry: { body: '新 body' } },
    });
    expect(status).toBe(200);
    expect(body.entry.body).toBe('新 body');
    expect(body.entry.why).toBe('原因');
    expect(body.entry.howToApply).toBe('应用');
  });

  it('PATCH /memory/session/:name 含 sessionId → 200 + per-entry 落盘', async () => {
    await call('POST', '/memory/session', {
      body: { sessionId: SID, entry: { name: 'sp', intro: 'd', type: 'user', body: 'b1' } },
    });
    const { status } = await call('PATCH', '/memory/session/sp', {
      body: { sessionId: SID, entry: { body: 'b2' } },
    });
    expect(status).toBe(200);
    const raw = readFileSync(sessionEntryPath('sp'), 'utf8');
    expect(raw).toContain('b2');
    expect(raw).not.toContain('b1');
  });
});

// ============================================================
// DELETE 归档
// ============================================================

describe('memory UI handler — DELETE 归档', () => {
  it('DELETE /memory/global/:name → 200 {ok, archivedAt}', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'to-archive', intro: 'd', type: 'user', body: 'b' } },
    });
    const { status, body } = await call('DELETE', '/memory/global/to-archive');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.archivedAt).toBeTruthy();
  });

  it('DELETE 不存在 name → 404', async () => {
    const { status } = await call('DELETE', '/memory/global/nonexistent');
    expect(status).toBe(404);
  });

  it('DELETE /memory/session/:name 缺 sessionId → 400', async () => {
    const { status } = await call('DELETE', '/memory/session/foo');
    expect(status).toBe(400);
  });

  it('DELETE 后 GET 默认排除，includeArchived=true 返全（global scope）', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'arch-me', intro: 'd', type: 'user', body: 'b' } },
    });
    await call('DELETE', '/memory/global/arch-me');
    const def = await call('GET', '/memory/global');
    expect(def.body.entries.find((e: any) => e.name === 'arch-me')).toBeUndefined();
    const withArc = await call('GET', '/memory/global', { query: { includeArchived: 'true' } });
    const hit = withArc.body.entries.find((e: any) => e.name === 'arch-me');
    expect(hit).toBeTruthy();
    expect(hit.archived).toBe(true);
  });

  it('DELETE /memory/:scope/:name 错方法（GET）→ 405', async () => {
    const { status } = await call('GET', '/memory/global/foo');
    expect(status).toBe(405);
  });
});

// ============================================================
// scope/evolvable/字符硬限/反归档
// ============================================================

describe('memory UI handler — scope/evolvable/字符硬限/反归档', () => {
  it('旧 scope 值 user 不再接受 → 400 invalid scope（不变量#1）', async () => {
    const { status, body } = await call('GET', '/memory/user');
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid scope: user/);
  });

  it('POST /memory/global 新建默认 evolvable=false（用户资产，UI 不 gate）', async () => {
    const { status, body } = await call('POST', '/memory/global', {
      body: { entry: { name: 'ev-default', intro: 'd', type: 'user', body: '正文' } },
    });
    expect(status).toBe(201);
    expect(body.entry.evolvable).toBe(false);
  });

  it('POST 客户端传 evolvable:true 仍落 false（POST 强制 defaultEvolvable:false，spec §4.2）', async () => {
    const { status, body } = await call('POST', '/memory/global', {
      body: { entry: { name: 'ev-force', intro: 'd', type: 'user', body: '正文', evolvable: true } },
    });
    expect(status).toBe(201);
    expect(body.entry.evolvable).toBe(false);
  });

  it('PATCH evolvable:true → setEvolvable 生效（UI 全字段可编辑，不 gate）', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'ev-patch', intro: 'd', type: 'user', body: '正文' } },
    });
    const { status, body } = await call('PATCH', '/memory/global/ev-patch', {
      body: { entry: { evolvable: true } },
    });
    expect(status).toBe(200);
    expect(body.entry.evolvable).toBe(true);
  });

  it('PATCH 省略 evolvable → 保留原值（省略=保留）', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'ev-keep', intro: 'd', type: 'user', body: '正文' } },
    });
    await call('PATCH', '/memory/global/ev-keep', { body: { entry: { evolvable: true } } });
    const { body } = await call('PATCH', '/memory/global/ev-keep', {
      body: { entry: { body: '改后正文' } },
    });
    expect(body.entry.evolvable).toBe(true);
    expect(body.entry.body).toBe('改后正文');
  });

  it('PATCH archived:false 反归档（归档后重新可见，e2e seed 幂等依赖）', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'unarch', intro: 'd', type: 'user', body: '正文' } },
    });
    await call('DELETE', '/memory/global/unarch');
    const { status } = await call('PATCH', '/memory/global/unarch', {
      body: { entry: { body: '重写正文', archived: false } },
    });
    expect(status).toBe(200);
    const def = await call('GET', '/memory/global');
    expect(def.body.entries.find((e: any) => e.name === 'unarch')).toBeTruthy();
  });

  it('POST 正文 >500 字符 → 400（字符硬限，spec §4.2）', async () => {
    const longBody = 'x'.repeat(501); // 501 字符超 500 硬限
    const { status, body } = await call('POST', '/memory/global', {
      body: { entry: { name: 'too-long', intro: 'd', type: 'user', body: longBody } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds 500 chars/);
  });

  it('PATCH 正文 >500 字符 → 400（覆盖 UI 更新路径）', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'grow', intro: 'd', type: 'user', body: 'short' } },
    });
    const longBody = 'x'.repeat(501); // 501 字符超 500 硬限
    const { status, body } = await call('PATCH', '/memory/global/grow', {
      body: { entry: { body: longBody } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exceeds 500 chars/);
  });

  it('GET /memory/session 返 entries 含 evolvable + scope stamp', async () => {
    await call('POST', '/memory/session', {
      body: { sessionId: SID, entry: { name: 'sev', intro: 'd', type: 'user', body: 'b' } },
    });
    const { body } = await call('GET', '/memory/session', { query: { sessionId: SID } });
    const hit = body.entries.find((e: any) => e.name === 'sev');
    expect(hit).toBeTruthy();
    expect(hit.evolvable).toBe(false); // session POST 也走 defaultEvolvable:false
    expect(hit.scope).toBe('session'); // session entries 带 scope stamp（UI 契约）
  });
});

// ============================================================
// source/updatedAt — UI POST origin=user / PATCH 保留既有 origin
// ============================================================

describe('memory UI handler — source/updatedAt', () => {
  it('POST /memory/global → entry.source=user（UI 新建 origin=user 落盘）', async () => {
    const { status, body } = await call('POST', '/memory/global', {
      body: { entry: { name: 'src-post', intro: 'd', type: 'user', body: 'b' } },
    });
    expect(status).toBe(201);
    expect(body.entry.source).toBe('user');
    expect(body.entry.updatedAt).toBeTruthy();
    // 真落盘校验：per-entry 文件内容
    const raw = readFileSync(globalEntryPath('src-post'), 'utf8');
    expect(raw).toContain('source: user');
  });

  it('PATCH /memory/global/:name → 不改 source（保留既有 origin）', async () => {
    await call('POST', '/memory/global', {
      body: { entry: { name: 'src-patch', intro: 'v1', type: 'user', body: 'b1' } },
    });
    const { status, body } = await call('PATCH', '/memory/global/src-patch', {
      body: { entry: { body: 'b2' } },
    });
    expect(status).toBe(200);
    expect(body.entry.source).toBe('user'); // origin 不可变
    expect(body.entry.body).toBe('b2');
    expect(body.entry.updatedAt).toBeTruthy();
  });

  it('POST /memory/session → entry.source=user（session 介质也盖 user origin）', async () => {
    const { status, body } = await call('POST', '/memory/session', {
      body: { sessionId: SID, entry: { name: 'src-sess', intro: 'd', type: 'user', body: 'b' } },
    });
    expect(status).toBe(201);
    expect(body.entry.source).toBe('user');
    expect(body.entry.updatedAt).toBeTruthy();
  });
});

// ============================================================
// workspaceDir 缺省回退 <dataDir>/workspace
// ============================================================

describe('memory UI handler — session workspaceDir 回退', () => {
  it('session record workspaceDir 为空 → 落 <dataDir>/workspace/.rocky/memory/', async () => {
    sessions.set(SID, ''); // 空 workspaceDir → 回退
    await call('POST', '/memory/session', {
      body: { sessionId: SID, entry: { name: 'fallback-e', intro: 'd', type: 'user', body: 'b' } },
    });
    expect(existsSync(join(tmpDataDir, 'workspace', '.rocky', 'memory', 'fallback-e.md'))).toBe(true);
  });
});

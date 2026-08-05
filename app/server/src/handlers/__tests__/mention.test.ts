/**
 * mention handler 单测 —— GET /mention/search 参数校验 + 错误码 + 成功（v0.0.45 T2）
 * 参考: specs/api/mention/GET-search.md（端点契约）
 *
 * 覆盖：
 *   - 缺 provider → 400
 *   - 缺 query → 400
 *   - 缺 sessionId → 400
 *   - limit 超范围 → 400
 *   - session 不存在 → 404
 *   - provider 未注册 → 404
 *   - 成功 200 + items + nextCursor
 *   - 非 GET → 405
 *
 * 走真实 router + bootstrap（tmpdir），确保 router 分发 + handler 集成。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../../router';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-mention-handler-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造最小可用 providers 配置（router bootstrap 时 AppConfigService 读） */
function writeAppConfig(dataDir: string): void {
  const providersDir = join(dataDir, 'app_config', 'providers', 'app_config');
  mkdirSync(providersDir, { recursive: true });
  writeFileSync(
    join(providersDir, 'p1.json'),
    JSON.stringify({
      id: 'p1',
      group: 'providers',
      key: 'p1',
      data: {
        id: 'p1',
        name: 'mock',
        kind: 'mock',
        enabled: true,
        credentials: {},
        models: [{ modelId: 'm1', contextWindow: 100000 }],
      },
    }),
  );
  mkdirSync(join(dataDir, 'dev_config'), { recursive: true });
}

/** 直连 store 创建 session */
async function createSession(
  dataDir: string,
  opts: { id?: string; workspaceDir?: string; type?: string; bizType?: string } = {},
): Promise<{ store: SessionStore; sid: string }> {
  const fs = new FsCrudStore({ root: dataDir });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: dataDir });
  const sid = opts.id ?? ulid();
  await store.createSession({
    id: sid,
    title: 'test',
    workspaceDir: opts.workspaceDir ?? join(dataDir, 'workspaces', sid),
    ...(opts.type ? { type: opts.type as any } : {}),
    ...(opts.bizType ? { bizType: opts.bizType as any } : {}),
  });
  return { store, sid };
}

/** 解析 Response body 为 JSON */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// 参数校验 400
// ============================================================

describe('GET /mention/search — 参数校验', () => {
  it('缺 provider → 400', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    const res = await handleRequest(
      new Request(`http://x/mention/search?query=test&sessionId=${sid}`, { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toContain('provider');
  });

  it('缺 query → 400', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    const res = await handleRequest(
      new Request(`http://x/mention/search?provider=file&sessionId=${sid}`, { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toContain('query');
  });

  it('缺 sessionId → 400', async () => {
    writeAppConfig(tmpRoot);
    const res = await handleRequest(
      new Request('http://x/mention/search?provider=file&query=test', { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toContain('sessionId');
  });

  it('limit < 1 → 400', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    const res = await handleRequest(
      new Request(
        `http://x/mention/search?provider=file&query=test&sessionId=${sid}&limit=0`,
        { method: 'GET' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toContain('limit');
  });

  it('limit > 100 → 400', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    const res = await handleRequest(
      new Request(
        `http://x/mention/search?provider=file&query=test&sessionId=${sid}&limit=101`,
        { method: 'GET' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toContain('limit');
  });

  it('query=空串 不报 400（允许空串搜索）', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    const res = await handleRequest(
      new Request(
        `http://x/mention/search?provider=file&query=&sessionId=${sid}`,
        { method: 'GET' },
      ),
      tmpRoot,
    );
    // 空串 query 是合法的（搜全部）；不应返回 400
    expect(res.status).not.toBe(400);
  });
});

// ============================================================
// 错误码 404
// ============================================================

describe('GET /mention/search — 404', () => {
  it('session 不存在 → 404', async () => {
    writeAppConfig(tmpRoot);
    const res = await handleRequest(
      new Request(
        'http://x/mention/search?provider=file&query=test&sessionId=nonexistent-sid',
        { method: 'GET' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(404);
    const b = await body(res);
    expect(b.error).toContain('session not found');
  });

  it('provider 未注册 → 404', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    const res = await handleRequest(
      new Request(
        `http://x/mention/search?provider=nonexistent&query=test&sessionId=${sid}`,
        { method: 'GET' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(404);
    const b = await body(res);
    expect(b.error).toContain('unknown provider');
  });
});

// ============================================================
// 成功 200
// ============================================================

describe('GET /mention/search — 200', () => {
  it('成功搜索 → 200 + items 数组', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    // 使用已注册的 provider（bootstrap-mention 注册了 'file' 和 'skill'）
    const res = await handleRequest(
      new Request(
        `http://x/mention/search?provider=file&query=&sessionId=${sid}`,
        { method: 'GET' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(Array.isArray(b.items)).toBe(true);
  });

  it('limit 参数透传（不报 400）', async () => {
    writeAppConfig(tmpRoot);
    const { sid } = await createSession(tmpRoot);
    const res = await handleRequest(
      new Request(
        `http://x/mention/search?provider=file&query=test&sessionId=${sid}&limit=5`,
        { method: 'GET' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(200);
  });
});

// ============================================================
// 405 方法不允许
// ============================================================

describe('GET /mention/search — 405', () => {
  it('POST /mention/search → 405', async () => {
    writeAppConfig(tmpRoot);
    const res = await handleRequest(
      new Request('http://x/mention/search', { method: 'POST' }),
      tmpRoot,
    );
    expect(res.status).toBe(405);
  });
});

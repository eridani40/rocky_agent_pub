/**
 * session-abort + messages-cancel + Session state 字段 + 移除 409 UT（v0.0.12 task t4）
 * 参考: specs/api/overall/04-agent-session.md §2.1 §2.3 §3.2 §3.3 §3.4
 *       states/v0.0.12/design.md 板块 4 / 5 / 3.4
 *
 * 覆盖：
 *   - Session 响应含 state/running/currentRunId 字段（GET /session/:id + GET /session）
 *   - POST /session/:id/abort → 202 {ok:true}；幂等（session 无活跃 run 仍 202）
 *   - POST /session/:id/messages/:enqueueId/cancel → 202 {ok:true}；404 session 不存在
 *   - POST /session/:id/messages 不再返 409（running 时 enqueue 排队）
 *
 * 走真实 router + bootstrap（fs engine + tmpdir），确保 router 分发 + handler 集成。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../../router';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema,
  MessageSchema,
  SummarySchema,
  RunSchema,
} from '../../agent/schema_defs';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-abort-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 构造最小可用 providers 配置（router bootstrap 时 AppConfigService 读）。
 * KV-sharded：记录形如 { id, group, key, data }；落盘 {root}/app_config/providers/app_config/<id>.json。
 * data 字段含 ProviderInstance（id/name/kind/enabled/credentials/models）。
 */
function writeAppConfig(dataDir: string): void {
  const fs = require('node:fs');
  const path = require('node:path');
  const providersDir = path.join(dataDir, 'app_config', 'providers', 'app_config');
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(
    path.join(providersDir, 'p1.json'),
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
  // [v0.0.89 工作块 ③] resolveModel 不静默兜底（PRD §5.1）。
  //   POST /messages handler 不再调 resolveProviderModel；deliverTo 内部 resolveModel 走
  //   chat fallback 链需 default_models.chat 命中 m1（本测试聚焦 abort 流程，不验 model 解析）。
  const dmDir = path.join(dataDir, 'app_config', 'default_models', 'app_config');
  fs.mkdirSync(dmDir, { recursive: true });
  fs.writeFileSync(
    path.join(dmDir, 'default.json'),
    JSON.stringify({
      id: 'default',
      group: 'default_models',
      key: 'default',
      data: { chat: 'm1', summary: 'm1' },
    }),
  );
  fs.mkdirSync(path.join(dataDir, 'dev_config'), { recursive: true });
}

/** 直连 store 创建 session（绕开 router，便于预设状态） */
async function createSessionViaStore(
  dataDir: string,
  sid: string,
): Promise<void> {
  const fs = new FsCrudStore({ root: dataDir });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: dataDir });
  await store.createSession({ id: sid, title: 'test' });
}

/** 解析 Response body 为 JSON */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// Session 响应含 state/running/currentRunId（api §2.1 §2.3）
// ============================================================

describe('Session 响应 — state/running/currentRunId 字段', () => {
  it('GET /session/:id 含 state（idle）/ running（false）/ currentRunId（null）', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}`, { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(200);
    const s = await body(res);
    expect(s.state).toBe('idle');
    expect(s.running).toBe(false);
    expect(s.currentRunId).toBeNull();
  });

  it('GET /session 列表项含 state/running/currentRunId 字段', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);

    const res = await handleRequest(
      new Request('http://x/session', { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(200);
    const { items } = await body(res);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const target = items.find((s: any) => s.id === sid);
    expect(target).toBeTruthy();
    expect(target.state).toBe('idle');
    expect(target.running).toBe(false);
    expect(target.currentRunId).toBeNull();
  });
});

// ============================================================
// POST /session/:id/abort
// ============================================================

describe('POST /session/:id/abort — 202 + 幂等', () => {
  it('session 无活跃 run → 仍 202（fire-and-forget 幂等）', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/abort`, { method: 'POST' }),
      tmpRoot,
    );
    expect(res.status).toBe(202);
    const b = await body(res);
    expect(b.ok).toBe(true);
  });

  it('404 session 不存在 → 404', async () => {
    writeAppConfig(tmpRoot);
    const res = await handleRequest(
      new Request(`http://x/session/${ulid()}/abort`, { method: 'POST' }),
      tmpRoot,
    );
    expect(res.status).toBe(404);
  });

  it('GET 非 POST → 405 + Allow: POST', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);
    const res = await handleRequest(
      new Request(`http://x/session/${sid}/abort`, { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

// ============================================================
// POST /session/:id/messages/:enqueueId/cancel
// ============================================================

describe('POST /session/:id/messages/:enqueueId/cancel — 202', () => {
  it('任意 enqueueId → 202 {ok:true}（fire-and-forget，不查存在）', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);

    const res = await handleRequest(
      new Request(
        `http://x/session/${sid}/messages/01TEST_ENQUEUE/cancel`,
        { method: 'POST' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(202);
    const b = await body(res);
    expect(b.ok).toBe(true);
  });

  it('404 session 不存在 → 404', async () => {
    writeAppConfig(tmpRoot);
    const res = await handleRequest(
      new Request(
        `http://x/session/${ulid()}/messages/01ANY/cancel`,
        { method: 'POST' },
      ),
      tmpRoot,
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// POST /session/:id/messages — 移除 409（running 时 enqueue 排队）
// ============================================================

describe('POST /session/:id/messages — running 时不再返 409', () => {
  it('provider/model 校验通过即 enqueue + activate，返 202 {runId}', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
      tmpRoot,
    );
    // 响应应 202（接受），runId 非空。绝不返 409。
    expect(res.status).toBe(202);
    const b = await body(res);
    expect(typeof b.runId).toBe('string');
    expect(b.runId.length).toBeGreaterThan(0);
  });
});

// ============================================================
// v0.0.15：activate=false 测试专用守卫（仅 NODE_ENV=test 生效）
// ============================================================

describe('POST /session/:id/messages — activate=false 测试专用守卫', () => {
  it('activate=false + NODE_ENV=test → 返 202 + runId="" + enqueueId 非空（消息留 inbox 不 drain）', async () => {
    // vitest 默认设 NODE_ENV=test（已在 _tmp_env.test.ts 验证）
    expect(process.env.NODE_ENV).toBe('test');
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: 'queued-msg', activate: false }),
      }),
      tmpRoot,
    );
    expect(res.status).toBe(202);
    const b = await body(res);
    // skipActivate：runId 空（未启动 run）
    expect(b.runId).toBe('');
    // enqueueId 非空（消息已入 inbox，可立即用于 cancel）
    expect(typeof b.enqueueId).toBe('string');
    expect(b.enqueueId.length).toBeGreaterThan(0);

    // session 应保持 idle（未 activate）
    const sres = await handleRequest(
      new Request(`http://x/session/${sid}`, { method: 'GET' }),
      tmpRoot,
    );
    const s = await body(sres);
    expect(s.state).toBe('idle');
    expect(s.running).toBe(false);
  });

  it('activate=false 在生产环境（NODE_ENV≠test）应被忽略，仍 activate', async () => {
    // 临时清除 NODE_ENV 模拟生产
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      writeAppConfig(tmpRoot);
      const sid = ulid();
      await createSessionViaStore(tmpRoot, sid);

      const res = await handleRequest(
        new Request(`http://x/session/${sid}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: 'should-activate', activate: false }),
        }),
        tmpRoot,
      );
      expect(res.status).toBe(202);
      const b = await body(res);
      // 生产忽略 activate=false：runId 非空（已启动 run）
      expect(typeof b.runId).toBe('string');
      expect(b.runId.length).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

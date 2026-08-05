/**
 * subagent 只读会话 403 拒绝 UT（v0.0.28 task-1）
 * 参考: specs/api/overall/10-multi-agent.md §4.2（POST /messages 拒绝 user-source）
 *       §4.3（abort/clear 对 subagent 同拒 403 subagent_readonly）
 *       states/v0.0.28/task.json tasks[0] acceptance「subagent 403 拒绝」
 *
 * 覆盖 3 端点 × subagent/非 subagent 两种 session：
 *   - POST /session/:id/messages   → subagent 403 subagent_readonly / 非 subagent 正常路径
 *   - POST /session/:id/abort      → subagent 403 / 非 subagent 202
 *   - POST /session/:id/clear      → subagent 403 / 非 subagent 200
 *
 * [v0.0.54] compact 已从 readonly 拒绝清单移除——subagent 允许 compact（长跑上下文也会爆炸），
 *           见 specs/api/overall/04-agent-session.md §7。subagent→202 放行测在
 *           handlers-session-compact.test.ts 覆盖，故本文件不再测 compact。
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

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-subagent-403-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * 构造最小可用 providers 配置（router bootstrap 时 AppConfigService 读）。
 * 与 session-abort.test.ts 同形态。
 */
function writeAppConfig(dataDir: string): void {
  const fs = require('node:fs');
  const path = require('node:path');
  const providersDir = path.join(dataDir, 'app_config', 'providers', 'app_config');
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(
    path.join(providersDir, 'p1.json'),
    JSON.stringify({
      id: 'p1', group: 'providers', key: 'p1',
      data: {
        id: 'p1', name: 'mock', kind: 'mock', enabled: true, credentials: {},
        models: [{ modelId: 'm1', contextWindow: 100000 }],
      },
    }),
  );
  fs.mkdirSync(path.join(dataDir, 'dev_config'), { recursive: true });
}

/** 直连 store 创建 subagent session（绕开 router，直接落 5 字段） */
async function createSubagentSession(
  dataDir: string,
  sid: string,
  parentSid: string,
): Promise<void> {
  const fs = new FsCrudStore({ root: dataDir });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: dataDir });
  await store.createSession({
    id: sid,
    title: 'subagent',
    parentSessionId: parentSid,
    derivation: 'subagent', role: 'rocky',
    subAgentTemplateType: 'explorer',
  });
}

/** 直连 store 创建普通 session（顶层 standalone，无 5 字段） */
async function createPlainSession(dataDir: string, sid: string): Promise<void> {
  const fs = new FsCrudStore({ root: dataDir });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: dataDir });
  await store.createSession({ id: sid, title: 'plain' });
}

/** 解析 Response body 为 JSON */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// subagent session — 3 端点均 403 subagent_readonly
// （compact 已于 v0.0.54 移出此清单，subagent 允许 compact）
// ============================================================

describe('subagent session — 3 端点拒绝 user-source', () => {
  // 3 个端点的 subagent 403 拦截行为等价（拦截点在 handler 入口，早于业务逻辑），
  // 用 it.each 收敛重复样板（setup + 断言完全一致，仅 path/body 不同）。
  it.each([
    ['messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) }],
    ['abort', { method: 'POST' }],
    ['clear', { method: 'POST' }],
  ] as const)('POST /session/:subagentSid/%s → 403 subagent_readonly', async (ep, init) => {
    writeAppConfig(tmpRoot);
    const parentSid = ulid();
    const childSid = ulid();
    await createPlainSession(tmpRoot, parentSid);
    await createSubagentSession(tmpRoot, childSid, parentSid);

    const res = await handleRequest(
      new Request(`http://x/session/${childSid}/${ep}`, init as RequestInit),
      tmpRoot,
    );
    expect(res.status).toBe(403);
    const b = await body(res);
    expect(b.error).toBe('subagent_readonly');
  });
});

// ============================================================
// 非 subagent session（顶层 standalone）— 不受 403 影响
// （compact 正常路径在 handlers-session-compact.test.ts 覆盖，此处不重复）
// ============================================================

describe('非 subagent session — 2 端点正常路径（不返 403）', () => {
  it('POST /session/:plainSid/abort → 202（非 403）', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createPlainSession(tmpRoot, sid);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/abort`, { method: 'POST' }),
      tmpRoot,
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(202);
  });

  it('POST /session/:plainSid/clear → 200（非 403）', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createPlainSession(tmpRoot, sid);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/clear`, { method: 'POST' }),
      tmpRoot,
    );
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.ok).toBe(true);
  });

});

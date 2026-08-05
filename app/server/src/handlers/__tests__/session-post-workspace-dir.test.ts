/**
 * POST /session handler 集成测试 - BUG-001 修复验证（v0.0.17）
 * 参考: specs/api/overall/04-agent-session.md §2.1（CreateSessionBody.workspaceDir）
 *
 * 覆盖（verifier 建议「补 handler 集成 UT」）：
 *   - body.workspaceDir 提供且合法 → 用该值（不建默认目录）
 *   - body.workspaceDir 相对路径 → 400
 *   - body.workspaceDir 不存在 → 400
 *   - body.workspaceDir 是文件非目录 → 400
 *   - 不提供 workspaceDir → 默认 <DATA_DIR>/workspaces/<sid> 自动建（现有行为不破）
 *
 * 测试策略：真实 SessionStore（fs + tmpdir）+ 真 fs；
 * 不走 mock store —— 验证 handler 与 store 真接线 + fs 真实落地。
 * 文件系统隔离：tmpdir + mkdtemp + afterEach rm。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import { handleSessionCollection } from '../session';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { AppConfigService } from '../../config/app-config-service';
import type { PluginManager } from '../../plugin/plugin-manager';
import type { ContextEngine } from '../../agent/context-engine';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-post-ws-'));
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

/** 构造空 SessionHandlerDeps（POST /session 不需要 provider/plugin/agentManager） */
function makeDeps(): SessionHandlerDeps {
  const fake = {
    abort: async () => ({ accepted: false }),
    clearReplay: () => undefined,
  };
  return {
    store,
    agentManager: fake as unknown as AgentManagerImpl,
    appConfig: {} as AppConfigService,
    pluginManager: {} as PluginManager,
    contextEngine: {} as ContextEngine,
    dataDir: tmpRoot,
  };
}

/** body 解析 helper */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 发 POST /session */
async function postSession(bodyObj: unknown): Promise<Response> {
  return handleSessionCollection(
    new Request('http://x/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyObj),
    }),
    'POST',
    makeDeps(),
  );
}

describe('POST /session - [v0.0.17 BUG-001 修复] body.workspaceDir', () => {
  it('body.workspaceDir 提供且合法（绝对+存在+目录）→ 用该值，不建默认 <DATA_DIR>/workspaces/<sid>', async () => {
    // 准备 caller 预建的目录
    const callerDir = mkdtempSync(join(tmpdir(), 'oobt-caller-ws-'));
    try {
      const res = await postSession({ workspaceDir: callerDir });
      expect(res.status).toBe(201);
      const b = await body(res);
      // 响应 workspaceDir = caller 传入的值（非默认）
      expect(b.workspaceDir).toBe(callerDir);
      expect(b.id).toBeTruthy();
      // 不建默认目录 <DATA_DIR>/workspaces/<sid>
      const defaultDir = resolve(tmpRoot, 'workspaces', b.id);
      expect(existsSync(defaultDir)).toBe(false);
      // 持久化：重新 getSession 验字段
      const got = await store.getSession(b.id);
      expect(got?.workspaceDir).toBe(callerDir);
    } finally {
      rmSync(callerDir, { recursive: true, force: true });
    }
  });

  it('body.workspaceDir 相对路径 → 400', async () => {
    const res = await postSession({ workspaceDir: 'relative/path' });
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toMatch(/absolute/i);
  });

  it('body.workspaceDir 不存在 → 400', async () => {
    const res = await postSession({
      workspaceDir: '/nonexistent/definitely/not/here/xyz',
    });
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toMatch(/not exist/i);
  });

  it('body.workspaceDir 是文件而非目录 → 400', async () => {
    const file = resolve(tmpRoot, 'notdir.txt');
    writeFileSync(file, 'x');
    const res = await postSession({ workspaceDir: file });
    expect(res.status).toBe(400);
    const b = await body(res);
    expect(b.error).toMatch(/directory/i);
  });

  it('不提供 workspaceDir → 默认 <DATA_DIR>/workspaces/<sid> 自动建（现有行为不破）', async () => {
    const res = await postSession({});
    expect(res.status).toBe(201);
    const b = await body(res);
    const expected = resolve(tmpRoot, 'workspaces', b.id);
    expect(b.workspaceDir).toBe(expected);
    // 默认目录被自动建（mkdir recursive）
    expect(existsSync(expected)).toBe(true);
    expect(statSync(expected).isDirectory()).toBe(true);
  });

  it('空 body（无 JSON）→ 默认行为（自动建 <DATA_DIR>/workspaces/<sid>）', async () => {
    const res = await handleSessionCollection(
      new Request('http://x/session', { method: 'POST' }),
      'POST',
      makeDeps(),
    );
    expect(res.status).toBe(201);
    const b = await body(res);
    expect(b.workspaceDir).toBe(resolve(tmpRoot, 'workspaces', b.id));
  });

  it('workspaceDir 空串 → 视作未提供，走默认路径（向后兼容）', async () => {
    const res = await postSession({ workspaceDir: '' });
    expect(res.status).toBe(201);
    const b = await body(res);
    expect(b.workspaceDir).toBe(resolve(tmpRoot, 'workspaces', b.id));
    expect(existsSync(b.workspaceDir)).toBe(true);
  });
});

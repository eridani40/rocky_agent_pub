/**
 * DELETE /session/:id → connectorManager.disconnect 兜底 UT（v0.0.46 P7）
 * 参考: specs/tech/config/[P1]connectors.md v1.2 §3
 *       states/v0.0.46.connector_opt/design.md §5（session 结束兜底 disconnect）
 *
 * 覆盖：
 *   - DELETE session → connectorManager.disconnect('browser', sessionId) 被调 1 次
 *   - 重复 DELETE（第一次已删）→ 404，disconnect 不再被调（disconnect 内部幂等由 T1 UT 覆盖，此处只关注调用次数）
 *   - deps.connectorManager 未注入 → DELETE 仍返 204（健壮）
 *   - connectorManager.disconnect 抛错 → DELETE 仍返 204（吞错）
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import {
  handleSessionCollection,
  handleSessionItem,
  type SessionHandlerDeps,
} from '../session';
import type { ConnectorManager } from '../../tools/browser/connector-manager';

let tmpRoot: string;
let deps: SessionHandlerDeps;

/** fake AgentManager（DELETE 路径不用，但 SessionHandlerDeps 必填） */
function makeFakeAgentManager() {
  return {
    enqueue: vi.fn(),
    activate: vi.fn(),
    deliverTo: vi.fn(),
    subscribe: vi.fn(),
    activeLoopCount: vi.fn(() => 0),
  };
}

function req(method: string, path: string): Request {
  return new Request(`http://127.0.0.1:3700${path}`, { method });
}

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 创建一个 session（走 handleSessionCollection POST） */
async function createSession(): Promise<string> {
  const r = await handleSessionCollection(
    new Request('http://127.0.0.1:3700/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    'POST',
    deps,
  );
  const body = await jsonBody(r);
  return body.id;
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-session-delete-cm-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: tmpRoot });
  const appConfig = new AppConfigService({ root: tmpRoot });
  const devConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(mkdtempSync(join(tmpdir(), 'rocky-session-bs-')));
  deps = {
    store,
    agentManager: makeFakeAgentManager() as never,
    appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: bs.contextEngine,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('DELETE /session/:id → connectorManager.disconnect 兜底（v0.0.46 P7）', () => {
  it('DELETE session → connectorManager.disconnect("browser", sessionId) 被调 1 次；返 204', async () => {
    const disconnect = vi.fn(async () => {});
    const cm: ConnectorManager = {
      isReady: () => false,
      getAttachSession: () => undefined,
      disconnect,
    };
    deps.connectorManager = cm;

    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith('browser', sid);
  });

  it('重复 DELETE（第二次 404）→ disconnect 不再被调（session 已不存在，前置 404 早返）', async () => {
    const disconnect = vi.fn(async () => {});
    const cm: ConnectorManager = {
      isReady: () => false,
      getAttachSession: () => undefined,
      disconnect,
    };
    deps.connectorManager = cm;

    const sid = await createSession();
    const r1 = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r1.status).toBe(204);
    expect(disconnect).toHaveBeenCalledTimes(1);

    const r2 = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r2.status).toBe(404);
    // 404 早返，disconnect 未再调
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('deps.connectorManager 未注入 → DELETE 仍返 204（可选依赖）', async () => {
    // 不注入 connectorManager
    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
  });

  it('connectorManager.disconnect 抛错 → DELETE 仍返 204（吞错）', async () => {
    const disconnect = vi.fn(async () => {
      throw new Error('driver kill boom');
    });
    const cm: ConnectorManager = {
      isReady: () => false,
      getAttachSession: () => undefined,
      disconnect,
    };
    deps.connectorManager = cm;

    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('deps.connectorManager 无 disconnect 方法（只有 isReady/getAttachSession）→ DELETE 仍返 204', async () => {
    const cm: ConnectorManager = {
      isReady: () => false,
      getAttachSession: () => undefined,
      // 无 disconnect：接口可选
    };
    deps.connectorManager = cm;

    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
  });
});

/**
 * DELETE /session/:id → browserInstanceManager.releaseSession 兜底 UT（v0.0.264+，v0.0.266 attach 纳入）
 * 参考: specs/tech/agent/tools/[P1]browser_instance_manager.md
 *       change_plan v0.0.266 行 40-41（ConnectorManager.disconnect 兜底删除——attach session 归 InstanceManager）
 *
 * 覆盖：
 *   - DELETE session → browserInstanceManager.releaseSession(sid) 被调 1 次
 *   - 重复 DELETE（第一次已删）→ 404，releaseSession 不再被调
 *   - deps.browserInstanceManager 未注入 → DELETE 仍返 204（可选依赖）
 *   - releaseSession 抛错 → DELETE 仍返 204（吞错）
 *   - connectorManager.disconnect 兜底已删除（v0.0.266）：不注入 connectorManager 也正常
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
import type { BrowserInstanceManager } from '../../tools/browser/instance-manager';

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

/** mock BrowserInstanceManager（仅 releaseSession 被 DELETE 路径消费） */
function makeFakeInstanceManager(
  over: Partial<BrowserInstanceManager> = {},
): BrowserInstanceManager {
  return {
    releaseSession: vi.fn(async () => {}),
    ...over,
  } as unknown as BrowserInstanceManager;
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

describe('DELETE /session/:id → browserInstanceManager.releaseSession 兜底（v0.0.264 + v0.0.266）', () => {
  it('DELETE session → releaseSession(sid) 被调 1 次；返 204', async () => {
    const releaseSession = vi.fn(async () => {});
    deps.browserInstanceManager = makeFakeInstanceManager({ releaseSession });

    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
    expect(releaseSession).toHaveBeenCalledTimes(1);
    expect(releaseSession).toHaveBeenCalledWith(sid);
  });

  it('重复 DELETE（第二次 404）→ releaseSession 不再被调（session 已不存在，前置 404 早返）', async () => {
    const releaseSession = vi.fn(async () => {});
    deps.browserInstanceManager = makeFakeInstanceManager({ releaseSession });

    const sid = await createSession();
    const r1 = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r1.status).toBe(204);
    expect(releaseSession).toHaveBeenCalledTimes(1);

    const r2 = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r2.status).toBe(404);
    expect(releaseSession).toHaveBeenCalledTimes(1);
  });

  it('deps.browserInstanceManager 未注入 → DELETE 仍返 204（可选依赖）', async () => {
    // 不注入 browserInstanceManager
    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
  });

  it('releaseSession 抛错 → DELETE 仍返 204（吞错）', async () => {
    const releaseSession = vi.fn(async () => {
      throw new Error('kill boom');
    });
    deps.browserInstanceManager = makeFakeInstanceManager({ releaseSession });

    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
    expect(releaseSession).toHaveBeenCalledTimes(1);
  });

  it('v0.0.266：不再调 connectorManager.disconnect 兜底（attach 归 InstanceManager）', async () => {
    // 不注入 connectorManager（接口已删 disconnect）；releaseSession 覆盖 attach disconnect 语义
    const releaseSession = vi.fn(async () => {});
    deps.browserInstanceManager = makeFakeInstanceManager({ releaseSession });

    const sid = await createSession();
    const r = await handleSessionItem(req('DELETE', `/session/${sid}`), 'DELETE', sid, deps);
    expect(r.status).toBe(204);
    expect(releaseSession).toHaveBeenCalledTimes(1);
  });
});

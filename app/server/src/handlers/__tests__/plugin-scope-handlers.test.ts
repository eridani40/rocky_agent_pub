/**
 * plugin scope handlers 集成测试（白盒：真实 PluginConfigService + handler）。
 * 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D4（写端点删）
 *
 * v0.0.67 重构（用户指示「直接删写端点，无死代码」）：
 *   - 写端点（POST/DELETE scope + POST/DELETE activate）已删，相关测试同步删
 *   - 保留 GET 读路径覆盖：
 *       1. GET /config/plugin/scopes → default 首位
 *       2. GET /config/plugin/scopes/:id/activations → default 返 yaml 声明集（v0.0.206）
 *       3. handlePluginConfig GET scopeId query（缺省 default + 不存在 → 400）
 *       4. 写端点不存在：POST/DELETE → 405（handler 自身返，路由层仍透传到 handler）
 *       5. PUT /config/plugin 不存在（handlePluginConfig 返 405）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Registry } from '../../plugin/registry';
import { PluginConfigService } from '../../plugin/plugin-config-service';
import { LoadedScopeConfigProvider } from '../../plugin/scope-config-provider';
import { LoadedGroupMetaProvider } from '../../plugin/group-meta-provider';
import {
  handlePluginScopes,
  handleScopeActivation,
} from '../plugin-scope-handlers';
import { handlePluginConfig } from '../config';
import type { ExtensionPoint } from '../../plugin/extension-point';
import type { PluginManifest } from '../../plugin/manifest';

let tmpRoot: string;
let registry: Registry;
let svc: PluginConfigService;

const TEST_EP: ExtensionPoint = {
  id: 'tc_test_ep',
  cardinality: 'ordered',
  description: 'handler UT 用 ordered EP',
};

/** noop impl 类（inventory 路径不实例化 impl，仅占位满足 register 签名） */
class NoopImpl {}

const TEST_PLUGIN: PluginManifest = {
  id: 'tc_test_plugin',
  label: 'TC Test Plugin',
  description: 'handler UT 用 plugin',
  extImpls: [
    {
      implId: 'tc_impl_a',
      point: 'tc_test_ep',
      impl: './noop.ts',
      description: 'impl A',
    },
    {
      implId: 'tc_impl_b',
      point: 'tc_test_ep',
      impl: './noop.ts',
      description: 'impl B',
    },
  ],
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-scope-handler-'));
  registry = new Registry();
  registry.registerExtensionPoint(TEST_EP);
  registry.register(TEST_PLUGIN, NoopImpl, NoopImpl);
  svc = new PluginConfigService(registry, {
    root: tmpRoot,
    scopeConfigs: new LoadedScopeConfigProvider([
      // v0.0.206：default 无特权（plugin scope D6 已删），activations 端点返 yaml 声明集
      { scopeId: 'default', name: 'Default', activatedPoints: ['tc_test_ep'], impls: {} },
    ]),
    // v0.0.71 D1：注入 groupMeta（合成单 group 包含 TEST_EP，inventory-builder 用）
    groupMeta: new LoadedGroupMetaProvider([
      {
        id: 'test-group',
        label: '__MSG_group.test_group.label__',
        description: '__MSG_group.test_group.description__',
        extPoints: ['tc_test_ep'],
      },
    ]),
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeReq(
  method: string,
  urlPath: string,
  body?: unknown,
): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://test${urlPath}`, init);
}

async function bodyOf(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe('handlePluginScopes: GET /config/plugin/scopes', () => {
  it('GET /config/plugin/scopes → 200 + default 首位', async () => {
    const res = await handlePluginScopes(makeReq('GET', '/config/plugin/scopes'), 'GET', '/config/plugin/scopes', svc);
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    expect(b.items[0].scopeId).toBe('default');
  });

  it('v0.0.67 写端点已删：POST /config/plugin/scopes → 405（service 层 createScope 不存在）', async () => {
    // 验证写端点不返 201（防回归：用户指示「直接删，不返 405」在 handler 返 405，路由层不接 POST）
    const res = await handlePluginScopes(
      makeReq('POST', '/config/plugin/scopes', { id: 'release', name: 'Release' }),
      'POST',
      '/config/plugin/scopes',
      svc,
    );
    expect(res.status).toBe(405);
  });

  it('v0.0.67 写端点已删：DELETE /config/plugin/scopes/:id → 405', async () => {
    const res = await handlePluginScopes(
      makeReq('DELETE', '/config/plugin/scopes/whatever'),
      'DELETE',
      '/config/plugin/scopes/whatever',
      svc,
    );
    expect(res.status).toBe(405);
  });

  it('v0.0.67 service 层无写方法（createScope/deleteScope 不存在，防回归）', () => {
    expect(typeof (svc as unknown as { createScope?: unknown }).createScope).toBe('undefined');
    expect(typeof (svc as unknown as { deleteScope?: unknown }).deleteScope).toBe('undefined');
    expect(typeof (svc as unknown as { activateEp?: unknown }).activateEp).toBe('undefined');
    expect(typeof (svc as unknown as { deactivateEp?: unknown }).deactivateEp).toBe('undefined');
  });
});

describe('handleScopeActivation: GET /config/plugin/scopes/:id/activations', () => {
  it('GET activations default → 返 yaml 声明的激活 EP（plugin scope D6 v0.0.206 已删）', async () => {
    const res = await handleScopeActivation(
      makeReq('GET', '/config/plugin/scopes/default/activations'),
      'GET',
      '/config/plugin/scopes/default/activations',
      svc,
    );
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    expect(b.items.map((i: any) => i.pointId)).toContain('tc_test_ep');
  });

  it('GET activations scope 不存在 → 404', async () => {
    const res = await handleScopeActivation(
      makeReq('GET', '/config/plugin/scopes/ghost/activations'),
      'GET',
      '/config/plugin/scopes/ghost/activations',
      svc,
    );
    expect(res.status).toBe(404);
  });

  it('v0.0.67 写端点已删：POST activate → 405', async () => {
    const res = await handleScopeActivation(
      makeReq('POST', '/config/plugin/scopes/default/activate/tc_test_ep'),
      'POST',
      '/config/plugin/scopes/default/activate/tc_test_ep',
      svc,
    );
    expect(res.status).toBe(405);
  });

  it('v0.0.67 写端点已删：DELETE activate → 405', async () => {
    const res = await handleScopeActivation(
      makeReq('DELETE', '/config/plugin/scopes/default/activate/tc_test_ep'),
      'DELETE',
      '/config/plugin/scopes/default/activate/tc_test_ep',
      svc,
    );
    expect(res.status).toBe(405);
  });
});

describe('handlePluginConfig: GET scopeId query + PUT 已删（v0.0.67 配置只读化）', () => {
  it('GET 缺省 scopeId=default → 200 + tree.scope.id=default（向后兼容）', async () => {
    const url = new URL('http://test/config/plugin');
    const res = await handlePluginConfig(makeReq('GET', '/config/plugin'), 'GET', url, svc);
    expect(res.status).toBe(200);
    const b = await bodyOf(res);
    expect(b.tree.scope.id).toBe('default');
  });

  it('GET scopeId 不存在 → 400', async () => {
    const url = new URL('http://test/config/plugin?scopeId=ghost');
    const res = await handlePluginConfig(makeReq('GET', '/config/plugin?scopeId=ghost'), 'GET', url, svc);
    expect(res.status).toBe(400);
  });

  it('v0.0.67 PUT 已删：PUT /config/plugin → 405（任意 op）', async () => {
    const url = new URL('http://test/config/plugin');
    const res = await handlePluginConfig(
      makeReq('PUT', '/config/plugin', { op: 'setImplEnabled', implId: 'tc_impl_a', enabled: false }),
      'PUT',
      url,
      svc,
    );
    expect(res.status).toBe(405);
  });
});

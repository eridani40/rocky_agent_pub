/**
 * channel HTTP handler 单元测试（白盒，T4 模块 7）
 * 参考: specs/api/overall/17-channel.md §2-§5（端点契约）
 *       app/server/src/handlers/__tests__/connector.test.ts（同款 mock 模式）
 *
 * 覆盖（mock ChannelManager + ChannelConfigService + Registry，不发真 HTTP）：
 *   - GET /config/channels → 200 + { items: ChannelState[] }
 *   - GET /config/channels/impl-types → 200 { items: [{implId,label}] }（v0.0.206）
 *   - POST /config/channels → 201 ChannelState（implId 双段校验 + configSchema 校验）
 *   - POST 非法 implId → 400 未注册 / 已注册未激活 → 400 未激活（v0.0.206 双段文案区分）
 *   - POST name 缺失 → 400 / config required 缺失 → 400
 *   - PUT /config/channels/:id { enabled:false } → 202 + 触发 cm.setEnabled
 *   - PUT appSecret '***' → mergeChannelSecret 回填落盘原值（不丢 secret）
 *   - PUT 未知 :id → 404
 *   - DELETE /config/channels/:id → 200 + 触发 cm.unregisterConfig
 *   - DELETE 未知 :id → 404
 *   - 路由分发：GET /config/channels/:id → 405 / POST 无 body → 400
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleChannelRoute,
  handleChannelList,
  handleChannelCreate,
  handleChannelUpdate,
  handleChannelDelete,
  type ChannelHandlerDeps,
  type ChannelApiResponse,
} from '../channel';
import type { ChannelManager } from '../../channel/channel-manager';
import type { ChannelState, ChannelConfig } from '../../channel/types';
import { ChannelConfigService } from '../../channel/channel-config-service';
import { Registry } from '../../plugin/registry';
import type { PluginManifest } from '../../plugin/manifest';

/** 构造临时 dataDir（每 test 独立，afterEach 清理） */
async function makeTempDir(): Promise<string> {
  const dir = join(tmpdir(), `channel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 构造 mock ChannelManager：vi.fn 记录 register/unregister/setEnabled/updateConfig 调用 + 可控 getAllStates/listActiveImpls */
function makeMockChannelManager(states: ChannelState[] = [], activeImpls: { type: string }[] = [{ type: 'feishu' }]) {
  const registerConfig = vi.fn().mockResolvedValue(undefined);
  const unregisterConfig = vi.fn().mockResolvedValue(undefined);
  const setEnabled = vi.fn().mockResolvedValue(undefined);
  const updateConfig = vi.fn();
  const getAllStates = vi.fn().mockReturnValue(states);
  const getState = vi.fn((id: string) => states.find((s) => s.id === id));
  const listActiveImpls = vi.fn().mockReturnValue(activeImpls);
  const cm: ChannelManager = {
    bootstrap: vi.fn().mockResolvedValue(undefined),
    registerConfig,
    unregisterConfig,
    setEnabled,
    updateConfig,
    getAllStates,
    getState,
    listActiveImpls: listActiveImpls as ChannelManager['listActiveImpls'],
    getBinding: vi.fn().mockResolvedValue(null),
    bind: vi.fn().mockResolvedValue(undefined),
    unbind: vi.fn().mockResolvedValue(undefined),
    deleteBindingsBySession: vi.fn().mockResolvedValue(undefined),
    deleteBindingsByInstance: vi.fn().mockResolvedValue(undefined),
    subscribeOutbound: vi.fn(),
    unsubscribeOutbound: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    deliverTo: vi.fn().mockResolvedValue(undefined),
    findConversationBySession: vi.fn().mockResolvedValue(null),
  };
  return { cm, registerConfig, unregisterConfig, setEnabled, updateConfig, listActiveImpls };
}

/** 构造真实 Registry（注册 feishu manifest + configSchema） */
function makeRealRegistry(): Registry {
  const reg = new Registry();
  const manifest: PluginManifest = {
    id: 'feishu',
    extImpls: [
      {
        implId: 'feishu',
        point: 'channel',
        impl: './feishu-channel.ts',
        configSchema: {
          type: 'object',
          required: ['appId', 'appSecret'],
          properties: {
            appId: { type: 'string' },
            appSecret: { type: 'string', format: 'secret' },
          },
        },
      },
    ],
  };
  reg.register(manifest, class FakeChannel {}); // implClass 不参与 handler 校验
  return reg;
}

/** 构造完整 deps（真实 configService + registry，mock channelManager） */
async function makeDeps(
  states: ChannelState[] = [],
  activeImpls: { type: string }[] = [{ type: 'feishu' }],
): Promise<{
  deps: ChannelHandlerDeps;
  cm: ChannelManager;
  registerConfig: ReturnType<typeof vi.fn>;
  unregisterConfig: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  dataDir: string;
}> {
  const dataDir = await makeTempDir();
  const { cm, registerConfig, unregisterConfig, setEnabled, updateConfig } = makeMockChannelManager(states, activeImpls);
  const deps: ChannelHandlerDeps = {
    channelManager: cm,
    configService: new ChannelConfigService({ root: dataDir }),
    registry: makeRealRegistry(),
  };
  return { deps, cm, registerConfig, unregisterConfig, setEnabled, updateConfig, dataDir };
}

describe('handleChannelList: GET /config/channels', () => {
  it('200 + items[] 按 spec 字段（enabled 非 switch / config.appSecret 明文 / errorDetail null）', async () => {
    // 先经 configService 落盘一个 instance（JOIN 数据源）
    const { deps } = await makeDeps([]);
    const inst = deps.configService.create({
      implId: 'feishu', name: '公司飞书',
      config: { appId: 'cli_real', appSecret: 'topsecret' },
    });
    // mock cm.getAllStates 返对应 state
    const state: ChannelState = {
      id: inst.id, implId: 'feishu', name: '公司飞书',
      switch: 'on', connection: 'connected', bindingCount: 2,
    };
    deps.channelManager.getAllStates = vi.fn().mockReturnValue([state]);
    const res = handleChannelList(deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ChannelApiResponse[] };
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    // spec §2 字段断言
    expect(item.id).toBe(inst.id);
    expect(item.enabled).toBe(true); // switch 'on' → enabled true
    expect(item.config.appId).toBe('cli_real');
    expect(item.config.appSecret).toBe('topsecret'); // 明文（mask 收敛前端）
    expect(item.connection).toBe('connected');
    expect(item.errorDetail).toBeNull(); // 显式 null 非 undefined
    expect(item.lastConnectedAt).toBeNull();
    expect(item.bindingCount).toBe(2);
    expect(item.createdAt).toBeDefined(); // store 信封注入
    expect(item.updatedAt).toBeDefined();
  });

  it('switch=off → enabled=false', async () => {
    const { deps } = await makeDeps([]);
    const inst = deps.configService.create({
      implId: 'feishu', name: 'X', config: { appId: 'a', appSecret: 's' }, enabled: false,
    });
    deps.channelManager.getAllStates = vi.fn().mockReturnValue([
      { id: inst.id, implId: 'feishu', name: 'X', switch: 'off', connection: 'disconnected' },
    ]);
    const res = handleChannelList(deps);
    const body = (await res.json()) as { items: ChannelApiResponse[] };
    expect(body.items[0]!.enabled).toBe(false);
  });

  it('空列表 → 200 + { items: [] }', async () => {
    const { deps } = await makeDeps([]);
    const res = handleChannelList(deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ChannelApiResponse[] };
    expect(body.items).toHaveLength(0);
  });
});

describe('handleChannelCreate: POST /config/channels', () => {
  it('合法 body → 201 + spec 字段（enabled/config 明文/errorDetail null/bindingCount 0）', async () => {
    const { deps, registerConfig } = await makeDeps([]);
    const res = await handleChannelCreate(
      { implId: 'feishu', name: '机器人A', config: { appId: 'cli_x', appSecret: 'sec' } },
      deps,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ChannelApiResponse;
    // spec §3 响应字段断言
    expect(body.id).toBeDefined(); // ULID 生成
    expect(body.implId).toBe('feishu');
    expect(body.name).toBe('机器人A');
    expect(body.enabled).toBe(true); // 默认 true（建完即连）
    expect(body.config.appId).toBe('cli_x');
    expect(body.config.appSecret).toBe('sec'); // 明文（mask 收敛前端）
    expect(body.connection).toMatch(/^(disconnected|connecting|connected|error)$/);
    expect(body.errorDetail).toBeNull();
    expect(body.bindingCount).toBe(0);
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
    expect(registerConfig).toHaveBeenCalledTimes(1);
    // 落盘验证（落盘原值非 redact）
    expect(deps.configService.getRaw(body.id)!.config.appSecret).toBe('sec');
  });

  it('enabled 默认 true（建完即连）', async () => {
    const { deps } = await makeDeps([]);
    await handleChannelCreate(
      { implId: 'feishu', name: 'B', config: { appId: 'a', appSecret: 's' } },
      deps,
    );
    const list = deps.configService.list();
    expect(list[0]!.enabled).toBe(true);
  });

  it('enabled: false 显式传 → 不自动连', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelCreate(
      { implId: 'feishu', name: 'C', config: { appId: 'a', appSecret: 's' }, enabled: false },
      deps,
    );
    const body = (await res.json()) as ChannelApiResponse;
    expect(body.enabled).toBe(false);
    expect(deps.configService.getRaw(body.id)!.enabled).toBe(false);
  });

  it('非法 implId → 400（未注册文案）', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelCreate(
      { implId: 'unknown', name: 'X', config: {} },
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not registered as channel EP/);
  });

  it('已注册但未在 scope default 激活 → 400（未激活文案，与未注册区分）', async () => {
    // registry 已登记 feishu，但 listActiveImpls 返 []（default.yaml 未配 channel impl）
    const { deps } = await makeDeps([], []);
    const res = await handleChannelCreate(
      { implId: 'feishu', name: 'X', config: { appId: 'a', appSecret: 's' } },
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("registered but not activated in scope 'default'");
    expect(body.error).not.toContain('not registered');
  });

  it('name 缺失 → 400', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelCreate(
      { implId: 'feishu', config: { appId: 'a', appSecret: 's' } },
      deps,
    );
    expect(res.status).toBe(400);
  });

  it('config.required 缺失 → 400', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelCreate(
      { implId: 'feishu', name: 'X', config: { appId: 'a' } },
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/appSecret/);
  });

  it('config 空串字段 → 400', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelCreate(
      { implId: 'feishu', name: 'X', config: { appId: '', appSecret: 's' } },
      deps,
    );
    expect(res.status).toBe(400);
  });

  it('body 非对象 → 400', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelCreate('not-object', deps);
    expect(res.status).toBe(400);
  });
});

describe('handleChannelUpdate: PUT /config/channels/:id', () => {
  /** 预置一份 config（用 configService.create） */
  async function seedInstance(deps: ChannelHandlerDeps): Promise<ChannelConfig> {
    return deps.configService.create({
      implId: 'feishu',
      name: '原',
      config: { appId: 'orig-app', appSecret: 'orig-secret' },
    });
  }

  it('enabled:false → 202 + setEnabled(false) + 落盘 enabled=false', async () => {
    const { deps, setEnabled } = await makeDeps([]);
    const inst = await seedInstance(deps);
    const res = await handleChannelUpdate(inst.id, { enabled: false }, deps);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(inst.id, false));
    expect(deps.configService.getRaw(inst.id)!.enabled).toBe(false);
  });

  it("appSecret '***' → 回填落盘原值（不丢 secret）", async () => {
    const { deps } = await makeDeps([]);
    const inst = await seedInstance(deps);
    await handleChannelUpdate(
      inst.id,
      { config: { appId: 'new-app', appSecret: '***' } },
      deps,
    );
    const raw = deps.configService.getRaw(inst.id)!;
    expect(raw.config.appSecret).toBe('orig-secret'); // 保原值
    expect(raw.config.appId).toBe('new-app'); // 非 secret 字段用新值
  });

  it('appSecret 新填明文 → 直接覆盖', async () => {
    const { deps } = await makeDeps([]);
    const inst = await seedInstance(deps);
    await handleChannelUpdate(
      inst.id,
      { config: { appId: 'a2', appSecret: 'new-plain-secret' } },
      deps,
    );
    expect(deps.configService.getRaw(inst.id)!.config.appSecret).toBe('new-plain-secret');
  });

  it('改 name 不改 config → 只更 name', async () => {
    const { deps, updateConfig } = await makeDeps([]);
    const inst = await seedInstance(deps);
    await handleChannelUpdate(inst.id, { name: '新名字' }, deps);
    const raw = deps.configService.getRaw(inst.id)!;
    expect(raw.name).toBe('新名字');
    expect(raw.config.appSecret).toBe('orig-secret'); // 原值不动
    // 回归（BUG v0.0.106 #4）：PUT 必须同步 ChannelManager 内存态，否则 GET 返回旧 name
    expect(updateConfig).toHaveBeenCalledWith(inst.id, expect.objectContaining({ name: '新名字' }));
  });

  it('改 name → 同步内存态（GET 不再返回旧值：BUG v0.0.106 #4 回归）', async () => {
    const { deps, updateConfig } = await makeDeps([]);
    const inst = await seedInstance(deps);
    await handleChannelUpdate(inst.id, { name: '改名后' }, deps);
    // 落盘 ✓
    expect(deps.configService.getRaw(inst.id)!.name).toBe('改名后');
    // 内存态同步 ✓（updateConfig 被调，name/config/enabled 字段齐全；config/enabled undefined 字段透传）
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledWith(
      inst.id,
      { name: '改名后', config: undefined, enabled: undefined },
    );
  });

  it('改 config → updateConfig 收到 mergedConfig（内存态同步）', async () => {
    const { deps, updateConfig } = await makeDeps([]);
    const inst = await seedInstance(deps);
    await handleChannelUpdate(
      inst.id,
      { config: { appId: 'new-app', appSecret: '***' } },
      deps,
    );
    expect(updateConfig).toHaveBeenCalledTimes(1);
    const [, patch] = updateConfig.mock.calls[0]!;
    expect(patch.config).toMatchObject({ appId: 'new-app', appSecret: 'orig-secret' });
  });

  it('未知 :id → 404', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelUpdate('unknown-id', { enabled: false }, deps);
    expect(res.status).toBe(404);
  });

  it('enabled 非 boolean → 400', async () => {
    const { deps } = await makeDeps([]);
    const inst = await seedInstance(deps);
    const res = await handleChannelUpdate(inst.id, { enabled: 'yes' }, deps);
    expect(res.status).toBe(400);
  });
});

describe('handleChannelDelete: DELETE /config/channels/:id', () => {
  it('存在 :id → 200 + unregisterConfig + 落盘删', async () => {
    const { deps, unregisterConfig } = await makeDeps([]);
    const inst = deps.configService.create({
      implId: 'feishu',
      name: 'del',
      config: { appId: 'a', appSecret: 's' },
    });
    const res = await handleChannelDelete(inst.id, deps);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(unregisterConfig).toHaveBeenCalledWith(inst.id));
    // unregisterConfig 内部会调 configService.delete；mock 不调，手验 handler 不直接删
    // （删由 ChannelManager.unregisterConfig 负责级联清，handler 不重复）
  });

  it('未知 :id → 404', async () => {
    const { deps } = await makeDeps([]);
    const res = await handleChannelDelete('unknown', deps);
    expect(res.status).toBe(404);
  });
});

describe('handleChannelRoute: 路由分发', () => {
  it('GET /config/channels → 200', async () => {
    const { deps } = await makeDeps([
      { id: '01HX', implId: 'feishu', name: 'X', switch: 'off', connection: 'disconnected' },
    ]);
    const req = new Request('http://x/config/channels');
    const res = await handleChannelRoute(req, 'GET', '/config/channels', deps);
    expect(res.status).toBe(200);
  });

  it('POST /config/channels → 201', async () => {
    const { deps } = await makeDeps([]);
    const req = new Request('http://x/config/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ implId: 'feishu', name: 'X', config: { appId: 'a', appSecret: 's' } }),
    });
    const res = await handleChannelRoute(req, 'POST', '/config/channels', deps);
    expect(res.status).toBe(201);
  });

  it('POST 无 body → 400', async () => {
    const { deps } = await makeDeps([]);
    const req = new Request('http://x/config/channels', { method: 'POST' });
    const res = await handleChannelRoute(req, 'POST', '/config/channels', deps);
    expect(res.status).toBe(400);
  });

  it('PUT /config/channels（无 :id）→ 405', async () => {
    const { deps } = await makeDeps([]);
    const req = new Request('http://x/config/channels', { method: 'PUT' });
    const res = await handleChannelRoute(req, 'PUT', '/config/channels', deps);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET,POST');
  });

  it('DELETE /config/channels/:id → 200', async () => {
    const { deps } = await makeDeps([]);
    const inst = deps.configService.create({
      implId: 'feishu', name: 'D', config: { appId: 'a', appSecret: 's' },
    });
    const req = new Request(`http://x/config/channels/${inst.id}`, { method: 'DELETE' });
    const res = await handleChannelRoute(req, 'DELETE', `/config/channels/${inst.id}`, deps);
    expect(res.status).toBe(200);
  });

  it('GET /config/channels/:id → 405（仅 PUT/DELETE）', async () => {
    const { deps } = await makeDeps([]);
    const req = new Request('http://x/config/channels/01HX');
    const res = await handleChannelRoute(req, 'GET', '/config/channels/01HX', deps);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('PUT,DELETE');
  });

  it('未匹配路径 → 404', async () => {
    const { deps } = await makeDeps([]);
    const req = new Request('http://x/other');
    const res = await handleChannelRoute(req, 'GET', '/other', deps);
    expect(res.status).toBe(404);
  });

  it('GET /config/channels/impl-types → 200 items 含 feishu + label（字面分支不被 :id 吞）', async () => {
    const { deps } = await makeDeps([]);
    const req = new Request('http://x/config/channels/impl-types');
    const res = await handleChannelRoute(req, 'GET', '/config/channels/impl-types', deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { implId: string; label: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.implId).toBe('feishu');
    // label = registry 反查 manifest label（makeRealRegistry 未设 label → 回落 implId）
    expect(body.items[0]!.label).toBe('feishu');
  });

  it('impl-types 空激活 → 200 items=[]（scope 未配 channel impl）', async () => {
    const { deps } = await makeDeps([], []);
    const req = new Request('http://x/config/channels/impl-types');
    const res = await handleChannelRoute(req, 'GET', '/config/channels/impl-types', deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it('POST /config/channels/impl-types → 405（仅 GET）', async () => {
    const { deps } = await makeDeps([]);
    const req = new Request('http://x/config/channels/impl-types', { method: 'POST' });
    const res = await handleChannelRoute(req, 'POST', '/config/channels/impl-types', deps);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

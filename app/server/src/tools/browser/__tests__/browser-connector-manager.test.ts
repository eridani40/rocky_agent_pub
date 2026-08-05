/**
 * BrowserConnectorManager 单元测试（白盒，v0.0.46 时机重构）
 * 参考: specs/tech/config/[P1]connectors.md v1.2 §3-§6（switch/connection 解耦 + lazy connect）
 *       states/v0.0.46.connector_opt/design.md §2 §7（PRD P1/P4/P5/P8 UT 清单）
 *
 * 覆盖（不 spawn 真 npx / 不连真 chrome，mock driver + 真持久化 ConnectorConfigService）：
 *   - P1 enable：只写 intent + state.switch=on/connection=disconnected；driver.connect 未调
 *   - P4 in_use_by_other：sessionA connected 时 sessionB 抢占失败
 *   - P5 bootstrap：intent=on → state.switch=on/connection=disconnected；driver.connect 未调
 *   - P8 connect_failed：driver.connect 抛错 → error + owner=null + errorDetail；不重试
 *   - 附加：disable / disconnect idempotent / lazy connect 首次成功 / not_enabled 门禁
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrowserConnectorManager } from '../connector-manager';
import { ConnectorConfigService } from '../../../config/connector-config-service';
import type { BrowserSession, BrowserConnectOptions } from '../types';

interface MockDriverState {
  connectResult: 'success' | 'fail';
  connectCalls: BrowserConnectOptions[];
  disconnectCalls: BrowserConnectOptions[];
}

function makeMockDriver(state: MockDriverState) {
  const fakeSession: BrowserSession = {
    listPages: async () => [],
    selectPage: async () => {},
    navigate: async () => {},
    snapshot: async () => ({ snapshot: '', refs: {} }),
    click: async () => {},
    type: async () => {},
    evaluate: async () => undefined,
    close: async () => {},
  };
  return {
    mode: 'attach' as const,
    async connect(opts: BrowserConnectOptions): Promise<BrowserSession> {
      state.connectCalls.push(opts);
      if (state.connectResult === 'fail') {
        throw new Error('Could not connect to chrome (ECONNREFUSED)');
      }
      return fakeSession;
    },
    async disconnect(opts: BrowserConnectOptions): Promise<void> {
      state.disconnectCalls.push(opts);
    },
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-mgr-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeManager(connectResult: 'success' | 'fail' = 'success') {
  const driverState: MockDriverState = {
    connectResult,
    connectCalls: [],
    disconnectCalls: [],
  };
  const driver = makeMockDriver(driverState);
  const configService = new ConnectorConfigService({ root: tmpRoot });
  const manager = new BrowserConnectorManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    driver: driver as any,
    configService,
  });
  return { manager, driverState, configService };
}

describe('P1 enable — 只写 intent + state.switch，不触发 connect', () => {
  it('enable 后 driver.connect 未调；state={switch:on, connection:disconnected}；owner=null', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    const state = manager.getState('browser');
    expect(state.switch).toBe('on');
    expect(state.connection).toBe('disconnected');
    expect(driverState.connectCalls).toHaveLength(0);
    expect(manager.getOwner('browser')).toBeNull();
    expect(manager.isReady('browser')).toBe(false);
    expect(manager.getAttachSession('browser')).toBeUndefined();
  });

  it('enable → connector_config browser enabled=true 落盘', async () => {
    const { manager } = makeManager('success');
    await manager.enable('browser');
    const fresh = new ConnectorConfigService({ root: tmpRoot });
    expect(fresh.getEnabled('browser')).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'connector_config', 'browser.json'))).toBe(true);
  });
});

describe('P5 bootstrap — 只读 intent 恢复 UI 态，不 connect', () => {
  it('intent=on → {switch:on, connection:disconnected}；driver.connect 未调；owner=null', async () => {
    new ConnectorConfigService({ root: tmpRoot }).setEnabled('browser', true);
    const { manager, driverState } = makeManager('success');
    await manager.bootstrap!();
    const state = manager.getState('browser');
    expect(state.switch).toBe('on');
    expect(state.connection).toBe('disconnected');
    expect(driverState.connectCalls).toHaveLength(0);
    expect(manager.getOwner('browser')).toBeNull();
  });

  it('intent=off / 无记录 → {switch:off, connection:disconnected}', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.bootstrap!();
    expect(manager.getState('browser').switch).toBe('off');
    expect(manager.getState('browser').connection).toBe('disconnected');
    expect(driverState.connectCalls).toHaveLength(0);
  });
});

describe('connectForToolRun — 门禁分层', () => {
  it('门禁1 switch=off → not_enabled；driver.connect 未调', async () => {
    const { manager, driverState } = makeManager('success');
    const r = await manager.connectForToolRun!('browser', 'sA');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('not_enabled');
      expect(r.error.message).toContain('未启用');
    }
    expect(driverState.connectCalls).toHaveLength(0);
  });

  it('门禁4 首次 lazy connect 成功 → ok:true + owner + connected', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    const r = await manager.connectForToolRun!('browser', 'sA');
    expect(r.ok).toBe(true);
    expect(driverState.connectCalls).toHaveLength(1);
    const state = manager.getState('browser');
    expect(state).toMatchObject({ switch: 'on', connection: 'connected' });
    expect(state.lastConnectedAt).toBeTypeOf('number');
    expect(manager.getOwner('browser')?.sessionId).toBe('sA');
    expect(manager.isReady('browser')).toBe(true);
    expect(manager.getAttachSession('browser')).toBeDefined();
  });

  it('门禁3 同 owner 二次调用 → 复用 session，driver.connect 不再调', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    await manager.connectForToolRun!('browser', 'sA');
    const r = await manager.connectForToolRun!('browser', 'sA');
    expect(r.ok).toBe(true);
    expect(driverState.connectCalls).toHaveLength(1);
  });
});

describe('P4 in_use_by_other — 全局唯一占用', () => {
  it('sessionA 连上后 sessionB → in_use_by_other，owner 保持 A', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    const rA = await manager.connectForToolRun!('browser', 'sA');
    expect(rA.ok).toBe(true);
    const rB = await manager.connectForToolRun!('browser', 'sB');
    expect(rB.ok).toBe(false);
    if (!rB.ok) {
      expect(rB.error.kind).toBe('in_use_by_other');
      expect(rB.error.ownerSessionId).toBe('sA');
      expect(rB.error.message).toContain('sA');
    }
    expect(manager.getOwner('browser')?.sessionId).toBe('sA');
    expect(manager.getState('browser').connection).toBe('connected');
    expect(driverState.connectCalls).toHaveLength(1);
  });

  it('owner=A 但 connection=error → 允许 B 抢占（owner 值滞留时不锁死）', async () => {
    const state: MockDriverState = { connectResult: 'fail', connectCalls: [], disconnectCalls: [] };
    const driver = makeMockDriver(state);
    const configService = new ConnectorConfigService({ root: tmpRoot });
    const manager = new BrowserConnectorManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      driver: driver as any,
      configService,
    });
    await manager.enable('browser');
    const rA = await manager.connectForToolRun!('browser', 'sA');
    expect(rA.ok).toBe(false);
    expect(manager.getOwner('browser')).toBeNull();
    state.connectResult = 'success';
    const rB = await manager.connectForToolRun!('browser', 'sB');
    expect(rB.ok).toBe(true);
    expect(manager.getOwner('browser')?.sessionId).toBe('sB');
  });
});

describe('P8 connect_failed — 失败即停', () => {
  it('driver.connect 抛错 → connect_failed；state.connection=error；switch 保持 on；owner=null', async () => {
    const { manager, driverState } = makeManager('fail');
    await manager.enable('browser');
    const r = await manager.connectForToolRun!('browser', 'sA');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('connect_failed');
      expect(r.error.message).toContain('连接失败');
    }
    const state = manager.getState('browser');
    expect(state.switch).toBe('on');
    expect(state.connection).toBe('error');
    expect(state.errorDetail).toContain('Could not connect');
    expect(manager.getOwner('browser')).toBeNull();
    expect(manager.getAttachSession('browser')).toBeUndefined();
    expect(driverState.connectCalls).toHaveLength(1);
  });

  it('内部不重试（一次调用只调 driver.connect 一次）', async () => {
    const { manager, driverState } = makeManager('fail');
    await manager.enable('browser');
    await manager.connectForToolRun!('browser', 'sA');
    // 显式再调 → 会再触发一次（不禁止用户主动再试；但内部不 backoff/循环）
    await manager.connectForToolRun!('browser', 'sA');
    expect(driverState.connectCalls).toHaveLength(2);
  });
});

describe('disable — 用户 toggle off', () => {
  it('已连时 disable → intent=off + owner=null + state.disconnected + driver.disconnect 调 1 次', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    await manager.connectForToolRun!('browser', 'sA');
    await manager.disable('browser');
    const state = manager.getState('browser');
    expect(state.switch).toBe('off');
    expect(state.connection).toBe('disconnected');
    expect(manager.getOwner('browser')).toBeNull();
    expect(driverState.disconnectCalls).toHaveLength(1);
    expect(new ConnectorConfigService({ root: tmpRoot }).getEnabled('browser')).toBe(false);
  });

  it('未连时 disable → 不报错，driver.disconnect 未调', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    await manager.disable('browser');
    expect(driverState.disconnectCalls).toHaveLength(0);
    expect(manager.getState('browser').switch).toBe('off');
  });
});

describe('disconnect — LLM disconnect / session 兜底 (idempotent)', () => {
  it('未占用 → no-op（driver.disconnect 未调，switch 保持）', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    await manager.disconnect!('browser', 'sA');
    expect(driverState.disconnectCalls).toHaveLength(0);
    expect(manager.getState('browser').switch).toBe('on');
  });

  it('sessionId ≠ owner → no-op（不能替他人断）', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    await manager.connectForToolRun!('browser', 'sA');
    await manager.disconnect!('browser', 'sB');
    expect(driverState.disconnectCalls).toHaveLength(0);
    expect(manager.getOwner('browser')?.sessionId).toBe('sA');
    expect(manager.getState('browser').connection).toBe('connected');
  });

  it('sessionId=owner → driver.disconnect 调 1 次；owner=null；connection=disconnected；switch 保持 on', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    await manager.connectForToolRun!('browser', 'sA');
    await manager.disconnect!('browser', 'sA');
    expect(driverState.disconnectCalls).toHaveLength(1);
    expect(manager.getOwner('browser')).toBeNull();
    expect(manager.getState('browser').connection).toBe('disconnected');
    expect(manager.getState('browser').switch).toBe('on');
  });

  it('未传 sessionId → 无条件断（session DELETE 兜底路径）；重复调用幂等', async () => {
    const { manager, driverState } = makeManager('success');
    await manager.enable('browser');
    await manager.connectForToolRun!('browser', 'sA');
    await manager.disconnect!('browser');
    expect(driverState.disconnectCalls).toHaveLength(1);
    await manager.disconnect!('browser'); // 已 owner=null
    await manager.disconnect!('browser', 'sA');
    expect(driverState.disconnectCalls).toHaveLength(1); // 后续都是 no-op
  });
});

describe('getAll — GET /config/connectors', () => {
  it('返单元素数组（v0.0.23 仅 browser）', () => {
    const { manager } = makeManager('success');
    expect(manager.getAll()).toHaveLength(1);
    expect(manager.getAll()[0]!).toMatchObject({ id: 'browser', switch: 'off', connection: 'disconnected' });
  });
});

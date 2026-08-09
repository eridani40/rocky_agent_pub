/**
 * BrowserConnectorManager 单元测试（白盒，v0.0.266 瘦身后）
 * 参考: specs/tech/config/[P1]connectors.md v1.2 §3-§6（switch/connection 解耦）
 *       change_plan v0.0.266 行 40-41（ConnectorManager 瘦身为「switch 门禁 + UI 状态」）
 *
 * 覆盖（不 spawn 真 npx / 不连真 chrome；真持久化 ConnectorConfigService）：
 *   - enable：只写 intent + state.switch=on/connection=disconnected
 *   - disable：只写 intent=off + state.switch=off（v0.0.266 不再 disconnect——attach session 归 InstanceManager）
 *   - bootstrap：intent 恢复 switch，connection 一律 disconnected
 *   - getState/getAll/isReady（switch 门禁语义）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BrowserConnectorManager } from '../connector-manager';
import { ConnectorConfigService } from '../../../config/connector-config-service';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-mgr-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeManager() {
  const configService = new ConnectorConfigService({ root: tmpRoot });
  const manager = new BrowserConnectorManager({ configService });
  return { manager, configService };
}

describe('P1 enable — 只写 intent + state.switch，不 connect', () => {
  it('enable 后 state={switch:on, connection:disconnected}；isReady=true（switch 门禁）', async () => {
    const { manager } = makeManager();
    await manager.enable('browser');
    const state = manager.getState('browser');
    expect(state.switch).toBe('on');
    expect(state.connection).toBe('disconnected');
    expect(manager.isReady('browser')).toBe(true);
  });

  it('enable → connector_config browser enabled=true 落盘', async () => {
    const { manager } = makeManager();
    await manager.enable('browser');
    const fresh = new ConnectorConfigService({ root: tmpRoot });
    expect(fresh.getEnabled('browser')).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'connector_config', 'browser.json'))).toBe(true);
  });
});

describe('P5 bootstrap — 只读 intent 恢复 UI 态，不 connect', () => {
  it('intent=on → {switch:on, connection:disconnected}', async () => {
    new ConnectorConfigService({ root: tmpRoot }).setEnabled('browser', true);
    const { manager } = makeManager();
    await manager.bootstrap!();
    const state = manager.getState('browser');
    expect(state.switch).toBe('on');
    expect(state.connection).toBe('disconnected');
    expect(manager.isReady('browser')).toBe(true);
  });

  it('intent=off / 无记录 → {switch:off, connection:disconnected}', async () => {
    const { manager } = makeManager();
    await manager.bootstrap!();
    expect(manager.getState('browser').switch).toBe('off');
    expect(manager.getState('browser').connection).toBe('disconnected');
    expect(manager.isReady('browser')).toBe(false);
  });
});

describe('disable — 用户 toggle off（v0.0.266 仅 intent，不 disconnect）', () => {
  it('disable → intent=off + state={switch:off, connection:disconnected}', async () => {
    const { manager } = makeManager();
    await manager.enable('browser');
    await manager.disable('browser');
    const state = manager.getState('browser');
    expect(state.switch).toBe('off');
    expect(state.connection).toBe('disconnected');
    expect(manager.isReady('browser')).toBe(false);
    expect(new ConnectorConfigService({ root: tmpRoot }).getEnabled('browser')).toBe(false);
  });

  it('未 enable 时 disable → 不报错，状态 off', async () => {
    const { manager } = makeManager();
    await manager.disable('browser');
    expect(manager.getState('browser').switch).toBe('off');
  });
});

describe('getAll / getState — GET /config/connectors', () => {
  it('返单元素数组（v0.0.23 仅 browser）', () => {
    const { manager } = makeManager();
    expect(manager.getAll()).toHaveLength(1);
    expect(manager.getAll()[0]!).toMatchObject({ id: 'browser', switch: 'off', connection: 'disconnected' });
  });

  it('非 browser id → 防御性返 off/disconnected', () => {
    const { manager } = makeManager();
    expect(manager.getState('browser')).toBeDefined();
    expect(manager.isReady('browser')).toBe(false);
  });
});

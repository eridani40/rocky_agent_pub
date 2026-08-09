/**
 * connector HTTP handler 单元测试（白盒，v0.0.23 Task 6）
 * 参考: specs/api/overall/03-config-center.md §3.6（连接器端点组契约）
 *       tests/api/connector/*（conn_toggle_on/fail/restart/attach_gate）
 *
 * 覆盖（mock ConnectorManager，不发真 HTTP）：
 *   - GET /config/connectors → 200 + { items: ConnectorState[] }
 *   - PUT /config/connectors/browser {enable:true} → 202 + {ok:true} + 触发 enable
 *   - PUT /config/connectors/browser {enable:false} → 202 + 触发 disable
 *   - PUT 未知 :id → 400
 *   - PUT body 非 {enable:boolean} → 400
 *   - GET /config/connectors/:id 非 PUT → 405
 *   - PUT /config/connectors（无 :id）→ 405
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleConnectorRoute,
  handleConnectorList,
  handleConnectorToggle,
} from '../connector';
import type {
  ConnectorManager,
  ConnectorState,
} from '../../tools/browser/connector-manager';

/** 构造 mock ConnectorManager：vi.fn 记录 enable/disable 调用 + 可控 getAll 返回 */
function makeMockManager(state: ConnectorState) {
  const enable = vi.fn().mockResolvedValue(undefined);
  const disable = vi.fn().mockResolvedValue(undefined);
  const cm: ConnectorManager = {
    isReady: () => state.switch === 'on' && state.connection === 'connected',
    getAll: () => [{ ...state }],
    getState: () => ({ ...state }),
    enable,
    disable,
  };
  return { cm, enable, disable };
}

describe('handleConnectorList: GET /config/connectors', () => {
  it('200 + { items: ConnectorState[] }（透传 getAll）', () => {
    const state: ConnectorState = {
      id: 'browser',
      switch: 'on',
      connection: 'connected',
      lastConnectedAt: 1234,
    };
    const { cm } = makeMockManager(state);
    const res = handleConnectorList(cm);
    expect(res.status).toBe(200);
    return res.json().then((body) => {
      const b = body as { items: ConnectorState[] };
      expect(b.items).toHaveLength(1);
      expect(b.items[0]).toMatchObject({
        id: 'browser',
        switch: 'on',
        connection: 'connected',
      });
    });
  });
});

describe('handleConnectorToggle: PUT /config/connectors/:id', () => {
  it('enable=true → 202 + {ok:true} + 触发 cm.enable', async () => {
    const { cm, enable, disable } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const res = await handleConnectorToggle('browser', { enable: true }, cm);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // fire-and-forget：enable 被异步调用（void .catch），用 waitFor 断言
    await vi.waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    expect(disable).not.toHaveBeenCalled();
  });

  it('enable=false → 202 + 触发 cm.disable', async () => {
    const { cm, enable, disable } = makeMockManager({
      id: 'browser',
      switch: 'on',
      connection: 'connected',
    });
    const res = await handleConnectorToggle('browser', { enable: false }, cm);
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    expect(enable).not.toHaveBeenCalled();
  });

  it('未知 :id → 400', async () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const res = await handleConnectorToggle('unknown', { enable: true }, cm);
    expect(res.status).toBe(400);
  });

  it('body 非 {enable:boolean} → 400', async () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const res = await handleConnectorToggle('browser', { enable: 'yes' }, cm);
    expect(res.status).toBe(400);
  });

  it('body 缺 enable → 400', async () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const res = await handleConnectorToggle('browser', {}, cm);
    expect(res.status).toBe(400);
  });

  it('cm 缺 enable 能力 → 500', async () => {
    const cm: ConnectorManager = {
      isReady: () => false,
      // 无 enable/disable
    };
    const res = await handleConnectorToggle('browser', { enable: true }, cm);
    expect(res.status).toBe(500);
  });
});

describe('handleConnectorRoute: 路由分发', () => {
  it('GET /config/connectors → 200', () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const req = new Request('http://x/config/connectors');
    return handleConnectorRoute(req, 'GET', '/config/connectors', cm).then((res) => {
      expect(res.status).toBe(200);
    });
  });

  it('PUT /config/connectors（无 :id）→ 405', () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const req = new Request('http://x/config/connectors', { method: 'PUT' });
    return handleConnectorRoute(req, 'PUT', '/config/connectors', cm).then((res) => {
      expect(res.status).toBe(405);
    });
  });

  it('GET /config/connectors/browser → 405（仅 PUT）', () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const req = new Request('http://x/config/connectors/browser');
    return handleConnectorRoute(req, 'GET', '/config/connectors/browser', cm).then((res) => {
      expect(res.status).toBe(405);
    });
  });

  it('PUT /config/connectors/browser {enable:true} → 202', () => {
    const { cm, enable } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const req = new Request('http://x/config/connectors/browser', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enable: true }),
    });
    return handleConnectorRoute(req, 'PUT', '/config/connectors/browser', cm).then(
      async (res) => {
        expect(res.status).toBe(202);
        await vi.waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
      },
    );
  });

  it('PUT /config/connectors/browser 非 json body → 400', () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const req = new Request('http://x/config/connectors/browser', {
      method: 'PUT',
      body: 'not json',
    });
    return handleConnectorRoute(req, 'PUT', '/config/connectors/browser', cm).then((res) => {
      expect(res.status).toBe(400);
    });
  });

  it('未匹配路径 → 404', () => {
    const { cm } = makeMockManager({
      id: 'browser',
      switch: 'off',
      connection: 'disconnected',
    });
    const req = new Request('http://x/other');
    return handleConnectorRoute(req, 'GET', '/other', cm).then((res) => {
      expect(res.status).toBe(404);
    });
  });
});

/**
 * ChannelManager scope 门 + 动态组合 单测（v0.0.206 新模型核心护栏）
 * 参考: specs/tech/version_logs/v0.0.206/change_plan.md 模块四（组合器 + scope 门）
 *
 * 覆盖：
 *   1. impl 未激活（getExtensionImpls 返 []）→ spawnConnect → connection='error'
 *      + errorDetail 含「未在 scope 'default' 激活」+ 不崩 server
 *   2. gate 失败不 retry（gate 在 retry 之外：errorDetail 无 retry 前缀，connect 0 次调用）
 *   3. gate 失败的 config toggle off → 不崩（off 路径对 handle undefined 安全）
 *   4. impl 激活 → connect 成功 → connection='connected' + rt.handle 挂句柄
 *   5. listActiveImpls 返激活 impl 列表
 *   6. multi-config 并行：同一 impl 两份 config 各连各 handle（connect 各收对应 config，
 *      互不影响——动态组合核心卖点护栏）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelManagerImpl } from '../channel-manager';
import type { ChannelManagerOptions } from '../channel-manager';
import type { Channel, ChannelHandle, ChannelConfig } from '../types';
import type { ChannelManagerBackend } from '../channel-base';
import type { AgentEvent } from '../../agent/agent-event-types';

/** 构造 spy ChannelHandle */
function makeHandle(configId: string): ChannelHandle & { disconnect: ReturnType<typeof vi.fn> } {
  return {
    configId,
    disconnect: vi.fn().mockResolvedValue(undefined),
    handleInbound: vi.fn().mockResolvedValue(undefined),
    sendOutbound: vi.fn().mockResolvedValue(undefined),
    updateInputState: vi.fn().mockResolvedValue(undefined),
  };
}

/** 构造 spy 无状态 impl（connect 记录调用 + 每 config 返独立 handle） */
function makeImpl(type = 'feishu') {
  const connect = vi.fn(async (config: ChannelConfig, _backend: ChannelManagerBackend): Promise<ChannelHandle> =>
    makeHandle(config.id),
  );
  const impl: Channel & { connect: typeof connect } = { type, connect };
  return impl;
}

/** 构造 ChannelManagerImpl（getExtensionImpls 返给定 impl 列表） */
function makeManager(tmpRoot: string, activeImpls: Channel[]): ChannelManagerImpl {
  const opts: ChannelManagerOptions = {
    dataDir: tmpRoot,
    agentManager: {
      deliverTo: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue((async function* (): AsyncIterable<AgentEvent> {})()),
    },
    sessionStore: { listSessions: vi.fn().mockResolvedValue([]) },
    registry: { getImplById: vi.fn() } as never,
    pluginManager: { getExtensionImpls: vi.fn().mockReturnValue(activeImpls) } as never,
  };
  return new ChannelManagerImpl(opts);
}

/** 构造一份 config */
function makeConfig(id: string, enabled = true): ChannelConfig {
  return { id, implId: 'feishu', name: id, enabled, config: { appId: 'a', appSecret: 's' } };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'channel-gate-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ChannelManager scope 门（resolveImpl gate）', () => {
  it('① impl 未激活（getExtensionImpls 返 []）→ config 转 error 不崩 + errorDetail 含「未在 scope \'default\' 激活」', async () => {
    const cm = makeManager(tmpRoot, []); // default.yaml 未配 channel impl
    await cm.registerConfig(makeConfig('cfg-gate'));
    // spawnConnect fire-and-forget：等状态落定
    await vi.waitFor(() => {
      expect(cm.getState('cfg-gate')!.connection).toBe('error');
    });
    const state = cm.getState('cfg-gate')!;
    expect(state.errorDetail).toContain('未在 scope \'default\' 激活');
    // server 不崩：cm 仍可正常服务其他调用
    expect(cm.getAllStates()).toHaveLength(1);
  });

  it('② gate 失败不 retry（确定性失败：无 retry 前缀 + 无任何 connect 调用）', async () => {
    // 激活列表只给另一 type 的 impl（'other'）：config.implId='feishu' gate miss
    // → other impl 的 connect 绝不被误调（断言有效接入系统）
    const impl = makeImpl('other');
    const cm = makeManager(tmpRoot, [impl]);
    await cm.registerConfig(makeConfig('cfg-noretry'));
    await vi.waitFor(() => {
      expect(cm.getState('cfg-noretry')!.connection).toBe('error');
    });
    const state = cm.getState('cfg-noretry')!;
    // retry 路径的 errorDetail 前缀是「connect 失败（第 N/3 次）：」；gate 失败无此前缀
    expect(state.errorDetail).not.toContain('connect 失败');
    expect(impl.connect).not.toHaveBeenCalled();
  });

  it('③ gate 失败的 config toggle off → 不崩（off 路径对 handle undefined 安全）', async () => {
    const cm = makeManager(tmpRoot, []);
    await cm.registerConfig(makeConfig('cfg-off'));
    await vi.waitFor(() => {
      expect(cm.getState('cfg-off')!.connection).toBe('error');
    });
    // gate 失败 → rt.handle undefined；toggle off 必须不崩
    await expect(cm.setEnabled('cfg-off', false)).resolves.toBeUndefined();
    expect(cm.getState('cfg-off')!.connection).toBe('disconnected');
    // toggle on 重过 gate 仍 error（gate 语义稳定）
    await cm.setEnabled('cfg-off', true);
    await vi.waitFor(() => {
      expect(cm.getState('cfg-off')!.connection).toBe('error');
    });
  });

  it('④ impl 激活 → connect 成功 connected + handle 挂 configId', async () => {
    const impl = makeImpl();
    const cm = makeManager(tmpRoot, [impl]);
    await cm.registerConfig(makeConfig('cfg-ok'));
    await vi.waitFor(() => {
      expect(cm.getState('cfg-ok')!.connection).toBe('connected');
    });
    expect(impl.connect).toHaveBeenCalledTimes(1);
    // connect 收到对应 config（组合点：impl + config → handle）
    expect(impl.connect.mock.calls[0]![0].id).toBe('cfg-ok');
  });

  it('⑤ listActiveImpls 返激活 impl 列表（impl-types 端点 + POST 激活校验消费）', () => {
    const impl = makeImpl();
    const cm = makeManager(tmpRoot, [impl]);
    const actives = cm.listActiveImpls();
    expect(actives).toHaveLength(1);
    expect(actives[0]!.type).toBe('feishu');
    // 未激活 → 空列表
    const cm2 = makeManager(tmpRoot, []);
    expect(cm2.listActiveImpls()).toHaveLength(0);
  });

  it('⑥ multi-config 并行：同一 impl 两份 config 各连各 handle（connect 各收对应 config，互不影响）', async () => {
    const impl = makeImpl();
    const cm = makeManager(tmpRoot, [impl]);
    await cm.registerConfig(makeConfig('cfg-A'));
    await cm.registerConfig(makeConfig('cfg-B'));
    await vi.waitFor(() => {
      expect(cm.getState('cfg-A')!.connection).toBe('connected');
      expect(cm.getState('cfg-B')!.connection).toBe('connected');
    });
    // 同一无状态 impl 被组合 2 次，各收对应 config
    expect(impl.connect).toHaveBeenCalledTimes(2);
    const calledConfigIds = impl.connect.mock.calls.map((c) => (c[0] as ChannelConfig).id).sort();
    expect(calledConfigIds).toEqual(['cfg-A', 'cfg-B']);
    // 两份 config 状态独立：toggle off A 不影响 B
    await cm.setEnabled('cfg-A', false);
    expect(cm.getState('cfg-A')!.connection).toBe('disconnected');
    expect(cm.getState('cfg-B')!.connection).toBe('connected');
  });
});

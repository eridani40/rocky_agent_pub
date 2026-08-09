/**
 * AttachModeImpl 单元测试（白盒，全 mock env/attachDriver，不真连 Chrome）
 * 参考: specs/tech/version_logs/v0.0.266/change_plan.md Delta（registry 重构：attach 用例迁移）
 *       specs/tech/agent/tools/[P1]browser_tool.md §4（ChromeMcpDriver connect/close 语义）
 *
 * 覆盖（从 instance-manager.test.ts attach 段迁移，保持覆盖度）：
 *   ① launch：switch 门禁 enabled=false → not_enabled；驱动缺省 → attach_failed（fail-closed）
 *   ② launch connect 成功 → handle（session 承载）；connect 失败 → attach_failed
 *   ③ execute：dispatch 到 session 方法（navigate/listPages/click/type/evaluate/snapshot/selectPage）
 *   ④ execute 失活（connection closed）→ 置 dead + attach_lost 引导文案
 *   ⑤ execute 非失活错误 → 原样透传（不置 dead）
 *   ⑥ execute screenshot → ctx.snapshot.save + 路径文本
 *   ⑦ close：disconnect 调 + 幂等（不杀 chrome/不删目录/不释放端口/不持久化）
 */
import { describe, it, expect, vi } from 'vitest';
import type { BrowserSession, BrowserConnectOptions, SnapshotResult } from '../types';
import type { ChromeMcpDriver } from '../chrome-mcp-driver';
import type { ModeImplEnv } from '../mode-impl';
import { AttachModeImpl, type AttachHandle } from '../attach-mode-impl';

/** mock ChromeMcpDriver（attachDriver）：connect/disconnect + session 方法记录调用 */
function makeDriver(connectResult: 'success' | 'fail' = 'success') {
  const fakeSession: BrowserSession = {
    listPages: vi.fn(async () => [{ id: 'p1', url: 'https://x', selected: true }]),
    selectPage: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async (): Promise<SnapshotResult> => ({ snapshot: '- button "Go"', refs: { b1: { role: 'button', name: 'Go', nth: 0 } } })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    evaluate: vi.fn(async () => 42),
    close: vi.fn(async () => {}),
  };
  return {
    connect: vi.fn(async (opts?: BrowserConnectOptions): Promise<BrowserSession> => {
      if (connectResult === 'fail') throw new Error('ECONNREFUSED 9222');
      return fakeSession;
    }),
    disconnect: vi.fn(async (_opts?: BrowserConnectOptions): Promise<void> => {}),
    fakeSession,
  };
}

/** mock env（attachDriver/isAttachEnabled 注入；now 可控） */
function makeEnv(over: Partial<ModeImplEnv> = {}): ModeImplEnv {
  return { dataDir: '/tmp', now: () => 1_000, ...over } as ModeImplEnv;
}

/** 构造 impl + 默认 env（attachDriver + enabled） */
function makeImpl(opts: { connectResult?: 'success' | 'fail'; enabled?: boolean } = {}) {
  const driver = makeDriver(opts.connectResult ?? 'success');
  const impl = new AttachModeImpl();
  const env = makeEnv({
    attachDriver: driver as unknown as ChromeMcpDriver,
    isAttachEnabled: () => opts.enabled ?? true,
  });
  return { impl, env, driver };
}

describe('AttachModeImpl launch', () => {
  it('connect 成功 → handle（session 承载 + ready）；不持久化', async () => {
    const { impl, env, driver } = makeImpl();
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('launched');
    expect(driver.connect).toHaveBeenCalledTimes(1);
    const ah = r.handle as AttachHandle;
    expect(ah.key).toBe('sA:attach');
    expect(ah.mode).toBe('attach');
    expect(ah.state).toBe('ready');
    expect(ah.session).toBe(driver.fakeSession);
  });

  it('switch=off → not_enabled；driver.connect 未调', async () => {
    const { impl, env, driver } = makeImpl({ enabled: false });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('not_enabled');
      expect(r.error?.message).toContain('未启用');
    }
    expect(driver.connect).not.toHaveBeenCalled();
  });

  it('attachDriver 缺省 → attach_failed（fail-closed）', async () => {
    const impl = new AttachModeImpl();
    const env = makeEnv({ isAttachEnabled: () => true });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
    }
  });

  it('connect 失败 → attach_failed + message 透传', async () => {
    const { impl, env } = makeImpl({ connectResult: 'fail' });
    const r = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
      expect(r.error?.message).toContain('ECONNREFUSED');
    }
  });
});

describe('AttachModeImpl execute', () => {
  it('navigate → dispatch 到 session.navigate + ok', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const r = await impl.execute(lr.handle, 'navigate', { url: 'https://x' }, {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('navigated');
    expect(driver.fakeSession.navigate).toHaveBeenCalledWith('https://x');
  });

  it('listPages / snapshot / click / type / evaluate / selectPage 全 dispatch', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const r1 = await impl.execute(lr.handle, 'listPages', {}, {});
    expect(r1.ok).toBe(true);
    expect(driver.fakeSession.listPages).toHaveBeenCalledTimes(1);
    const r2 = await impl.execute(lr.handle, 'snapshot', {}, {});
    expect(r2.ok).toBe(true);
    expect(JSON.parse(r2.text!).snapshot).toContain('Go');
    const r3 = await impl.execute(lr.handle, 'click', { ref: 'b1' }, {});
    expect(r3.ok).toBe(true);
    expect(driver.fakeSession.click).toHaveBeenCalledWith('b1');
    const r4 = await impl.execute(lr.handle, 'type', { ref: 'inp', text: 'hi' }, {});
    expect(r4.ok).toBe(true);
    expect(driver.fakeSession.type).toHaveBeenCalledWith('inp', 'hi');
    const r5 = await impl.execute(lr.handle, 'evaluate', { text: '1+1' }, {});
    expect(r5.ok).toBe(true);
    expect(driver.fakeSession.evaluate).toHaveBeenCalledWith('1+1');
    const r6 = await impl.execute(lr.handle, 'selectPage', { ref: 'p1' }, {});
    expect(r6.ok).toBe(true);
    expect(driver.fakeSession.selectPage).toHaveBeenCalledWith('p1');
  });

  it('失活（connection closed）→ 置 dead + attach_lost 引导文案', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    driver.fakeSession.listPages = vi.fn(async () => {
      throw new Error('connection closed');
    });
    const r = await impl.execute(lr.handle, 'listPages', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_lost');
      expect(r.error?.message).toContain('连接已断开');
      expect(r.error?.message).toContain('重新 launch');
    }
    expect(lr.handle.state).toBe('dead'); // 失活置 dead（manager 收尾 close）
  });

  it('非失活错误 → 原样透传（不置 dead）', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    driver.fakeSession.click = vi.fn(async () => {
      throw new Error('ref not found: b9');
    });
    const r = await impl.execute(lr.handle, 'click', { ref: 'b9' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('unknown');
      expect(r.error?.message).toContain('ref not found');
    }
    expect(lr.handle.state).toBe('ready'); // 非失活不置 dead
  });

  it('未知 action → unknown_action error', async () => {
    const { impl, env } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const r = await impl.execute(lr.handle, 'fly', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('unknown_action');
    }
  });

  it('screenshot → ctx.snapshot.save + 路径文本（无 base64 inline）', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    driver.fakeSession.screenshot = vi.fn(async () => ({ mime: 'image/png', data: pngBytes }));
    const save = vi.fn(async (_data: Buffer | string, _mediaType: string) => ({ relPath: 'snapshots/call_attach_1.png' }));
    const r = await impl.execute(lr.handle, 'screenshot', {}, { snapshot: { save } });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('snapshots/call_attach_1.png');
    expect(r.text).toContain('see_image');
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]![0] as Buffer).equals(pngBytes)).toBe(true);
    expect(save.mock.calls[0]![1]).toBe('image/png');
  });

  it('session 无 screenshot 方法 → unsupported error', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    delete (driver.fakeSession as { screenshot?: unknown }).screenshot;
    const r = await impl.execute(lr.handle, 'screenshot', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('unsupported');
      expect(r.error?.message).toContain('不支持');
    }
  });
});

describe('AttachModeImpl close', () => {
  it('close → disconnect 调 + 置 dead；不删目录/不释放端口/不持久化', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    await impl.close(lr.handle, env2);
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    expect(lr.handle.state).toBe('dead');
  });

  it('close 幂等：二次 close no-op（disconnect 内部幂等 + state dead）', async () => {
    const { impl, env, driver } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => true,
    });
    await impl.close(lr.handle, env2);
    await impl.close(lr.handle, env2); // 二次 close：disconnect 再调（driver 层幂等）
    expect(lr.handle.state).toBe('dead');
  });

  it('attachDriver 缺省 → close no-op（disconnect 不调不抛）', async () => {
    const { impl, env } = makeImpl();
    const lr = await impl.launch('sA:attach', { mode: 'attach' }, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const env2 = makeEnv({}); // 无 attachDriver
    await expect(impl.close(lr.handle, env2)).resolves.toBeUndefined();
  });
});

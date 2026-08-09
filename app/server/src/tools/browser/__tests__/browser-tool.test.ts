/**
 * browser Tool 单元测试（白盒，v0.0.266 T3 registry 重构后）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md v1.4 §7
 *       specs/api/overall/08-web-tools.md §4（isError 分支）
 *       change_plan v0.0.266 Delta（T3：操作 action 统一 execute，零 mode 分叉）
 *
 * 覆盖：
 *   - attach launch/close → im.launch/im.close（cdpUrl 透传）
 *   - 操作类 action（attach/headless/managed-profile 三模式统一）→ im.execute 路由
 *     （attach 失活自愈/非失活错误/未知 action 均由 impl 返回错误 → tool 透传）
 *   - headless/managed-profile：im.launch/im.close/im.execute（v0.0.264 语义不变）
 *   - 无 instanceManager → 未注册 isError（三模式统一 fail-closed）
 *   - screenshot 落盘：经 execute ctx.snapshot（落盘逻辑在 impl，tool 透传路径文本）
 *   - cdpUrl SSRF 门禁（loopback 豁免 / 私网 fail-closed）
 */
import { describe, it, expect, vi } from 'vitest';
import { createBrowserTool } from '../tool';
import type { ToolCtx, ToolInput } from '../../types';
import type { BrowserSession, SnapshotResult } from '../types';
import type { BrowserInstanceManager } from '../instance-manager';
import type { ExecuteCtx } from '../mode-impl';

// ---- mock BrowserInstanceManager（三模式统一：launch/execute/close） ----
function makeInstanceManager(
  over: Partial<BrowserInstanceManager> = {},
): BrowserInstanceManager {
  return {
    launch: vi.fn(async () => ({ ok: true, text: 'launched headless' })),
    execute: vi.fn(async () => ({ ok: true, text: '{}' })),
    close: vi.fn(async () => ({ ok: true, text: 'closed' })),
    releaseSession: vi.fn(async () => {}),
    releaseAll: vi.fn(async () => {}),
    ...over,
  } as unknown as BrowserInstanceManager;
}

/** 生成带 sessionId 的 ctx */
function makeCtx(sessionId = 'sA'): ToolCtx {
  return { config: { tools: [], sessionId }, workdir: '/tmp' };
}

describe('browser Tool: attach launch/close（v0.0.266 三模式统一）', () => {
  it('attach launch → im.launch(sessionId, {mode:"attach"}) + ok 透传', async () => {
    const launch = vi.fn(async () => ({ ok: true, text: 'launched attach' }));
    const im = makeInstanceManager({ launch });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'launch' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('sA', { mode: 'attach' });
    expect((r.content[0] as { text: string }).text).toContain('launched');
  });

  it('attach launch 带 cdpUrl → im.launch 透传 cdpUrl', async () => {
    const launch = vi.fn(async () => ({ ok: true, text: 'launched attach' }));
    const im = makeInstanceManager({ launch });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run(
      { mode: 'attach', action: 'launch', cdpUrl: 'http://127.0.0.1:9222' },
      makeCtx('sA'),
    );
    expect(r.isError).toBe(false);
    expect(launch).toHaveBeenCalledWith('sA', { mode: 'attach', cdpUrl: 'http://127.0.0.1:9222' });
  });

  it('attach launch switch=off → im.launch 返 not_enabled → isError 引导开启', async () => {
    const launch = vi.fn(async () => ({
      ok: false,
      error: { kind: 'not_enabled', message: 'browser attach 未启用：请在「连接器 → 浏览器」中开启开关' },
    }));
    const im = makeInstanceManager({ launch });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'launch' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('未启用');
    expect(text).toContain('连接器 → 浏览器');
  });

  it('attach close → im.close(sessionId, {mode:"attach"}) + ok 透传', async () => {
    const close = vi.fn(async () => ({ ok: true, text: 'closed' }));
    const im = makeInstanceManager({ close });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'close' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('sA', { mode: 'attach' });
  });
});

describe('browser Tool: 操作类 action 统一 execute（v0.0.266 T3 零 mode 分叉）', () => {
  it('attach navigate → im.execute(sessionId, {mode:"attach"}, "navigate", {url}, ctx) + ok 透传', async () => {
    const execute = vi.fn(async () => ({ ok: true, text: 'navigated to https://x' }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'navigate', url: 'https://x' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'sA',
      { mode: 'attach' },
      'navigate',
      { url: 'https://x' },
      expect.objectContaining({ signal: undefined, snapshot: expect.any(Object) }),
    );
    expect((r.content[0] as { text: string }).text).toContain('navigated');
  });

  it('未 launch → execute 返 no_browser_instance → errorResult 提示先 launch', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      error: { kind: 'no_browser_instance', message: '当前会话没有 attach 浏览器实例，请先调用 browser(action="launch")' },
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'listPages' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('attach');
    expect(text).toContain('launch');
  });

  it('attach 失活自愈（impl 内部）→ execute 返 attach_lost → tool 透传引导文案', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      error: { kind: 'attach_lost', message: 'attach 浏览器连接已断开（Chrome 可能被关闭），请重新 launch' },
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'listPages' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('连接已断开');
    expect(text).toContain('重新 launch');
  });

  it('attach 非失活错误 → 原样透传（不重写文案）', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      error: { kind: 'unknown', message: 'ref not found: b9' },
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'click', ref: 'b9' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('ref not found');
    expect(text).not.toContain('连接已断开');
  });

  it('未知 action → execute 返 unknown_action → isError（attach 不再有独立 dispatch 分支）', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      error: { kind: 'unknown_action', message: 'browser: 未知 action "fly"' },
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'fly' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
  });
});

describe('browser Tool: InstanceManager 常驻（headless/managed-profile，v0.0.264）', () => {
  it('launch action → im.launch 被调 (sessionId, {mode}) + ok 透传', async () => {
    const launch = vi.fn(async () => ({ ok: true, text: 'launched headless' }));
    const im = makeInstanceManager({ launch });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'headless', action: 'launch' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('sA', { mode: 'headless' });
    expect((r.content[0] as { text: string }).text).toContain('launched');
  });

  it('managed-profile launch 带 profileName → im.launch 被调 ({mode, profileName})', async () => {
    const launch = vi.fn(async () => ({ ok: true, text: 'launched managed-profile p1' }));
    const im = makeInstanceManager({ launch });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run(
      { mode: 'managed-profile', action: 'launch', profileName: 'p1' },
      makeCtx('sA'),
    );
    expect(r.isError).toBe(false);
    expect(launch).toHaveBeenCalledWith('sA', { mode: 'managed-profile', profileName: 'p1' });
  });

  it('close action → im.close 被调 + ok 透传', async () => {
    const close = vi.fn(async () => ({ ok: true, text: 'closed' }));
    const im = makeInstanceManager({ close });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'headless', action: 'close' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('sA', { mode: 'headless' });
  });

  it('snapshot → im.execute 被调 (sessionId, opts, action, params, ctx) + ok 透传', async () => {
    const execute = vi.fn(async () => ({ ok: true, text: '{"snapshot":"- button \\"Go\\""}' }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'headless', action: 'snapshot' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'sA',
      { mode: 'headless' },
      'snapshot',
      {},
      expect.objectContaining({ signal: undefined, snapshot: expect.any(Object) }),
    );
    expect((r.content[0] as { text: string }).text).toContain('snapshot');
  });

  it('navigate → im.execute 被调 with url params', async () => {
    const execute = vi.fn(async () => ({ ok: true, text: 'navigated to https://example.com' }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run(
      { mode: 'headless', action: 'navigate', url: 'https://example.com' },
      makeCtx('sA'),
    );
    expect(r.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith(
      'sA',
      { mode: 'headless' },
      'navigate',
      { url: 'https://example.com' },
      expect.anything(),
    );
    expect((r.content[0] as { text: string }).text).toBe('navigated to https://example.com');
  });

  it('无 instance 时 navigate → errorResult 提示先 launch（no_browser_instance）', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      error: {
        kind: 'no_browser_instance',
        message: '当前会话没有 headless 浏览器实例，请先调用 browser(action="launch")',
      },
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run(
      { mode: 'headless', action: 'navigate', url: 'https://x' },
      makeCtx('sA'),
    );
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('no_browser_instance');
    expect(text).toContain('launch');
  });

  it('im.execute 返 error → isError 透传（formatExecuteError 带 kind）', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      error: { kind: 'worker_crashed', message: 'worker 崩溃: boom，请重新 launch' },
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'headless', action: 'snapshot' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('worker_crashed');
  });

  it('无 instanceManager → isError 未注册（三模式统一 fail-closed）', async () => {
    const tool = createBrowserTool();
    const r = await tool.run({ mode: 'headless', action: 'snapshot' }, makeCtx());
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('未注册');
  });

  it('attach + 无 instanceManager → isError 未注册（不再走 connectorManager）', async () => {
    const tool = createBrowserTool();
    const r = await tool.run({ mode: 'attach', action: 'snapshot' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('未注册');
  });
});

describe('browser Tool: 校验失败', () => {
  const tool = createBrowserTool();
  it('缺 mode → isError', async () => {
    const r = await tool.run({ action: 'snapshot' }, makeCtx());
    expect(r.isError).toBe(true);
  });
  it('缺 action → isError', async () => {
    const r = await tool.run({ mode: 'headless' }, makeCtx());
    expect(r.isError).toBe(true);
  });
});

describe('browser Tool: cdpUrl SSRF 门禁（仅非 loopback）', () => {
  // spec browser_tool §4/§6 + refs/openclaw cdp-reachability-policy:
  // CDP 控制面 ≠ 页面导航——loopback（127.x/::1/localhost）CDP 豁免 SSRF；
  // 非 loopback（私网/link-local/file://）仍 fail-closed。
  it('cdpUrl=127.0.0.1 loopback → SSRF 放行（CDP 控制面豁免）', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://127.0.0.1:9222' },
      makeCtx(),
    );
    // loopback 放行——attach 路径无 im → 未注册分支，但关键是不被 SSRF 拦
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('cdpUrl=[::1] loopback → SSRF 放行', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://[::1]:9222' },
      makeCtx(),
    );
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('cdpUrl=localhost loopback → SSRF 放行', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://localhost:9222' },
      makeCtx(),
    );
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('cdpUrl=10.x 私网 → isError', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://10.0.0.5:9222' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('SSRF');
  });

  it('cdpUrl=192.168.x 私网 → isError', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://192.168.1.1:9222' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('SSRF');
  });

  it('cdpUrl=169.254.169.254 link-local（云元数据）→ isError SSRF', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://169.254.169.254:9222' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('SSRF');
  });

  it('cdpUrl=file:// → isError（协议被禁）', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'file:///etc/passwd' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
  });

  it('cdpUrl=公网 IP → SSRF 放行（不因 SSRF 拒绝）', async () => {
    const tool = createBrowserTool();
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://93.184.216.34:9222' },
      makeCtx(),
    );
    // 公网 IP 放行——无 im → 未注册（关键：不是 SSRF 拒绝）
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('无 cdpUrl → 不触发 SSRF 门禁（正常流程）', async () => {
    const execute = vi.fn(async () => ({ ok: true, text: '[]' }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run({ mode: 'attach', action: 'listPages' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// 截图本地化（INV-157-1/3）：落盘在 impl（经 ctx.snapshot），tool 只透传路径文本
describe('browser Tool: screenshot 落盘（经 execute ctx.snapshot）', () => {
  it('execute 返落盘路径文本 → tool 透传（snapshots/ + see_image，无 base64）', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const execute = vi.fn(async () => ({
      ok: true,
      text: 'Saved browser screenshot to snapshots/call_1.png. Use see_image tool to view it.',
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const ctx: ToolCtx = { config: { tools: [], sessionId: 'sA' }, workdir: '/tmp', toolCallId: 'call_1' };
    const r = await tool.run({ mode: 'headless', action: 'screenshot' }, ctx);
    expect(r.isError).toBe(false);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('snapshots/');
    expect(text).toContain('browser screenshot');
    expect(text).toContain('see_image');
    expect(text).not.toContain(pngBytes.toString('base64'));
    // execute 收到带 SnapshotSink 的 ctx（落盘 sink 由 tool 构造注入）
    const ctxArg = (execute as ReturnType<typeof vi.fn>).mock.calls[0]![4] as ExecuteCtx;
    expect(ctxArg.snapshot).toBeDefined();
  });

  it('execute 返 error → isError 透传（落盘失败由 impl 返回）', async () => {
    const execute = vi.fn(async () => ({
      ok: false,
      error: { kind: 'screenshot_save_failed', message: 'browser screenshot 落盘失败: disk full' },
    }));
    const im = makeInstanceManager({ execute });
    const tool = createBrowserTool({ instanceManager: im });
    const r = await tool.run(
      { mode: 'attach', action: 'screenshot' },
      { config: { tools: [], sessionId: 'sA' }, workdir: '/tmp', toolCallId: 'call_2' },
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('落盘失败');
  });
});

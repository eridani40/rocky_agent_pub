/**
 * browser Tool 单元测试（白盒，v0.0.46 时机重构后）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md v1.4 §7
 *       specs/api/overall/08-web-tools.md §4（isError 分支）
 *       states/v0.0.46.connector_opt/design.md §3 §7（PRD P2/P3/P6 UT 清单）
 *
 * 覆盖：
 *   - [v0.0.101] needsApproval 已退役（O7），原 attach=true/headless=false 测试已移除
 *   - P2 attach lazy connect：switch=on owner=null → connectForToolRun 被调 1 次 → dispatchAction 走通
 *   - P3 attach disconnect：调 cm.disconnect(id, sessionId) 且 isError:false；不改 intent
 *   - P6 not_enabled：cm.connectForToolRun 返 not_enabled → isError + 引导文案
 *   - in_use_by_other / connect_failed 各一断言
 *   - mode !== 'attach' 且 action='disconnect' → 参数错
 *   - headless → pickDriver → connect → dispatch(snapshot) → finally close
 *   - dispatch 各 action（navigate/snapshot/click/type/listPages/evaluate）映射
 *   - 校验失败：缺 mode / 缺 action / 未知 action
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserTool } from '../tool';
import type { ToolCtx, ToolInput } from '../../types';
import type { BrowserSession, BrowserDriver, SnapshotResult } from '../types';
import type { DriverRegistry } from '../pick-driver';
import type { ConnectorManager, ConnectForToolRunResult } from '../connector-manager';

// ---- mock ConnectorManager ----
function makeConnectorManager(over: Partial<ConnectorManager> = {}): ConnectorManager {
  return {
    isReady: () => false,
    getAttachSession: () => undefined,
    ...over,
  };
}

// ---- mock BrowserSession ----
function makeSession(over: Partial<BrowserSession> = {}): BrowserSession {
  return {
    listPages: vi.fn(async () => [{ id: 'p1', url: 'https://x', selected: true }]),
    selectPage: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(
      async (): Promise<SnapshotResult> => ({
        snapshot: '- button "Go"',
        refs: { b1: { role: 'button', name: 'Go', nth: 0 } },
      }),
    ),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    evaluate: vi.fn(async () => 42),
    close: vi.fn(async () => {}),
    ...over,
  };
}

// ---- mock DriverRegistry（headless/managed-profile → fake driver） ----
function makeRegistry(session: BrowserSession): DriverRegistry {
  const fakeDriver: BrowserDriver = {
    mode: 'headless',
    connect: vi.fn(async () => session),
  };
  return {
    get: () => fakeDriver,
  };
}

/** 生成带 sessionId 的 ctx（v0.0.46 attach 依赖 ctx.config.sessionId 传给 connectForToolRun） */
function makeCtx(sessionId = 'sA'): ToolCtx {
  return { config: { tools: [], sessionId }, workdir: '/tmp' };
}

describe('browser Tool: attach lazy connect（v0.0.46 P2/P6）', () => {
  it('P2 switch=on owner=null → connectForToolRun 被调 1 次；dispatchAction 走通', async () => {
    const session = makeSession();
    const connectForToolRun = vi.fn(
      async (): Promise<ConnectForToolRunResult> => ({ ok: true, session }),
    );
    const cm = makeConnectorManager({ connectForToolRun });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'navigate', url: 'https://x' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(connectForToolRun).toHaveBeenCalledTimes(1);
    expect(connectForToolRun).toHaveBeenCalledWith('browser', 'sA');
    expect(session.navigate).toHaveBeenCalledWith('https://x');
  });

  it('P6 not_enabled → isError 引导用户开启开关', async () => {
    const connectForToolRun = vi.fn(
      async (): Promise<ConnectForToolRunResult> => ({
        ok: false,
        error: { kind: 'not_enabled', message: 'ignored: tool 走引导文案' },
      }),
    );
    const cm = makeConnectorManager({ connectForToolRun });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'listPages' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('未启用');
    expect(text).toContain('连接器 → 浏览器');
  });

  it('in_use_by_other → isError 提示 owner sessionId', async () => {
    const connectForToolRun = vi.fn(
      async (): Promise<ConnectForToolRunResult> => ({
        ok: false,
        error: {
          kind: 'in_use_by_other',
          ownerSessionId: 'sX',
          message: 'ignored',
        },
      }),
    );
    const cm = makeConnectorManager({ connectForToolRun });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'listPages' }, makeCtx('sB'));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('sX');
    expect(text).toContain('disconnect');
  });

  it('connect_failed → isError 附带底层 message', async () => {
    const connectForToolRun = vi.fn(
      async (): Promise<ConnectForToolRunResult> => ({
        ok: false,
        error: { kind: 'connect_failed', message: 'ECONNREFUSED 9222' },
      }),
    );
    const cm = makeConnectorManager({ connectForToolRun });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'snapshot' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('连接失败');
    expect(text).toContain('ECONNREFUSED');
  });

  it('cm 无 connectForToolRun 方法 → isError 引导（fail-closed）', async () => {
    const cm = makeConnectorManager(); // 默认无 connectForToolRun
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'listPages' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('未启用');
  });
});

describe('browser Tool: attach disconnect（v0.0.46 P3）', () => {
  it('P3 attach action=disconnect → 调 cm.disconnect(id, sessionId)；isError:false', async () => {
    const disconnect = vi.fn(async () => {});
    const cm = makeConnectorManager({ disconnect });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'disconnect' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith('browser', 'sA');
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('已断开');
  });

  it('cm.disconnect 未定义 → isError「不支持断开」', async () => {
    const cm = makeConnectorManager(); // 无 disconnect
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'disconnect' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('不支持断开');
  });

  it('cm.disconnect 抛错 → 转 errorResult 不冒泡', async () => {
    const disconnect = vi.fn(async () => {
      throw new Error('driver kill boom');
    });
    const cm = makeConnectorManager({ disconnect });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'disconnect' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('driver kill boom');
  });

  it('mode=headless action=disconnect → 参数错误（disconnect 仅 attach）', async () => {
    const disconnect = vi.fn(async () => {});
    const cm = makeConnectorManager({ disconnect });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'headless', action: 'disconnect' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    expect((r.content[0] as { text: string }).text).toContain('仅 attach');
  });

  it('disconnect 无副作用（未连接也 OK；idempotent）', async () => {
    const disconnect = vi.fn(async () => {});
    const cm = makeConnectorManager({ disconnect });
    const tool = createBrowserTool({ connectorManager: cm });
    // 第一次
    const r1 = await tool.run({ mode: 'attach', action: 'disconnect' }, makeCtx('sA'));
    expect(r1.isError).toBe(false);
    // 第二次
    const r2 = await tool.run({ mode: 'attach', action: 'disconnect' }, makeCtx('sA'));
    expect(r2.isError).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});

describe('browser Tool: headless 流程', () => {
  it('connect → dispatch(snapshot) → finally close', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run({ mode: 'headless', action: 'snapshot' }, makeCtx());
    expect(r.isError).toBe(false);
    expect(session.snapshot).toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
  });

  it('navigate → session.navigate(url)', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'headless', action: 'navigate', url: 'https://example.com' },
      makeCtx(),
    );
    expect(r.isError).toBe(false);
    expect(session.navigate).toHaveBeenCalledWith('https://example.com');
  });

  it('driver.connect 抛错 → isError（finally 仍 close）', async () => {
    const reg: DriverRegistry = {
      get: () => ({
        mode: 'headless',
        connect: vi.fn(async () => {
          throw new Error('chrome not found');
        }),
      }),
    };
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run({ mode: 'headless', action: 'snapshot' }, makeCtx());
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('chrome not found');
  });

  it('无 driverRegistry → isError', async () => {
    const tool = createBrowserTool();
    const r = await tool.run({ mode: 'headless', action: 'snapshot' }, makeCtx());
    expect(r.isError).toBe(true);
  });
});

describe('browser Tool: dispatch action 映射（attach lazy connect 通过）', () => {
  async function runAttach(action: string, extra: Record<string, unknown> = {}) {
    const session = makeSession();
    const cm = makeConnectorManager({
      connectForToolRun: vi.fn(
        async (): Promise<ConnectForToolRunResult> => ({ ok: true, session }),
      ),
    });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action, ...extra }, makeCtx('sA'));
    return { r, session };
  }

  it('click(ref)', async () => {
    const { r, session } = await runAttach('click', { ref: 'b1' });
    expect(r.isError).toBe(false);
    expect(session.click).toHaveBeenCalledWith('b1');
  });

  it('type(ref,text)', async () => {
    const { r, session } = await runAttach('type', { ref: 'inp', text: 'hi' });
    expect(r.isError).toBe(false);
    expect(session.type).toHaveBeenCalledWith('inp', 'hi');
  });

  it('click 缺 ref → isError', async () => {
    const { r } = await runAttach('click');
    expect(r.isError).toBe(true);
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
  it('未知 action → isError（走 attach dispatchAction default 分支）', async () => {
    const session = makeSession();
    const cm = makeConnectorManager({
      connectForToolRun: vi.fn(
        async (): Promise<ConnectForToolRunResult> => ({ ok: true, session }),
      ),
    });
    const t = createBrowserTool({ connectorManager: cm });
    const r = await t.run({ mode: 'attach', action: 'fly' }, makeCtx('sA'));
    expect(r.isError).toBe(true);
  });
});

describe('browser Tool: cdpUrl SSRF 门禁（仅非 loopback）', () => {
  // spec browser_tool §4/§6 + refs/openclaw cdp-reachability-policy:
  // CDP 控制面 ≠ 页面导航——loopback（127.x/::1/localhost）CDP 豁免 SSRF；
  // 非 loopback（私网/link-local/file://）仍 fail-closed。
  it('cdpUrl=127.0.0.1 loopback → SSRF 放行（CDP 控制面豁免）', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://127.0.0.1:9222' },
      makeCtx(),
    );
    // loopback 放行——attach 路径无 cm → 走 not_enabled 分支，但关键是不被 SSRF 拦
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('cdpUrl=[::1] loopback → SSRF 放行', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://[::1]:9222' },
      makeCtx(),
    );
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('cdpUrl=localhost loopback → SSRF 放行', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://localhost:9222' },
      makeCtx(),
    );
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('cdpUrl=10.x 私网 → isError', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://10.0.0.5:9222' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('SSRF');
  });

  it('cdpUrl=192.168.x 私网 → isError', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://192.168.1.1:9222' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('SSRF');
  });

  it('cdpUrl=169.254.169.254 link-local（云元数据）→ isError SSRF', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://169.254.169.254:9222' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('SSRF');
  });

  it('cdpUrl=file:// → isError（协议被禁）', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'file:///etc/passwd' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
  });

  it('cdpUrl=公网 IP → SSRF 放行（不因 SSRF 拒绝）', async () => {
    const session = makeSession();
    const reg = makeRegistry(session);
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'attach', action: 'listPages', cdpUrl: 'http://93.184.216.34:9222' },
      makeCtx(),
    );
    // 公网 IP 放行——无 cm → 未启用引导（关键：不是 SSRF 拒绝）
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain('SSRF');
  });

  it('无 cdpUrl → 不触发 SSRF 门禁（正常流程）', async () => {
    const session = makeSession();
    const cm = makeConnectorManager({
      connectForToolRun: vi.fn(
        async (): Promise<ConnectForToolRunResult> => ({ ok: true, session }),
      ),
    });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run({ mode: 'attach', action: 'listPages' }, makeCtx('sA'));
    expect(r.isError).toBe(false);
    expect(session.listPages).toHaveBeenCalled();
  });
});

// 截图本地化（INV-157-1/3）：attach + headless 两路径均落盘，tool_result 纯文本无 base64
describe('browser Tool: screenshot 落盘', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'browser-screenshot-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** 生成带 toolCallId + tmpdir workdir 的 ctx（截图落盘必需） */
  function makeCtxForSnapshot(toolCallId: string): ToolCtx {
    return { config: { tools: [], sessionId: 'sA' }, workdir: tmpRoot, toolCallId };
  }

  it('attach screenshot → saveSnapshot 落盘 + 文案含 snapshots/ + 不含 base64', async () => {
    // mock session.screenshot 返 PNG magic bytes + mime
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const session = makeSession({
      screenshot: vi.fn(async () => ({ mime: 'image/png', data: pngBytes })),
    });
    const cm = makeConnectorManager({
      connectForToolRun: vi.fn(
        async (): Promise<ConnectForToolRunResult> => ({ ok: true, session }),
      ),
    });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run(
      { mode: 'attach', action: 'screenshot' },
      makeCtxForSnapshot('call_attach_1'),
    );
    // isError=false
    expect(r.isError).toBe(false);
    const text = (r.content[0] as { text: string }).text;
    // 关键：tool_result 文案含 snapshots/ + browser screenshot + see_image 引导
    expect(text).toContain('snapshots/');
    expect(text).toContain('browser screenshot');
    expect(text).toContain('see_image');
    // INV-157-1：不含 base64 字串（pngBytes 的 base64 不该出现在 text 里）
    const b64 = pngBytes.toString('base64');
    expect(text).not.toContain(b64);
    expect(text).not.toContain('data:');
    // INV-157-2/3：文件确定性命名 + 落盘成功
    const expectedPath = join(tmpRoot, 'snapshots', 'call_attach_1.png');
    expect(existsSync(expectedPath)).toBe(true);
    const written = readFileSync(expectedPath);
    expect(written.equals(pngBytes)).toBe(true);
  });

  it('attach screenshot: session 无 screenshot 方法 → isError', async () => {
    // makeSession 默认不设 screenshot（undefined）—— 但默认 makeSession 也没 screenshot 字段，
    // 显式构造一个不带 screenshot 的 session 验证 errorResult 分支
    const session: BrowserSession = {
      listPages: vi.fn(async () => []),
      selectPage: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      snapshot: vi.fn(async () => ({ snapshot: '', refs: {} })),
      click: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined),
      close: vi.fn(async () => {}),
    };
    const cm = makeConnectorManager({
      connectForToolRun: vi.fn(
        async (): Promise<ConnectForToolRunResult> => ({ ok: true, session }),
      ),
    });
    const tool = createBrowserTool({ connectorManager: cm });
    const r = await tool.run(
      { mode: 'attach', action: 'screenshot' },
      makeCtxForSnapshot('call_no_supp'),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('不支持');
  });

  it('headless executeOnce screenshot → 拦截 decode+落盘（worker 协议不变）', async () => {
    // mock driver.executeOnce 返 r.text = JSON.stringify({mime, data:base64})
    // —— 模拟 worker boundary 协议（driver 契约不变）
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fakeDriver: BrowserDriver = {
      mode: 'headless',
      connect: vi.fn(async () => ({}) as unknown as BrowserSession),
      executeOnce: vi.fn(async () => ({
        ok: true,
        text: JSON.stringify({ mime: 'image/png', data: pngBytes.toString('base64') }),
      })),
    };
    const reg: DriverRegistry = { get: () => fakeDriver };
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'headless', action: 'screenshot' },
      makeCtxForSnapshot('call_headless_1'),
    );
    // 拦截成功 → 落盘 + 路径文本
    expect(r.isError).toBe(false);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('snapshots/call_headless_1.png');
    expect(text).toContain('browser screenshot');
    // 不含 base64 原文
    expect(text).not.toContain(pngBytes.toString('base64'));
    // 文件落盘且内容正确（base64 解码后 == 原 Buffer）
    const expectedPath = join(tmpRoot, 'snapshots', 'call_headless_1.png');
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath).equals(pngBytes)).toBe(true);
  });

  it('headless executeOnce 非 screenshot action（navigate）→ 保持原 textResult(r.text)', async () => {
    // 验证拦截仅对 screenshot 生效，其他 action 不动
    const fakeDriver: BrowserDriver = {
      mode: 'headless',
      connect: vi.fn(async () => ({}) as unknown as BrowserSession),
      executeOnce: vi.fn(async () => ({
        ok: true,
        text: 'navigated to https://example.com',
      })),
    };
    const reg: DriverRegistry = { get: () => fakeDriver };
    const tool = createBrowserTool({ driverRegistry: reg });
    const r = await tool.run(
      { mode: 'headless', action: 'navigate', url: 'https://example.com' },
      makeCtxForSnapshot('call_nav'),
    );
    expect(r.isError).toBe(false);
    expect((r.content[0] as { text: string }).text).toBe('navigated to https://example.com');
    // 非 screenshot 不该落盘任何 snapshots 文件
    expect(existsSync(join(tmpRoot, 'snapshots'))).toBe(false);
  });
});

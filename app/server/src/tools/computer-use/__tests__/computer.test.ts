/**
 * computer tool 单测 —— 单 tool + 11 action dispatch + fail-closed 分层 + 按 action 权限门禁
 * 参考: app/server/src/tools/computer-use/computer.ts + actions/*
 *       change_plan_v2_batch2 §B2.1 A（11 action dispatch / ACTION_PERMS / 结果包装）
 *       specs/tech/version_logs/v0.0.157/change_plan.md §1 T2（screenshot/get_app_state 落盘验证）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computerTool, COMPUTER_ACTIONS } from '../computer';
import type { ToolCtx } from '../../types';
import type { TextBlock } from '../../../message/types';
import type {
  ComputerNativePort,
  ComputerPermissions,
} from '../../../platform/computer/native-port';

/** 每个用例独立的 tmpdir 作 workdir（验证截图落盘；afterEach 清理） */
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'computer-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造一个全 granted / 全成功的 fake port，可 override 单方法 */
function fakePort(over: Partial<ComputerNativePort> = {}, perms?: ComputerPermissions): ComputerNativePort {
  const p: ComputerPermissions = perms ?? { accessibility: 'granted', screenRecording: 'granted' };
  return {
    checkPermissions: async () => p,
    screenshot: async () => ({
      ok: true,
      mediaType: 'image/png',
      data: 'IMG',
      width: 2,
      height: 2,
      scaleFactor: 2,
      windowBounds: { x: 0, y: 0, w: 1, h: 1 },
    }),
    getAppState: async () => ({
      ok: true,
      screenshot: { ok: true, data: 'STATEIMG', mediaType: 'image/png', width: 2, height: 2 },
      axText: '[0] AXButton "OK"',
      pid: 9,
      scaleFactor: 2,
      windowBounds: { x: 0, y: 0, w: 1, h: 1 },
    }),
    readAxTree: async () => ({ ok: true, text: '[0] AXButton "OK"', nodes: [], pid: 9, scaleFactor: 2 }),
    listApps: async () => [{ bundleId: 'com.apple.Safari', name: 'Safari', pid: 501, isRunning: true }],
    click: async () => ({ ok: true }),
    type: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    pressKey: async () => ({ ok: true }),
    drag: async () => ({ ok: true }),
    setValue: async () => ({ ok: true }),
    performSecondaryAction: async () => ({ ok: true }),
    ...over,
  };
}

/** 造 ToolCtx（注入 port + sessionId；over 覆盖 workdir/toolCallId 等字段） */
function ctxWith(
  port: ComputerNativePort | undefined,
  sessionId = 'sid-1',
  over: Partial<ToolCtx> = {},
): ToolCtx {
  return {
    config: { tools: [], sessionId, computerNativePort: port },
    workdir: '/tmp',
    ...over,
  } as unknown as ToolCtx;
}

function text(r: { content: unknown[] }): string {
  return (r.content[0] as TextBlock).text;
}

describe('computerTool.definition', () => {
  it('name=computer, action-discriminated schema, description 含 (computer use)', () => {
    expect(computerTool.definition.name).toBe('computer');
    expect(computerTool.definition.inputSchema.additionalProperties).toBe(false);
    expect(computerTool.definition.inputSchema.required).toEqual(['action']);
    expect(computerTool.definition.description).toContain('computer use');
    const actionProp = computerTool.definition.inputSchema.properties?.action as { enum?: string[] };
    expect(actionProp.enum).toEqual([...COMPUTER_ACTIONS]);
  });

  it('COMPUTER_ACTIONS = 11 action（对齐 open-codex 9 + 2 补充）', () => {
    expect(COMPUTER_ACTIONS).toHaveLength(11);
    expect([...COMPUTER_ACTIONS]).toEqual([
      'get_app_state', 'list_apps', 'screenshot', 'read_ax_tree', 'click',
      'perform_secondary_action', 'scroll', 'drag', 'type_text', 'press_key', 'set_value',
    ]);
  });
});

describe('computerTool.run — fail-closed 前置分层', () => {
  it('未知 action → errorResult（引导有效 action 列表）', async () => {
    const r = await computerTool.run({ action: 'nope' }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('未知 action');
  });

  it('action 缺失 / 非 string → errorResult', async () => {
    const r = await computerTool.run({}, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('未知 action');
  });

  it('port 未注入 → errorResult「桌面 App」（不调 port）', async () => {
    const r = await computerTool.run({ action: 'screenshot' }, ctxWith(undefined));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('桌面 App');
  });

  it('screenshot：screenRecording missing → 门禁 errorResult（screenshot 不被调）', async () => {
    const screenshot = vi.fn(async () => ({ ok: true, data: 'x' }));
    const port = fakePort({ screenshot }, { accessibility: 'granted', screenRecording: 'missing' });
    const r = await computerTool.run({ action: 'screenshot' }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('屏幕录制');
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('click：accessibility missing → 门禁 errorResult（click 不被调，含「辅助功能」）', async () => {
    const click = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ click }, { accessibility: 'missing', screenRecording: 'granted' });
    const r = await computerTool.run({ action: 'click', element_index: 1 }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('辅助功能');
    expect(click).not.toHaveBeenCalled();
  });

  it('screenshot 的门禁只查 screenRecording（accessibility missing 不挡截图）', async () => {
    const port = fakePort({}, { accessibility: 'missing', screenRecording: 'granted' });
    const r = await computerTool.run(
      { action: 'screenshot' },
      ctxWith(port, 'sid-1', { workdir: tmpRoot, toolCallId: 'call_perm_1' }),
    );
    expect(r.isError).toBe(false);
    // screenshot 落盘 → TextBlock(路径 + see_image 引导)
    expect(text(r)).toContain('snapshots/');
    expect(text(r)).toContain('see_image');
  });

  it('get_app_state：双门禁——accessibility missing 挡（screenRecording granted 不够）', async () => {
    const getAppState = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ getAppState }, { accessibility: 'missing', screenRecording: 'granted' });
    const r = await computerTool.run({ action: 'get_app_state' }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('辅助功能');
    expect(getAppState).not.toHaveBeenCalled();
  });

  it('get_app_state：双门禁——screenRecording missing 挡', async () => {
    const getAppState = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ getAppState }, { accessibility: 'granted', screenRecording: 'missing' });
    const r = await computerTool.run({ action: 'get_app_state' }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('屏幕录制');
    expect(getAppState).not.toHaveBeenCalled();
  });
});

describe('computerTool.run — 读类 action dispatch', () => {
  it('get_app_state → [TextBlock(路径), TextBlock(AX 树)]，映射 opts，截图落盘', async () => {
    const getAppState = vi.fn(async () => ({
      ok: true,
      screenshot: { ok: true as const, data: 'GIMG', mediaType: 'image/png' as const, width: 2, height: 2 },
      axText: 'TREE',
      windowBounds: { x: 0, y: 0, w: 1, h: 1 },
      scaleFactor: 2,
    }));
    const port = fakePort({ getAppState });
    const r = await computerTool.run(
      { action: 'get_app_state', app: 'Notes', text_limit: 100, max_tree_nodes: 50, max_tree_depth: 8 },
      ctxWith(port, 'sid-1', { workdir: tmpRoot, toolCallId: 'call_gas_1' }),
    );
    expect(r.isError).toBe(false);
    // 截图落盘 → 2 TextBlock 顺序 [path, axText]（INV-157-1）
    expect(r.content).toHaveLength(2);
    expect((r.content[0] as TextBlock).type).toBe('text');
    expect((r.content[0] as TextBlock).text).toContain('snapshots/call_gas_1.png');
    expect((r.content[0] as TextBlock).text).toContain('see_image');
    expect((r.content[0] as TextBlock).text).toContain('2x2');
    expect((r.content[1] as TextBlock).text).toBe('TREE');
    // 落盘验证（not just text）
    expect(existsSync(join(tmpRoot, 'snapshots', 'call_gas_1.png'))).toBe(true);
    expect(getAppState).toHaveBeenCalledWith({ app: 'Notes', textLimit: 100, maxNodes: 50, maxDepth: 8 });
  });

  it('get_app_state：!ok → errorResult(reason)', async () => {
    const port = fakePort({ getAppState: async () => ({ ok: false, reason: 'no-app' }) });
    const r = await computerTool.run({ action: 'get_app_state' }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('no-app');
  });

  it('list_apps → TextBlock（含 app name/bundleId/pid）', async () => {
    const r = await computerTool.run({ action: 'list_apps' }, ctxWith(fakePort()));
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('Safari');
    expect(text(r)).toContain('com.apple.Safari');
    expect(text(r)).toContain('501');
  });

  it('list_apps：空列表 → 提示文本', async () => {
    const port = fakePort({ listApps: async () => [] });
    const r = await computerTool.run({ action: 'list_apps' }, ctxWith(port));
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('未发现');
  });

  it('screenshot → TextBlock(snapshots/ + see_image + 尺寸)，app 透传，落盘验证', async () => {
    const screenshot = vi.fn(async () => ({
      ok: true as const, mediaType: 'image/png' as const, data: 'IMG', width: 2, height: 2,
      windowBounds: { x: 0, y: 0, w: 1, h: 1 },
    }));
    const port = fakePort({ screenshot });
    const r = await computerTool.run(
      { action: 'screenshot', app: 'Safari' },
      ctxWith(port, 'sid-1', { workdir: tmpRoot, toolCallId: 'call_test_1' }),
    );
    expect(r.isError).toBe(false);
    // 截图落盘 → TextBlock(路径 + 尺寸 + see_image 引导)
    expect(text(r)).toContain('snapshots/call_test_1.png');
    expect(text(r)).toContain('see_image');
    expect(text(r)).toContain('2x2');
    // 落盘验证（content[0] 文本对应真实文件存在）
    expect(existsSync(join(tmpRoot, 'snapshots', 'call_test_1.png'))).toBe(true);
    expect(screenshot).toHaveBeenCalledWith({ app: 'Safari' });
  });

  it('screenshot：port.screenshot !ok → errorResult(reason)', async () => {
    const port = fakePort({ screenshot: async () => ({ ok: false, reason: 'no-source' }) });
    const r = await computerTool.run({ action: 'screenshot' }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('no-source');
  });

  it('read_ax_tree → TextBlock(AX 文本)，映射 app/text_limit → readAxTree opts', async () => {
    const readAxTree = vi.fn(async () => ({ ok: true, text: 'TREE', scaleFactor: 2 }));
    const port = fakePort({ readAxTree });
    const r = await computerTool.run(
      { action: 'read_ax_tree', app: 'Notes', text_limit: 100, max_tree_nodes: 50, max_tree_depth: 8 },
      ctxWith(port),
    );
    expect(r.isError).toBe(false);
    expect(text(r)).toBe('TREE');
    expect(readAxTree).toHaveBeenCalledWith({ app: 'Notes', textLimit: 100, maxNodes: 50, maxDepth: 8 });
  });

  it('read_ax_tree：!ok → errorResult(reason)', async () => {
    const port = fakePort({ readAxTree: async () => ({ ok: false, reason: 'ax-fail' }) });
    const r = await computerTool.run({ action: 'read_ax_tree' }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('ax-fail');
  });
});

describe('computerTool.run — 动作类 action dispatch', () => {
  it('click element_index → port.click({elementIndex}, {button,clickCount})', async () => {
    const click = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ click });
    const r = await computerTool.run(
      { action: 'click', element_index: 3, mouse_button: 'right', click_count: 2, app: 'Safari' },
      ctxWith(port),
    );
    expect(r.isError).toBe(false);
    expect(click).toHaveBeenCalledWith({ elementIndex: 3 }, { button: 'right', clickCount: 2, app: 'Safari' });
  });

  it('click 无 target（无 element_index / 无 x,y）→ errorResult', async () => {
    const r = await computerTool.run({ action: 'click' }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('element_index');
  });

  it('click：port.click !ok → errorResult(reason)', async () => {
    const port = fakePort({ click: async () => ({ ok: false, reason: 'click-fail' }) });
    const r = await computerTool.run({ action: 'click', element_index: 1 }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('click-fail');
  });

  it('perform_secondary_action → port.performSecondaryAction(idx,name,{app})', async () => {
    const fn = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ performSecondaryAction: fn });
    const r = await computerTool.run(
      { action: 'perform_secondary_action', element_index: 2, secondary_action: 'Raise', app: 'Safari' },
      ctxWith(port),
    );
    expect(r.isError).toBe(false);
    expect(fn).toHaveBeenCalledWith(2, 'Raise', { app: 'Safari' });
  });

  it('perform_secondary_action 缺 secondary_action → errorResult', async () => {
    const r = await computerTool.run({ action: 'perform_secondary_action', element_index: 2 }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('secondary_action');
  });

  it('perform_secondary_action 缺 element_index → errorResult', async () => {
    const r = await computerTool.run(
      { action: 'perform_secondary_action', secondary_action: 'Raise' },
      ctxWith(fakePort()),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('element_index');
  });

  it('scroll 有 direction + element_index → port.scroll(target,{direction,pages,app})', async () => {
    const scroll = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ scroll });
    const r = await computerTool.run(
      { action: 'scroll', direction: 'down', element_index: 2, pages: 3, app: 'Safari' },
      ctxWith(port),
    );
    expect(r.isError).toBe(false);
    expect(scroll).toHaveBeenCalledWith({ elementIndex: 2 }, { direction: 'down', pages: 3, app: 'Safari' });
  });

  it('scroll 缺 direction → errorResult', async () => {
    const r = await computerTool.run({ action: 'scroll', element_index: 2 }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('direction');
  });

  it('drag 四坐标 → port.drag(from,to,{app})（无坐标上下文 scale=1/origin=0）', async () => {
    const drag = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ drag });
    const r = await computerTool.run(
      { action: 'drag', from_x: 10, from_y: 20, to_x: 30, to_y: 40, app: 'Safari' },
      ctxWith(port, 'sid-drag-fresh'),
    );
    expect(r.isError).toBe(false);
    expect(drag).toHaveBeenCalledWith({ x: 10, y: 20 }, { x: 30, y: 40 }, { app: 'Safari' });
  });

  it('drag 缺坐标 → errorResult', async () => {
    const r = await computerTool.run({ action: 'drag', from_x: 10, from_y: 20 }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('from_x');
  });

  it('type_text 有 text → port.type(text,{app})', async () => {
    const type = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ type });
    const r = await computerTool.run({ action: 'type_text', text: 'hello', app: 'Notes' }, ctxWith(port));
    expect(r.isError).toBe(false);
    expect(type).toHaveBeenCalledWith('hello', { app: 'Notes' });
  });

  it('type_text 缺 text → errorResult', async () => {
    const r = await computerTool.run({ action: 'type_text' }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('text');
  });

  it('press_key 有 key → port.pressKey(key,{app})', async () => {
    const pressKey = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ pressKey });
    const r = await computerTool.run({ action: 'press_key', key: 'cmd+s' }, ctxWith(port));
    expect(r.isError).toBe(false);
    expect(pressKey).toHaveBeenCalledWith('cmd+s', {});
  });

  it('press_key 缺 key → errorResult', async () => {
    const r = await computerTool.run({ action: 'press_key' }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('key');
  });

  it('set_value 有 element_index+value → port.setValue(idx,value,{app})', async () => {
    const setValue = vi.fn(async () => ({ ok: true }));
    const port = fakePort({ setValue });
    const r = await computerTool.run(
      { action: 'set_value', element_index: 4, value: 'new text', app: 'Notes' },
      ctxWith(port),
    );
    expect(r.isError).toBe(false);
    expect(setValue).toHaveBeenCalledWith(4, 'new text', { app: 'Notes' });
  });

  it('set_value 缺 value → errorResult', async () => {
    const r = await computerTool.run({ action: 'set_value', element_index: 4 }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('value');
  });

  it('set_value 缺 element_index → errorResult', async () => {
    const r = await computerTool.run({ action: 'set_value', value: 'x' }, ctxWith(fakePort()));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('element_index');
  });
});

describe('computerTool.run — v0.0.160 新增 (state_unavailable 友好文案 + list_apps Spotlight line)', () => {
  it('type_text state_unavailable → 友好前缀 + 保留原始 message', async () => {
    const port = fakePort({
      type: async () => ({
        ok: false,
        reason: 'type_text requires a focused editable text element.',
        code: 'state_unavailable',
      }),
    });
    const r = await computerTool.run({ action: 'type_text', text: 'hi' }, ctxWith(port));
    expect(r.isError).toBe(true);
    const msg = text(r);
    // 友好前缀（引导 LLM）
    expect(msg).toContain('无法输入');
    expect(msg).toContain('目标元素不接受文本输入或已消失');
    // 引导建议
    expect(msg).toMatch(/click|set_value/);
    // 保留原始 message 供 debug（不吞异常）
    expect(msg).toContain('type_text requires a focused editable text element');
  });

  it('type_text 其他 code / 无 code → 原有错误文案（不加友好前缀）', async () => {
    const port = fakePort({
      type: async () => ({ ok: false, reason: 'timeout' }),
    });
    const r = await computerTool.run({ action: 'type_text', text: 'hi' }, ctxWith(port));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('输入文本失败');
    expect(text(r)).toContain('timeout');
    expect(text(r)).not.toContain('无法输入：目标元素不接受');
  });

  it('set_value state_unavailable → 友好前缀 + 建议重新 get_app_state', async () => {
    const port = fakePort({
      setValue: async () => ({
        ok: false,
        reason: 'element gone',
        code: 'state_unavailable',
      }),
    });
    const r = await computerTool.run(
      { action: 'set_value', element_index: 7, value: 'x' },
      ctxWith(port),
    );
    expect(r.isError).toBe(true);
    const msg = text(r);
    expect(msg).toContain('无法赋值');
    expect(msg).toContain('element_index=7');
    expect(msg).toContain('get_app_state');
    expect(msg).toContain('element gone');
  });

  it('set_value 无 code → 原有错误文案', async () => {
    const port = fakePort({ setValue: async () => ({ ok: false, reason: 'oops' }) });
    const r = await computerTool.run(
      { action: 'set_value', element_index: 4, value: 'x' },
      ctxWith(port),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('赋值失败');
    expect(text(r)).toContain('oops');
    expect(text(r)).not.toContain('无法赋值');
  });

  it('list_apps：AppInfo 带 line → 使用 Swift AppDiscovery 渲染行（含 flags）', async () => {
    const port = fakePort({
      listApps: async () => [
        {
          bundleId: 'com.apple.Safari',
          name: 'Safari',
          pid: 501,
          isRunning: true,
          isFrontmost: true,
          line: 'Safari — com.apple.Safari [frontmost, running]',
        },
        {
          bundleId: 'com.apple.mail',
          name: 'Mail',
          pid: 0,
          isRunning: false,
          lastUsed: '2026-07-10',
          uses: 42,
          line: 'Mail — com.apple.mail [last-used=2026-07-10, uses=42]',
        },
      ],
    });
    const r = await computerTool.run({ action: 'list_apps' }, ctxWith(port));
    expect(r.isError).toBe(false);
    const msg = text(r);
    expect(msg).toContain('Safari — com.apple.Safari [frontmost, running]');
    expect(msg).toContain('Mail — com.apple.mail [last-used=2026-07-10, uses=42]');
    // 不重排（Swift 已排好）
    expect(msg.indexOf('Safari')).toBeLessThan(msg.indexOf('Mail'));
  });

  it('list_apps：AppInfo 无 line → 回退旧格式（保后向兼容）', async () => {
    const port = fakePort({
      listApps: async () => [
        { bundleId: 'com.example', name: 'Example', pid: 1234, isRunning: true },
      ],
    });
    const r = await computerTool.run({ action: 'list_apps' }, ctxWith(port));
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('- Example (com.example) pid=1234');
  });

  it('read_ax_tree：text_limit="max" → 透传给 port.readAxTree', async () => {
    const readAxTree = vi.fn(async () => ({ ok: true, text: 'BIG', scaleFactor: 1 }));
    const port = fakePort({ readAxTree });
    const r = await computerTool.run({ action: 'read_ax_tree', text_limit: 'max' }, ctxWith(port));
    expect(r.isError).toBe(false);
    expect(readAxTree).toHaveBeenCalledWith({ textLimit: 'max' });
  });

  it('get_app_state：text_limit="max" → 透传给 port.getAppState', async () => {
    const getAppState = vi.fn(async () => ({
      ok: true as const,
      screenshot: { ok: true as const, data: 'X', mediaType: 'image/png' as const, width: 1, height: 1 },
      axText: 'A',
      pid: 1,
      scaleFactor: 1,
      windowBounds: { x: 0, y: 0, w: 1, h: 1 },
    }));
    const port = fakePort({ getAppState });
    const r = await computerTool.run(
      { action: 'get_app_state', text_limit: 'max' },
      ctxWith(port, 'sid-1', { workdir: tmpRoot, toolCallId: 'call_max' }),
    );
    expect(r.isError).toBe(false);
    expect(getAppState).toHaveBeenCalledWith({ textLimit: 'max' });
  });
});

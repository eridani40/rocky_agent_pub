/**
 * session-state 单测 —— 坐标上下文 per-sessionId 缓存 + screenshot/get_app_state→coordinate click 集成
 * 参考: app/server/src/tools/computer-use/session-state.ts + computer.ts
 *       change_plan_v2_batch2 §B2.1 决策C（screenshot/get_app_state 缓存 {scaleFactor,windowBounds}，
 *       coordinate click 消费 window-relative 三段式；read_ax_tree AX-only 不建坐标上下文）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getComputerState, setComputerCoordContext } from '../session-state';
import { computerTool } from '../computer';
import type { ToolCtx } from '../../types';
import type { ComputerNativePort } from '../../../platform/computer/native-port';

/**
 * screenshot/get_app_state 集成路径走 saveSnapshot 落盘 → 需真实 workdir（tmpdir 隔离）
 * + 稳定 toolCallId（避 unknown-<ts> warn 噪音 + 路径确定性）。
 */
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'session-state-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('session-state（坐标上下文 per-sessionId）', () => {
  it('setComputerCoordContext 写 / getComputerState 读，按 sessionId 隔离', () => {
    setComputerCoordContext('sid-A', { scaleFactor: 2, windowBounds: { x: 5, y: 6, w: 100, h: 200 } });
    setComputerCoordContext('sid-B', { scaleFactor: 3 });
    expect(getComputerState('sid-A')?.scaleFactor).toBe(2);
    expect(getComputerState('sid-A')?.windowBounds).toEqual({ x: 5, y: 6, w: 100, h: 200 });
    expect(getComputerState('sid-B')?.scaleFactor).toBe(3);
    expect(getComputerState('sid-B')?.windowBounds).toBeUndefined();
    expect(getComputerState('sid-missing')).toBeUndefined();
  });

  it('缺省字段不覆盖已有值（二次写只更 windowBounds）', () => {
    setComputerCoordContext('sid-merge', { scaleFactor: 2 });
    setComputerCoordContext('sid-merge', { windowBounds: { x: 1, y: 1, w: 10, h: 10 } });
    expect(getComputerState('sid-merge')?.scaleFactor).toBe(2);
    expect(getComputerState('sid-merge')?.windowBounds).toEqual({ x: 1, y: 1, w: 10, h: 10 });
  });

  it('未写过的 session → undefined', () => {
    expect(getComputerState('never-set-sid')).toBeUndefined();
  });
});

describe('screenshot/get_app_state 建坐标上下文 → coordinate click 消费（集成）', () => {
  function fullPort(over: Partial<ComputerNativePort>): ComputerNativePort {
    return {
      checkPermissions: async () => ({ accessibility: 'granted', screenRecording: 'granted' }),
      screenshot: async () => ({ ok: true, data: 'x', width: 200, scaleFactor: 2, windowBounds: { x: 50, y: 60, w: 100, h: 80 } }),
      getAppState: async () => ({ ok: true, axText: 'TREE' }),
      readAxTree: async () => ({ ok: true, text: 'TREE', scaleFactor: 2 }),
      listApps: async () => [],
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
  function ctx(port: ComputerNativePort, sessionId: string): ToolCtx {
    return {
      config: { tools: [], sessionId, computerNativePort: port },
      workdir: tmpRoot,
      toolCallId: `call_${sessionId}`,
    } as unknown as ToolCtx;
  }

  it('screenshot 返 width=200/windowBounds{w:100,origin(50,60)} → deriveScaleFactor=2 缓存 → coordinate click 三段式', async () => {
    const click = vi.fn(async () => ({ ok: true }));
    const port = fullPort({ click });
    const sid = 'sid-shot-int';
    // screenshot 建坐标上下文：scaleFactor = width/windowBounds.w = 200/100 = 2
    await computerTool.run({ action: 'screenshot' }, ctx(port, sid));
    expect(getComputerState(sid)?.scaleFactor).toBe(2);
    expect(getComputerState(sid)?.windowBounds).toEqual({ x: 50, y: 60, w: 100, h: 80 });
    // coordinate click：x=640 → 640/2 + 50 = 370；y=400 → 400/2 + 60 = 260
    await computerTool.run({ action: 'click', x: 640, y: 400 }, ctx(port, sid));
    expect(click).toHaveBeenCalledWith({ coordinate: { x: 370, y: 260 } }, {});
  });

  it('get_app_state 建坐标上下文 → coordinate click 消费', async () => {
    const click = vi.fn(async () => ({ ok: true }));
    const port = fullPort({
      getAppState: async () => ({
        ok: true,
        screenshot: { ok: true, data: 'x', width: 100 },
        axText: 'TREE',
        scaleFactor: 2,
        windowBounds: { x: 0, y: 0, w: 50, h: 40 },
      }),
      click,
    });
    const sid = 'sid-state-int';
    await computerTool.run({ action: 'get_app_state' }, ctx(port, sid));
    // scaleFactor = screenshot.width/windowBounds.w = 100/50 = 2
    expect(getComputerState(sid)?.scaleFactor).toBe(2);
    await computerTool.run({ action: 'click', x: 200, y: 100 }, ctx(port, sid));
    expect(click).toHaveBeenCalledWith({ coordinate: { x: 100, y: 50 } }, {});
  });

  it('read_ax_tree AX-only 不建坐标上下文（无 windowBounds → coordinate click 退化 origin=0）', async () => {
    const click = vi.fn(async () => ({ ok: true }));
    const port = fullPort({ click });
    const sid = 'sid-axonly-int';
    await computerTool.run({ action: 'read_ax_tree' }, ctx(port, sid));
    // read_ax_tree 不写坐标上下文
    expect(getComputerState(sid)).toBeUndefined();
    // coordinate click：无缓存 → scale=1, origin=0 → 原样透传
    await computerTool.run({ action: 'click', x: 300, y: 150 }, ctx(port, sid));
    expect(click).toHaveBeenCalledWith({ coordinate: { x: 300, y: 150 } }, {});
  });
});

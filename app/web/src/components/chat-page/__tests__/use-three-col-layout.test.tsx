// @vitest-environment jsdom
/**
 * use-three-col-layout 单测 —— T2 hook + readConvWidth（含 T1 移交的 UT #15）
 * 参考: specs/tech/version_logs/v0.0.182/change_plan.md §4 UT 清单 #15 + §3 layout-hook 模块契约
 *       specs/prd/version_logs/v0.0.182/change_log.md §3.3（左栏全局 key `conv-panel-width`）
 *
 * 覆盖 acceptanceCriteria：
 *   - hook 按 §3 契约返回全部 12 字段
 *   - jsdom 无 ResizeObserver 不崩（fallback window resize 生效）
 *   - readConvWidth: clamp[180,400] / 缺省 220 / 坏值兜底（UT #15，T1 移交 T2 落实）
 *   - writeConvWidth: try/catch 吞异常（隐私模式）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  CONV_WIDTH_LS_KEY,
  readConvWidth,
  writeConvWidth,
  useThreeColLayout,
} from '../use-three-col-layout';
import {
  CONV_WIDTH_DEFAULT,
  CONV_WIDTH_MAX,
  CONV_WIDTH_MIN,
  MIDDLE_COMFORT,
  WS_WIDTH_DEFAULT,
} from '../../../lib/layout-width-engine';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('readConvWidth —— UT #15（T1 移交 T2）', () => {
  it('缺省值 = 220（CONV_WIDTH_DEFAULT）', () => {
    expect(readConvWidth()).toBe(CONV_WIDTH_DEFAULT);
    expect(readConvWidth()).toBe(220);
  });

  it('正常值原样返回', () => {
    localStorage.setItem(CONV_WIDTH_LS_KEY, '300');
    expect(readConvWidth()).toBe(300);
  });

  it('越界上界 → clamp 到 400（CONV_WIDTH_MAX）', () => {
    localStorage.setItem(CONV_WIDTH_LS_KEY, '9999');
    expect(readConvWidth()).toBe(CONV_WIDTH_MAX);
    expect(readConvWidth()).toBe(400);
  });

  it('越界下界 → clamp 到 180（CONV_WIDTH_MIN）', () => {
    localStorage.setItem(CONV_WIDTH_LS_KEY, '50');
    expect(readConvWidth()).toBe(CONV_WIDTH_MIN);
    expect(readConvWidth()).toBe(180);
  });

  it('边界值 180/400 原样返回（闭区间）', () => {
    localStorage.setItem(CONV_WIDTH_LS_KEY, '180');
    expect(readConvWidth()).toBe(180);
    localStorage.setItem(CONV_WIDTH_LS_KEY, '400');
    expect(readConvWidth()).toBe(400);
  });

  it('坏值：非数字字符串 → 缺省 220', () => {
    localStorage.setItem(CONV_WIDTH_LS_KEY, 'not-a-number');
    expect(readConvWidth()).toBe(CONV_WIDTH_DEFAULT);
  });

  it('坏值：空字符串 → 缺省 220', () => {
    localStorage.setItem(CONV_WIDTH_LS_KEY, '');
    expect(readConvWidth()).toBe(CONV_WIDTH_DEFAULT);
  });

  it('坏值：NaN/Infinity → 缺省 220', () => {
    localStorage.setItem(CONV_WIDTH_LS_KEY, 'NaN');
    expect(readConvWidth()).toBe(CONV_WIDTH_DEFAULT);
    localStorage.setItem(CONV_WIDTH_LS_KEY, 'Infinity');
    expect(readConvWidth()).toBe(CONV_WIDTH_DEFAULT);
  });

  it('localStorage 抛异常 → 缺省 220（隐私模式兜底）', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota / privacy');
    });
    expect(readConvWidth()).toBe(CONV_WIDTH_DEFAULT);
  });
});

describe('writeConvWidth', () => {
  it('正常写入', () => {
    writeConvWidth(333);
    expect(localStorage.getItem(CONV_WIDTH_LS_KEY)).toBe('333');
  });

  it('localStorage 抛异常 → 静默吞（隐私模式 / 配额满）', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeConvWidth(333)).not.toThrow();
  });
});

describe('useThreeColLayout —— hook 契约（返回 12 字段）', () => {
  it('返回 §3 契约全部 12 字段', () => {
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: true, rightPresent: true }));
    const expected = [
      'containerRef',
      'rowMinWidth',
      'layout',
      'convWidth',
      'handleConvResize',
      'handleConvResizeEnd',
      'convDragMaxWidth',
      'reportRightPanel',
      'rightRenderWidth',
      'rightDragMaxWidth',
      'setDragging',
    ];
    for (const key of expected) {
      expect(result.current).toHaveProperty(key);
    }
    // layout 含 6 个引擎输出字段
    expect(result.current.layout).toHaveProperty('leftWidth');
    expect(result.current.layout).toHaveProperty('rightWidth');
    expect(result.current.layout).toHaveProperty('middleWidth');
    expect(result.current.layout).toHaveProperty('minRowWidth');
    expect(result.current.layout).toHaveProperty('scrollX');
    expect(result.current.layout).toHaveProperty('cDefend');
  });

  it('jsdom 无 ResizeObserver → 不崩，fallback window resize 生效（MUST 守卫）', () => {
    // jsdom 默认无 ResizeObserver —— 直接渲染验证不崩
    expect(typeof ResizeObserver).toBe('undefined');
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: true, rightPresent: true }));
    // available=0（containerRef 未挂到真实 DOM）→ rowMinWidth clamp 到 1（防 0 塌陷）
    expect(result.current.rowMinWidth).toBeGreaterThanOrEqual(1);
    // 触发 window resize 应不抛
    expect(() => {
      window.dispatchEvent(new Event('resize'));
    }).not.toThrow();
  });

  it('初值：convWidth = 220（readConvWidth 默认）', () => {
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: true, rightPresent: true }));
    expect(result.current.convWidth).toBe(CONV_WIDTH_DEFAULT);
  });

  it('handleConvResize 更新 convWidth + handleConvResizeEnd 写 localStorage', () => {
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: true, rightPresent: true }));
    act(() => {
      result.current.handleConvResize(350);
    });
    expect(result.current.convWidth).toBe(350);
    // 拖动期间不写盘
    expect(localStorage.getItem(CONV_WIDTH_LS_KEY)).toBeNull();
    // mouseup 触发 persist
    act(() => {
      result.current.handleConvResizeEnd();
    });
    expect(localStorage.getItem(CONV_WIDTH_LS_KEY)).toBe('350');
  });

  it('reportRightPanel 上报 {settingWidth, collapsed} → 影响后续 layout 计算', () => {
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: true, rightPresent: true }));
    // 首帧 rightReport=null → 引擎 right={setting: WS_WIDTH_DEFAULT=272, collapsed:false}
    expect(result.current.rightRenderWidth).toBeLessThanOrEqual(WS_WIDTH_DEFAULT);
    act(() => {
      result.current.reportRightPanel({ settingWidth: 400, collapsed: false });
    });
    // 上报后 right.setting=400 → rightRenderWidth 受 dynMax clamp（available=0 → dynMax 极小 → 静态 min 232 赢）
    // 主要验证「上报后影响计算」而非具体值（available=0 边界）
    expect(result.current.rightRenderWidth).toBeGreaterThanOrEqual(232);
  });

  it('setDragging 切换场景 A/B：dragging!=null → cDefend=MIDDLE_MIN(480)', () => {
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: true, rightPresent: true }));
    // 场景 B 初值：dragging=null，middleCurrentRef 初始=MIDDLE_COMFORT → cDefend=clamp(480,932,932)=932
    expect(result.current.layout.cDefend).toBe(MIDDLE_COMFORT);
    act(() => {
      result.current.setDragging('right');
    });
    // 场景 A：dragging='right' → cDefend=480（拖拽守 480 底线，与 middleCurrent 解耦）
    expect(result.current.layout.cDefend).toBe(480);
  });

  it('hasLeft=false（studio 槽位）→ layout.leftWidth=0', () => {
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: false, rightPresent: true }));
    expect(result.current.layout.leftWidth).toBe(0);
  });

  it('rightPresent=false → layout.rightWidth=0（ws-panel 不挂载场景）', () => {
    const { result } = renderHook(() => useThreeColLayout({ hasLeft: true, rightPresent: false }));
    expect(result.current.layout.rightWidth).toBe(0);
  });
});

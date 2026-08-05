/**
 * use-persistent-width —— 通用列宽 state + clamp + localStorage 持久化 hook（common 层）
 * 参考: specs/ui/components/academy-page/_overview.md §2「可拖宽列约定」
 *       specs/ui/components/chat-page/component-workspace-panel.md §4.2（宽度持久化 clamp 口径）
 *
 * 列宽持久化的单一实现源：academy 三列直接用本 hook；
 * chat 三栏（use-three-col-layout / workspace-storage）保留各自让位引擎与 per-session key 工厂，
 * 仅把 localStorage 读写/clamp 委托给本文件的纯函数。
 *
 * 行为约定：
 *   - 初始宽 = localStorage 读值 clamp 到 [min,max]；缺失 / 非有限数 / storage 不可用 → defaultWidth
 *   - 拖动中（onResize）只更新 state，不写 storage（避免每帧 IO）
 *   - 拖动结束（onResizeEnd）才 persist，try/catch 吞异常（隐私模式 / 配额满）
 *
 * 上限为静态值：适用「两栏无让位」的简单分栏；chat 三栏的动态上限（dragDynMax）
 * 由 layout-width-engine 负责，本 hook 不涉足。
 */
import { useCallback, useRef, useState } from 'react';

/** 列宽 clamp 纯函数：非有限数 → fallback；越界 → 收敛到 [min,max] */
export function clampColWidth(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

/** 读取持久化列宽：坏值 / 缺失 / storage 不可用一律回退 defaultWidth */
export function readColWidth(storageKey: string, defaultWidth: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultWidth;
    return clampColWidth(Number(raw), min, max, defaultWidth);
  } catch {
    return defaultWidth;
  }
}

/** 写入持久化列宽（异常吞掉：隐私模式 / 配额满） */
export function writeColWidth(storageKey: string, width: number): void {
  try {
    localStorage.setItem(storageKey, String(width));
  } catch {
    // ignore
  }
}

export interface PersistentWidthOptions {
  /** localStorage 全局 key（每处分栏独立；academy 三列见 academy-col-widths.ts） */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

export interface PersistentWidthState {
  /** 当前列宽（直接用于 style width + 手柄 currentWidth） */
  width: number;
  /** 手柄 onResize（拖动中每帧调用，仅更新 state） */
  onResize: (w: number) => void;
  /** 手柄 onResizeEnd（mouseup 时 persist） */
  onResizeEnd: () => void;
  minWidth: number;
  maxWidth: number;
}

/**
 * 可拖宽列状态 hook。
 *
 * @param opts storageKey + 默认/上下限（min/max 为静态值，手柄内部按其 clamp）
 * @returns width（受控宽）+ onResize / onResizeEnd（直接透传给 ComponentColResizeHandle）+ min/max
 */
export function usePersistentWidth(opts: PersistentWidthOptions): PersistentWidthState {
  const { storageKey, defaultWidth, minWidth, maxWidth } = opts;
  const [width, setWidth] = useState(() => readColWidth(storageKey, defaultWidth, minWidth, maxWidth));
  // ref 跟随最新宽度：onResizeEnd 依赖恒定引用即可 persist 到最新值（避免每帧重建回调）
  const widthRef = useRef(width);

  const onResize = useCallback(
    (w: number) => {
      const next = clampColWidth(w, minWidth, maxWidth, defaultWidth);
      widthRef.current = next;
      setWidth(next);
    },
    [minWidth, maxWidth, defaultWidth],
  );

  const onResizeEnd = useCallback(() => {
    writeColWidth(storageKey, widthRef.current);
  }, [storageKey]);

  return { width, onResize, onResizeEnd, minWidth, maxWidth };
}

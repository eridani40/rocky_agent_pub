/**
 * resolveTarget / resolveDrag —— 从 tool input 解析 click/scroll/drag 目标（window-relative 三段式）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 决策C + §B2.8 A
 *
 * 两模式（resolveTarget）：
 *   1. element_index（主）：{element_index:int} → {elementIndex}（AX 语义定位，零像素数学、robust，
 *      不受 window-relative 影响）。
 *   2. coordinate（辅）：{x,y} → coords.pixelToGlobalPoint({x,y}, scaleFactor, windowBounds)
 *      → {coordinate:screenPoint}。window-relative 三段式：windowPoint=pixel/scaleFactor →
 *      globalPoint=windowPoint+windowBounds.origin（windowBounds 由 screenshot/get_app_state 缓存）。
 *   二者皆缺 → null（handler 转 errorResult，不抛）。
 *
 * resolveDrag（仅坐标）：{from_x,from_y,to_x,to_y} → 两 PixelPoint（各经 pixelToGlobalPoint 换算）；缺 → null。
 * resolveAxOptions：扁平 snake_case AX 采集预算入参 → 驼峰 AxTreeOptions（get_app_state/read_ax_tree 共用）。
 *
 * 纯函数（可测）；不调 port、不读 session-state（scaleFactor/windowBounds 由 handler 传入）。
 */
import { pixelToGlobalPoint } from '../../platform/computer/coords';
import type { AxTreeOptions, ComputerTarget, PixelPoint, WindowBounds } from '../../platform/computer/native-port';
import type { ToolInput } from '../types';

/** windowBounds 缺省（全屏截图 origin=(0,0)，仅 scaleFactor 换算） */
const ZERO_BOUNDS: WindowBounds = { x: 0, y: 0, w: 0, h: 0 };

/** 归一化 scaleFactor（>0 有效，否则兜底 1） */
function normScale(scaleFactor: number | undefined): number {
  return typeof scaleFactor === 'number' && scaleFactor > 0 ? scaleFactor : 1;
}

/**
 * 解析 click/scroll 目标。element_index 优先；否则用 x,y 像素坐标经三段式换算成屏幕 point。
 *
 * @param input tool 入参（读 element_index / x / y）
 * @param scaleFactor 缓存的 Retina 缩放因子（coordinate 模式用；缺省 1）
 * @param windowBounds 缓存的窗口 screen point 边界（coordinate 偏移源；缺省全屏 origin=0）
 * @returns ComputerTarget（elementIndex 或 coordinate）；二者皆缺返 null
 */
export function resolveTarget(
  input: ToolInput,
  scaleFactor: number | undefined,
  windowBounds?: WindowBounds,
): ComputerTarget | null {
  const ei = input.element_index;
  if (typeof ei === 'number' && Number.isInteger(ei)) {
    return { elementIndex: ei };
  }
  const x = input.x;
  const y = input.y;
  if (typeof x === 'number' && typeof y === 'number') {
    const screenPoint = pixelToGlobalPoint({ x, y }, normScale(scaleFactor), windowBounds ?? ZERO_BOUNDS);
    return { coordinate: screenPoint };
  }
  return null;
}

/**
 * 解析 drag 的起止两点（from_x,from_y → to_x,to_y，均经 window-relative 三段式换算成屏幕 point）。
 *
 * @param input tool 入参（读 from_x / from_y / to_x / to_y，四者必填）
 * @param scaleFactor 缓存的 Retina 缩放因子（缺省 1）
 * @param windowBounds 缓存的窗口 screen point 边界（缺省全屏 origin=0）
 * @returns {from,to} 两 PixelPoint；任一坐标缺失返 null
 */
export function resolveDrag(
  input: ToolInput,
  scaleFactor: number | undefined,
  windowBounds?: WindowBounds,
): { from: PixelPoint; to: PixelPoint } | null {
  const fx = input.from_x;
  const fy = input.from_y;
  const tx = input.to_x;
  const ty = input.to_y;
  if (
    typeof fx !== 'number' ||
    typeof fy !== 'number' ||
    typeof tx !== 'number' ||
    typeof ty !== 'number'
  ) {
    return null;
  }
  const sf = normScale(scaleFactor);
  const wb = windowBounds ?? ZERO_BOUNDS;
  return {
    from: pixelToGlobalPoint({ x: fx, y: fy }, sf, wb),
    to: pixelToGlobalPoint({ x: tx, y: ty }, sf, wb),
  };
}

/**
 * 解析 AX 树采集预算（get_app_state / read_ax_tree 共用；GetAppStateOptions === AxTreeOptions 同形）。
 * 扁平 snake_case 入参 → 驼峰 AxTreeOptions（仅拷有效字段，缺省走 addon 默认）。
 *
 * v0.0.160：`text_limit` 支持 `number | 'max'`（对齐 Swift `SnapshotTextLimit.max`；'max' = 无上限）。
 *
 * @param input tool 入参（读 app / text_limit / max_tree_nodes / max_tree_depth）
 * @returns AxTreeOptions（仅含 input 提供的字段）
 */
export function resolveAxOptions(input: ToolInput): AxTreeOptions {
  const opts: AxTreeOptions = {};
  if (typeof input.app === 'string') opts.app = input.app;
  if (typeof input.text_limit === 'number') {
    opts.textLimit = input.text_limit;
  } else if (input.text_limit === 'max') {
    opts.textLimit = 'max';
  }
  if (typeof input.max_tree_nodes === 'number') opts.maxNodes = input.max_tree_nodes;
  if (typeof input.max_tree_depth === 'number') opts.maxDepth = input.max_tree_depth;
  return opts;
}

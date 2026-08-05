/**
 * computer-use session 级状态缓存（坐标上下文 per-sessionId）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 决策C + §B2.8 A
 *
 * 职责：screenshot / get_app_state action 拿到单窗口截图后写入坐标上下文
 *   {scaleFactor, windowBounds}，coordinate 模式的 click/scroll/drag 读它做
 *   「截图像素 → 屏幕 point」window-relative 三段式换算（target.ts resolveTarget/resolveDrag 消费）。
 *   read_ax_tree 是 AX-only（无窗口截图），不建坐标上下文——coordinate 动作前必先
 *   screenshot / get_app_state。pid 归 Swift-side（addon 单例自缓存 lastPid），TS 侧不缓存 pid。
 *
 * 纯内存、按 sessionId 隔离；computer use 仅 bound playground（单人单桌面），无跨 session 并发风险。
 */
import type { WindowBounds } from '../../platform/computer/native-port';

/** 单 session 的 computer 坐标上下文（screenshot/get_app_state 写；coordinate 动作读） */
export interface ComputerSessionState {
  /** Retina 缩放因子（coordinate click/scroll/drag 的像素→point 换算） */
  scaleFactor?: number;
  /** 窗口 screen point 边界（三段式偏移源；全屏截图时 origin=0） */
  windowBounds?: WindowBounds;
}

/** 坐标上下文写入参数（scaleFactor + windowBounds 一次写） */
export interface CoordContext {
  scaleFactor?: number;
  windowBounds?: WindowBounds;
}

/** 模块级 per-sessionId 状态表（纯内存） */
const stateBySid = new Map<string, ComputerSessionState>();

/**
 * 读某 session 的 computer 坐标上下文（未初始化返 undefined）。
 * @param sid sessionId
 */
export function getComputerState(sid: string): ComputerSessionState | undefined {
  return stateBySid.get(sid);
}

/**
 * 写某 session 的坐标上下文（screenshot / get_app_state 拿到单窗口截图后调用）。
 * 一次写 scaleFactor + windowBounds；供后续 coordinate 动作的 window-relative 三段式换算。
 * @param sid sessionId
 * @param ctx {scaleFactor, windowBounds}（缺省字段不覆盖已有值）
 */
export function setComputerCoordContext(sid: string, ctx: CoordContext): void {
  const cur = stateBySid.get(sid) ?? {};
  if (ctx.scaleFactor !== undefined) cur.scaleFactor = ctx.scaleFactor;
  if (ctx.windowBounds !== undefined) cur.windowBounds = ctx.windowBounds;
  stateBySid.set(sid, cur);
}

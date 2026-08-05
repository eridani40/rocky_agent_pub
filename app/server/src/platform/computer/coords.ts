/**
 * 坐标换算（Retina scale 链）—— driver 内部把 LLM 给的截图像素坐标转屏幕全局坐标
 * 参考: specs/tech/agent/platform/[P1]computer_driver.md §5（坐标换算）
 *       specs/research/v0.0.105-cu-ifuryst-open-codex.md §4（ComputerUseService.swift:123-157 三段式）
 *
 * 换算链（coordinate 模式）：
 *   scaleFactor  = screenshot.width / windowBounds.w   ≈ 2.0 on Retina（不假设 2.0，多显示器混合 DPI）
 *   windowPoint  = screenshotPixel / scaleFactor        # 回到 point 坐标系
 *   globalPoint  = windowPoint + windowBounds.origin    # 加窗口左上偏移得屏幕全局 point
 *
 * element_index 模式不走这里（AX 直接给 windowPoint，helper 内换算）。
 */
import type { PixelPoint, WindowBounds } from './native-port';

/**
 * 从截图像素尺寸 + 窗口边界推导 Retina scaleFactor。
 * 优先用 screenshot.width / windowBounds.w（多显示器混合 DPI 场景比 backingScaleFactor 报告值更准）；
 * 无有效 windowBounds 时退回 helper 报告的 reportedScaleFactor（≥1 兜底）。
 *
 * @param screenshotWidth 截图实际像素宽（Retina 上 = windowBounds.w * 2）
 * @param windowBounds key window point 边界（可缺）
 * @param reportedScaleFactor helper 报告的 backingScaleFactor（兜底）
 */
export function deriveScaleFactor(
  screenshotWidth: number,
  windowBounds: WindowBounds | undefined,
  reportedScaleFactor: number,
): number {
  if (windowBounds && windowBounds.w > 0 && screenshotWidth > 0) {
    return screenshotWidth / windowBounds.w;
  }
  return reportedScaleFactor > 0 ? reportedScaleFactor : 1;
}

/**
 * 截图像素坐标 → 屏幕全局 point 坐标（喂 postToPid）。
 *   windowPoint = pixel / scaleFactor
 *   globalPoint = windowPoint + windowBounds.origin
 *
 * @param pixel LLM 给的截图像素坐标（如 {x:640,y:400} 在 1280×800 截图中央）
 * @param scaleFactor Retina 缩放因子（deriveScaleFactor 产出）
 * @param windowBounds key window point 边界（origin 用于加偏移）
 */
export function pixelToGlobalPoint(
  pixel: PixelPoint,
  scaleFactor: number,
  windowBounds: WindowBounds,
): PixelPoint {
  const sf = scaleFactor > 0 ? scaleFactor : 1;
  return {
    x: pixel.x / sf + windowBounds.x,
    y: pixel.y / sf + windowBounds.y,
  };
}

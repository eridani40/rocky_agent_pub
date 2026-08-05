/**
 * handleScreenshot —— computer tool 的 action:"screenshot"（native 单窗口截图 → 落盘 + 路径文本）
 * 参考: specs/tech/version_logs/v0.0.157/change_plan.md §0 Q5（文案）/ §1 T2 / INV-157-1/3/4
 *       specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 决策A/C + §B2.8 A/B
 *
 * port undefined 检查 + screenRecording 权限门禁由 computer.ts run() 前置统一做，此处四步：
 *   映射 app → screenshot opts → port.screenshot(opts) → !ok errorResult →
 *   缓存坐标上下文（deriveScaleFactor + windowBounds，供后续 coordinate click/scroll/drag）→
 *   saveSnapshot 落盘到 <workdir>/snapshots/<toolCallId>.<ext> → 返 TextBlock(路径+尺寸)。
 *
 * INV-157-1：tool_result.content 绝不含 ImageBlock（截图落盘，主对话上下文纯文本）。
 * INV-157-3：走 saveSnapshot 单一出口，禁 fs.writeFile。
 * INV-157-4：落盘失败 → errorResult，不回退 inline image。
 */
import type { ToolCtx, ToolInput, ToolRunResult } from '../../types';
import { errorResult } from '../../types';
import type { ComputerNativePort, ComputerScreenshotOptions } from '../../../platform/computer/native-port';
import { deriveScaleFactor } from '../../../platform/computer/coords';
import { saveSnapshot, formatSnapshotText } from '../../snapshot-store';
import { setComputerCoordContext } from '../session-state';

/**
 * 截图（假定 port 已注入 + screenRecording 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（app 可选）
 * @param port  ComputerNativePort（computer.ts 已判非空）
 * @param ctx   ToolCtx（读 sessionId 缓存坐标上下文；workdir + toolCallId 落盘命名用）
 * @returns 成功 → {content:[TextBlock(路径+尺寸)], isError:false}；
 *          port.screenshot !ok → errorResult(reason)；落盘失败 → errorResult（不回退 inline image）
 */
export async function handleScreenshot(
  input: ToolInput,
  port: ComputerNativePort,
  ctx: ToolCtx,
): Promise<ToolRunResult> {
  const opts: ComputerScreenshotOptions = {};
  if (typeof input.app === 'string') opts.app = input.app;
  const shot = await port.screenshot(opts);
  if (!shot.ok) {
    return errorResult(`截图失败：${shot.reason ?? '未知原因'}`);
  }
  // 缓存坐标上下文（供 coordinate 模式 click/scroll/drag 的 window-relative 三段式换算）
  const sid = ctx.config.sessionId;
  if (sid) {
    setComputerCoordContext(sid, {
      scaleFactor: deriveScaleFactor(shot.width ?? 0, shot.windowBounds, shot.scaleFactor ?? 1),
      windowBounds: shot.windowBounds,
    });
  }
  // 落盘（INV-157-3 单一出口）；失败抛 → caller catch 转 errorResult，不回退 inline image（INV-157-4）
  try {
    const saved = await saveSnapshot({
      workdir: ctx.workdir,
      toolCallId: ctx.toolCallId,
      data: shot.data ?? '',
      mediaType: shot.mediaType ?? 'image/png',
      width: shot.width,
      height: shot.height,
    });
    return {
      content: [
        {
          type: 'text',
          text: formatSnapshotText({
            relPath: saved.relPath,
            width: saved.width,
            height: saved.height,
            mediaType: saved.mediaType,
          }),
        },
      ],
      isError: false,
    };
  } catch (e) {
    return errorResult(`截图落盘失败：${(e as Error).message ?? '未知原因'}`);
  }
}

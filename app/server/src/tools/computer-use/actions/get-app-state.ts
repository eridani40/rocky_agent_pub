/**
 * handleGetAppState —— computer tool 的 action:"get_app_state"（单窗口截图 + AX 树合一 → 路径文本 + AX 文本）
 * 参考: specs/tech/version_logs/v0.0.157/change_plan.md §0 Q5（文案）/ §1 T2 / INV-157-1/3/4
 *       specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 决策A/C + §B2.8 A
 *
 * open-codex 每 turn 先调的主 action：一次返回截图（看界面）+ AX 树（拿 element_index）。
 * port undefined + 双权限门禁（screenRecording+accessibility）由 computer.ts run() 前置统一做，此处四步：
 *   映射 opts → port.getAppState(opts) → !ok errorResult →
 *   缓存坐标上下文（deriveScaleFactor + windowBounds）→
 *   截图落盘 → 返 [TextBlock(路径+尺寸), TextBlock(AX 树)]（两 TextBlock 顺序固定 [path, axText]）。
 *
 * INV-157-1：tool_result.content 绝不含 ImageBlock。
 * INV-157-3：走 saveSnapshot 单一出口。
 * INV-157-4：落盘失败 → errorResult，不回退 inline image。
 */
import type { ToolCtx, ToolInput, ToolRunResult } from '../../types';
import { errorResult } from '../../types';
import type { ComputerNativePort } from '../../../platform/computer/native-port';
import { deriveScaleFactor } from '../../../platform/computer/coords';
import { saveSnapshot, formatSnapshotText } from '../../snapshot-store';
import { setComputerCoordContext } from '../session-state';
import { resolveAxOptions } from '../target';

/**
 * 读 app 状态（假定 port 已注入 + screenRecording+accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（app/text_limit/max_tree_nodes/max_tree_depth 可选）
 * @param port  ComputerNativePort
 * @param ctx   ToolCtx（读 sessionId 缓存坐标上下文；workdir + toolCallId 落盘命名用）
 * @returns 成功 → {content:[TextBlock(截图路径+size), TextBlock(axText)], isError:false}；
 *          截图缺省则只返 [TextBlock(axText)]；port.getAppState !ok → errorResult(reason)；
 *          落盘失败 → errorResult（不回退 inline image）
 */
export async function handleGetAppState(
  input: ToolInput,
  port: ComputerNativePort,
  ctx: ToolCtx,
): Promise<ToolRunResult> {
  const res = await port.getAppState(resolveAxOptions(input));
  if (!res.ok) {
    return errorResult(`读取 app 状态失败：${res.reason ?? '未知原因'}`);
  }
  // 缓存坐标上下文（供 coordinate 模式 click/scroll/drag 的 window-relative 三段式换算）
  const sid = ctx.config.sessionId;
  if (sid) {
    setComputerCoordContext(sid, {
      scaleFactor: deriveScaleFactor(res.screenshot?.width ?? 0, res.windowBounds, res.scaleFactor ?? 1),
      windowBounds: res.windowBounds,
    });
  }
  // 图 + 树合一：截图 → 落盘 → TextBlock(路径+尺寸)；AX 文本 → TextBlock(axText)
  // 两 TextBlock 顺序固定 [path, axText]（change_plan §0 Q5 + §1 T2）
  const content: ToolRunResult['content'] = [];
  if (res.screenshot) {
    // 落盘（INV-157-3）；失败抛 → caller catch 转 errorResult，不回退 inline image（INV-157-4）
    try {
      const saved = await saveSnapshot({
        workdir: ctx.workdir,
        toolCallId: ctx.toolCallId,
        data: res.screenshot.data ?? '',
        mediaType: res.screenshot.mediaType ?? 'image/png',
        width: res.screenshot.width,
        height: res.screenshot.height,
      });
      content.push({
        type: 'text',
        text: formatSnapshotText({
          relPath: saved.relPath,
          width: saved.width,
          height: saved.height,
          mediaType: saved.mediaType,
        }),
      });
    } catch (e) {
      return errorResult(`截图落盘失败：${(e as Error).message ?? '未知原因'}`);
    }
  }
  content.push({ type: 'text', text: res.axText ?? '' });
  return { content, isError: false };
}

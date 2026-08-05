/**
 * handleReadAxTree —— computer tool 的 action:"read_ax_tree"（纯读 AX 树 → TextBlock）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 决策C + §B2.8 A
 *
 * 映射 input(app/text_limit/max_tree_nodes/max_tree_depth) → AxTreeOptions → port.readAxTree →
 *   !ok errorResult → 返 AX 渲染文本 TextBlock。
 * read_ax_tree 是 AX-only（无窗口截图）——**不建坐标上下文**：只出 element_index，coordinate 动作
 *   （x,y / drag）需先 screenshot / get_app_state 拿 windowBounds。仅返文本（无截图）。
 */
import type { ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ComputerNativePort } from '../../../platform/computer/native-port';
import { resolveAxOptions } from '../target';

/**
 * 读 AX 树（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（app/text_limit/max_tree_nodes/max_tree_depth 可选）
 * @param port  ComputerNativePort
 * @returns 成功 → TextBlock(AX 文本)；port.readAxTree !ok → errorResult(reason)
 */
export async function handleReadAxTree(input: ToolInput, port: ComputerNativePort): Promise<ToolRunResult> {
  const res = await port.readAxTree(resolveAxOptions(input));
  if (!res.ok) {
    return errorResult(`读取界面结构失败：${res.reason ?? '未知原因'}`);
  }
  return textResult(res.text ?? '');
}

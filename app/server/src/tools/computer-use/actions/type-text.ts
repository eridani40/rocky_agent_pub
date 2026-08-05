/**
 * handleTypeText —— computer tool 的 action:"type_text"（输入 Unicode 文本）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 A #7 + §B2.8 A
 *       specs/tech/version_logs/v0.0.160/change_plan.md 模块 E（type_text 三段式）+ 模块 J（state_unavailable 友好文案）
 *
 * 校验 text（缺/非 string → errorResult）→ port.type(text,{app}) → !ok errorResult → 成功文本。
 * v0.0.160：port 返 code=`state_unavailable`（目标元素不可输入 / 无 focused editable）时加友好前缀
 *   引导 LLM 先点击文本区、或改用 set_value；同时保留 native 原始 message 供 debug。
 */
import type { ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ComputerNativePort, TypeOptions } from '../../../platform/computer/native-port';

/**
 * 输入文本（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（text 必填；app 可选）
 * @param port  ComputerNativePort
 * @returns 成功文本；text 缺/非 string → errorResult；port.type !ok → errorResult(reason)
 */
export async function handleTypeText(input: ToolInput, port: ComputerNativePort): Promise<ToolRunResult> {
  const text = input.text;
  if (typeof text !== 'string') {
    return errorResult('type_text 需要 text 参数（要输入的文本字符串）。');
  }
  const opts: TypeOptions = {};
  if (typeof input.app === 'string') opts.app = input.app;
  const res = await port.type(text, opts);
  if (!res.ok) {
    // v0.0.160 J-1：state_unavailable = 目标元素不接受文本输入或已消失，加引导文案；不吞 native message
    if (res.code === 'state_unavailable') {
      return errorResult(
        `无法输入：目标元素不接受文本输入或已消失。请先点击一个文本输入区（click），` +
          `或对可赋值元素用 set_value。（原因：${res.reason ?? '未知'}）`,
      );
    }
    return errorResult(`输入文本失败：${res.reason ?? '未知原因'}`);
  }
  return textResult(`已输入文本（${text.length} 字符）。`);
}

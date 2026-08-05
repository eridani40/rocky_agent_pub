/**
 * handlePressKey —— computer tool 的 action:"press_key"（按键/组合键，xdotool 语法）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 A #8 + §B2.8 A
 *
 * 校验 key（缺/非 string/空 → errorResult）→ port.pressKey(key,{app}) → !ok errorResult → 成功文本。
 * action 名对齐 open-codex 原名 press_key（区别于旧 6-action 的 key）；参数键 keys→key。
 */
import type { ToolInput, ToolRunResult } from '../../types';
import { errorResult, textResult } from '../../types';
import type { ComputerNativePort, PressKeyOptions } from '../../../platform/computer/native-port';

/**
 * 按键/组合键（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param input tool 入参（key 必填，如 "cmd+s" / "enter"；app 可选）
 * @param port  ComputerNativePort
 * @returns 成功文本；key 缺/非 string/空 → errorResult；port.pressKey !ok → errorResult(reason)
 */
export async function handlePressKey(input: ToolInput, port: ComputerNativePort): Promise<ToolRunResult> {
  const key = input.key;
  if (typeof key !== 'string' || key.length === 0) {
    return errorResult('press_key 需要 key 参数（xdotool 语法，如 "cmd+s" / "enter"）。');
  }
  const opts: PressKeyOptions = {};
  if (typeof input.app === 'string') opts.app = input.app;
  const res = await port.pressKey(key, opts);
  if (!res.ok) {
    return errorResult(`按键失败：${res.reason ?? '未知原因'}`);
  }
  return textResult(`已按键：${key}。`);
}

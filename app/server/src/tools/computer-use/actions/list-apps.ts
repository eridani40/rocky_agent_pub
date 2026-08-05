/**
 * handleListApps —— computer tool 的 action:"list_apps"（列运行中 + Spotlight 最近使用 app → TextBlock）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 A #1 + §B2.8 A
 *       specs/tech/version_logs/v0.0.160/change_plan.md 模块 H（Spotlight AppDiscovery）
 *
 * port undefined + accessibility 权限门禁由 computer.ts run() 前置统一做，此处两步：
 *   port.listApps() → 格式化为 TextBlock（每行 name / bundleId / pid + Spotlight 标记，供 LLM 取 app hint）。
 * 纯读、无参数、恒成功（异常由 impl 侧收敛为空数组）。
 *
 * v0.0.160：Swift AppDiscovery 已按 frontmost > running > lastUsed > uses > name 排好序，
 *   TS 侧不重排；若 `line` 字段存在（AppDiscovery.renderedLine）直接透传（含 flags），
 *   否则回退旧格式（保对不带 Spotlight 数据的旧 addon 兼容）。
 */
import type { ToolRunResult } from '../../types';
import { textResult } from '../../types';
import type { AppInfo, ComputerNativePort } from '../../../platform/computer/native-port';

/**
 * 列可用 app（假定 port 已注入 + accessibility 已门禁通过，由 computer.ts 保证）。
 * @param port ComputerNativePort
 * @returns TextBlock（app 列表；空列表返提示文本）
 */
export async function handleListApps(port: ComputerNativePort): Promise<ToolRunResult> {
  const apps = await port.listApps();
  if (apps.length === 0) {
    return textResult('未发现可控 app。');
  }
  const lines = apps.map(formatAppLine);
  return textResult(`可用 app（${apps.length}）：\n${lines.join('\n')}`);
}

/**
 * 单行格式化：优先用 Swift AppDiscovery 的 `line`（含 frontmost/running/lastUsed/uses 标记），
 * 缺失则回退到旧格式 `- name (bundleId) pid=N`（保后向兼容）。
 */
function formatAppLine(a: AppInfo): string {
  if (typeof a.line === 'string' && a.line.length > 0) {
    return `- ${a.line}`;
  }
  return `- ${a.name} (${a.bundleId}) pid=${a.pid}`;
}

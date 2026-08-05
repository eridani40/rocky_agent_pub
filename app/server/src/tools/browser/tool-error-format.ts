/**
 * browser tool 错误文案 helper —— formatConnectorError
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §7 (Tool 层)
 *       states/v0.0.46.connector_opt/design.md §3.2 (formatConnectorError 分层)
 *
 * 职责：把 ConnectorManager.connectForToolRun 返回的 error（kind + 附加字段）
 * 转成面向 LLM 的引导文案（tool.ts 的 errorResult 消费）。
 */
import type { ConnectForToolRunResult } from './connector-types';

/** connectForToolRun 失败分支的 error 形状（narrow 后从 ConnectForToolRunResult 派生） */
type ConnectorError = Extract<ConnectForToolRunResult, { ok: false }>['error'];

/**
 * 将 ConnectorManager.connectForToolRun 的 error 转成引导文案。
 * 三种 kind：
 *   - not_enabled     → 引导用户在「连接器 → 浏览器」开启开关
 *   - in_use_by_other → 提示 owner sessionId，请在该会话调用 disconnect
 *   - connect_failed  → 附带底层 message（driver.connect 失败详情）
 *
 * @param err ConnectorManager.connectForToolRun 返回的 error 对象
 * @returns 面向 LLM 的引导文案（作为 errorResult 的 text）
 */
export function formatConnectorError(err: ConnectorError): string {
  switch (err.kind) {
    case 'not_enabled':
      return 'browser attach 未启用：请在「连接器 → 浏览器」中开启开关';
    case 'in_use_by_other':
      return `browser attach 已被其他会话占用（sessionId=${err.ownerSessionId ?? 'unknown'}），请先在该会话调用 disconnect`;
    case 'connect_failed':
      return `browser attach 连接失败：${err.message}`;
  }
  // 兜底透传底层 message（switch 已穷尽 3 kind，此 return 为类型完备/未来新增 kind 的保底）
  return err.message;
}

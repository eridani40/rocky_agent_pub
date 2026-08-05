/**
 * provider-protocol-helpers — protocol metadata 投影 + 合法性校验
 * 参考: specs/api/overall/02-llm-chat.md §5.2（ProtocolMeta 类型）/ §5.4（protocolId 合法性校验）
 *       specs/tech/version_logs/v0.0.53/change_log.md §4（path 来源 C 增强版）
 *
 * 两份职责：
 *   1. buildProtocolMeta：pluginManager.getExtensionImpls(llm_protocol) → ProtocolMeta[]（GET /provider 响应顶层附带）
 *   2. isValidProtocolId：校验 body.protocolId 是否在已注册 llm_protocol implId 集合内（POST/PUT 校验）
 */
import type { ProtocolName } from '../llm/provider-types';
import { LlmProtocolPoint } from '../plugin/extension-point';
import type { LlmProtocol } from '../llm/protocol';
import type { PluginManager } from '../plugin/plugin-manager';

/**
 * 已注册 llm_protocol ext impl 元数据（GET /provider 响应顶层附带）。
 * handler 实例化 protocol impl 一次读 readonly 字段（id/label/path）投影返回。
 * 前端 provider 配置 UI 用此数组：label 渲染下拉 + path 拼「实际请求地址」预览。
 */
export interface ProtocolMeta {
  /** implId / 持久化标识（= ProtocolName），如 'anthropic_messages' */
  id: ProtocolName;
  /** 人类可读展示名（如 'Anthropic Messages 风格'） */
  label: string;
  /** endpoint path（如 '/v1/messages'），拼接地址用 */
  path: string;
}

/**
 * 取已注册 llm_protocol ext impl 元数据（id/label/path）投影为 ProtocolMeta[]。
 * handler 单次实例化 impl → 读 readonly 字段 → 返回；前端零知识（不实例化 impl）。
 */
export function buildProtocolMeta(pluginManager: PluginManager): ProtocolMeta[] {
  const protocols = pluginManager.getExtensionImpls<LlmProtocol>(LlmProtocolPoint);
  return protocols.map((p) => ({
    id: (p as unknown as { implId: string }).implId as ProtocolName,
    label: p.label,
    path: p.path,
  }));
}

/**
 * 校验 protocolId 是否在已注册 llm_protocol ext impl 集合内。
 * POST/PUT /provider 调用：不在集合 → 视为非法 body → 400。
 */
export function isValidProtocolId(pluginManager: PluginManager, id: string): boolean {
  const protocols = pluginManager.getExtensionImpls<LlmProtocol>(LlmProtocolPoint);
  return protocols.some((p) => (p as unknown as { implId: string }).implId === id);
}

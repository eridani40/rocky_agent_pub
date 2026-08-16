/**
 * provider-type-presets — provider 类型 preset 表（v0.0.350 决策④）
 * 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策④ + PRD §2.1 类型表
 *
 * 职责：5 类型（1 通用 + 4 native coding plan）前端 preset 数据源——
 *   类型选择器选项（KeyChoiceCards）、选中联动（baseUrl 填充/协议锁定/默认模型预填）、
 *   额度总览参与判定（isNativeCodingPlan）共用本表。
 * 边界：后端不感知本表（只做 name 白名单校验，决策④）；类型 id 与后端 ProviderName 一致。
 * 来源：默认 baseUrl/默认模型名 = PRD §2.1 表（官方文档背书）；kimi contextWindow 262144
 *   （cc-switch 预设同款 256K 窗口，research §7）；其余类型 contextWindow 不预置（用户可改）。
 */

/** provider 类型 id（与 server ProviderName union 同构；api-client 同名类型单一事实源） */
export type ProviderTypeId =
  | 'anthropic_compatible'
  | 'kimi_coding_plan'
  | 'glm_coding_plan'
  | 'minimax_coding_plan'
  | 'deepseek_api';

/** 单类型 preset（通用类型仅 id/labelKey/协议） */
export interface ProviderTypePreset {
  /** 类型 id（= ProviderName 成员；持久化与额度过滤锚点） */
  id: ProviderTypeId;
  /** i18n key（providers:type.{id}，友好名） */
  labelKey: string;
  /** 协议锁定（4 类型预置 anthropic_messages 不可改；通用类型跟随 protocolOptions） */
  protocolId: 'anthropic_messages';
  /** 默认 baseUrl（仅 baseUrl 为空时填充，用户值优先；通用类型无） */
  defaultBaseUrl?: string;
  /** 默认模型名（仅新建空 models 时预填一条；通用类型无） */
  defaultModel?: string;
  /** 预填模型 contextWindow（kimi 262144；其余不预置 = 0 用户可改） */
  contextWindow?: number;
}

/** 5 类型 preset 表（顺序 = 选择器展示顺序：通用在前 + 4 native） */
export const PROVIDER_TYPE_PRESETS: readonly ProviderTypePreset[] = [
  {
    id: 'anthropic_compatible',
    labelKey: 'type.anthropic_compatible',
    protocolId: 'anthropic_messages',
  },
  {
    id: 'kimi_coding_plan',
    labelKey: 'type.kimi_coding_plan',
    protocolId: 'anthropic_messages',
    defaultBaseUrl: 'https://api.kimi.com/coding/',
    defaultModel: 'kimi-for-coding',
    contextWindow: 262144,
  },
  {
    id: 'glm_coding_plan',
    labelKey: 'type.glm_coding_plan',
    protocolId: 'anthropic_messages',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: 'glm-5.2',
  },
  {
    id: 'minimax_coding_plan',
    labelKey: 'type.minimax_coding_plan',
    protocolId: 'anthropic_messages',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M2.7',
  },
  {
    id: 'deepseek_api',
    labelKey: 'type.deepseek_api',
    protocolId: 'anthropic_messages',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-v4-pro',
  },
];

/** 4 native coding plan 类型 id（额度总览参与集合） */
const NATIVE_TYPE_IDS: ReadonlySet<string> = new Set([
  'kimi_coding_plan',
  'glm_coding_plan',
  'minimax_coding_plan',
  'deepseek_api',
]);

/** 判定是否 native coding plan 类型（额度查询参与 + 类型联动生效；通用 anthropic_compatible=false） */
export function isNativeCodingPlan(name: string | undefined | null): boolean {
  return !!name && NATIVE_TYPE_IDS.has(name);
}

/** 按 id 查 preset（通用类型返回其占位 preset；未知 id 返回 null） */
export function findProviderTypePreset(id: string): ProviderTypePreset | null {
  return PROVIDER_TYPE_PRESETS.find((p) => p.id === id) ?? null;
}

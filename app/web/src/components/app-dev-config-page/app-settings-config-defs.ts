/**
 * app-settings-config-defs — 应用设置合并页 KV group 定义 + tab 定义 + 纯函数。
 * 参考 specs/ui/components/app-dev-config-page/page-app-settings-merged.md。
 *
 * 现状：所有 group 走 domain='app'；general tab 只挂 ComponentLocaleCard（切即生效，
 * 不进 KV 网格 / 不参与 page-tab dirty）；backend `appearance` group 仍存（language
 * 走 putConfigGroup('app','appearance',[{key:'language',...}])，见 change-language.ts）。
 * default_models 与 session 走「read-modify-write 单 record」范式（详见 KV_GROUPS 注释）。
 */
import type { KeyInfo } from './component-key-card';

/** tab id（ET 锚点 tab-tree-item-{tabId}） */
export type TabId = 'general' | 'session' | 'models' | 'tools' | 'memory' | 'observability' | 'consolidation' | 'plugin';

/** default_models record data 形状（chat optional；v0.0.158 起 summary 字段整删） */
export interface DefaultModelsData {
  chat?: string;
}

/**
 * consolidation record data 形状。
 * modelId 清空语义 = 赋值 undefined（不删 key），与 default_models 的删 key 语义不同，
 * 故不走 dmDraft 那套专属分支，而是复用 llm_request/session 的「完整 record 读改写」范式
 * （详见 section-consolidation-config.md「实现选型订正」）。
 */
export interface ConsolidationData {
  enabled: boolean;
  dailyTime: string; // HH:mm
  modelId?: string;
}

/** KV group 定义：groupId + 域 + keys 元信息 */
export interface GroupDef {
  groupId: 'llm_request' | 'logs' | 'session';
  /** GET/PUT 域：v0.0.89 起全走 app（dev_config 废弃） */
  domain: 'app';
  keys: { key: string; type: KeyInfo['type']; desc?: string; labelKey?: string; options?: string[] }[];
}

/**
 * 合并页管理的 KV group 定义（v0.0.89 起仅含 page-tab dirty 跟踪的 group）。
 * - llm_request：暴露 stall_tool_s + max_attempts（由 SectionDefaultModelsAndRequest 自渲染 number 卡）
 *   注：llm_request 是嵌套 record（key=default，data 含 timeout/retry/...），前端 read-modify-write 完整 data；
 *   此处 group def 仅用于 dirty/保存编排，KV 网格不直接渲染
 * - logs：4 toggle（KV 网格直接渲染）
 * - session：maxSkillInject + maxMemoryInject（由 SectionSessionConfig 自渲染 number 卡）
 *   注：session 是单 record（key=default，data={maxSkillInject?,maxMemoryInject?}），前端 read-modify-write；
 *   record 缺失 → draft 默认 {50, 50}（DEFAULT_SESSION_SUBFIELDS）
 *
 * appearance group 不进 KV 网格（language 由 ComponentLocaleCard 自渲染切即生效；theme 前端不管）。
 */
export const KV_GROUPS: GroupDef[] = [
  {
    groupId: 'llm_request',
    domain: 'app',
    keys: [
      { key: 'stall_tool_s', type: 'number', desc: 'schema.llm_request.stall_tool_s.desc', labelKey: 'schema.llm_request.stall_tool_s.label' },
      { key: 'max_attempts', type: 'number', desc: 'schema.llm_request.max_attempts.desc', labelKey: 'schema.llm_request.max_attempts.label' },
    ],
  },
  {
    groupId: 'session',
    domain: 'app',
    keys: [
      { key: 'maxSkillInject', type: 'number', desc: 'schema.session.maxSkillInject.desc', labelKey: 'schema.session.maxSkillInject.label' },
      { key: 'maxMemoryInject', type: 'number', desc: 'schema.session.maxMemoryInject.desc', labelKey: 'schema.session.maxMemoryInject.label' },
    ],
  },
  {
    groupId: 'logs',
    domain: 'app',
    keys: [
      { key: 'enableLlmRequestLog', type: 'boolean', desc: 'schema.logs.enableLlmRequestLog.desc', labelKey: 'schema.logs.enableLlmRequestLog.label' },
      { key: 'enableToolResultLog', type: 'boolean', desc: 'schema.logs.enableToolResultLog.desc', labelKey: 'schema.logs.enableToolResultLog.label' },
      { key: 'enableAppApiLog', type: 'boolean', desc: 'schema.logs.enableAppApiLog.desc', labelKey: 'schema.logs.enableAppApiLog.label' },
      { key: 'enableEventLog', type: 'boolean', desc: 'schema.logs.enableEventLog.desc', labelKey: 'schema.logs.enableEventLog.label' },
      { key: 'enableErrorLog', type: 'boolean', desc: 'schema.logs.enableErrorLog.desc', labelKey: 'schema.logs.enableErrorLog.label' },
      { key: 'enableAgentLog', type: 'boolean', desc: 'schema.logs.enableAgentLog.desc', labelKey: 'schema.logs.enableAgentLog.label' },
      { key: 'enablePerformanceLog', type: 'boolean', desc: 'schema.logs.enablePerformanceLog.desc', labelKey: 'schema.logs.enablePerformanceLog.label' },
    ],
  },
];

/** tab 定义（通用区 4 + 系统设置区 2，顺序即渲染顺序） */
export interface TabDef {
  id: TabId;
  /** i18n key（app-dev-config ns 下的 tab.{id}.label） */
  labelKey: string;
  /** 该 tab 下的 group id 列表（按渲染顺序） */
  groups: string[];
  /** 是否在系统设置收起区（true=收起区，受 systemExpanded 控制） */
  inSystemArea: boolean;
}

export const APP_SETTINGS_TABS: readonly TabDef[] = [
  // general tab: 仅语言 card 自渲染（'locale'），无 KV group 参与 page-tab dirty
  { id: 'general', labelKey: 'tab.general.label', groups: ['locale'], inSystemArea: false },
  { id: 'session', labelKey: 'tab.session.label', groups: ['session', 'default_models', 'llm_request'], inSystemArea: false },
  { id: 'models', labelKey: 'tab.models.label', groups: ['providers'], inSystemArea: false },
  { id: 'tools', labelKey: 'tab.tools.label', groups: ['web_search', 'web_fetch', 'see_image'], inSystemArea: false },
  { id: 'memory', labelKey: 'tab.memory.label', groups: ['user_memory'], inSystemArea: false },
  { id: 'observability', labelKey: 'tab.observability.label', groups: ['observability', 'logs'], inSystemArea: true },
  // 系统设置收起区「整理」tab，位于 observability 之后、plugin 之前
  { id: 'consolidation', labelKey: 'tab.consolidation.label', groups: ['consolidation'], inSystemArea: true },
  { id: 'plugin', labelKey: 'tab.plugin.label', groups: ['plugin'], inSystemArea: true },
];

/** 系统设置收起区 tab id 集合（收起时若选中需回落 general） */
export const SYSTEM_TABS: ReadonlySet<TabId> = new Set<TabId>(['observability', 'consolidation', 'plugin']);

/**
 * tab → 该 tab 内由 useAppSettingsConfig 管理的 KV groupId 列表。
 * 不含 providers/web_search/user_memory/observability/plugin 等自渲染 group（走各自独立 save 流）。
 */
export const TAB_KV_GROUPS: Record<TabId, string[]> = {
  // general tab: 无 KV group（仅 ComponentLocaleCard 切即生效）
  general: [],
  session: ['session', 'default_models', 'llm_request'],
  models: [],
  tools: [],
  memory: [],
  observability: ['logs'],
  // consolidation 是自渲染 group（不进 KV_GROUPS 通用网格），
  // 但仍参与 page-tab dirty 跟踪/保存（同 default_models/session/llm_request 惯例）
  consolidation: ['consolidation'],
  plugin: [],
};

/** llm_request/default 嵌套对象的默认子字段值（record 缺失时占位，来自后端 DEFAULT_LLM_REQUEST_CONFIG） */
export const DEFAULT_LLM_REQUEST_SUBFIELDS = {
  stall_tool_s: 120,
  max_attempts: 3,
} as const;

/** session/default record 默认子字段值（record 缺失时占位；PRD §4.2 缺失回退 50） */
export const DEFAULT_SESSION_SUBFIELDS = {
  maxSkillInject: 50,
  maxMemoryInject: 50,
} as const;

/** consolidation/default record 默认子字段值（record 缺失时占位，对齐 app_config.md §3.16；modelId 无默认值） */
export const DEFAULT_CONSOLIDATION_SUBFIELDS = {
  enabled: false,
  dailyTime: '04:00',
} as const;

/** type 默认值（key record 缺失时占位） */
export function defaultFor(type: KeyInfo['type']): unknown {
  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
    case 'enum':
    default:
      return '';
  }
}

/** 保存前规范化 draft 值（空串 number → 0；其余原样） */
export function normalizeValue(v: unknown, type: KeyInfo['type']): unknown {
  if (type === 'number') {
    if (v === '' || v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return v;
}

/** structuredClone 兜底（jsdom 无该 API 时回退 JSON 克隆） */
export function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(v);
    } catch {
      /* fallthrough */
    }
  }
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 比较两对象 shallow 不等（键集 + 值）。dirty 检测用。 */
export function shallowDiff(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return true;
  }
  return false;
}

/** 根据 groupId + KV_GROUPS def + values map 构建 GroupInfo（load 回填 + 初始化共用） */
export function buildKvGroup(
  groupId: GroupDef['groupId'],
  values: Record<string, unknown>,
): { groupId: string; keys: KeyInfo[] } {
  const def = KV_GROUPS.find((d) => d.groupId === groupId);
  if (!def) throw new Error(`unknown KV group: ${groupId}`);
  return {
    groupId,
    keys: def.keys.map((k) => ({
      key: k.key,
      type: k.type,
      value: values[k.key] as KeyInfo['value'],
      desc: k.desc,
      labelKey: k.labelKey,
      options: k.options,
    })),
  };
}

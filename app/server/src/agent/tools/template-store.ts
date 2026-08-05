/**
 * sub_agent_templates 存储适配 + loadTemplate 实现 + explorer 预配（v0.0.28 task-3）
 * 参考: specs/tech/multi_agent/[P1]subagent_templates.md §2/§3/§5（结构 + app_config 存储 + explorer 预配）
 *       specs/api/overall/10-multi-agent.md §5（CRUD 复用 /config/app/sub_agent_templates + §5.3 DELETE）
 *       specs/tech/config/[P0]app_config.md（存储机制）
 *
 * 职责：
 *   1. app_config `sub_agent_templates` group 的 record ↔ SubAgentTemplate 互转
 *   2. loadTemplate(name): 从 app_config 读对应模板 → SubAgentTemplate | null（找不到返 null）
 *   3. upsertExplorer(appConfig): 启动预配 builtin explorer（idempotent，存在即跳过）
 *
 * 历史：v0.0.28 task-3 落在 dev_config 上；v0.0.89 dev_config 废弃，整组直迁 app_config
 *       （group/key 名零变更，ULID 全局唯一可直拷）。原 loadTemplateFromDevConfig 函数名保留为
 *       历史命名（实现已切 app_config），避免下游 import 大幅改动。
 *
 * 单文件 ≤300 行（纯函数 + 预配常量）。
 */
import type { AppConfigService } from '../../config/app-config-service';
import type { SubAgentTemplate } from './types';

/** sub_agent_templates 在 app_config 中的 group 名（api spec §5.1，迁移前后同名） */
export const SUB_AGENT_TEMPLATES_GROUP = 'sub_agent_templates';

/**
 * builtin explorer 预配（subagent_templates §5，对齐实际工具命名——无通配符 read_*）。
 * modelId=null = inherit parent（explorer 不指定 model）。
 */
export const EXPLORER_TEMPLATE: SubAgentTemplate = {
  name: 'explorer',
  description: '探索型子 agent——只读探查、广撒网收集信息，不做写操作。',
  systemPrompt:
    '你是 explorer 子 agent。你的职责是【只读探索】：调研、搜索、读取、汇总信息。\n' +
    '不执行任何写/改/删除操作。完成后用简明结构化方式把发现回报给调用者。',
  tools: ['read', 'web_search', 'web_fetch', 'send_message'],
  skills: [],
  modelId: null,
  builtin: true,
};

/**
 * 校验并归一化 app_config record.data → SubAgentTemplate。
 * record.data 可能字段不全（如旧数据/手工误改），用 EXPLORER 同款默认兜底关键字段。
 * @returns 归一化后的 SubAgentTemplate；输入非 object 抛错
 */
export function normalizeTemplate(data: unknown): SubAgentTemplate {
  if (typeof data !== 'object' || data === null) {
    throw new Error('normalizeTemplate: data is not an object');
  }
  const d = data as Record<string, unknown>;
  return {
    name: typeof d.name === 'string' ? d.name : '',
    description: typeof d.description === 'string' ? d.description : '',
    systemPrompt: typeof d.systemPrompt === 'string' ? d.systemPrompt : '',
    tools: Array.isArray(d.tools) ? (d.tools as string[]) : [],
    ...(Array.isArray(d.skills) ? { skills: d.skills as string[] } : {}),
    // modelId: null/undefined/string 均合法（null/undefined = inherit parent）
    ...(d.modelId !== undefined ? { modelId: d.modelId as string | null } : {}),
    ...(typeof d.builtin === 'boolean' ? { builtin: d.builtin } : {}),
  };
}

/**
 * 从 app_config sub_agent_templates group 读单个模板（loadTemplate concrete 实现）。
 *
 * 历史命名：函数名保留 FromDevConfig 后缀（实现已切 app_config，v0.0.89 迁移），
 * 避免下游 import 大幅改动。
 *
 * @param appConfig AppConfigService 实例
 * @param name      模板 name（= record.key）
 * @returns 模板存在返归一化的 SubAgentTemplate；不存在返 null（spawn 解析阶段由
 *          template-loader.resolveEffective 判断 templateRef 提供但 null → 抛 error）
 */
export async function loadTemplateFromDevConfig(
  appConfig: AppConfigService,
  name: string,
): Promise<SubAgentTemplate | null> {
  const raw = appConfig.get(SUB_AGENT_TEMPLATES_GROUP, name);
  if (raw === undefined) return null;
  return normalizeTemplate(raw);
}

/**
 * 列出 sub_agent_templates group 全部模板（list 用）。
 * @returns 归一化后的 SubAgentTemplate[]；空组返空数组
 */
export function listTemplates(appConfig: AppConfigService): SubAgentTemplate[] {
  return appConfig
    .listGroup(SUB_AGENT_TEMPLATES_GROUP)
    .map((item) => normalizeTemplate(item.data));
}

/**
 * bootstrap 时 upsert builtin explorer 预配（idempotent）。
 *
 * 语义（subagent_templates §5.4 + api spec §5.4）：
 *   - 探测 sub_agent_templates group 是否有 builtin=true 的 explorer record
 *   - 存在 → 跳过（不回写用户改的字段，保证 builtin 标记不被篡改 + 允许用户改衍生）
 *   - 不存在 → 写入 EXPLORER_TEMPLATE 预配值（builtin=true）
 *
 * @returns true=本次写入；false=已存在跳过
 */
export function upsertExplorerTemplate(appConfig: AppConfigService): boolean {
  const existing = appConfig.get(SUB_AGENT_TEMPLATES_GROUP, EXPLORER_TEMPLATE.name);
  if (existing !== undefined) {
    // explorer record 已存在 → idempotent 跳过（不覆盖用户改的字段）
    return false;
  }
  appConfig.set(SUB_AGENT_TEMPLATES_GROUP, EXPLORER_TEMPLATE.name, EXPLORER_TEMPLATE);
  return true;
}

/**
 * 构造 loadTemplate 函数（bind appConfig），供 bootstrap 注入到 agent 工具运行时。
 *
 * 用法（bootstrap）：
 *   const loadTemplate = makeLoadTemplate(appConfig);
 *   agentManager.setBuildAgentToolContext(async (sid, runId) => ({
 *     ...,
 *     loadTemplate,
 *   }));
 */
export function makeLoadTemplate(
  appConfig: AppConfigService,
): (name: string) => Promise<SubAgentTemplate | null> {
  return (name: string) => loadTemplateFromDevConfig(appConfig, name);
}

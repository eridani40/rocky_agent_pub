/**
 * config-sync-export — 配置导出采集模块。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D3
 *      specs/prd/v0.0.318-config-sync.md §2.2 §3.2
 *
 * 按选中项读取 provider + 工具 group 配置 → 剥离 id → 构造 ConfigExportData → 加密下载。
 */

import {
  loadProvidersAndProtocols,
  getConfigGroup,
} from './api-client';
import {
  wrapExport,
  type ConfigExportData,
  type ProviderExportItem,
} from './config-crypto';

/** 选择状态（provider 用 label 作 key，工具用 tabId） */
export interface SelectionState {
  providers: Set<string>;
  tools: Set<string>;
}

/** 工具 tab → config group/key 映射（D3 约束，对齐 PRD §3.2） */
export const TOOL_TAB_MAP = {
  web_search: { group: 'web_search', keys: ['default'] },
  web_fetch: { group: 'web', keys: ['jinaApiKey', 'jinaEnabled', 'jinaTimeoutMs'] },
  see_image: { group: 'see_image', keys: ['default'] },
  bash: { group: 'runtime', keys: ['bash_seatbelt'] },
} as const;

/** 工具 tab id 列表（用于遍历） */
export const TOOL_TAB_IDS = ['web_search', 'web_fetch', 'see_image', 'bash'] as const;

/** i18n tab 名 key（展示用） */
export const TOOL_TAB_LABEL_KEYS: Record<string, string> = {
  web_search: 'tab.tools.web_search',
  web_fetch: 'tab.tools.web_fetch',
  see_image: 'tab.tools.see_image',
  bash: 'tab.tools.bash',
};

/**
 * 从 config group records 中提取指定 tab 相关 key 的 data。
 * @returns tabId → { key: data } 映射
 */
function extractToolData(
  records: { key: string; data: unknown }[],
  tabId: string,
): Record<string, unknown> {
  const config = TOOL_TAB_MAP[tabId as keyof typeof TOOL_TAB_MAP];
  if (!config) return {};
  const result: Record<string, unknown> = {};
  for (const key of config.keys) {
    const record = records.find((r) => r.key === key);
    if (record) result[key] = record.data;
  }
  return result;
}

/**
 * 按选中项采集导出数据（D3 method 级流程）。
 * - 模型：GET /provider → 过滤选中 provider → 剥离 id → models 全量
 * - 工具：逐 tab GET config group → 提取选中 key
 */
export async function collectExportData(selected: SelectionState): Promise<ConfigExportData> {
  // 1. 模型采集
  const { items } = await loadProvidersAndProtocols();
  const providers: ProviderExportItem[] = items
    .filter((p) => selected.providers.has(p.label))
    .map((p) => ({
      label: p.label,
      name: p.name,
      protocolId: p.protocolId,
      baseUrl: p.baseUrl,
      credentials: { key: p.credentials.key },
      enabled: p.enabled,
      models: p.models, // 全量 models
    }));

  // 2. 工具采集
  const tools: Record<string, unknown> = {};
  for (const tabId of TOOL_TAB_IDS) {
    if (!selected.tools.has(tabId)) continue;
    const { group } = TOOL_TAB_MAP[tabId];
    const records = await getConfigGroup('app', group);
    tools[tabId] = extractToolData(records, tabId);
  }

  return {
    v: 1,
    exportedAt: new Date().toISOString(),
    providers,
    tools,
  };
}

/**
 * 格式化文件名：rocky_agent_config_YYYYMMDD_HHmmss.json
 */
function formatFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `rocky_agent_config_${y}${m}${d}_${h}${min}${s}.json`;
}

/**
 * 加密 + 构造 Blob → 触发浏览器下载（D3）。
 */
export async function triggerDownload(data: ConfigExportData): Promise<void> {
  const file = await wrapExport(data);
  const json = JSON.stringify(file, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = formatFileName();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

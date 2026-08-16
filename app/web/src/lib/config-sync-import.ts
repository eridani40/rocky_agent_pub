/**
 * config-sync-import — 配置导入执行模块。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D4
 *      specs/prd/v0.0.318-config-sync.md §2.3 §3.3
 *
 * 文件解析（解密+校验）→ 重名检测 → 逐条注入（provider POST + model POST）+ 整 tab 覆盖（PUT config）。
 */

import type { ProviderInstance } from './api-client';
import {
  createProvider,
  createModel,
  putConfigGroup,
  loadProvidersAndProtocols,
} from './api-client';
import { unwrapExport, type ConfigExportData, type ProviderExportItem } from './config-crypto';
import { TOOL_TAB_MAP, TOOL_TAB_IDS, type SelectionState } from './config-sync-export';

/** 导入结果 */
export interface ImportResult {
  providersImported: number;
  toolsImported: number;
}

/**
 * 解析导入文件 → 解密 → 校验 → ConfigExportData（D4）。
 * 失败 throw 带用户可读 message 的 Error（3 种场景：非本系统格式/损坏/版本不兼容）。
 */
export async function parseImportFile(file: File): Promise<ConfigExportData> {
  let parsed: unknown;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件格式不正确，无法解析为配置同步文件');
  }
  // unwrapExport 内部处理 v 校验 + 解密 + 可读 error message
  return unwrapExport(parsed);
}

/**
 * 检查导入文件中与本地 label 重复的 provider（D4）。
 * 按 label 精确匹配，返回重名 label 集合。
 */
export function checkDuplicateLabels(
  providers: ProviderExportItem[],
  localProviders: ProviderInstance[],
): Set<string> {
  const localLabels = new Set(localProviders.map((p) => p.label));
  const duplicates = new Set<string>();
  for (const p of providers) {
    if (localLabels.has(p.label)) duplicates.add(p.label);
  }
  return duplicates;
}

/**
 * 从 tools data 中提取指定 tab 的 key→data items（用于 PUT 整组提交）。
 */
function resolveToolItems(
  toolsData: Record<string, unknown>,
  tabId: string,
): { key: string; data: unknown }[] {
  const config = TOOL_TAB_MAP[tabId as keyof typeof TOOL_TAB_MAP];
  if (!config) return [];
  const tabData = toolsData[tabId];
  if (!tabData || typeof tabData !== 'object') return [];
  const dataRecord = tabData as Record<string, unknown>;
  return config.keys
    .filter((key) => key in dataRecord)
    .map((key) => ({ key, data: dataRecord[key] }));
}

/**
 * 执行导入（D4 method 级流程）。
 * - 模型注入：逐条 createProvider（不传 id）+ createModel
 * - 工具覆盖：整 tab putConfigGroup
 */
export async function executeImport(
  data: ConfigExportData,
  selected: SelectionState,
): Promise<ImportResult> {
  const result: ImportResult = { providersImported: 0, toolsImported: 0 };

  // 1. 模型注入（逐条）
  for (const provider of data.providers) {
    if (!selected.providers.has(provider.label)) continue;

    // 1a. POST /provider（不传 id，后端生成新 ULID）
    // [v0.0.350] name 透传（native 类型导入保型；旧导出文件无 name → 缺省通用向后兼容）
    const created = await createProvider({
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey: provider.credentials.key,
      protocolId: provider.protocolId,
      name: provider.name,
    });

    // 1b. 逐个 POST /provider/:id/model
    for (const model of provider.models ?? []) {
      await createModel(created.id, {
        modelId: model.modelId,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        label: model.label,
        enabled: model.enabled,
      });
    }

    result.providersImported++;
  }

  // 2. 工具覆盖（整 tab PUT）
  for (const tabId of TOOL_TAB_IDS) {
    if (!selected.tools.has(tabId)) continue;
    const { group } = TOOL_TAB_MAP[tabId];
    const items = resolveToolItems(data.tools, tabId);
    if (items.length === 0) continue;
    await putConfigGroup('app', group, items);
    result.toolsImported++;
  }

  return result;
}

/**
 * 便捷：获取本地 provider 列表（导入树渲染前比对重名用）。
 */
export async function getLocalProviders(): Promise<ProviderInstance[]> {
  const { items } = await loadProvidersAndProtocols();
  return items;
}

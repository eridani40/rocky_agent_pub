/**
 * app-settings-persist — 应用设置 KV 加载 + 保存的纯 async 辅助。
 * 参考 specs/ui/components/app-dev-config-page/page-app-settings-merged.md（page-tab 级保存）。
 *
 * 职责：
 *   - loadAppConfig：GET logs/default_models/llm_request/session/consolidation 并汇总为 plain data（不碰 React state）
 *   - persistGroup：把单个 group draft 提交到后端，返回新 snapshot（不碰 React state）
 *
 * 不处理 appearance（language 由 ComponentLocaleCard 自行持久化；theme 前端不管）。
 * 边界：纯函数，调用方（hook）负责 setState；不持 React state。
 */
import { putConfigGroup, req, getConfigGroup } from '../../lib/api-client';
import {
  KV_GROUPS,
  DEFAULT_LLM_REQUEST_SUBFIELDS,
  DEFAULT_SESSION_SUBFIELDS,
  DEFAULT_CONSOLIDATION_SUBFIELDS,
  structuredCloneSafe,
  defaultFor,
  type DefaultModelsData,
  type ConsolidationData,
} from './app-settings-config-defs';

/** llm_request/default record 完整 data（read-modify-write 用，前端持完整 snapshot） */
export interface LlmRequestData {
  timeout: Record<string, number>;
  retry: Record<string, number>;
  degradation?: unknown;
  length?: unknown;
  fallback_chain?: unknown;
  [k: string]: unknown;
}

/** session/default record 完整 data（read-modify-write 用） */
export interface SessionData {
  maxSkillInject?: number;
  maxMemoryInject?: number;
  [k: string]: unknown;
}

/** 加载结果（plain data，调用方据此 setState） */
export interface LoadResult {
  logsMap: Record<string, unknown>;
  defaultModels: DefaultModelsData;
  llmFull: LlmRequestData | null;
  stallToolS: number;
  maxAttempts: number;
  sessionFull: SessionData | null;
  maxSkillInject: number;
  maxMemoryInject: number;
  /** consolidation/default（完整 record，缺失回退默认值） */
  consolidation: ConsolidationData;
}

/** 挂载时加载所有 KV group 数据（logs/default_models/llm_request/session/consolidation）
 *  5 个 GET 互相独立 → Promise.all 并行（避免顺序 await 拖慢首屏） */
export async function loadAppConfig(): Promise<LoadResult> {
  const [logsItems, dmRes, llmRes, sessionRes, consolidationRes] = await Promise.all([
    getConfigGroup('app', 'logs'),
    req<{ value: DefaultModelsData | null }>('/config/app?group=default_models&key=default'),
    req<{ value: LlmRequestData | null }>('/config/app?group=llm_request&key=default'),
    req<{ value: SessionData | null }>('/config/app?group=session&key=default'),
    req<{ value: ConsolidationData | null }>('/config/app?group=consolidation&key=default'),
  ]);
  // logs group
  const logsMap: Record<string, unknown> = {};
  for (const k of KV_GROUPS.find((d) => d.groupId === 'logs')!.keys) {
    const hit = logsItems.find((i) => i.key === k.key);
    logsMap[k.key] = hit?.data ?? defaultFor(k.type);
  }
  // default_models group
  const defaultModels = dmRes.value ?? {};
  // llm_request/default（read-modify-write：持完整 snapshot）
  const llmFull = llmRes.value ?? null;
  const stallToolS = llmFull?.timeout?.stall_tool_s ?? DEFAULT_LLM_REQUEST_SUBFIELDS.stall_tool_s;
  const maxAttempts = llmFull?.retry?.max_attempts ?? DEFAULT_LLM_REQUEST_SUBFIELDS.max_attempts;
  // session/default（read-modify-write：缺失字段回退 50）
  const sessionFull = sessionRes.value ?? null;
  const maxSkillInject = sessionFull?.maxSkillInject ?? DEFAULT_SESSION_SUBFIELDS.maxSkillInject;
  const maxMemoryInject = sessionFull?.maxMemoryInject ?? DEFAULT_SESSION_SUBFIELDS.maxMemoryInject;
  // consolidation/default（完整 record，字段缺失回退默认值；modelId 无默认，缺失即 undefined）
  const consolidation: ConsolidationData = {
    enabled: consolidationRes.value?.enabled ?? DEFAULT_CONSOLIDATION_SUBFIELDS.enabled,
    dailyTime: consolidationRes.value?.dailyTime ?? DEFAULT_CONSOLIDATION_SUBFIELDS.dailyTime,
    modelId: consolidationRes.value?.modelId,
  };
  return { logsMap, defaultModels, llmFull, stallToolS, maxAttempts, sessionFull, maxSkillInject, maxMemoryInject, consolidation };
}

/** tab 内某 group 的 draft 上下文（传给 persistTabGroup） */
export interface GroupPersistContext {
  groupId: string;
  draft: Record<string, unknown>;
  defaultModelsDraft: DefaultModelsData;
  llmFullSnapshot: LlmRequestData | null;
  sessionFullSnapshot: SessionData | null;
}

/** persist 单个 group 到后端；返回该 group 提交后的新 snapshot（供 hook 更新基线） */
export async function persistGroup(ctx: GroupPersistContext): Promise<{
  newDmSnapshot?: DefaultModelsData;
  newLlmFullSnapshot?: LlmRequestData;
  newLlmSnapshot?: Record<string, unknown>;
  newLogsSnapshot?: Record<string, unknown>;
  newSessionFullSnapshot?: SessionData;
  newSessionSnapshot?: Record<string, unknown>;
  newConsolidationSnapshot?: ConsolidationData;
}> {
  const { groupId, draft, defaultModelsDraft, llmFullSnapshot, sessionFullSnapshot } = ctx;
  if (groupId === 'default_models') {
    await req('/config/app', {
      method: 'PUT',
      body: JSON.stringify({ group: 'default_models', key: 'default', data: defaultModelsDraft }),
    });
    return { newDmSnapshot: structuredCloneSafe(defaultModelsDraft) };
  }
  if (groupId === 'llm_request') {
    // read-modify-write：基于完整 snapshot 改 stall_tool_s + max_attempts 后 PUT 完整 data
    const base: LlmRequestData = llmFullSnapshot
      ? structuredCloneSafe(llmFullSnapshot)
      : { timeout: {}, retry: {} };
    if (!base.timeout) base.timeout = {};
    if (!base.retry) base.retry = {};
    base.timeout.stall_tool_s = (draft.stall_tool_s as number) ?? DEFAULT_LLM_REQUEST_SUBFIELDS.stall_tool_s;
    base.retry.max_attempts = (draft.max_attempts as number) ?? DEFAULT_LLM_REQUEST_SUBFIELDS.max_attempts;
    await req('/config/app', {
      method: 'PUT',
      body: JSON.stringify({ group: 'llm_request', key: 'default', data: base }),
    });
    return {
      newLlmFullSnapshot: base,
      newLlmSnapshot: { stall_tool_s: base.timeout.stall_tool_s, max_attempts: base.retry.max_attempts },
    };
  }
  if (groupId === 'logs') {
    const def = KV_GROUPS.find((d) => d.groupId === 'logs')!;
    const items = def.keys.map((k) => ({ key: k.key, data: draft[k.key] }));
    await putConfigGroup('app', 'logs', items);
    return { newLogsSnapshot: { ...draft } };
  }
  if (groupId === 'session') {
    // read-modify-write：基于完整 snapshot 改 maxSkillInject + maxMemoryInject 后 PUT 完整 data
    const base: SessionData = sessionFullSnapshot
      ? structuredCloneSafe(sessionFullSnapshot)
      : {};
    base.maxSkillInject = (draft.maxSkillInject as number) ?? DEFAULT_SESSION_SUBFIELDS.maxSkillInject;
    base.maxMemoryInject = (draft.maxMemoryInject as number) ?? DEFAULT_SESSION_SUBFIELDS.maxMemoryInject;
    await req('/config/app', {
      method: 'PUT',
      body: JSON.stringify({ group: 'session', key: 'default', data: base }),
    });
    return {
      newSessionFullSnapshot: base,
      newSessionSnapshot: { maxSkillInject: base.maxSkillInject, maxMemoryInject: base.maxMemoryInject },
    };
  }
  if (groupId === 'consolidation') {
    // consolidation 是完整 record（无部分字段场景），直接整体 PUT（同 llm_request/session 范式）
    const data: ConsolidationData = {
      enabled: Boolean(draft.enabled),
      dailyTime: (draft.dailyTime as string) ?? DEFAULT_CONSOLIDATION_SUBFIELDS.dailyTime,
      modelId: draft.modelId as string | undefined,
    };
    await req('/config/app', {
      method: 'PUT',
      body: JSON.stringify({ group: 'consolidation', key: 'default', data }),
    });
    return { newConsolidationSnapshot: data };
  }
  return {};
}

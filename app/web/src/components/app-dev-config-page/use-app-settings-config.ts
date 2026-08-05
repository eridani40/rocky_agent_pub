/**
 * use-app-settings-config — 应用设置合并页 KV 状态 hook（page-tab 级 dirty 跟踪）。
 * 参考 specs/ui/components/app-dev-config-page/page-app-settings-merged.md。
 *
 * 管理 default_models（chat）/ llm_request（stall_tool_s+max_attempts）/ session / consolidation /
 * logs（4 toggle）的 snapshot/draft + page-tab 级 dirty 检测 + 保存/取消。
 * observability/providers/web_search/user_memory/appearance(locale) 是自渲染 group，
 * 不进本 hook（各自独立 save 流；language 由 ComponentLocaleCard 切即生效）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyInfo } from './component-key-card';
import type { GroupInfo } from './section-config-layout';
import {
  KV_GROUPS,
  DEFAULT_LLM_REQUEST_SUBFIELDS,
  DEFAULT_SESSION_SUBFIELDS,
  DEFAULT_CONSOLIDATION_SUBFIELDS,
  defaultFor,
  structuredCloneSafe,
  shallowDiff,
  buildKvGroup,
  TAB_KV_GROUPS,
  type TabId,
  type DefaultModelsData,
  type ConsolidationData,
} from './app-settings-config-defs';
import { persistGroup, loadAppConfig, type LlmRequestData, type SessionData } from './app-settings-persist';

/** default_models record data 形状（从 config-defs re-export，保持外部 import 路径兼容） */
export type { DefaultModelsData } from './app-settings-config-defs';

/** useAppSettingsConfig 返回值 */
export interface UseAppSettingsConfigResult {
  kvGroups: Record<string, GroupInfo>;
  defaultModelsDraft: DefaultModelsData;
  handleDefaultModelsChange: (key: 'chat', value: string | undefined) => void;
  /** consolidation/default draft（v0.0.151.t2_consolidate）；改字段走泛型 handleKeyChange('consolidation', key, value) */
  consolidationDraft: ConsolidationData;
  handleKeyChange: (groupId: string, key: string, next: unknown) => void;
  /** 该 tab 是否 dirty（tab 内任一 KV group dirty，或 default_models dirty） */
  dirtyOfTab: (tab: TabId) => boolean;
  /** 保存当前 tab 全部 dirty group（按 tab.groups 顺序提交） */
  saveTab: (tab: TabId) => Promise<void>;
  /** 取消：重置当前 tab draft 到 snapshot */
  cancelTab: (tab: TabId) => void;
  saving: boolean;
  /** 最近一次保存成功的短暂反馈（1.5s flash） */
  savedFlash: boolean;
  error: string | null;
}

/** 初始 KV groups（受控展示用，含 keys[].value 默认值） */
function initKvGroups(): Record<string, GroupInfo> {
  const init: Record<string, GroupInfo> = {};
  for (const def of KV_GROUPS) {
    init[def.groupId] = {
      groupId: def.groupId,
      keys: def.keys.map((k) => ({
        key: k.key,
        type: k.type,
        value:
          def.groupId === 'session' && (k.key === 'maxSkillInject' || k.key === 'maxMemoryInject')
            ? (DEFAULT_SESSION_SUBFIELDS[k.key as keyof typeof DEFAULT_SESSION_SUBFIELDS] as KeyInfo['value'])
            : (defaultFor(k.type) as KeyInfo['value']),
        desc: k.desc,
        labelKey: k.labelKey,
        options: k.options,
      })),
    };
  }
  return init;
}

/** 应用设置合并页 KV 状态 hook（page-tab 级 dirty） */
export function useAppSettingsConfig(): UseAppSettingsConfigResult {
  const [kvGroups, setKvGroups] = useState<Record<string, GroupInfo>>(initKvGroups);
  // snapshot：已持久化的基线（dirty 比对）
  const [snapshot, setSnapshot] = useState<Record<string, Record<string, unknown>>>({
    llm_request: { stall_tool_s: DEFAULT_LLM_REQUEST_SUBFIELDS.stall_tool_s, max_attempts: DEFAULT_LLM_REQUEST_SUBFIELDS.max_attempts },
    logs: {},
    session: { maxSkillInject: DEFAULT_SESSION_SUBFIELDS.maxSkillInject, maxMemoryInject: DEFAULT_SESSION_SUBFIELDS.maxMemoryInject },
    consolidation: { enabled: DEFAULT_CONSOLIDATION_SUBFIELDS.enabled, dailyTime: DEFAULT_CONSOLIDATION_SUBFIELDS.dailyTime, modelId: undefined },
  });
  // draft：用户编辑中的值
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>(() => structuredCloneSafe(snapshot));
  // default_models snapshot + draft
  const [dmSnapshot, setDmSnapshot] = useState<DefaultModelsData>({});
  const [dmDraft, setDmDraft] = useState<DefaultModelsData>({});
  // llm_request 完整 snapshot（read-modify-write：保存时 PUT 完整 data，不丢其他子字段）
  const [llmFullSnapshot, setLlmFullSnapshot] = useState<LlmRequestData | null>(null);
  // session 完整 snapshot（read-modify-write：保存时 PUT 完整 data，不丢其他子字段）
  const [sessionFullSnapshot, setSessionFullSnapshot] = useState<SessionData | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 挂载：loadAppConfig 汇总 GET 所有 KV group → setState 回填
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await loadAppConfig();
        if (cancelled) return;
        const llmValues = { stall_tool_s: r.stallToolS, max_attempts: r.maxAttempts };
        const sessionValues = { maxSkillInject: r.maxSkillInject, maxMemoryInject: r.maxMemoryInject };
        // consolidation：完整 record 存入 draft/snapshot（Record<string,unknown> 形态，modelId 可能为 undefined）
        const consolidationValues: Record<string, unknown> = { ...r.consolidation };
        setSnapshot((p) => ({ ...p, logs: r.logsMap, llm_request: llmValues, session: sessionValues, consolidation: consolidationValues }));
        setDraft((p) => ({ ...p, logs: structuredCloneSafe(r.logsMap), llm_request: { ...llmValues }, session: { ...sessionValues }, consolidation: { ...consolidationValues } }));
        setKvGroups((p) => ({
          ...p,
          logs: buildKvGroup('logs', r.logsMap),
          llm_request: buildKvGroup('llm_request', llmValues),
          session: buildKvGroup('session', sessionValues),
        }));
        setDmSnapshot(r.defaultModels);
        setDmDraft(structuredCloneSafe(r.defaultModels));
        setLlmFullSnapshot(r.llmFull);
        setSessionFullSnapshot(r.sessionFull);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载清理 savedFlash 定时器
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  /** 编辑 default_models 某 key（v0.0.158 起 key 收窄为 'chat' 单值） */
  const handleDefaultModelsChange = useCallback(
    (key: 'chat', value: string | undefined) => {
      setDmDraft((prev) => {
        const next = { ...prev };
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next;
      });
    },
    [],
  );

  /** 编辑某 KV key → 更新 draft + kvGroups 受控展示 */
  const handleKeyChange = useCallback(
    (groupId: string, key: string, next: unknown) => {
      setDraft((prev) => ({
        ...prev,
        [groupId]: { ...prev[groupId], [key]: next },
      }));
      setKvGroups((prev) => {
        const g = prev[groupId];
        if (!g) return prev;
        return {
          ...prev,
          [groupId]: {
            ...g,
            keys: g.keys.map((k) => (k.key === key ? { ...k, value: next as KeyInfo['value'] } : k)),
          },
        };
      });
    },
    [],
  );

  /** 该 tab 是否 dirty */
  const dirtyOfTab = useCallback(
    (tab: TabId): boolean => {
      const gids = TAB_KV_GROUPS[tab];
      for (const gid of gids) {
        if (gid === 'default_models') {
          // v0.0.158：default_models 只剩 chat 单字段（summary 已删）→ 直比 chat；
          //   保留「一方有 key 一方无 key」的空对象兼容（Object.keys 长度差异）。
          const dHas = 'chat' in dmDraft;
          const sHas = 'chat' in dmSnapshot;
          if (dHas !== sHas) return true;
          if (dmDraft.chat !== dmSnapshot.chat) return true;
        } else if (gid === 'llm_request') {
          if (shallowDiff(draft.llm_request ?? {}, snapshot.llm_request ?? {})) return true;
        } else if (shallowDiff(draft[gid] ?? {}, snapshot[gid] ?? {})) {
          return true;
        }
      }
      return false;
    },
    [draft, snapshot, dmDraft, dmSnapshot],
  );

  /** 保存当前 tab 全部 dirty group（委托 persistGroup 提交，按结果更新 snapshot） */
  const saveTab = useCallback(
    async (tab: TabId) => {
      const gids = TAB_KV_GROUPS[tab];
      if (gids.length === 0) return;
      setError(null);
      setSaving(true);
      try {
        for (const gid of gids) {
          const r = await persistGroup({
            groupId: gid,
            draft: draft[gid] ?? {},
            defaultModelsDraft: dmDraft,
            llmFullSnapshot: llmFullSnapshot,
            sessionFullSnapshot: sessionFullSnapshot,
          });
          // 按 persistGroup 返回的新 snapshot 更新基线（各 group 互斥，最多命中一支）
          if (r.newDmSnapshot) setDmSnapshot(r.newDmSnapshot);
          if (r.newLlmFullSnapshot) setLlmFullSnapshot(r.newLlmFullSnapshot);
          if (r.newLlmSnapshot) setSnapshot((p) => ({ ...p, llm_request: r.newLlmSnapshot! }));
          if (r.newLogsSnapshot) setSnapshot((p) => ({ ...p, logs: r.newLogsSnapshot! }));
          if (r.newSessionFullSnapshot) setSessionFullSnapshot(r.newSessionFullSnapshot);
          if (r.newSessionSnapshot) setSnapshot((p) => ({ ...p, session: r.newSessionSnapshot! }));
          if (r.newConsolidationSnapshot) setSnapshot((p) => ({ ...p, consolidation: { ...r.newConsolidationSnapshot! } }));
        }
        // flash saved 反馈（1.5s）
        setSavedFlash(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSavedFlash(false), 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [draft, dmDraft, llmFullSnapshot, sessionFullSnapshot],
  );

  /** 取消：重置当前 tab draft 到 snapshot */
  const cancelTab = useCallback(
    (tab: TabId) => {
      const gids = TAB_KV_GROUPS[tab];
      setDraft((prev) => {
        const next = { ...prev };
        for (const gid of gids) {
          if (gid === 'default_models') continue;
          next[gid] = structuredCloneSafe(snapshot[gid] ?? {});
        }
        return next;
      });
      setKvGroups((prev) => {
        const next = { ...prev };
        for (const gid of gids) {
          if (gid === 'default_models' || !next[gid]) continue;
          const def = KV_GROUPS.find((d) => d.groupId === gid);
          if (!def) continue;
          next[gid] = {
            ...next[gid],
            keys: next[gid].keys.map((k) => ({
              ...k,
              value: (snapshot[gid]?.[k.key] ?? defaultFor(k.type)) as KeyInfo['value'],
            })),
          };
        }
        return next;
      });
      if (gids.includes('default_models')) {
        setDmDraft(structuredCloneSafe(dmSnapshot));
      }
    },
    [snapshot, dmSnapshot],
  );

  // consolidation draft 派生（Record<string,unknown> 形态 → 落回 ConsolidationData 类型，缺省回退默认值）
  const consolidationDraft: ConsolidationData = {
    enabled: Boolean(draft.consolidation?.enabled ?? DEFAULT_CONSOLIDATION_SUBFIELDS.enabled),
    dailyTime: (draft.consolidation?.dailyTime as string | undefined) ?? DEFAULT_CONSOLIDATION_SUBFIELDS.dailyTime,
    modelId: draft.consolidation?.modelId as string | undefined,
  };

  return {
    kvGroups,
    defaultModelsDraft: dmDraft,
    handleDefaultModelsChange,
    consolidationDraft,
    handleKeyChange,
    dirtyOfTab,
    saveTab,
    cancelTab,
    saving,
    savedFlash,
    error,
  };
}

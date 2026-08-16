/**
 * section-tab-panel — 应用设置页右栏 tab 内容渲染。
 * 参考 specs/ui/components/app-dev-config-page/page-app-settings-merged.md（tab → group 映射）。
 *
 * 职责：根据 selectedTab 渲染对应 group 集合（上下排列，每 group title + 区域间隔）。
 *   - general：仅 ComponentLocaleCard 语言切即生效（light-only，无 theme 项）
 *   - session：session（maxSkillInject/maxMemoryInject KV）/ default_models + llm_request（KV）
 *   - models：providers（独立 dirty）
 *   - tools：web_search / web_fetch / see_image（均自渲染 item）
 *   - memory：user_memory（自渲染 item）
 *   - observability：observability（独立 save-bar，detail 视图独占内容区时隐藏 logs）+ logs（KV）
 *   - consolidation：SectionConsolidationConfig（自渲染）
 *   - plugin：PagePluginConfig（整页内嵌）
 *
 * 边界：纯展示组件，所有 draft/handlers 由父级 useAppSettingsConfig 注入；
 *   不持业务态（providerViewLevel 为 UI 展示态，非业务态）。
 */
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ComponentLocaleCard } from './component-locale-card';
import { SectionDefaultModelsAndRequest } from './section-default-models-and-request';
import { SectionSessionConfig } from './section-session-config';
import { SectionConsolidationConfig } from './section-consolidation-config';
import { SectionProviders } from '../providers/section-providers';
import { SectionObservability } from './observability-config/section-observability';
import { SectionWebSearchConfig } from './section-web-search-config';
import { SectionWebFetchConfig } from './section-web-fetch-config';
import { SectionSeeImageConfig } from './section-see-image-config';
import { SectionBashConfig } from './section-bash-config';
import { SectionLogsConfig } from './section-logs-config';
import { SectionUserMemory } from './section-user-memory';
import { SectionModelRoutingPlans } from './section-model-routing-plans';
// [v0.0.318] 配置同步（导入导出）：自渲染即时操作，不走 SaveBar
import { SectionConfigSync } from './section-config-sync';
import { SectionTeamSync } from './section-team-sync';
import { PagePluginConfig } from '../plugin-config-page/page-plugin-config';
import type { LocaleId } from '../../i18n';
import type { GroupInfo } from './section-config-layout';
import type { DefaultModelsData } from './use-app-settings-config';
import type { TabId, ConsolidationData } from './app-settings-config-defs';

export interface SectionTabPanelProps {
  selectedTab: TabId;
  kvGroups: Record<string, GroupInfo>;
  defaultModelsDraft: DefaultModelsData;
  /** v0.0.158：default_models 只剩 chat 一列（summary 已删） */
  onDefaultModelsChange: (key: 'chat', value: string | undefined) => void;
  /** [v0.0.347 T6] playground 方案挂载 draft（model_routing/default.playgroundPlanId；null=未挂载） */
  mountDraft?: string | null;
  /** [v0.0.347 T6] 挂载 draft 变更（planId=null=清除） */
  onMountChange?: (planId: string | null) => void;
  /** [v0.0.349 BUG-004] 方案库删除成功上抛（detached 含 'playground' 时 page 清本地挂载态） */
  onPlanDeleted?: (detached: string[], planId: string) => void;
  onKeyChange: (groupId: string, key: string, next: unknown) => void;
  /** consolidation record draft */
  consolidationDraft: ConsolidationData;
  /**
   * [v0.0.316] tab 级 section ref 注册器（tools/observability tab 用）。
   * 传入时，tools tab 的 4 个 section + observability section 挂 ref 到 aggregator。
   * 不传（undefined）= 旧模式（section 自管 save bar，向后兼容）。
   */
  registerSection?: (key: string) => (handle: import('./use-tab-dirty-aggregator').SectionSaveHandle | null) => void;
  /**
   * [v0.0.316-fix] section dirty 变化上报（page 注入 aggregator.reportDirty）。
   * section 通过 onDirtyChange callback 上报 → page setDirtyMap → re-render → save bar 亮。
   */
  onSectionDirtyChange?: (key: string, dirty: boolean) => void;
  /** [v0.0.317 D8] 语言 draft 值（null = 未改动，显示当前 i18n 语言） */
  languageDraft?: LocaleId | null;
  /** [v0.0.317 D8] 语言选择回调（仅上报父级，不调 changeLanguage） */
  onLanguageChange?: (lng: LocaleId) => void;
}

/** 渲染当前 tab 的 group 集合 */
export function SectionTabPanel({
  selectedTab,
  kvGroups,
  defaultModelsDraft,
  onDefaultModelsChange,
  mountDraft,
  onMountChange,
  onPlanDeleted,
  onKeyChange,
  consolidationDraft,
  registerSection,
  onSectionDirtyChange,
  languageDraft,
  onLanguageChange,
}: SectionTabPanelProps): ReactNode {
  const { t, i18n } = useTranslation('app-dev-config');
  // 可观测性 detail 视图（新增/编辑配置）独占 tab 内容区时，隐藏 tab 内其他 group（logs）。
  // 由 SectionObservability 通过 onDetailViewChange 同步上报（UI 展示态，与 providerViewLevel 同性质）。
  const [obsInDetail, setObsInDetail] = useState(false);
  // [v0.0.347 T4] models tab 双 section view level（providers + 方案库）：任一进 detail 态
  // 时独占 tab 内容区（其余 group 及标题全隐藏，独立详情页——老板拍板）。由各 section
  // 通过 onViewLevelChange 上抛（同 obsInDetail 机制；provider 侧 v0.0.140 机制本次补接线）。
  const [providerViewLevel, setProviderViewLevel] = useState<'list' | 'detail'>('list');
  const [plansViewLevel, setPlansViewLevel] = useState<'list' | 'detail'>('list');
  // 切离 observability tab 时 SectionObservability 会 unmount（内部 detail state 丢失），
  // 同步把 obsInDetail 重置为 list 态，避免切回时 stale=true 错误隐藏 logs/标题。
  useEffect(() => {
    if (selectedTab !== 'observability') setObsInDetail(false);
  }, [selectedTab]);
  // [v0.0.347 T4] 同上：切离 models tab 时两 section unmount，重置防 stale。
  useEffect(() => {
    if (selectedTab !== 'models') {
      setProviderViewLevel('list');
      setPlansViewLevel('list');
    }
  }, [selectedTab]);

  switch (selectedTab) {
    case 'general':
      // general tab 只留语言 card；theme 不再前端配置（light-only）
      // [v0.0.317 D8] 语言走 SaveBar：受控 value/onChange（不调 changeLanguage，点保存才切）
      return (
        <div>
          <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.locale.label')}</h3>
          <div className="flex flex-col">
            <ComponentLocaleCard
              value={languageDraft ?? (i18n.language ?? 'zh-CN') as LocaleId}
              onChange={(lng) => onLanguageChange?.(lng)}
            />
          </div>
        </div>
      );
    case 'session':
      return (
        <>
          {/* 会话注入数量 group（maxSkillInject + maxMemoryInject，KV page-tab dirty） */}
          <SectionSessionConfig
            sessionDraft={{
              maxSkillInject: Number(kvGroups.session?.keys.find((k) => k.key === 'maxSkillInject')?.value ?? 50),
              maxMemoryInject: Number(kvGroups.session?.keys.find((k) => k.key === 'maxMemoryInject')?.value ?? 50),
            }}
            onSessionChange={(key, value) => onKeyChange('session', key, value)}
          />
          {/* playground 默认模型 + 请求设置（v0.0.149 从 models tab 迁来，复用既有 section） */}
          <SectionDefaultModelsAndRequest
            defaultModelsDraft={defaultModelsDraft}
            onDefaultModelsChange={onDefaultModelsChange}
            mountDraft={mountDraft ?? null}
            onMountChange={(planId) => onMountChange?.(planId)}
            llmRequestDraft={{
              stall_tool_s: Number(kvGroups.llm_request?.keys.find((k) => k.key === 'stall_tool_s')?.value ?? 120),
              max_attempts: Number(kvGroups.llm_request?.keys.find((k) => k.key === 'max_attempts')?.value ?? 3),
            }}
            onLlmRequestChange={(key, value) => onKeyChange('llm_request', key, value)}
          />
        </>
      );
    case 'models': {
      // [v0.0.347 T4] detail 态独占 tab 内容区（独立详情页，老板拍板）：任一 section 进
      // detail 时另一 section 及其 group 标题隐藏。互斥由构造保证：detail 态下另一
      // section 列表不可见 → 无法进入其 detail。
      // [T4-blocking 教训] 骨架恒定契约：顶层恒为 [div, div] 两容器，detail 态只用条件
      // null 置空槽位内容——禁止 detail 分支裸 return Section（同位置节点类型 div→Section
      // 变化会触发 React reconciliation 整树卸载重挂，Section 内部 view state 丢失重置
      // list → onViewLevelChange 上抛 list → 详情闪回进不去）。
      const providersInDetail = providerViewLevel === 'detail';
      const plansInDetail = plansViewLevel === 'detail';
      return (
        <>
          {/* 供应商和模型 group：独立 dirty（provider 编辑器自管 save，不进 page-tab dirty）。
              槽位恒定：slot0 = h3|null，slot1 = SectionProviders|null —— providers 进 detail
              时 SectionProviders 槽位不动不重挂（plans 进 detail 时才卸载隐藏） */}
          <div data-active="true">
            {providersInDetail || plansInDetail ? null : (
              <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.providers.label')}</h3>
            )}
            {plansInDetail ? null : <SectionProviders onViewLevelChange={setProviderViewLevel} />}
          </div>
          {/* [v0.0.347] 模型组合方案库（自渲染即时操作，不走 page-tab dirty；provider 独立 save 流同范式）。
              槽位恒定：slot0 = SectionModelRoutingPlans|null —— plans 进 detail 时槽位不动不重挂；
              detail 态去 mt-8（详情独占页顶对齐，与 provider 详情一致） */}
          <div className={plansInDetail ? '' : 'mt-8'}>
            {providersInDetail ? null : (
              <SectionModelRoutingPlans onViewLevelChange={setPlansViewLevel} onPlanDeleted={onPlanDeleted} />
            )}
          </div>
        </>
      );
    }
    case 'tools':
      return (
        <>
          {/* 网络搜索 section（[v0.0.316] 挂 ref 到 tab 级 aggregator，自管 save/reset toolbar 已移除） */}
          <div>
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.web_search.label')}</h3>
            <SectionWebSearchConfig
              ref={registerSection?.('web_search')}
              onDirtyChange={(d) => onSectionDirtyChange?.('web_search', d)}
            />
          </div>
          {/* 网络抓取 section（v0.0.121 新增，紧邻网络搜索下方） */}
          <div className="mt-8">
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.web_fetch.label')}</h3>
            <SectionWebFetchConfig
              ref={registerSection?.('web_fetch')}
              onDirtyChange={(d) => onSectionDirtyChange?.('web_fetch', d)}
            />
          </div>
          {/* 看图理解 section（v0.0.141 新增，紧邻网络抓取下方） */}
          <div className="mt-8">
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.see_image.label')}</h3>
            <SectionSeeImageConfig
              ref={registerSection?.('see_image')}
              onDirtyChange={(d) => onSectionDirtyChange?.('see_image', d)}
            />
          </div>
          {/* Bash 工具 section（v0.0.296 新增，沙箱开关） */}
          <div className="mt-8">
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.bash.label')}</h3>
            <SectionBashConfig
              ref={registerSection?.('bash')}
              onDirtyChange={(d) => onSectionDirtyChange?.('bash', d)}
            />
          </div>
        </>
      );
    case 'memory':
      return (
        <div>
          <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.user_memory.label')}</h3>
          <SectionUserMemory />
        </div>
      );
    case 'config_sync':
      // [v0.0.318] 配置同步：自渲染即时操作（导入导出），不走 SaveBar / page-tab dirty
      return <SectionConfigSync />;
    case 'team_sync':
      // [v0.0.319] 团队同步：独立操作页（即时操作，不进 page-tab dirty / SaveBar）
      return <SectionTeamSync />;
    case 'observability': {
      // detail 视图（新增/编辑可观测性配置）独占 tab 内容区，
      // 隐藏「可观测性」group 标题与「日志」group，避免 detail 下滚看到 tab 内其他内容。
      // SectionObservability 两种态都渲染（内部按 detail state 自行渲染 list 或 detail）。
      return (
        <>
          <div>
            {obsInDetail ? null : (
              <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.observability.label')}</h3>
            )}
            <SectionObservability
              ref={registerSection?.('observability')}
              onDirtyChange={(d) => onSectionDirtyChange?.('observability', d)}
              onDetailViewChange={setObsInDetail}
            />
          </div>
          {obsInDetail ? null : (
            <div>
              <h3 className="text-[15px] font-semibold text-fg mb-3 mt-8">{t('group.logs.label')}</h3>
              <SectionLogsConfig
                ref={registerSection?.('logs')}
                onDirtyChange={(d) => onSectionDirtyChange?.('logs', d)}
              />
            </div>
          )}
        </>
      );
    }
    case 'consolidation':
      return (
        <SectionConsolidationConfig
          draft={consolidationDraft}
          onChange={(key, value) => onKeyChange('consolidation', key, value)}
        />
      );
    case 'plugin':
      return (
        <div>
          <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.plugin.label')}</h3>
          <PagePluginConfig />
        </div>
      );
    default:
      return null;
  }
}

export default SectionTabPanel;

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
import { ComponentKeyCard } from './component-key-card';
import { ComponentLocaleCard } from './component-locale-card';
import { SectionDefaultModelsAndRequest } from './section-default-models-and-request';
import { SectionSessionConfig } from './section-session-config';
import { SectionConsolidationConfig } from './section-consolidation-config';
import { SectionProviders } from '../providers/section-providers';
import { SectionObservability } from './observability-config/section-observability';
import { SectionWebSearchConfig } from './section-web-search-config';
import { SectionWebFetchConfig } from './section-web-fetch-config';
import { SectionSeeImageConfig } from './section-see-image-config';
import { SectionUserMemory } from './section-user-memory';
import { PagePluginConfig } from '../plugin-config-page/page-plugin-config';
import type { GroupInfo } from './section-config-layout';
import type { DefaultModelsData } from './use-app-settings-config';
import type { TabId, ConsolidationData } from './app-settings-config-defs';

export interface SectionTabPanelProps {
  selectedTab: TabId;
  kvGroups: Record<string, GroupInfo>;
  defaultModelsDraft: DefaultModelsData;
  /** v0.0.158：default_models 只剩 chat 一列（summary 已删） */
  onDefaultModelsChange: (key: 'chat', value: string | undefined) => void;
  onKeyChange: (groupId: string, key: string, next: unknown) => void;
  /** consolidation record draft */
  consolidationDraft: ConsolidationData;
}

/** 渲染当前 tab 的 group 集合 */
export function SectionTabPanel({
  selectedTab,
  kvGroups,
  defaultModelsDraft,
  onDefaultModelsChange,
  onKeyChange,
  consolidationDraft,
}: SectionTabPanelProps): ReactNode {
  const { t } = useTranslation('app-dev-config');
  // 可观测性 detail 视图（新增/编辑配置）独占 tab 内容区时，隐藏 tab 内其他 group（logs）。
  // 由 SectionObservability 通过 onDetailViewChange 同步上报（UI 展示态，与 providerViewLevel 同性质）。
  const [obsInDetail, setObsInDetail] = useState(false);
  // 切离 observability tab 时 SectionObservability 会 unmount（内部 detail state 丢失），
  // 同步把 obsInDetail 重置为 list 态，避免切回时 stale=true 错误隐藏 logs/标题。
  useEffect(() => {
    if (selectedTab !== 'observability') setObsInDetail(false);
  }, [selectedTab]);

  switch (selectedTab) {
    case 'general':
      // general tab 只留语言 card；theme 不再前端配置（light-only）
      return (
        <div>
          <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.locale.label')}</h3>
          <div className="flex flex-col">
            <ComponentLocaleCard />
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
            llmRequestDraft={{
              stall_tool_s: Number(kvGroups.llm_request?.keys.find((k) => k.key === 'stall_tool_s')?.value ?? 120),
              max_attempts: Number(kvGroups.llm_request?.keys.find((k) => k.key === 'max_attempts')?.value ?? 3),
            }}
            onLlmRequestChange={(key, value) => onKeyChange('llm_request', key, value)}
          />
        </>
      );
    case 'models':
      return (
        <>
          {/* 供应商和模型 group：独立 dirty（provider 编辑器自管 save，不进 page-tab dirty） */}
          <div data-active="true">
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.providers.label')}</h3>
            <SectionProviders />
          </div>
        </>
      );
    case 'tools':
      return (
        <>
          {/* 网络搜索 section */}
          <div>
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.web_search.label')}</h3>
            <SectionWebSearchConfig />
          </div>
          {/* 网络抓取 section（v0.0.121 新增，紧邻网络搜索下方） */}
          <div className="mt-8">
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.web_fetch.label')}</h3>
            <SectionWebFetchConfig />
          </div>
          {/* 看图理解 section（v0.0.141 新增，紧邻网络抓取下方） */}
          <div className="mt-8">
            <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.see_image.label')}</h3>
            <SectionSeeImageConfig />
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
            <SectionObservability onDetailViewChange={setObsInDetail} />
          </div>
          {obsInDetail ? null : (
            <div>
              <h3 className="text-[15px] font-semibold text-fg mb-3 mt-8">{t('group.logs.label')}</h3>
              <div className="flex flex-col">
                {kvGroups.logs!.keys.map((k) => (
                  <ComponentKeyCard
                    key={k.key}
                    keyInfo={k}
                    onChange={(next) => onKeyChange('logs', k.key, next)}
                  />
                ))}
              </div>
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

/**
 * page-app-settings-merged — 应用设置合并页（v0.0.89 大改：tab 竖排导航树 + page-tab 级保存）
 * 参考: specs/ui/components/app-dev-config-page/page-app-settings-merged.md
 *       reqs/[working] v0.0.89.ui_opt/demo.html（视觉契约：tab 树 + group title + sticky save bar）
 *
 * 结构：左侧 tab 树（通用区 5 tab + 系统设置收起区 3 tab（观测/整理/插件），
 *   复用 app-settings-system-toggle）+ 右侧按选中 tab 渲染对应 group 集合（SectionTabPanel）+
 *   底部 page-tab 级 sticky save-bar（TabSaveBar）。
 *
 * 保存粒度：page-tab 级（当前 tab 全部 KV group 原子提交）；
 *   provider/observability/user_memory/web_search 例外（独立 save 流，不进 page-tab dirty）；
 *   language 切即生效（ComponentLocaleCard 内部处理，不走 page-tab dirty）。
 *
 * 切 tab dirty 未保存 → 弹确认 modal「丢弃改动 / 取消」（不静默丢）。
 *
 * 边界：薄壳编排，不持 KV 状态（在 useAppSettingsConfig hook）；
 *   tab 内容渲染抽到 SectionTabPanel；确认 modal 抽到 common/component-confirm-modal；
 *   收起 systemExpanded 时若 selectedTab ∈ {observability/consolidation/plugin} → 回落 general。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TabTreeItem } from './component-tab-tree-item';
import { TabSaveBar } from './component-tab-save-bar';
import { SectionTabPanel } from './section-tab-panel';
import { ConfirmModal } from '../common/component-confirm-modal';
import { useAppSettingsConfig } from './use-app-settings-config';
import {
  APP_SETTINGS_TABS,
  SYSTEM_TABS,
  TAB_KV_GROUPS,
  type TabId,
} from './app-settings-config-defs';

/** 应用设置合并页根（v0.0.89 tab 树重构） */
export function PageAppSettingsMerged() {
  const { t } = useTranslation('app-dev-config');
  const [selectedTab, setSelectedTab] = useState<TabId>('general');
  const [systemExpanded, setSystemExpanded] = useState(false);
  // dirty 切 tab 时的待确认 tab（非 null 时显示确认 modal）
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);
  const {
    kvGroups,
    defaultModelsDraft,
    handleDefaultModelsChange,
    consolidationDraft,
    handleKeyChange,
    dirtyOfTab,
    saveTab,
    cancelTab,
    saving,
    savedFlash,
    error,
  } = useAppSettingsConfig();

  /** 点 system-toggle：翻转 systemExpanded；收起时若选中 ∈ system → 回落 general */
  const handleToggle = () => {
    const next = !systemExpanded;
    setSystemExpanded(next);
    if (!next && SYSTEM_TABS.has(selectedTab)) setSelectedTab('general');
  };

  /** 点 tab item：若当前 dirty → 弹确认；否则直接切 */
  const handleSelectTab = (tab: TabId) => {
    if (tab === selectedTab) return;
    if (dirtyOfTab(selectedTab)) {
      setPendingTab(tab);
      return;
    }
    setSelectedTab(tab);
  };

  /** 确认丢弃改动 → 切到 pendingTab + 重置上一 tab draft（PRD UC-1.4「丢弃」语义） */
  const handleConfirmDiscard = () => {
    if (pendingTab === null) return;
    cancelTab(selectedTab);
    setSelectedTab(pendingTab);
    setPendingTab(null);
  };

  /** 取消确认 → 留在当前 tab */
  const handleCancelDiscard = () => setPendingTab(null);

  // 可见 tab：通用区 4 + 系统区（systemExpanded 时显示 2）
  const visibleTabs = APP_SETTINGS_TABS.filter(
    (tab) => !tab.inSystemArea || systemExpanded,
  );
  const generalTabs = visibleTabs.filter((tab) => !tab.inSystemArea);
  const systemTabs = visibleTabs.filter((tab) => tab.inSystemArea);
  const dirty = dirtyOfTab(selectedTab);
  // 该 tab 是否含由 useAppSettingsConfig 管理的 KV group（决定是否显示 page save bar）。
  // 单一事实源 = TAB_KV_GROUPS（空数组 = 全自渲染独立 save，如 models 仅 providers → 不显 page save bar）。
  const showSaveBar = TAB_KV_GROUPS[selectedTab].length > 0;

  return (
    <main className="flex flex-col h-full bg-bg">
      {error && (
        <div role="alert" className="px-4 py-2 text-sm text-accent bg-accent-surface border-b border-border">
          {error}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* 左栏：tab 竖排导航树 */}
        <aside className="w-[200px] shrink-0 border-r border-border bg-surface overflow-y-auto p-3">
          <nav>
            <ul className="flex flex-col gap-1.5">
              {/* 通用区 section label */}
              <li className="px-3 pt-1 pb-1.5 text-[10px] font-mono uppercase tracking-wider text-muted">
                {t('layout.generalSection')}
              </li>
              {generalTabs.map((tab) => (
                <li key={tab.id}>
                  <TabTreeItem
                    tabId={tab.id}
                    label={t(tab.labelKey)}
                    active={selectedTab === tab.id}
                    onSelect={() => handleSelectTab(tab.id)}
                  />
                </li>
              ))}
              {/* 系统设置分割线 + toggle */}
              <li className="my-2">
                <div className="h-px bg-border" />
                <button
                  type="button"

                  data-expanded={systemExpanded ? 'true' : 'false'}
                  aria-expanded={systemExpanded}
                  aria-label={systemExpanded ? t('layout.collapseAll') : t('layout.expandAll')}
                  onClick={handleToggle}
                  className="mt-1.5 flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-mono text-muted hover:text-fg-2 hover:bg-bg-warm rounded transition-colors"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className={systemExpanded ? 'rotate-90 transition-transform' : 'transition-transform'}
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span>{systemExpanded ? t('layout.collapseAll') : t('layout.expandAll')}</span>
                </button>
              </li>
              {/* 系统设置区 tab（systemExpanded 时显示） */}
              {systemExpanded &&
                systemTabs.map((tab) => (
                  <li key={tab.id}>
                    <TabTreeItem
                      tabId={tab.id}
                      label={t(tab.labelKey)}
                      active={selectedTab === tab.id}
                      onSelect={() => handleSelectTab(tab.id)}
                    />
                  </li>
                ))}
            </ul>
          </nav>
        </aside>
        {/* 右栏：当前 tab 的 group 集合 + 底部 page save bar */}
        <section className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto py-6 px-8">
            <SectionTabPanel
              selectedTab={selectedTab}
              kvGroups={kvGroups}
              defaultModelsDraft={defaultModelsDraft}
              onDefaultModelsChange={handleDefaultModelsChange}
              onKeyChange={handleKeyChange}
              consolidationDraft={consolidationDraft}
            />
          </div>
          {/* page-tab 级 save bar：仅 KV tab 显示；provider/observability/web_search/user_memory/plugin 自带 save 流 */}
          {showSaveBar && (
            <TabSaveBar
              dirty={dirty}
              saving={saving}
              saved={savedFlash}
              onSave={() => void saveTab(selectedTab)}
              onCancel={() => cancelTab(selectedTab)}
            />
          )}
        </section>
      </div>
      {/* dirty 切 tab 确认 modal */}
      {pendingTab !== null && (
        <ConfirmModal
          title={t('layout.discardConfirmTitle')}
          body={t('layout.discardConfirmBody')}
          okLabel={t('layout.discardConfirmOk')}
          cancelLabel={t('layout.discardConfirmCancel')}
          onOk={handleConfirmDiscard}
          onCancel={handleCancelDiscard}
        />
      )}
    </main>
  );
}

export default PageAppSettingsMerged;

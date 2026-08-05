/**
 * page-plugin-config — 插件配置页根（2 tab：插件 / 扩展点）
 * 参考: specs/ui/components/plugin-config-page/page-plugin-config.md
 *       specs/prd/overall/04-config-center-ui.md §3.9.3 + §3.9.4 + §3.9.5
 *       specs/prd/version_logs/v0.0.26/change_log.md §3 UC-F6（scope 维度状态管理）
 *
 * 职责：顶部 2 tab 切换；挂载 GET /config/plugin 取 inventory（顶层 plugins[] + groups[]）；
 *   插件 tab = section-plugin-list（每 plugin 独立 state slice）；
 *   扩展点 tab = section-ext-point-area（按 type 路由 radio/checkbox/ordered + schema modal）。
 *
 * BUG-001 修复核心（v0.0.5）：每个 plugin 开关**独立 state slice**——
 *   不再像 v0.0.4 PluginSettingsPage 那样用 pluginId matcher 乐观更新波及同 pluginId 多行。
 *   inventory 顶层 plugins[] 已是平面（一 plugin 一行），本页直接以 pluginId 为 key
 *   维护独立 Map<pluginId, enabled>，toggle 只改当前 pluginId 一行。
 *
 * [v0.0.26] scope 维度状态：拆到 use-plugin-scope.ts（currentScopeId + 5 个 handler +
 *   activatedPoints + scopeItems）。impl 写 op 携 scopeId: currentScopeId（仍在本文件）。
 *   scope 切换器仅扩展点 tab 顶层（plugin tab 不受 scope 影响，PRD OUT）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getPluginInventory,
  type PluginInventory,
} from '../../lib/api-client';
import { SectionPluginList } from './section-plugin-list';
import { SectionExtPointArea } from './section-ext-point-area';
import { ComponentScopeSwitcher } from './component-scope-switcher';
import { usePluginScope } from './use-plugin-scope';

type Tab = 'plugin' | 'extpoint';

/**
 * 插件配置页根。tab 默认 'plugin'。
 * plugins / groups 各自独立 state；PUT 失败乐观回滚。
 * [v0.0.26] scope 维度由 usePluginScope hook 管理（currentScopeId 默认 'default'）。
 */
export function PagePluginConfig() {
  const [tab, setTab] = useState<Tab>('plugin');
  const [inv, setInv] = useState<PluginInventory>({ plugins: [], groups: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // [v0.0.62 i18n] 本页 UI 文案走 plugin-config ns；通用加载走 common ns
  const { t } = useTranslation('plugin-config');

  // [v0.0.26] scope 维度状态 + handlers（拆到 use-plugin-scope.ts 避免本文件超 300 行）
  const {
    currentScopeId,
    handleSelectScope,
    activatedPoints,
    scopeItems,
  } = usePluginScope({ inv, setInv: (t) => setInv(t), setError });

  useEffect(() => {
    let cancelled = false;
    getPluginInventory()
      .then((tree) => {
        if (cancelled) return;
        setInv(tree);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * [v0.0.67] 配置只读化：5 个写 handler 改 noop（putPluginOp 已删）。
   * 前端编辑控件已 disabled / 隐藏（任务 4），UI 上用户根本点不动；
   * 此处保留 handler 签名（组件 props 不破）。
   */
  function handlePluginToggle(_pluginId: string, _next: boolean) {
    // 只读：不写后端，不乐观更新（plugin toggle 已 disabled）
  }

  function handleImplToggle(_implId: string, _next: boolean) {
    // 只读：不写后端（ext impl 列表已 disabled）
  }

  function handleExclusiveSelect(_implId: string) {
    // 只读：不写后端（radio 已 disabled）
  }

  function handleReorder(_pointId: string, _from: number, _to: number) {
    // 只读：不写后端（drag handle 已 disabled）
  }

  function handleSaveImplConfig(_implId: string, _values: Record<string, unknown>) {
    // 只读：不写后端（schema config 齿轮入口已隐藏）
  }

  return (
    <section className="flex flex-col h-full min-h-0">
      {/* [v0.0.67] 配置只读化：顶部 banner 提示配置已代码化（app/plugins/scopes/*.json） */}
      <div

        className="px-4 py-2 text-[11px] text-muted bg-bg-warm border-b border-border italic"
      >
        {t('page.readonlyBanner')}
      </div>
      <div className="flex border-b border-border" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'plugin'}
          data-action-key="plugin.tab.open-plugin"
          data-active={tab === 'plugin' ? 'true' : 'false'}
          onClick={() => setTab('plugin')}
          className={
            'px-4 py-2 text-sm border-b-2 transition-colors ' +
            (tab === 'plugin'
              ? 'border-accent text-fg'
              : 'border-transparent text-fg-2 hover:text-fg')
          }
        >
          {t('tab.plugin')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'extpoint'}
          data-action-key="plugin.tab.open-ext-point"
          data-active={tab === 'extpoint' ? 'true' : 'false'}
          onClick={() => setTab('extpoint')}
          className={
            'px-4 py-2 text-sm border-b-2 transition-colors ' +
            (tab === 'extpoint'
              ? 'border-accent text-fg'
              : 'border-transparent text-fg-2 hover:text-fg')
          }
        >
          {t('tab.extpoint')}
        </button>
      </div>
      {/* [v0.0.18 post-merge 回归修复] 滚动布局：本层只做 flex 尺寸（flex-1 min-h-0 flex flex-col），
          不做 overflow。各 tab 各自管滚动（详见 git log / 历史 spec）。 */}
      <div className="flex-1 min-h-0 p-4 flex flex-col">
        {error && <p className="text-red text-sm">{t('page.loadFail', { error })}</p>}
        {!loaded && <p className="text-muted text-sm">{t('page.loading')}</p>}
        {loaded && tab === 'plugin' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/* [v0.0.67] plugin toggle 已 disabled（plugin 开关也代码化只读） */}
            <SectionPluginList plugins={inv.plugins} onToggle={handlePluginToggle} disabled />
          </div>
        )}
        {loaded && tab === 'extpoint' && (
          <>
            {/* [v0.0.26] scope 切换器仅扩展点 tab 顶层（plugin tab 不受 scope 影响，PRD OUT）。
                [v0.0.67] scope 切换器仅用于切换只读视图（create/delete scope 入口已删，无死代码）。
                component-scope-switcher 内部 dropdown absolute 定位，下方 EP 区不受影响（布局稳定性）。 */}
            <ComponentScopeSwitcher
              scopes={scopeItems}
              currentScopeId={currentScopeId}
              onSelect={handleSelectScope}
            />
            <SectionExtPointArea
              groups={inv.groups}
              onImplToggle={handleImplToggle}
              onExclusiveSelect={handleExclusiveSelect}
              onReorder={handleReorder}
              onSaveImplConfig={handleSaveImplConfig}
              currentScopeId={currentScopeId}
              activatedPoints={activatedPoints}
            />
          </>
        )}
      </div>
    </section>
  );
}

export default PagePluginConfig;

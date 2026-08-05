/**
 * component-scope-switcher — 扩展点 tab 顶层 scope 切换器
 * 参考: specs/ui/components/plugin-config-page/component-scope-switcher.md
 *       specs/prd/version_logs/v0.0.26/change_log.md §3 UC-F6-1/2/5/6
 *
 * 职责：展示当前选中 scope，下拉切换 / 创建新 scope / 删除非 default scope。
 * 边界：只管 scope 维度的切换/创建/删除交互；不渲染 EP/impl（section-ext-point-area 负责）；
 *   不判断激活态（section-ext-point-area 根据 inventory pointActivated 渲染）。
 *
 * 布局稳定性（MANDATORY）：dropdown 用 absolute 定位脱离常规流——出现/消失不导致下方 EP 区位移；
 *   切换 scope 时切换器自身位置固定（不重排）。
 *
 * 视觉基线（对齐既有 plugin-config-page 风格，spec §视觉基线）：
 *   「Scope」标签 xs uppercase muted；当前 name sm semibold hover accent；dropdown 卡片；
 *   default badge accent-light/accent；删除 icon muted hover red（default 不渲染）。
 *
 * [v0.0.67] 配置只读化：scope 列表代码声明（app/plugins/scopes/*.json），运行时不可增删。
 *   - 切换 scope 功能保留（只读切换查看不同 scope 配置）
 *   - create/delete 入口已删（不再需要 onCreate/onDelete props，无死代码）
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** scope 元信息（来自 inventory.scopes 或 listScopes，default 首位） */
export interface ScopeItem {
  id: string;
  name: string;
  description?: string;
}

export interface ComponentScopeSwitcherProps {
  /** 全部 scope 列表（default 首位，父级保证顺序） */
  scopes: ScopeItem[];
  /** 当前选中的 scopeId */
  currentScopeId: string;
  /** 切换 scope（父级刷新 inventory） */
  onSelect: (scopeId: string) => void;
}

/**
 * [v0.0.67] scope 切换器（只读）：仅切换查看 scope，不可创建/删除。
 * 点当前 name 展开 dropdown（absolute 定位）；dropdown 中只列 scope 项（id + name，default 标「基线」badge）。
 */
export function ComponentScopeSwitcher({
  scopes,
  currentScopeId,
  onSelect,
}: ComponentScopeSwitcherProps) {
  // [v0.0.62 i18n] scope switcher 文案走 plugin-config ns
  const { t } = useTranslation('plugin-config');
  const [open, setOpen] = useState(false);
  // dropdown 容器 ref——点击外部关闭
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 点击 dropdown 外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const currentScope = scopes.find((s) => s.id === currentScopeId) ?? scopes[0];

  return (
    <div className="relative mb-4" ref={containerRef}>
      {/* 「Scope」标签 + 当前 scope name（点击展开 dropdown） */}
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted">Scope</span>
        <button
          type="button"
          data-action-key="plugin.scope.open-switcher"
          onClick={() => {
            setOpen((v) => !v);
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="text-sm font-semibold text-fg hover:text-accent transition-colors"
        >
          {currentScope?.name ?? currentScopeId}
        </button>
        {currentScope?.description && (
          <span className="text-[11px] text-muted truncate">{currentScope.description}</span>
        )}
      </div>

      {/* dropdown：absolute 脱离常规流，下方 EP 区不受影响（布局稳定性 MANDATORY） */}
      {open && (
        <div

          role="listbox"
          className="absolute left-0 top-full mt-1 z-50 min-w-[240px] bg-bg border border-border rounded-md shadow-sm py-1"
        >
          {/* scope 列表（[v0.0.67] 仅展示，无创建/删除入口） */}
          {scopes.map((s) => (
            <div
              key={s.id}
              data-action-key="plugin.scope.select"
              role="option"
              aria-selected={s.id === currentScopeId}
              className="flex items-center gap-2 px-3 py-2 hover:bg-accent-surface cursor-pointer"
              onClick={() => {
                onSelect(s.id);
                setOpen(false);
              }}
            >
              <span className="text-sm text-fg flex-1 truncate">{s.name}</span>
              {/* default badge（accent-light/accent，对齐 EP type-tag 风格） */}
              {s.id === 'default' && (
                <span className="bg-accent-light text-accent text-[9px] font-mono uppercase px-1.5 py-0.5 rounded">
                  {t('scope.defaultBadge')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ComponentScopeSwitcher;

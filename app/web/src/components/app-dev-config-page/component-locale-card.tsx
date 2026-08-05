/**
 * component-locale-card —— 外观 group 内的语言选择器卡片（v0.0.59 i18n；v0.0.89 合并入 appearance group）
 * 参考: specs/ui/overall/03-config-center.md §2.3a（locale 选择器 UI 契约 / testid 表）
 *       specs/tech/i18n/[P0]i18n_overview.md §5.4（changeLanguage 实时切 + 持久化）
 *       specs/prd/version_logs/v0.0.89/01-config-page-tab.md §4（外观合并）
 *
 * v0.0.89 变更：
 *   - 挂载点从 locale group 改为 appearance group 内（与 theme 同 group）
 *   - testid 改 `key-card-language` / `key-select-language`（与 component-key-card 范式对齐）
 *   - 切即生效保持（不走 page-tab dirty，design-brief §1.2 硬约束）
 *
 * 设计：
 *   - 用 primitive-key-choice-cards 范式（与 appearance.theme 同款选择卡片，禁原生 <select>）
 *   - 选项 label 自指：「中文」始终显示「中文」、「English」始终显示「English」，
 *     不随 locale 切换变化（用户在任何 locale 下都能识别自己想切的语言）
 *   - onChange 立即调 changeLanguage（切即生效 + read-modify-write PUT appearance group 持久化）
 *   - useTranslation()：react-i18next 在 changeLanguage 后触发本组件重渲染（选中态视觉同步）
 */
import { useTranslation } from 'react-i18next';
import type { LocaleId } from '../../i18n';
import { changeLanguage } from '../../i18n/change-language';

/** 卡片容器 testid（v0.0.89 合并后改 key-card-language，对齐 component-key-card 范式） */
const CARD_TESTID = 'key-card-language';
/** 控件容器 testid（key-select-language，ET 锚点） */
const INPUT_TESTID = 'key-select-language';

/** 选项定义（label 自指：不进 i18n 切换） */
const LOCALE_OPTIONS: ReadonlyArray<{ id: LocaleId; label: string }> = [
  { id: 'zh-CN', label: '中文' },
  { id: 'en', label: 'English' },
];

/**
 * locale 选择器卡片。挂载在 app-dev-config-page 的 locale group 区（renderGroupArea 注入）。
 * 切即生效：onChange → changeLanguage(lng) → i18next.changeLanguage + <html lang> + PUT 持久化。
 */
export function ComponentLocaleCard() {
  // 取当前 i18n 语言作为选中态真值；changeLanguage 后 react-i18next 触发本组件重渲染
  const { i18n } = useTranslation();
  // [v0.0.62 i18n] locale 卡片 label/desc 走 app-dev-config ns
  const { t: tAdc } = useTranslation('app-dev-config');
  const currentLng = (i18n.language ?? 'zh-CN') as LocaleId;

  /** 切换 locale：调 changeLanguage（实时切 + 持久化）。错误吞掉（与既有 group save 错误反馈分离）。 */
  const handleSelect = (lng: LocaleId) => {
    if (lng === currentLng) return;
    void changeLanguage(lng).catch(() => {
      /* 持久化失败不影响切换即时性（i18next 已切，<html lang> 已设） */
    });
  };

  return (
    <div

      className="border border-border rounded-lg py-[16px] px-[20px] mb-[8px] bg-surface-2 transition-colors hover:border-border-strong"
    >
      <div className="flex items-start justify-between gap-4">
        {/* 左：label + 说明（与 component-key-card 同款布局） */}
        <div className="flex-1 min-w-0">
          <div

            className="text-[13px] font-semibold text-fg"
          >
            {tAdc('locale.label')}
          </div>
          <div className="text-xs text-muted-2 mt-1.5 leading-relaxed">
            {tAdc('locale.desc')}
          </div>
        </div>
        {/* 右：选项卡片组（testid 控件容器 = key-card-locale-language-input） */}
        <div className="shrink-0 w-[280px]">
          <div className="flex gap-2 w-full">
            {LOCALE_OPTIONS.map((opt) => {
              const selected = opt.id === currentLng;
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-action-key={`settings.locale.select-${opt.id.toLowerCase()}`}
                  aria-pressed={selected}
                  onClick={() => handleSelect(opt.id)}
                  className={
                    'flex-1 flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ' +
                    (selected
                      ? 'border-accent bg-accent-surface'
                      : 'border-border bg-surface-2 hover:border-border-strong')
                  }
                >
                  <span
                    className={
                      'text-[13px] font-medium ' +
                      (selected ? 'text-accent' : 'text-fg-2')
                    }
                  >
                    {/* label 自指（spec §2.3a 自指规则）：始终显示自身语言名，不进 i18n 切换 */}
                    {opt.label}
                  </span>
                  {/* 选中态：渲染额外 -active testid 元素（ET 锚点，spec §2.3a testid 表） */}
                  {selected && (
                    <span

                      aria-hidden
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-accent shrink-0"
                      >
                        <path d="M5 12l5 5L20 7" />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ComponentLocaleCard;

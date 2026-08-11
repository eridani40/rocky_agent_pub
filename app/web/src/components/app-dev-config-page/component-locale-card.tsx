/**
 * component-locale-card —— 外观 group 内的语言选择器卡片（v0.0.59 i18n；v0.0.89 合并入 appearance group）
 * 参考: specs/ui/overall/03-config-center.md §2.3a（locale 选择器 UI 契约 / testid 表）
 *       specs/tech/i18n/[P0]i18n_overview.md §5.4（changeLanguage 实时切 + 持久化）
 *
 * v0.0.317 变更（D8）：
 *   - 改为纯受控组件：接收 value（当前选中 locale）+ onChange（仅上报，不调 changeLanguage）
 *   - 语言切换走 SaveBar：选语言只进 draft，UI 不切，点保存才调 changeLanguage（与配置面板其他控件统一）
 *   - 去掉 changeLanguage import + useTranslation 取 i18n.language（不再自管选中态）
 *
 * 设计：
 *   - 用 primitive-key-choice-cards 范式（与 appearance.theme 同款选择卡片，禁原生 <select>）
 *   - 选项 label 自指：「中文」始终显示「中文」、「English」始终显示「English」，
 *     不随 locale 切换变化（用户在任何 locale 下都能识别自己想切的语言）
 */
import { useTranslation } from 'react-i18next';
import type { LocaleId } from '../../i18n';

/** 卡片容器 testid（v0.0.89 合并后改 key-card-language，对齐 component-key-card 范式） */
const CARD_TESTID = 'key-card-language';
/** 控件容器 testid（key-select-language，ET 锚点） */
const INPUT_TESTID = 'key-select-language';

/** 选项定义（label 自指：不进 i18n 切换） */
const LOCALE_OPTIONS: ReadonlyArray<{ id: LocaleId; label: string }> = [
  { id: 'zh-CN', label: '中文' },
  { id: 'en', label: 'English' },
];

/** 受控 props（v0.0.317 D8：value + onChange 纯上报，不调 changeLanguage） */
export interface ComponentLocaleCardProps {
  /** 当前选中 locale（由父级 draft 控制） */
  value: LocaleId;
  /** 选择回调：仅上报父级，不做任何副作用 */
  onChange: (lng: LocaleId) => void;
}

/**
 * locale 选择器卡片（v0.0.317 D8 受控化）。
 * 挂载在 app-dev-config-page 的 general tab（SectionTabPanel general case）。
 * 受控模式：value 决定选中态，onChange 仅上报父级（不调 changeLanguage，UI 不切）。
 * 语言切换走 SaveBar：点保存才由父级调 changeLanguage（切 UI + PUT 持久化一起做）。
 */
export function ComponentLocaleCard({ value, onChange }: ComponentLocaleCardProps) {
  // [v0.0.62 i18n] locale 卡片 label/desc 走 app-dev-config ns（label 自指不随 locale 变）
  const { t: tAdc } = useTranslation('app-dev-config');

  /** 选择 locale：仅上报父级（v0.0.317 D8 受控化——不调 changeLanguage，UI 不切） */
  const handleSelect = (lng: LocaleId) => {
    if (lng === value) return;
    onChange(lng);
  };

  return (
    <div
      data-testid={CARD_TESTID}
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
        {/* 右：选项卡片组（testid 控件容器 = key-select-language） */}
        <div className="shrink-0 w-[280px]" data-testid={INPUT_TESTID}>
          <div className="flex gap-2 w-full">
            {LOCALE_OPTIONS.map((opt) => {
              const selected = opt.id === value;
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

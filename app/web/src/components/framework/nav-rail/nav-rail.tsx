/**
 * nav-rail — ~56px 窄图标栏（brand「R」+ 顶部业务区 + 底部三独立入口）
 * 参考: specs/ui/components/framework/nav-rail.md（[v0.0.47] 改造段）
 *       设计稿视觉基线: reqs/v0.0.5/easy-opc-config-center-v4.html .icon-nav（§9）
 *
 * [v0.0.47] 改造（对齐 nav-rail.md [v0.0.47] 段 + design.md §0 决策 4）：
 *   - **删齿轮子菜单**：v0.0.33.1 的 `SettingsGroup`（齿轮 + 子菜单 + 遮罩 + drawerUp 动画）整体删除。
 *   - **底部三独立入口**（自上而下，spacer 推底）：SKILLS（nav-skill）/ 连接器（nav-connector）/ 应用设置（nav-settings-app，icon 改 GearIcon，tooltip「应用设置」）。
 *   - **view id 废弃**：`'settings-dev'` / `'settings-plugin'` 删除（合并入 `'settings-app'`）；`'skill'` / `'connector'` 沿用。
 *   - brand「R」/ 顶部业务区（Playground + Studio）不变（v0.0.33.1 已定）。
 *   - 去掉 theme-toggle（v0.0.33.1 已定，theme 切换在 app config appearance 区）。
 *   - 删 SettingsGroup 后无局部态（全受控、纯函数组件，无 useState）。
 *
 * 布局稳定性（ui §2.2）：激活态竖条 + tooltip 全用绝对定位（脱离文档流），
 * 出现/消失/切换激活项**不导致相邻图标位移**。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewId } from '../../../store/view-store';

/** 左栏导航项配置 */
interface NavItem {
  view: ViewId;
  testid: string;
  /** label i18n key（在 framework ns 内，nav.<leaf>） */
  labelKey: string;
  icon: ReactNode; // 内联 SVG，保持单文件可控
}

/** 顶部业务区 3 项：Playground + Studio + Academy（[v0.0.210] 加 Academy 🎓 教室培养） */
const NAV_BUSINESS: NavItem[] = [
  { view: 'playground', testid: 'nav-playground', labelKey: 'nav.playground', icon: <ChatIcon /> },
  { view: 'studio', testid: 'nav-studio', labelKey: 'nav.studio', icon: <TeamIcon /> },
  { view: 'academy', testid: 'nav-academy', labelKey: 'nav.academy', icon: <AcademyIcon /> },
];

/**
 * 底部独立入口（自上而下垂直排列）：
 *   1. SKILLS（沿用 v0.0.21）
 *   2. 渠道（testid nav-channel；位置 skill↔connector 间）
 *   3. 连接器（沿用 v0.0.23）
 *   4. 应用设置（testid 沿用 v0.0.33.1；icon user → gear，tooltip「用户设置」→「应用设置」；
 *      路由到新合并页 page-app-settings-merged）
 */
const NAV_BOTTOM: NavItem[] = [
  { view: 'skill', testid: 'nav-skill', labelKey: 'nav.skills', icon: <SkillIcon /> },
  { view: 'channel', testid: 'nav-channel', labelKey: 'nav.channel', icon: <ChannelIcon /> },
  { view: 'connector', testid: 'nav-connector', labelKey: 'nav.connector', icon: <PlugIcon /> },
  { view: 'settings-app', testid: 'nav-settings-app', labelKey: 'nav.settingsApp', icon: <GearIcon /> },
];

/** NavRail 受控 Props（父级 app-shell 从 view-store 读 currentView 并下发） */
export interface NavRailProps {
  /** 当前激活 view id */
  currentView: ViewId;
  /** 点击图标切换 */
  onChange: (view: ViewId) => void;
}

/** 单个左栏图标按钮：tooltip + active highlight（对齐设计稿 .nav-icon） */
function NavIcon({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  // [v0.0.62 i18n] tooltip/aria 文案走 framework ns
  const { t } = useTranslation('framework');
  const label = t(item.labelKey);
  return (
    <button
      type="button"
      data-action-key={`framework.nav.open-${item.view}`}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      className={
        'group relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors ' +
        (active ? 'bg-accent-surface text-accent' : 'text-muted hover:bg-accent-surface hover:text-accent')
      }
    >
      {/* 激活态左侧 3px×20px 竖条（绝对定位，脱离文档流，切换不位移）—— 设计稿 .nav-icon.active::before */}
      {active && (
        <span aria-hidden className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-sm bg-accent" />
      )}
      {item.icon}
      {/* hover tooltip：absolute 定位脱离文档流，出现/消失不导致位移（ui §2.2 布局稳定） */}
      <span
        role="tooltip"
        className={
          'pointer-events-none absolute left-full ml-2.5 z-50 whitespace-nowrap rounded-md ' +
          'bg-fg text-surface px-2.5 py-1 text-[11px] font-mono shadow-md ' +
          'opacity-0 group-hover:opacity-100 transition-opacity'
        }
      >
        {label}
      </span>
    </button>
  );
}

/** NavRail 根：brand → 业务区 → spacer → 底部三独立入口，受控（currentView/onChange 来自父级） */
export function NavRail({ currentView, onChange }: NavRailProps) {
  // [v0.0.62 i18n] brand 文案走 framework ns（brand「Rocky」保留字面，en/zh-CN 同值）
  const { t } = useTranslation('framework');
  /** 渲染一组同向 NavIcon（顶部业务区 / 底部独立入口复用；active + onClick 闭包绑定 currentView/onChange） */
  const renderGroup = (items: NavItem[]) => (
    <div className="flex flex-col items-center gap-1">
      {items.map((item) => (
        <NavIcon key={item.testid} item={item} active={currentView === item.view} onClick={() => onChange(item.view)} />
      ))}
    </div>
  );

  return (
    <nav className="flex flex-col items-center h-full w-full">
      {/* brand「R」：brand-grad 渐变方块 + font-sans 粗体，静态不可点 —— regulation 01 §1.8 / 02 §8 */}
      <div

        aria-label={t('nav.brand')}
        style={{ background: 'var(--brand-grad)' }}
        className="mb-5 flex items-center justify-center w-[34px] h-[34px] rounded-lg text-white font-sans font-bold text-base shadow-sm"
      >
        R
      </div>
      {/* 顶部业务区：Playground + Studio */}
      {renderGroup(NAV_BUSINESS)}
      {/* spacer：把底部三独立入口推到底部 —— 设计稿 .nav-spacer */}
      <div className="flex-1" />
      {/* 底部三独立入口（自上而下 SKILLS / 连接器 / 应用设置）—— [v0.0.47] 删齿轮子菜单后改三独立 NavIcon */}
      {renderGroup(NAV_BOTTOM)}
    </nav>
  );
}

// —— 内联图标（stroke=currentColor，跟随 active/hover 文字色；20x20 viewBox 居中）——
function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
/** [v0.0.33.1] Studio 团队图标（多人，对齐设计稿 studio-main.html squad icon） */
function TeamIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
/** [v0.0.210] Academy 毕业帽图标（教室培养语义，对齐 demo 🎓） */
function AcademyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 10L12 5 2 10l10 5 10-5z" />
      <path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
      <path d="M22 10v6" />
    </svg>
  );
}

/** [v0.0.47] 应用设置 gear 图标（齿轮，应用/系统配置通用语义；沿用 v0.0.33.1 SettingsGroup 齿轮形态） */
function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
/** [v0.0.21] skill 四角星图标（实心） */
function SkillIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}
/** [v0.0.23] 连接器 plug 图标 */
function PlugIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8z" /><path d="M12 17v5" />
    </svg>
  );
}
/** 渠道 channel 图标（对话气泡 + 信号，IM 渠道语义） */
function ChannelIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

export default NavRail;

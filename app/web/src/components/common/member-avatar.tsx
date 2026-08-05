/**
 * member-avatar —— member/user/squad 色块头像原子（common，跨页可复用）
 * 参考: specs/ui/components/common/member-avatar.md（视觉基线 + Props 契约）
 *       specs/ui/regulation/01-tokens.md §1.7 / 02-components.md §3（v0.0.165 银灰体系）
 *       specs/tech/version_logs/v0.0.165/change_plan.md §4（method 级契约）
 *
 * v0.0.165 更新（重塑）：
 *   - leader / mate 由 role 固定色（accent/gold）→ 走 `hashHueIndex(id ?? name)` % 8 色 palette
 *     单例来自 `lib/hue-hash.ts`（INV-5，禁重复实现）
 *   - user 保持中性灰（`--fg-2`）；squad 保持 `--brand-grad` 三色渐变
 *   - 新增可选 `id?` 参与 hash（缺省 fallback name）+ `showPresence?` 支持右下坐席状态点（online/busy/offline）
 *   - font-serif → font-sans（INV-4 全域下线衬线字体）
 *   - size='lg' 对齐 regulation 02 §3 = 48px（原 34px）；新增 size='xl'=64px 服务坐席卡
 *
 * 职责：渲染色块 + 首字母头像，下方可选附名字 label，右下可选 presence 点。
 * 边界：纯展示，无状态/回调；不依赖任何业务 store；所有颜色走 token 不硬编码。
 */
import type { ReactNode } from 'react';
import { hashHueName } from '../../lib/hue-hash';

/**
 * 角色决定色块底色策略：
 * - leader / mate → 按 id (fallback name) hash 到 8 色 palette 之一
 * - user → 中性灰 (`--fg-2`)，与 playground UserAvatar 一致
 * - squad → `--brand-grad` 三色渐变（全站仅 R logo + squad 头像两处，regulation 01 §1.8）
 */
export type MemberAvatarRole = 'leader' | 'mate' | 'user' | 'squad';

/** 坐席状态三态（无 idle：架构核实无 idle 数据源，PRD §6.4 决策）——size='sm' 时忽略 */
export type MemberAvatarPresence = 'online' | 'busy' | 'offline';

export interface MemberAvatarProps {
  /** 显示名（取首字母大写为图标内容；空名兜底 U/A/#） */
  name: string;
  /** member 角色 / user / squad（决定色块底色策略） */
  role: MemberAvatarRole;
  /**
   * 稳定 id（member.id / squad.id / a2a ref.id 等），参与 hash 保证同一实体同色。
   * 缺省时 fallback 到 name（back-compat，未传 id 的调用方保持既有行为一致性）。
   */
  id?: string;
  /** 尺寸档：sm=14（顶栏 inline）/ md=28（chat 流默认）/ lg=48（坐席卡）/ xl=64（大头像） */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 是否在头像下方渲染名字 label（chat 流 md=true；纯头像场景可 false） */
  showName?: boolean;
  /**
   * 坐席状态点（右下角覆盖，白 2px 描边 10×10 圆点）。undefined = 不渲染。
   * size='sm' 时忽略（顶栏 inline 头像太小放不下）。
   */
  showPresence?: MemberAvatarPresence;
  /** testid 后缀（默认 'member-avatar'；chat 流 caller 按 messageId 区分） */
}

/**
 * 色块底色（design token；leader/mate 走 hash 派生 8 色，user 中性，squad 渐变）。
 * `hueKey` = 传入 id ?? name，空串兜底 hue-hash 已处理（返 'rose'）。
 */
function bgColor(role: MemberAvatarRole, hueKey: string): string {
  if (role === 'user') return 'var(--fg-2)';
  if (role === 'squad') return 'var(--brand-grad)';
  // leader / mate：hash 派生 8 色之一
  return `var(--hue-${hashHueName(hueKey)})`;
}

/**
 * 首字母（trim 后首字符大写；空名按 role 兜底）。
 * - user → 'U' / squad → '#'（channel 语义）/ leader|mate → 'A'
 */
function initialOf(name: string, role: MemberAvatarRole): string {
  const c = name.trim().charAt(0).toUpperCase();
  if (c) return c;
  if (role === 'user') return 'U';
  if (role === 'squad') return '#';
  return 'A';
}

/** presence 点 CSS 变量（三态映射到 tokens.css --presence-*） */
function presenceBg(status: MemberAvatarPresence): string {
  return `var(--presence-${status})`;
}

/** 尺寸档 → 头像 box class（对齐 regulation 02 §3 Avatar 尺寸表） */
function boxClass(size: 'sm' | 'md' | 'lg' | 'xl'): string {
  if (size === 'sm') return 'h-3.5 w-3.5 text-[8px] rounded-xs';
  if (size === 'lg') return 'h-12 w-12 text-[18px] rounded-lg';
  if (size === 'xl') return 'h-16 w-16 text-[22px] rounded-xl';
  return 'h-7 w-7 text-[12px] rounded-lg'; // md 默认 28px
}

/**
 * member/user/squad 头像。
 * - sm：inline span，无外层列 / 无名字 label（顶栏 inline）
 * - md/lg/xl：外层 w-9 列（对齐 chat 三区布局），可选名字 label，可选右下 presence 点（sm 忽略）
 */
export function MemberAvatar({
  name,
  role,
  id,
  size = 'md',
  showName = true,
  showPresence,
}: MemberAvatarProps): ReactNode {
  const isSm = size === 'sm';
  const box = boxClass(size);
  // user 深底浅字（同 playground UserAvatar text-surface）；leader/mate/squad 白字
  const txt = role === 'user' ? 'text-surface' : 'text-white';
  const hueKey = id ?? name;
  const bg = bgColor(role, hueKey);
  const initial = initialOf(name, role);

  // sm 尺寸用于 inline（topbar），无外层列、无名字 label、忽略 presence——直接返色块 span
  if (isSm) {
    return (
      <span

        className={`inline-flex items-center justify-center font-bold font-sans ${box} ${txt}`}
        style={{ background: bg }}
      >
        {initial}
      </span>
    );
  }

  // md/lg/xl：外层 w-9 列（chat 三区布局）；presence 点通过 relative 外壳定位
  return (
    <div className="w-9 shrink-0 flex flex-col items-center gap-1">
      <span className="relative inline-block">
        <span

          className={`flex items-center justify-center font-bold font-sans ${box} ${txt}`}
          style={{ background: bg }}
        >
          {initial}
        </span>
        {showPresence && (
          <span

            aria-label={`presence-${showPresence}`}
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2"
            style={{
              background: presenceBg(showPresence),
              borderColor: 'var(--surface)',
            }}
          />
        )}
      </span>
      {showName && (
        <span className="text-[10px] font-semibold text-muted uppercase tracking-wider truncate max-w-full">
          {name}
        </span>
      )}
    </div>
  );
}

export default MemberAvatar;

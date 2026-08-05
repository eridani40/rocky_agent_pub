/**
 * component-placeholder-banner —— 占位 banner（友好提示，非 error）
 * 参考: specs/ui/components/studio-page/chat-placeholder.md（视觉基线）
 *       设计稿: reqs/[done] v0.0.33.1/studio-main.html .ph-banner / role-panel.html .ph-banner
 *
 * 职责：渲染「某能力在某版本上线」的友好占位卡片（图标 + 版本 pill + 标题 + 描述）。
 *   被目标 tab / member 面板当前任务·记忆 section / 占位 chat 复用。
 * 边界：纯展示，无交互；**绝不是 error 样式**（bg-warm 暖底 + muted 字 + 居中）。
 */
import { Icon, type StudioIconName } from './studio-icons';

interface PlaceholderBannerProps {
  /** 图标名（target/list/brain/chat 等） */
  icon: StudioIconName;
  /** 版本 pill 文案（如 v0.0.33.2） */
  version: string;
  /** 主标题（如「该对话能力在 v0.0.33.2 上线」） */
  title: string;
  /** 描述文案 */
  desc: string;
  /** 大尺寸（占位 chat 用：更大图标 + 更大留白） */
  large?: boolean;
  /** 测试锚点（容器 testid，标题/描述派生 -title/-desc 由调用方需要时另加） */
}

/** 占位 banner（暖底虚线框 + 居中图标/版本/标题/描述） */
export function PlaceholderBanner({ icon, version, title, desc, large }: PlaceholderBannerProps) {
  return (
    <div

      className={
        'flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border-strong bg-bg-warm text-center ' +
        (large ? 'max-w-[460px] px-8 py-12' : 'px-6 py-10')
      }
    >
      <span
        className={
          'flex items-center justify-center rounded-xl bg-surface text-muted-2 ' +
          (large ? 'w-14 h-14' : 'w-12 h-12')
        }
      >
        <Icon name={icon} size={large ? 26 : 22} />
      </span>
      <span className="rounded-full bg-accent-light px-2 py-0.5 text-[10px] font-mono text-accent">{version}</span>
      <span className={'font-semibold text-fg-2 ' + (large ? 'text-[15px]' : 'text-sm')}>{title}</span>
      <span className="max-w-[380px] text-xs leading-relaxed text-muted">{desc}</span>
    </div>
  );
}

export default PlaceholderBanner;

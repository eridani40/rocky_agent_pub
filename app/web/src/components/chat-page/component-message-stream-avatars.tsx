/**
 * component-message-stream-avatars —— ComponentMessageStream 默认头像（v0.0.156 B 从 component-message-stream.tsx 拆出）。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §3.5（B 仅抽 avatar 降行数 + INV-B-1）
 *       specs/ui/components/chat-page/brand-rocky.md（Rocky icon 视觉契约）
 *
 * 默认头像（caller 不传 resolveActor 时用）；被 component-message-stream.tsx 内部消费。
 * 实现等价：从 component-message-stream.tsx move，className / testid / props 100% 不变（INV-G1 纯 move）。
 */
// Rocky 品牌图标（agent avatar）— 参考 specs/ui/components/chat-page/brand-rocky.md
import rockyIcon from '../../assets/rocky-icon.png';

/** agent 头像列（默认：Rocky icon 图 + name='Rocky'；caller 传 resolveActor 时被覆盖） */
export function DefaultAgentAvatar({ messageId }: { messageId: string }) {
  return (
    <div className="w-9 shrink-0 flex flex-col items-center gap-1">
      <img
        src={rockyIcon}
        alt="Rocky"

        className="w-7 h-7 rounded-lg object-cover shadow"
      />
      <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">Rocky</span>
    </div>
  );
}

/** user 头像列（默认：U 色块 + name='you'；caller 传 resolveActor 时被覆盖） */
export function DefaultUserAvatar({ messageId }: { messageId: string }) {
  return (
    <div className="w-9 shrink-0 flex flex-col items-center gap-1">
      <div

        className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-[12px] font-sans text-surface bg-[var(--color-fg-2)]"
      >
        U
      </div>
      <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">you</span>
    </div>
  );
}

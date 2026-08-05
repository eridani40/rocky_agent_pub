/**
 * component-msg-time —— chat 消息 bubble 后方的极小 mono 时间戳
 * 参考: specs/ui/components/chat-page/component-msg-time.md
 *       specs/ui/regulation/02-components.md §6（消息时间视觉规则）
 *       specs/prd/version_logs/v0.0.165.ui_upgrade/change_log.md §4.1
 *
 * 职责：接受 ISO 字符串 + side，渲染一行 10.5px mono muted-2 时间戳。
 *   - 同日 HH:mm / 跨日 MM-dd HH:mm（走 lib/format-time.ts）
 *   - user 侧 text-right / assistant 侧 text-left（贴气泡对应边）
 *   - 无效 iso → 组件返 null 不渲染（不占位）
 *
 * 边界：只做展示，不做交互（无 tooltip / 无 click），不感知消息内容，不走 i18n。
 *
 * INV：
 *   - INV-7 三 chat 页同源：本文件是 MsgTime 唯一定义处，message-stream 引用一次即三页共享
 *   - 严肃基调：无 fadeIn/@keyframes，静态渲染
 */
import { formatMsgTime } from '../../lib/format-time';

interface MsgTimeProps {
  /** 消息 createdAt（ISO 字符串）；空/非法 → 组件返 null 不渲染 */
  iso: string;
  /** 侧位：user → text-right 贴气泡右；assistant → text-left 贴气泡左 */
  side: 'user' | 'assistant';
  /** 可选 testid（缺省 'msg-time'）；调用方通常传 `msg-time-${messageId}` 供 E2E 定位 */
  testId?: string;
}

/**
 * 消息时间戳 primitive（10.5px mono muted-2）。
 * 无效 iso（formatMsgTime 返空串）→ 组件返 null 不渲染。
 */
export function MsgTime({ iso, side, testId = 'msg-time' }: MsgTimeProps) {
  const text = formatMsgTime(iso);
  if (!text) return null;
  // v0.0.165 regulation 02 §6：10.5px font-mono muted-2；mt-1 与气泡的垂直距离
  const align = side === 'user' ? 'text-right' : 'text-left';
  return (
    <span

      className={`text-[10.5px] font-mono text-[var(--muted-2)] mt-1 ${align}`}
    >
      {text}
    </span>
  );
}

export default MsgTime;

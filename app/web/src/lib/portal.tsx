/**
 * Portal —— L3 modal 共用极薄 createPortal wrapper
 * 参考: specs/ui/components/chat-page/_layering.md §3 Invariant A
 *
 * 把 children 直接挂到 overlay-root 下（getOverlayRoot 懒创建），
 * 脱离一切祖先 stacking context + pointer-events gate。
 *
 * 极薄：无包装层、无 className、无副作用。children 直接是 overlay-root 唯一子节点。
 *
 * 用法（L3 modal 一律包一层）：
 *   <Portal>
 *     <div className="fixed inset-0 ...">...</div>
 *   </Portal>
 */
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getOverlayRoot } from './overlay-root';

export interface PortalProps {
  /** 必填：要 portal 的内容（一般是一个 L3 modal 根 div） */
  children: ReactNode;
}

/**
 * 极薄 createPortal wrapper。children 直接挂 overlay-root 下。
 * overlay-root 不存在（SSR / 单测 node 环境）时返回 null——React 安全。
 */
export function Portal({ children }: PortalProps) {
  const root = getOverlayRoot();
  if (!root) return null;
  return createPortal(children, root);
}

export default Portal;

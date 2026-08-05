/**
 * overlay-root —— L3 modal portal 挂载点（idempotent 懒创建）
 * 参考: specs/ui/components/chat-page/_layering.md §3 Invariant A（单一权威）
 *
 * 在 document.body 下懒创建一个透明的 `<div id="overlay-root">`：
 *   - position:absolute; top:0; left:0; width:100%; height:100%
 *   - pointer-events:none（容器不接事件；modal 自身 pointer-events:auto 才可交互）
 *   - z-index:var(--z-modal)（最上层，跨一切 stacking context）
 *
 * 所有 L3 modal（memory/cron/clear-confirm 等）经 <Portal> 共用此节点，
 * 脱离一切祖先 pointer-events:none 链 + stacking context——与触发者 DOM 位置无关。
 *
 * idempotent：重复调用返回同一节点，不重复创建。SSR 安全（typeof document 检查）。
 */

/** overlay-root DOM id（单一标识，防重复创建） */
const OVERLAY_ROOT_ID = 'overlay-root';

/** 已创建节点的缓存（同次 JS 运行期内复用，避免反复 DOM 查询） */
let cachedRoot: HTMLElement | null = null;

/**
 * 获取（或懒创建）overlay-root 节点。idempotent。
 *
 * SSR 安全：`typeof document === 'undefined'`（如 SSR / 单测 node 环境）下返回 null，
 * <Portal> 在 createPortal(children, null) 时 React 会渲染为空——caller 不需特判。
 */
export function getOverlayRoot(): HTMLElement | null {
  // SSR / 非 DOM 环境：返回 null（Portal 容许 target=null）
  if (typeof document === 'undefined') return null;

  // 缓存命中
  if (cachedRoot && document.body.contains(cachedRoot)) return cachedRoot;

  // 已存在节点（如热更新/重复挂载场景）：复用，不重建
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing) {
    cachedRoot = existing;
    return existing;
  }

  // 懒创建：透明容器，pointer-events:none 让 modal 外部 click 落到下层
  const el = document.createElement('div');
  el.id = OVERLAY_ROOT_ID;
  el.style.position = 'absolute';
  el.style.top = '0';
  el.style.left = '0';
  el.style.width = '100%';
  el.style.height = '100%';
  el.style.pointerEvents = 'none';
  el.style.zIndex = 'var(--z-modal)';
  document.body.appendChild(el);
  cachedRoot = el;
  return el;
}

/**
 * workspace-storage —— WorkspacePanel localStorage 持久化辅助
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.1（collapsed 持久化）
 *       + §4.2（width 持久化 clamp [232, 560] 默认 272）
 *
 * 从 section-workspace-panel.tsx 拆出控行数。per session 持久化（key 含 sid）。
 */
import { WS_WIDTH_DEFAULT, WS_WIDTH_MAX, WS_WIDTH_MIN, WS_RAIL_WIDTH } from '../../lib/layout-width-engine';
import { readColWidth, writeColWidth } from '../common/use-persistent-width';

/** 宽度常量唯一权威源 = 引擎；re-export 保持对外 surface 不变（§4.2 默认 272 / §6.6 rail 36） */
export { WS_WIDTH_DEFAULT, WS_RAIL_WIDTH };

/** localStorage key 工厂（per session，§4.1 / §4.2） */
export function wsLsKey(sid: string, kind: 'collapsed' | 'width'): string {
  return `ws-${kind}-${sid}`;
}

/** 读取 localStorage 持久化的 collapsed（缺省 false） */
export function readWsCollapsed(sid: string): boolean {
  try {
    return localStorage.getItem(wsLsKey(sid, 'collapsed')) === 'true';
  } catch {
    return false;
  }
}

/** 读取 localStorage 持久化的 width（clamp [232, 560]，缺省 272；读写/clamp 委托 common） */
export function readWsWidth(sid: string): number {
  return readColWidth(wsLsKey(sid, 'width'), WS_WIDTH_DEFAULT, WS_WIDTH_MIN, WS_WIDTH_MAX);
}

/** 写入 collapsed 到 localStorage（per session） */
export function writeWsCollapsed(sid: string, v: boolean): void {
  try {
    localStorage.setItem(wsLsKey(sid, 'collapsed'), String(v));
  } catch {
    // ignore（隐私模式 / 配额满）
  }
}

/** 写入 width 到 localStorage（per session；异常吞掉委托 common） */
export function writeWsWidth(sid: string, v: number): void {
  writeColWidth(wsLsKey(sid, 'width'), v);
}

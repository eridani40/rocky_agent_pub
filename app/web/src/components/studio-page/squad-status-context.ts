/**
 * squad-status-context —— Squad 成员状态入口的数据注入契约（v0.0.268）
 * 参考: specs/ui/components/studio-page/component-squad-status-modal.md §数据注入
 *       specs/tech/version_logs/v0.0.268/change_plan.md 决策②（selector 精化）
 *
 * 职责：SquadStatusContext + useSquadStatus——把 page-studio 已订阅的 session_meta `_all`
 *   stateMap 经「成员 sessionId 子集 + 值比较稳定引用」注入入口组件，**不新增 SSE 订阅**。
 *   - detail：squad 详情（members 含 sessionId/role/state/currentWork）；null = 未就绪
 *   - memberStateMap：仅 squad 成员 sessionId 子集的 stateMap（值比较稳定引用）
 *   - onEnterChat：面板进入对话回调（组装 ChatNode → setMainView chat）
 *   - refreshDetail：打开面板时刷新 detail（presence 文字尽量新；fire-and-forget）
 *
 * 边界：仅入口组件（SquadStatusEntry）消费；chat 其他区域不读。无 Provider 时
 *   useSquadStatus() 返 null（fail-safe，入口不渲染）。
 */
import { createContext, useContext } from 'react';
import type { SessionState } from '../chat-page/types';
import type { SquadDetail } from './squad-types';
import type { ChatNode } from './chat-node';

/** 入口组件数据注入契约（page-studio chat 分支 Provider 提供） */
export interface SquadStatusContextValue {
  /** squad 详情（members 含 sessionId/role/state/currentWork）；null = 未就绪 → 面板 loading/空态 */
  detail: SquadDetail | null;
  /** 仅 squad 成员 sessionId 子集的 stateMap（值比较稳定引用；成员 state 变化才变引用） */
  memberStateMap: Record<string, SessionState>;
  /** 面板进入对话回调（组装 ChatNode → setMainView chat） */
  onEnterChat: (node: ChatNode) => void;
  /** 打开面板时刷新 detail（presence 文字尽量新；fire-and-forget 失败不阻塞旧快照） */
  refreshDetail: () => void;
}

/** React Context（缺省 null = 无 Provider，消费方 fail-safe 不渲染） */
export const SquadStatusContext = createContext<SquadStatusContextValue | null>(null);

/**
 * 读 SquadStatusContext。
 * @returns Context value；无 Provider 时返 null（入口组件据此不渲染，不炸）
 */
export function useSquadStatus(): SquadStatusContextValue | null {
  return useContext(SquadStatusContext);
}

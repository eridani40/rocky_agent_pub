/**
 * squad-status-provider —— SquadStatusContext Provider（v0.0.268）
 * 参考: specs/tech/version_logs/v0.0.268/change_plan.md 决策②（selector 精化）
 *       specs/ui/components/studio-page/component-squad-status-modal.md §数据注入
 *
 * 职责：把 page-studio 已订阅的 session_meta `_all` stateMap 经「成员 sessionId 子集 +
 *   值比较稳定引用」注入 SquadStatusContext（**不新增 SSE 订阅**）。成员：
 *   - memberStateMap 派生：遍历 detail.members sessionId → stateMap[sid]，值比较逐项比对
 *     返 lastRef（稳定引用）——非成员 session SSE 时引用不变（StudioChatRouter memo 不 re-render）
 *   - refreshDetail：打开面板刷新 detail（presence 尽量新；fire-and-forget 失败不阻塞旧快照）
 *   - Provider value useMemo：非成员 SSE（memberStateMap 引用不变 + detail 不变）→ value 不变
 *     → 入口组件（Context 消费者）零 re-render
 *
 * 边界：仅 chat 分支包 Provider（seats 不需要）；onEnterChat 由 page-studio 注入
 *   （setMainView chat 语义）；无 Provider 时入口组件 fail-safe 不渲染。
 */
import { useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SessionState } from '../chat-page/types';
import type { SquadDetail } from './squad-types';
import type { ChatNode } from './chat-node';
import { SquadStatusContext } from './squad-status-context';

interface SquadStatusProviderProps {
  /** squad 详情（members 含 sessionId/role/state/currentWork）；null = 未就绪 */
  detail: SquadDetail | null;
  /** page-studio 已订阅的 session_meta `_all` 完整 stateMap（非成员子集，派生前过滤） */
  stateMap: Record<string, SessionState>;
  /** 面板进入对话回调（page-studio 注入：setMainView chat 语义，稳定引用） */
  onEnterChat: (node: ChatNode) => void;
  /** 刷新 detail（page-studio useSquadMutations.reloadDetail；fire-and-forget） */
  reloadDetail: (id: string) => Promise<void>;
  /** 当前选中 squad id（reloadDetail 目标） */
  selectedSquadId: string | null;
  children: ReactNode;
}

/**
 * SquadStatusContext Provider：memberStateMap 派生（值比较稳定引用）+ refreshDetail +
 * value useMemo，包 chat 子树（StudioChatRouter + 入口组件挂载点）。
 */
export function SquadStatusProvider({
  detail,
  stateMap,
  onEnterChat,
  reloadDetail,
  selectedSquadId,
  children,
}: SquadStatusProviderProps) {
  // memberStateMap 派生：只含 squad 成员 sessionId 子集，值比较返 lastRef（稳定引用）——
  //   非成员 session SSE（stateMap 引用变但成员子集值不变）→ 引用不变（memo 不 re-render）
  const lastMemberStateMapRef = useRef<Record<string, SessionState>>({});
  const memberStateMap = useMemo<Record<string, SessionState>>(() => {
    if (!detail) return lastMemberStateMapRef.current;
    const next: Record<string, SessionState> = {};
    for (const m of detail.members) {
      const st = stateMap[m.sessionId];
      if (st !== undefined) next[m.sessionId] = st;
    }
    const prev = lastMemberStateMapRef.current;
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    // 值比较：键集相同 + 每键同值 → 引用不变（跳过 re-render）
    if (prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === next[k])) {
      return prev;
    }
    lastMemberStateMapRef.current = next;
    return next;
  }, [stateMap, detail]);

  // 打开面板刷新 detail（presence 尽量新；fire-and-forget 失败不阻塞旧快照）
  const refreshDetail = useCallback(() => {
    if (selectedSquadId) void reloadDetail(selectedSquadId);
  }, [selectedSquadId, reloadDetail]);

  // Provider value：detail/memberStateMap/两回调变才重建（入口组件 re-render 可接受）；
  //   非成员 SSE（memberStateMap 引用不变 + detail 不变 + 回调稳定）→ value 不变 → 入口零 re-render
  const value = useMemo(
    () => ({ detail, memberStateMap, onEnterChat, refreshDetail }),
    [detail, memberStateMap, onEnterChat, refreshDetail],
  );

  return <SquadStatusContext.Provider value={value}>{children}</SquadStatusContext.Provider>;
}

export default SquadStatusProvider;

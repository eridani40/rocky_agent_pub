/**
 * use-chat-chrome —— 统一 chat 装配层的 chrome 数据 hook（GET /session/:id/chrome 一跳）
 * 参考: specs/tech/app/frontend/[P0]chat_session_assembly.md §3（拆解行权威）
 *       specs/api/overall/04a-session-chrome.md（接口契约）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法）
 *
 * 职责：Snapshot<SessionChromeView>，GET-once 不订 SSE（chrome 是静态装饰数据，
 *   刷新靠切 sessionId remount）。取代 useStudioChatChrome（两跳收敛一跳）与
 *   useModelRestore（token 竞态守卫由 useLifecycle abort + genRef 等价承担）。
 *
 * 注入模式（防双拉，tech assembly §2.6）：宿主已持 chrome（studio router 需 chrome 定
 *   workspaceSemantic）时经 opts.injected 传入 → onInit 同步返回注入值、零网络；
 *   setter 仍走本 hook 内部 mutate 乐观写（宿主副本不回写——身份要素期间不变，可接受）。
 *
 * setter 范式（与旧 useStudioChatChrome 一致）：mutate 乐观本地写 + fire-and-forget
 *   PUT /session/:id（失败仅 console.warn 不回滚），不 reload 不重新 GET。
 */
import { useCallback, useRef } from 'react';
import { useLifecycle } from '../../lib/use-lifecycle';
import { getSessionChrome, updateSession, type SessionChromeView } from '../../lib/chat-api';
import type { ModelSelection } from '../../lib/providers';
import type { EffortLevel } from './component-input-effort-picker';
import type { ApprovalMode } from './component-input-approval-mode-picker';

/** useChatChrome 可选项 */
export interface UseChatChromeOpts {
  /** 宿主注入的已装配 chrome（防双拉）；null/undefined = 内部自拉 */
  injected?: SessionChromeView | null;
}

/** useChatChrome 返回：chrome 快照 + loading/error + 命令式 setter 三件套 */
export interface UseChatChromeResult {
  /** onInit 完成后填；进行中/失败/sessionId 空为 null */
  chrome: SessionChromeView | null;
  /** onInit 进行中（完成/失败为 false） */
  loading: boolean;
  /** onInit 抛出的异常（消费方 console.warn + 空态兜底） */
  error: Error | null;
  /** 选中 effort：乐观写本地 + fire-and-forget PUT /session/:id */
  setEffort: (level: EffortLevel) => void;
  /** 选中审批模式：同上 */
  setApprovalMode: (mode: ApprovalMode) => void;
  /**
   * 选中 model：乐观写本地 sessionModel + fire-and-forget PUT。
   * 保留字 'default' → body {modelId:'default'}（不带 providerId，后端视为「跟随默认」）；
   * 具体 model → body {providerId, modelId}（复合精确）。
   */
  setModel: (sel: ModelSelection) => void;
}

/**
 * 统一 chrome hook：仅认 sessionId，GET /session/:id/chrome 一跳拉齐装饰数据。
 * sessionId 变化 → useLifecycle 自动 abort 旧 generation + 重拉 + 重置 ctx
 * （切 session 时 ctx 先置 null → 消费方渲 loading 占位，旧 model 无一帧残留）。
 *
 * @param sessionId 当前查看的 session id（空串/null 视为无会话，不拉取）
 * @param opts 见 UseChatChromeOpts（injected 注入防双拉）
 */
export function useChatChrome(sessionId: string | null, opts?: UseChatChromeOpts): UseChatChromeResult {
  const injected = opts?.injected ?? null;
  // generation 守卫：onInit 起 ++；await 后校验（同 sessionId reload 双保险，快切由 signal 兜底）
  const genRef = useRef(0);

  const { ctx, loading, error, mutate } = useLifecycle<SessionChromeView>({
    deps: [sessionId, injected],
    onInit: async ({ signal }) => {
      const gen = ++genRef.current;
      // 注入优先（防双拉）：宿主已拉过 → 直接作为 ctx，零网络
      if (injected) return injected;
      // sessionId 空：抛错走 error 通道（消费方按无会话渲空态；不发请求）
      if (!sessionId) throw new Error('[useChatChrome] sessionId required');
      const view = await getSessionChrome(sessionId);
      // 不变量②：await 后校验 abort + generation（切 session 后旧响应不覆盖新 ctx）
      if (signal.aborted || gen !== genRef.current) {
        throw new Error('[useChatChrome] aborted');
      }
      return view;
    },
  });

  // 命令式 setter：mutate 乐观写（c===null 返回 undefined 跳写）+ fire-and-forget PUT
  const setEffort = useCallback(
    (level: EffortLevel) => {
      mutate((c) => (c ? { ...c, effort: level } : undefined));
      if (!sessionId) return;
      updateSession(sessionId, { effort: level }).catch((e) =>
        console.warn('[useChatChrome] updateSession effort failed:', e),
      );
    },
    [sessionId, mutate],
  );
  const setApprovalMode = useCallback(
    (mode: ApprovalMode) => {
      mutate((c) => (c ? { ...c, approvalMode: mode } : undefined));
      if (!sessionId) return;
      updateSession(sessionId, { approvalMode: mode }).catch((e) =>
        console.warn('[useChatChrome] updateSession approvalMode failed:', e),
      );
    },
    [sessionId, mutate],
  );
  const setModel = useCallback(
    (sel: ModelSelection) => {
      // 保留字 'default' → sessionModel=null（picker 显默认态）；具体 model → 复合写入
      mutate((c) => (c ? { ...c, sessionModel: sel.modelId === 'default' ? null : sel } : undefined));
      if (!sessionId) return;
      const body =
        sel.modelId === 'default' ? { modelId: 'default' } : { providerId: sel.providerId, modelId: sel.modelId };
      updateSession(sessionId, body).catch((e) =>
        console.warn('[useChatChrome] updateSession model failed:', e),
      );
    },
    [sessionId, mutate],
  );

  return { chrome: ctx, loading, error, setEffort, setApprovalMode, setModel };
}

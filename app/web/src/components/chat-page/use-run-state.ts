/**
 * use-run-state —— 会话 run 态 area-hook
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §4.2（run_end GET 校正归此 / 多订阅 from.topic switch）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法 + 不变量①/⑥）
 *       specs/tech/app/frontend/[P0]sse_client_singleton.md §7（状态自愈：D6 卡 running）
 *       reqs/v0.0.94.component_refactor/design-decisions.md §5（mutate 法律：命令式局部改 ctx 不重订阅）
 *
 * 职责：唯一持 sessionRunning / sessionState 的 area-hook。
 *   - onInit GET /session 拉基线（running + state）作为 ctx 返回 + 双订阅（session_panel 拿 status_update，
 *     agent_loop 只为收 run_end 做 GET 校正）——多订阅按 from.topic switch（不变量⑥）。
 *   - session_panel `session_status_update` → applySessionStatusUpdate 纯 reducer → return 新 ctx（同步走 ctx 通道）。
 *   - agent_loop `run_end` 且 sessionRunning 仍 true 且非 interrupting → 异步 GET /session，完成后 mutate 写新 ctx
 *     （纠正卡 running，GET 为权威源；不在 interrupting 触发，避免与 abort 收尾竞态）。
 * 不碰 messages/runActive（归 useMessages）/ usage（归 useUsage）/ summary（归 useSummary）。
 */
import { useCallback, useRef } from 'react';
import { useLifecycle } from '../../lib/use-lifecycle';
import { getSession, abortSession } from '../../lib/chat-api';
import {
  applySessionStatusUpdate,
  type SessionEvent,
  type SessionState,
} from '../../store/session-slice-reducer';
import type { AgentEvent } from '../../store/chat-slice-reducer';

/** useRunState 的 ctx 形状：run 态原子化于 useLifecycle ctx */
interface RunStateCtx {
  /** session 是否 running（session_panel 权威源；门控停止按钮 + enqueue-view 可见性） */
  sessionRunning: boolean;
  /** session 状态机当前态（idle/running/interrupting/interrupted/error）；null = 初始未拉到 */
  sessionState: SessionState | null;
}

/** useRunState 返回：run 态 Snapshot */
export interface UseRunStateResult {
  /** session 是否 running */
  sessionRunning: boolean;
  /** session 状态机当前态；null = 初始未拉到 */
  sessionState: SessionState | null;
  /** 中断当前 run（POST /session/:id/abort，fire-and-forget） */
  abort: () => void;
}

/** useRunState 可选项（[v0.0.216] enabled 门） */
export interface UseRunStateOpts {
  /**
   * false = 不 subscribe 不 GET（零 SSE 零网络，返 inert 态）。
   * 群聊等 capabilities.runState=false 场景用（恒挂 hook 但订阅按能力门控，
   * 保持 v0.0.155 INV-E3「群聊不订 run 态」语义）。缺省 true。
   */
  enabled?: boolean;
}

/**
 * 会话 run 态 area-hook。sessionId 变化时 useLifecycle 自动重订阅 + 重拉基线 + 重置 ctx。
 * @param sessionId 当前查看的 session id
 * @param opts enabled 门（缺省 true；false = 零订阅零网络）
 */
export function useRunState(sessionId: string, opts?: UseRunStateOpts): UseRunStateResult {
  const enabled = opts?.enabled !== false;
  // generation 守卫：onInit 起 ++；run_end 异步 GET .then 内校验（切 session 后旧响应不写新 ctx）
  const genRef = useRef(0);

  const { ctx, mutate } = useLifecycle<RunStateCtx, AgentEvent | SessionEvent>({
    deps: [sessionId, enabled],
    onInit: async ({ signal, subscribe }) => {
      const gen = ++genRef.current;
      // enabled 门 / sessionId 空：不 subscribe 不 GET，返 inert ctx（零 SSE 零网络）
      if (!enabled || !sessionId) return { sessionRunning: false, sessionState: null };
      // 多订阅（不变量⑥）：onEvent 按 from.topic switch
      subscribe('session_panel', `session_id:${sessionId}`);
      // [v0.0.204] groupKey current→main（modeKey 退役→runKind，main run 发 _amt:main）
      subscribe('agent_loop', `session_id:${sessionId}_amt:main`);
      // 初始基线 GET /session（失败不阻塞 SSE；sessionRunning 由 session_panel 兜底）
      try {
        const detail = await getSession(sessionId);
        if (signal.aborted || gen !== genRef.current) return { sessionRunning: false, sessionState: null };
        return { sessionRunning: detail.running === true, sessionState: detail.state ?? null };
      } catch {
        // 拉取失败：SSE 仍可推 status_update（保 false 兜底）
        return { sessionRunning: false, sessionState: null };
      }
    },
    // onEvent：同步走 ctx 通道（session_panel reducer return 新 ctx / agent_loop run_end 触发异步 mutate）
    onEvent: (ctx, event, from) => {
      if (from.topic === 'session_panel') {
        const evt = event as SessionEvent;
        if (evt.type !== 'session_status_update') return;
        const result = applySessionStatusUpdate(evt, ctx?.sessionRunning ?? false);
        return { sessionRunning: result.sessionRunning, sessionState: result.sessionStatus.state };
      }
      if (from.topic === 'agent_loop') {
        const evt = event as AgentEvent;
        // 仅收 run_end 做 GET 校正（治 D6 卡 running）；其余 agent_loop 帧归 useMessages
        if (evt.type !== 'run_end') return;
        // 不在 interrupting 态触发：abort 收尾中，等 session_status_update 到达（避免与 abort 竞态）
        // sessionRunning 已 false 也不触发（无校正必要）
        if (!ctx || !ctx.sessionRunning || ctx.sessionState === 'interrupting') return;
        const gen = genRef.current;
        void getSession(sessionId)
          .then((d) => {
            // generation 校验：切 session 后旧响应丢弃（mutate 的 cancelledRef 守卫跨 session 失效，须本地兜底）
            if (gen !== genRef.current) return;
            mutate((c) => {
              // c 为 null（切 session 中 ctx 被重置）→ 返 void 跳渲染（generation 守卫已兜底，此为双保险）
              if (!c) return;
              return { ...c, sessionRunning: d.running === true, sessionState: d.state ?? null };
            });
          })
          .catch(() => {
            // best-effort：GET 失败不阻塞 UI（session_panel 会兜底）
          });
        return;
      }
      // 其余 topic 不归本 hook
      return;
    },
  });

  const abort = useCallback(() => {
    if (sessionId) abortSession(sessionId).catch((e) => console.warn('abortSession failed:', e));
  }, [sessionId]);

  return {
    sessionRunning: ctx?.sessionRunning ?? false,
    sessionState: ctx?.sessionState ?? null,
    abort,
  };
}

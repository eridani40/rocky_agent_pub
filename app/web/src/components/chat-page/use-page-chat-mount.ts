/**
 * usePageChatMount —— page-chat 挂载 lifecycle hook
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.10（契约权威源，6 不变量）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.1（Collection + applyCrud）
 *       specs/tech/app/frontend/[P0]sse_client_singleton.md §4-§5（getSseClient 单例位置 + R1 迁移）
 *       reqs/v0.0.94.component_refactor/design-decisions.md §2-§5（四方法+控制模型+三形）
 *
 * 职责：mount 时拉 sessions 列表 + 订阅 session_meta `_all`，走
 *   useLifecycle 四方法契约：
 *   - onInit：api.subscribe('session_meta','_all')（经 getSseClient 单例建实际订阅，useLifecycle 自动回收）
 *     + GET /session → ctx=Collection<Session>(keyOf=s=>s.id) + setSessions(list) + setError(null) +
 *     拉 parent children（subagent 不作顶层项，childrenFetchedRef 去重）+ signal.aborted 守卫（不变量②）
 *   - onEvent：session_meta 广播 → biz 反向守卫（playground 拒 studio，与 store applySessionMetaEvent 守卫镜像）
 *     + applyCrud(ctx, upsert by data.id) 得新 ctx + 受控副作用（setSessions(next.items) 投影 store +
 *     subagent parent children 刷新 refreshChildren，标受控例外）+ 返新 ctx
 *   - subagent transcript 实时性由 SectionChatSession 内 useMessages 的 agent_loop 订阅承担，
 *     本 hook 不接线 sub run meta
 *   - SSE 订阅/timer 由 useLifecycle 自动回收（不变量⑤）
 */
import type { MutableRefObject } from 'react';
import { listSessions } from '../../lib/chat-api';
import { useLifecycle } from '../../lib/use-lifecycle';
import { applyCrud, type Collection } from '../../lib/lifecycle-shapes';
import type { SessionMetaUpdateEvent } from '../../store/chat-slice';
import type { Session } from './types';

/** hook 接收的 deps（store actions + 子 hook 返回的方法 + 错误 state setter） */
export interface UsePageChatMountDeps {
  /** store action：写入 sessions 列表（onInit 初始投影 + onEvent 增量投影） */
  setSessions: (sessions: Session[]) => void;
  /** 本地 error state setter（listSessions 失败时写错误信息；成功时清空） */
  setError: (e: string | null) => void;
  /** 拉指定 parent 的 subagent children（subagent 不作顶层项） */
  refreshChildren: (sessionId: string) => Promise<void>;
  /** 已拉过 children 的 parent id 集合（防重复拉） */
  childrenFetchedRef: MutableRefObject<Set<string>>;
}

/**
 * page-chat 挂载 lifecycle：onInit 拉列表 + 订阅 session_meta `_all`；onEvent 按 Collection 形 upsert。
 *
 * ctx = Collection<Session>（list 三形，keyOf=s=>s.id）：onInit GET 结果包成 Collection；
 *   onEvent applyCrud(upsert) 返新 ctx（同 key 原地替换保位，新 key append 尾部）。
 *   onEvent 内受控副作用（setSessions/refreshChildren）标受控例外——
 *   onEvent 契约是纯函数返新 ctx，这两项是 ctx 变更的必要投影/扇出（store 是 ctx 的渲染投影，
 *   subagent children 刷新是 meta 事件的固有扇出）。useLifecycle 内部 onEventRef 每 render
 *   同步更新，故闭包变量（refreshChildren）随 deps 变化自然刷新，不漏帧。
 *
 * @param deps 见 UsePageChatMountDeps（store actions + 子 hook 方法 + error setter）
 */
export function usePageChatMount(deps: UsePageChatMountDeps): void {
  const { setSessions, setError, refreshChildren, childrenFetchedRef } = deps;

  useLifecycle<Collection<Session>, SessionMetaUpdateEvent>({
    // onInit：mount/deps 变/reload 时拉列表 + 订阅 session_meta `_all` + 返回 ctx
    onInit: async ({ signal, subscribe }) => {
      // 订阅 session_meta `_all`（spec sse_channel.md §10.5：group `_all` 一次收所有 session meta 变更）；
      // api.subscribe 内部走 getSseClient() 单例建实际订阅，useLifecycle 自动回收（不变量⑤）
      subscribe('session_meta', '_all');
      const list = await listSessions();
      // 不变量②：fetch 后必须校验 signal.aborted（abort 后不再写数据，杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      // 投影初始列表到 store + 清 error
      setSessions(list);
      setError(null);
      // 列表加载后拉每个 parent 的 children（subagent 不作顶层项；childrenFetchedRef 去重保）
      for (const s of list) {
        if (s.derivation === 'subagent') continue;
        if (childrenFetchedRef.current.has(s.id)) continue;
        childrenFetchedRef.current.add(s.id);
        void refreshChildren(s.id);
      }
      // ctx = Collection<Session>（keyOf=s=>s.id；onEvent applyCrud upsert 复用此 key）
      return { items: list, keyOf: (s: Session) => s.id };
    },
    // onEvent：session_meta 帧到达 → biz 反向守卫 + applyCrud upsert + 受控副作用扇出
    onEvent: (ctx, evt, _from) => {
      // pre-init 守卫（onEvent 仅在 onInit resolve 后触发，ctx 理论非 null；TS null-safety）
      if (!ctx) return;
      const incoming = evt?.data;
      if (!incoming) return ctx;
      // biz 反向守卫（playground 拒 studio，与 store applySessionMetaEvent 守卫镜像；spec session_biztype.md）：
      // studio session 广播不纳入 playground 列表 ctx（缺省/undefined/playground 正常纳入）
      // [v0.0.210] academy 同拒（教室 head/coach/student session 归 academy-page 列表）
      if (incoming.biz === 'studio' || incoming.biz === 'academy') return ctx;
      // applyCrud upsert → 新 ctx（同 key 原地替换保位，新 key append 尾部；immutable + 幂等）
      const next = applyCrud(ctx, { op: 'upsert', item: incoming });
      // 受控例外（design-decisions §5：onEvent 是纯函数返新 ctx；以下两项是 ctx 变更的必要投影/扇出）：
      //   1. setSessions(next.items)：store 是 ctx 的渲染投影，同步更新让 PageChat 重渲染
      //   2. refreshChildren(parentSessionId)：subagent meta → 刷新 parent children（UC-28.3 running→terminated 转移）
      setSessions(next.items);
      if (incoming.derivation === 'subagent' && incoming.parentSessionId) {
        void refreshChildren(incoming.parentSessionId);
      }
      return next;
    },
    // deps：store actions（zustand 稳定）+ 子 hook 方法（useCallback 稳定）+ ref（稳定）
    deps: [setSessions, setError, refreshChildren, childrenFetchedRef],
  });
}

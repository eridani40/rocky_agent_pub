/**
 * use-studio-unread-meta —— Studio sidebar 红点 unread + running + state 状态订阅
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.10（契约）+ §3.11（迁移映射：useStudioUnreadMeta）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.3（KeyedMap + applyKeyed）
 *       specs/tech/app/frontend/[P0]sse_client_singleton.md §1（S1/S3 全局唯一 + 组件不碰连接）
 *       specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta 广播）
 *       specs/tech/agent/session/[P0]session_state.md §6（unread CAS 模型）+ §1（六态机含 suspended）
 *       specs/ui/components/studio-page/studio-sidebar.md（红点 DOM 契约 + [v0.0.101] running spinner/state）
 *       reqs/[done] v0.0.94.component_refactor/design-decisions.md §5（mutate 法律：消灭 overlay workaround，数据唯一归 ctx）
 *       reqs/[done] v0.0.101.ask_question_tool/2-running-indicator.md（#2 studio 群聊/leader/mate 透传）
 *
 * 职责：page-studio 专用 hook，经 getSseClient() 单例订阅 `session_meta _all` 广播；
 *   biz='studio' 反向守卫（仅收 studio session meta，与 playground reducer 双向隔离——
 *   playground chat-slice.ts:129 `if (incoming.biz==='studio') return`，本 hook 反向
 *   `if (incoming.biz !== 'studio') return`）。维护三张 map：
 *   - `unreadMap: Record<sessionId, boolean>`（红点，v0.0.85 F4 既有）
 *   - `runningMap: Record<sessionId, boolean>`（[v0.0.101] state∈{running,interrupting}，spinner 亮）
 *   - `stateMap: Record<sessionId, SessionState>`（[v0.0.101] 完整 state，含 suspended → 「?」）
 *   暴露 `markReadAndClear(sessionId)` 给 onOpenChat 调用——POST /session/:id/read（fire-and-forget）
 *   + mutate 命令式乐观清该 sid unread（SSE session_read_update 会兜底）。
 *
 * 走 useLifecycle mutate 口子：数据唯一归 ctx（KeyedMap<string,boolean> 三张独立 map）。
 *   onEvent biz 守卫 + applyKeyed(set) 纯 reducer 返新 ctx 走标准路径；markReadAndClear 用
 *   mutate(applyKeyed set false) 命令式乐观清。
 *   SSE 推同 sid 新值（含 unread:true 复显红点 / state→running 复显 spinner）会经 onEvent 覆盖
 *   mutate 写的 false，自然调和。
 *   不变量：biz 反向守卫、G1 单例（getSseClient 经 api.subscribe）、markReadAndClear 语义。
 *
 * [v0.0.101] 三张 map 解耦：unread/running/state 各自独立 applyKeyed set，互不影响。
 *   - running 仅 state∈{running,interrupting} 为 true（suspended 排除 running，INV-2）
 *   - state 完整透传（caller 据 state==='suspended' 显「?」，state∈{running,interrupting} 显 spinner）
 */
import { useLifecycle } from '../../lib/use-lifecycle';
import { applyKeyed, type KeyedMap } from '../../lib/lifecycle-shapes';
import { markSessionRead } from '../../lib/chat-api';
import type { SessionMetaUpdateEvent } from '../../store/chat-slice';
import type { SessionState } from '../chat-page/types';

/** [v0.0.101] 三张独立 ctx map（unread / running / state）合一为一个 ctx 对象，三字段各管一摊。 */
interface StudioMetaCtx {
  /** key=sessionId，true=有未读（红点应显） */
  unreadMap: KeyedMap<string, boolean>;
  /** [v0.0.101] key=sessionId，true=state∈{running,interrupting}（spinner 应显） */
  runningMap: KeyedMap<string, boolean>;
  /** [v0.0.101] key=sessionId，完整 SessionState（含 suspended，caller 据 state 显「?」） */
  stateMap: KeyedMap<string, SessionState>;
}

/** hook 暴露态：三张 map（unread/running/state）+ 乐观清除并通知后端的 action */
export interface StudioUnreadMeta {
  /** key=sessionId，true 表示有未读（红点应显） */
  unreadMap: Record<string, boolean>;
  /** [v0.0.101] key=sessionId，true 表示 state∈{running,interrupting}（spinner 应显） */
  runningMap: Record<string, boolean>;
  /** [v0.0.101] key=sessionId，完整 SessionState（含 suspended，caller 显「?」） */
  stateMap: Record<string, SessionState>;
  /**
   * 点击 chat 节点时调用：本地立即清该 sid 的 unread（乐观更新）+ 后台 POST /session/:id/read
   * （CAS unread:true→false，fire-and-forget，失败仅 console.warn 不阻塞切 chat）。
   * 不清 running/state（切 chat 时 running 仍由 SSE 兜底同步；切走 ≠ 状态变化）。
   */
  markReadAndClear: (sessionId: string) => void;
}

/** [v0.0.101] 判 running：state∈{running,interrupting}（suspended 排除，INV-2 loop 已退出） */
function isRunningState(state: SessionState | undefined): boolean {
  return state === 'running' || state === 'interrupting';
}

/** 空 ctx（onInit 用） */
function emptyCtx(): StudioMetaCtx {
  return {
    unreadMap: {} as KeyedMap<string, boolean>,
    runningMap: {} as KeyedMap<string, boolean>,
    stateMap: {} as KeyedMap<string, SessionState>,
  };
}

/**
 * 订阅 session_meta `_all` 广播，按 biz='studio' 反向守卫过滤，维护 unread/running/state 三张 map。
 * 数据唯一归 ctx（三张独立 KeyedMap）：SSE 帧经 onEvent 纯 reducer 写入，
 * 命令式乐观清经 mutate 写入——同一 ref-latest 写回路径，无 overlay 分裂。
 */
export function useStudioUnreadMeta(): StudioUnreadMeta {
  const { ctx, mutate } = useLifecycle<StudioMetaCtx, SessionMetaUpdateEvent>({
    // onInit：订阅 session_meta `_all`（api.subscribe 内部走 getSseClient() 单例，修 G1）；返空 ctx（三张空 map）
    onInit: (api) => {
      api.subscribe('session_meta', '_all');
      return emptyCtx();
    },
    // onEvent：biz 反向守卫 + 三张 map 各自 applyKeyed(set)（幂等：同值返原引用跳渲染）；
    //   SSE 推同 sid 新值会覆盖 mutate 写的 false（unread）/ 旧 state（running/state）
    onEvent: (ctx, evt, _from) => {
      // pre-init 守卫（onEvent 仅在 onInit resolve 后触发，ctx 理论非 null；TS null-safety）
      if (!ctx) return;
      const incoming = evt?.data;
      if (!incoming || incoming.biz !== 'studio') return ctx;
      const sid = incoming.id;
      const state = incoming.state as SessionState | undefined;
      // unread / running / state 三字段各自独立 applyKeyed set，互不影响（caller 按字段各取所需）
      const nextUnread = applyKeyed(ctx.unreadMap, {
        op: 'set',
        key: sid,
        value: incoming.unread === true,
      });
      const nextRunning = applyKeyed(ctx.runningMap, {
        op: 'set',
        key: sid,
        value: isRunningState(state),
      });
      // state 仅在 meta 推了 state 字段时更新（缺省保留旧值）；undefined 不覆盖
      const nextState =
        state !== undefined
          ? applyKeyed(ctx.stateMap, { op: 'set', key: sid, value: state })
          : ctx.stateMap;
      // 三张 map 至少一张变才返新 ctx（否则返原 ctx 跳渲染，applyKeyed 已幂等保证）
      if (
        nextUnread === ctx.unreadMap &&
        nextRunning === ctx.runningMap &&
        nextState === ctx.stateMap
      ) {
        return ctx;
      }
      return { unreadMap: nextUnread, runningMap: nextRunning, stateMap: nextState };
    },
    deps: [],
  });

  /** 点击 chat 节点 → 乐观清红点（mutate 命令式写 ctx，走 ref-latest 不重订阅）+ 后台 POST /read（CAS false） */
  const markReadAndClear = (sessionId: string) => {
    // mutate 复用 commitCtx 路径：同步写 ctxRef + 排队 setCtx → unreadMap 立即反映 false（不等 SSE 兜底）
    // 仅清 unread，不动 running/state（切 chat 不是状态变化，running 仍由 SSE 兜底同步）
    // mutate 回调返 void 或新 ctx；pre-init 守卫 c 为 null 时返 void 不写（onInit resolve 后自然填）
    mutate((c) => {
      if (!c) return;
      return { ...c, unreadMap: applyKeyed(c.unreadMap, { op: 'set', key: sessionId, value: false }) };
    });
    // fire-and-forget：失败不阻塞切 chat（spec chat-api.ts markSessionRead 注释）
    void markSessionRead(sessionId).catch((e) =>
      console.warn('studio markSessionRead failed:', e),
    );
  };

  const fallback = emptyCtx();
  return {
    unreadMap: ctx?.unreadMap ?? fallback.unreadMap,
    runningMap: ctx?.runningMap ?? fallback.runningMap,
    stateMap: ctx?.stateMap ?? fallback.stateMap,
    markReadAndClear,
  };
}

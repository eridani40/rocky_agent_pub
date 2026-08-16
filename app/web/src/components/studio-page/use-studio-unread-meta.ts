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
import { useRef } from 'react';
import { useLifecycle } from '../../lib/use-lifecycle';
import { applyKeyed, type KeyedMap } from '../../lib/lifecycle-shapes';
import { markSessionRead, listSessionsByBiz } from '../../lib/chat-api';
import { getSseClient } from '../../lib/sse-singleton';
import type { SessionMetaUpdateEvent } from '../../store/chat-slice';
import type { Session, SessionState } from '../chat-page/types';

/** [v0.0.101] 三张独立 ctx map（unread / running / state）合一为一个 ctx 对象，三字段各管一摊。 */
interface StudioMetaCtx {
  /** key=sessionId，true=有未读（红点应显） */
  unreadMap: KeyedMap<string, boolean>;
  /** [v0.0.101] key=sessionId，true=state∈{running,interrupting}（spinner 应显） */
  runningMap: KeyedMap<string, boolean>;
  /** [v0.0.101] key=sessionId，完整 SessionState（含 suspended，caller 据 state 显「?」） */
  stateMap: KeyedMap<string, SessionState>;
  /**
   * [v0.0.348] 第四张内部 map：sid→updatedAt（ISO string）。
   * 竞态仲裁基准（change_plan 决策④）：GET 在途新帧先到时，GET 响应后到不得回退更新的帧。
   * 内部专用，不外露到 StudioUnreadMeta 返回值（决策⑥）。
   */
  metaMap: KeyedMap<string, string>;
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
    metaMap: {} as KeyedMap<string, string>,
  };
}

/**
 * [v0.0.348] GET 响应合并进 ctx —— 重建语义 + updatedAt 仲裁（决策④）。
 * 以 sessions 为基线重建三 map+metaMap；ctx 中 updatedAt 比响应条目新的 sid 保留原样
 * （GET 在途新帧先到场景，GET 响应后到不得回退新帧）；响应缺失但 ctx 有更新帧的 sid 也保留
 * （新建会话帧先到），陈旧幽灵条目由下次 GET 清理（重建语义天然丢弃）。
 * 纯函数无副作用；running 由 isRunningState(state) 派生（不直读 running 字段）。
 */
function mergeFromSessions(ctx: StudioMetaCtx, sessions: Session[]): StudioMetaCtx {
  const unreadMap: KeyedMap<string, boolean> = {};
  const runningMap: KeyedMap<string, boolean> = {};
  const stateMap: KeyedMap<string, SessionState> = {};
  const metaMap: KeyedMap<string, string> = {};
  for (const s of sessions) {
    if (!s?.id) continue;
    const state = s.state as SessionState | undefined;
    unreadMap[s.id] = s.unread === true;
    runningMap[s.id] = isRunningState(state);
    if (state !== undefined) stateMap[s.id] = state;
    if (s.updatedAt) metaMap[s.id] = s.updatedAt;
    // 仲裁：ctx 中该 sid 帧比 GET 响应新 → 四张 map 全保留 ctx 值（不回退）
    const ctxAt = ctx.metaMap[s.id];
    if (ctxAt && s.updatedAt && ctxAt > s.updatedAt) {
      const cu = ctx.unreadMap[s.id];
      if (cu !== undefined) unreadMap[s.id] = cu;
      const cr = ctx.runningMap[s.id];
      if (cr !== undefined) runningMap[s.id] = cr;
      const cs = ctx.stateMap[s.id];
      if (cs !== undefined) stateMap[s.id] = cs;
      metaMap[s.id] = ctxAt;
    }
  }
  // 响应缺失但 ctx 有更新帧的 sid：保留（新建会话帧先到；GET 基线未含）
  for (const sid of Object.keys(ctx.metaMap)) {
    if (sid in metaMap) continue;
    const cu = ctx.unreadMap[sid];
    if (cu !== undefined) unreadMap[sid] = cu;
    const cr = ctx.runningMap[sid];
    if (cr !== undefined) runningMap[sid] = cr;
    const cs = ctx.stateMap[sid];
    if (cs !== undefined) stateMap[sid] = cs;
    const cm = ctx.metaMap[sid];
    if (cm !== undefined) metaMap[sid] = cm;
  }
  return { unreadMap, runningMap, stateMap, metaMap };
}

/**
 * 订阅 session_meta `_all` 广播，按 biz='studio' 反向守卫过滤，维护 unread/running/state 三张 map。
 * 数据唯一归 ctx（三张独立 KeyedMap）：SSE 帧经 onEvent 纯 reducer 写入，
 * 命令式乐观清经 mutate 写入——同一 ref-latest 写回路径，无 overlay 分裂。
 */
export function useStudioUnreadMeta(): StudioUnreadMeta {
  // [v0.0.348] hydrate ref：onResumed 注册一次，回调读 ref 保持最新引用（对齐 use-squad-meta reloadRef 先例）
  const hydrateRef = useRef<() => void>(() => {});
  // [v0.0.348] onResumed 退订句柄：存 ref 供 onDestroy 回收（严于 use-squad-meta 先例——防 singleton 残留回调）
  const resumedUnsubRef = useRef<(() => void) | null>(null);

  const { ctx, mutate } = useLifecycle<StudioMetaCtx, SessionMetaUpdateEvent>({
    // onInit：同步订阅 session_meta `_all`（api.subscribe 内部走 getSseClient() 单例，修 G1）+ 返空 ctx；
    //   [v0.0.348] 追加三层 hydration（决策①⑦⑧）：订阅声明保持同步，hydrate() fire-and-forget 不 await
    //   （await 会阻塞 onInit resolve → establishSubscriptions 滞后 → 丢帧窗口扩大，⑦时序禁），onResumed 断连兜底
    onInit: (api) => {
      api.subscribe('session_meta', '_all');
      void hydrateRef.current();
      resumedUnsubRef.current = getSseClient().onResumed(() => {
        void hydrateRef.current();
      });
      return emptyCtx();
    },
    // onEvent：biz 反向守卫 + 三张 map 各自 applyKeyed(set)（幂等：同值返原引用跳渲染）；
    //   [v0.0.348] 帧写入三 map 同步写 metaMap[sid]=data.updatedAt（决策④，竞态仲裁基准）；
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
      // [v0.0.348] updatedAt 缺失时跳过 metaMap 写（防御）不跳过三 map（决策④）
      const nextMeta =
        typeof incoming.updatedAt === 'string' && incoming.updatedAt
          ? applyKeyed(ctx.metaMap, { op: 'set', key: sid, value: incoming.updatedAt })
          : ctx.metaMap;
      // 四张 map 全部未变才返原 ctx（否则返新 ctx；applyKeyed 已幂等保证）
      if (
        nextUnread === ctx.unreadMap &&
        nextRunning === ctx.runningMap &&
        nextState === ctx.stateMap &&
        nextMeta === ctx.metaMap
      ) {
        return ctx;
      }
      return { unreadMap: nextUnread, runningMap: nextRunning, stateMap: nextState, metaMap: nextMeta };
    },
    // [v0.0.348] onDestroy：回收 onResumed 退订句柄（unmount 后 singleton 无本 hook 残留回调；幂等）
    onDestroy: () => {
      resumedUnsubRef.current?.();
      resumedUnsubRef.current = null;
    },
    deps: [],
  });

  // [v0.0.348] hydrate：GET /session?biz=studio 全量基线 → mergeFromSessions 合并进 ctx（决策①③）。
  //   经 mutate（=mutateCtx ref-latest 单路径）写回；失败 console.warn 静默（SSE 仍活，下次 onResumed 重试）。
  hydrateRef.current = () => {
    void listSessionsByBiz('studio')
      .then((list) => {
        mutate((c) => (c ? mergeFromSessions(c, list) : undefined));
      })
      .catch((e) => console.warn('[studio-meta] hydrate failed:', e));
  };

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

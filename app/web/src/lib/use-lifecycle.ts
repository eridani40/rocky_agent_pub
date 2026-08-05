/**
 * useLifecycle —— 组件生命周期抽象 hook（v0.0.95：ctx 渲染 + buffer 工作内存双写）。
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.10（8 不变量①-⑧）
 *       specs/tech/version_logs/v0.0.95.lifecycle_buffer/change_plan.md §T1 §A（D1 参数传递 / D2 buffer 清理）
 * 双写：ctx 通道 commitCtx→setCtx（**触发渲染**，messages/loading 等驱动 UI 的数据）；
 *      buffer 通道 commitBuffer→bufferRef（**不渲染**，跨帧累积中间态如半截 rawArgs 防闪屏）。
 * 不变量⑦ buffer 变不渲染；⑧ SseClient 顺序投递 + handler 同步链路无重入，一帧处理完才接下一帧。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSseClient } from './sse-singleton';
import type { SseFrame, SubscribeHandle } from './sse-client';

/** onInit 收到的 api：声明式启动 timer / 订阅，useLifecycle 跟踪并自动回收（不变量⑤⑥） */
export interface LifecycleInitApi {
  signal: AbortSignal;       /** abort 后禁写数据（不变量②）：所有 await 后须 signal.aborted 校验 */
  startTimer: (opts: { intervalMs: number; justification: string }) => void; /** 启动 timer，到点调 onTick。必须写 justification（不变量④） */
  subscribe: (topic: string, group: string) => void; /** 订阅 SSE，帧到达调 onEvent。可多次（多订阅⑥） */
}

/** onInit 返回值（{ctx, buffer} 形式；裸 TCtx 也可，hook 内部包装） */
export interface LifecycleInitResult<TCtx, TBuffer> { ctx: TCtx; buffer?: TBuffer | null; }

/** onEvent/onTick 返回值：可选返回新 ctx/buffer，未提供的字段保持不变（跳写） */
export interface LifecycleMutation<TCtx, TBuffer> { ctx?: TCtx; buffer?: TBuffer | null; }

/** useLifecycle 四方法契约（§3.10）。
 * 泛型顺序 `<TCtx, TEvent = unknown, TBuffer = null>`：TEvent 放第二位让 v0.0.94 既有 `<TCtx, TEvent>` 两参 hook 零改动
 *   （TS 推断 TBuffer=null 默认）；需 buffer 的 hook（useMessages 等 T2 范围）显式写 3 参 `<TCtx, TEvent, TBuffer>`。
 * 签名（D1：buffer 进签名参数传递，位置无规定；选「buffer 放最后可选」让无 buffer 的 hook 零改动）：
 *   onEvent `(ctx, event, from, buffer?)` 与 v0.0.94 `(ctx, event, from)` 向后兼容；onTick `(ctx, buffer?)`；
 *   onDestroy `(ctx, buffer|null)` 收最终态做清理；onInit 返 `{ctx, buffer}` 或裸 TCtx 不变。
 */
export interface LifecycleContract<TCtx, TEvent = unknown, TBuffer = null> {
  /** mount/deps 变/reload：读数据 + startTimer + subscribe；返回 {ctx, buffer} 或裸 TCtx（兼容 v0.0.94） */
  onInit: (api: LifecycleInitApi) => Promise<LifecycleInitResult<TCtx, TBuffer> | TCtx> | LifecycleInitResult<TCtx, TBuffer> | TCtx;
  /** unmount/re-init 前：清 onInit 里自己 new 的业务资源。幂等（不变量③）。收最终 ctx+buffer 做清理 */
  onDestroy?: (ctx: TCtx | null, buffer: TBuffer | null) => void;
  /** timer 到点：收 ctxRef（最新，不变量①）+ bufferRef（可选）；可返 {ctx?,buffer?}/裸 ctx/void */
  onTick?: (ctx: TCtx | null, buffer?: TBuffer | null) => Promise<LifecycleMutation<TCtx, TBuffer> | TCtx | void> | LifecycleMutation<TCtx, TBuffer> | TCtx | void;
  /** SSE 帧到达：收 ctxRef（最新非快照）+event+from+bufferRef（可选）。多订阅按 from.topic switch；返 {ctx?,buffer?}（禁 setState）。
   * 签名 `(ctx, event, from, buffer?)` 与 v0.0.94 `(ctx, event, from)` 向后兼容：无 buffer 的 hook 不写第 4 参即合法。 */
  onEvent?: (ctx: TCtx | null, event: TEvent, from: { topic: string; group: string }, buffer?: TBuffer | null) => LifecycleMutation<TCtx, TBuffer> | TCtx | void;
  /** 依赖数组：变化时 onDestroy(旧) + onInit(新)（替代 useEffect dep） */
  deps: ReadonlyArray<unknown>;
}

/** useLifecycle 返回值（泛型只需 TCtx/TBuffer；TEvent 不进返回值） */
export interface LifecycleResult<TCtx, TBuffer = null> {
  ctx: TCtx | null;          /** onInit 返回的 ctx（init 未完成/失败为 null） */
  loading: boolean;          /** onInit 进行中（完成/失败为 false） */
  error: Error | null;       /** onInit 抛出的异常（已 abort 的不在此列） */
  reload: () => Promise<void>; /** 命令式刷新：abort 旧 generation + 重跑 onInit（重置 ctx+buffer） */
  mutateCtx: (updater: (ctx: TCtx | null) => TCtx | void) => void; /** 命令式改 ctx（触发渲染，ref-latest 写回，void 跳渲染） */
  mutateBuffer: (updater: (buffer: TBuffer | null) => TBuffer | void) => void; /** 命令式改 buffer（**不渲染**，只写 ref） */
  /** [v0.0.94 兼容别名] 等同 mutateCtx。4 个 v0.0.94 消费者仍依赖（component-squad-board/section-studio-sidebar/use-run-state/use-studio-unread-meta），后续清理批次统一改 + 删。 */
  mutate: (updater: (ctx: TCtx | null) => TCtx | void) => void;
}

type SubscribeSpec = { topic: string; group: string };
type TimerSpec = { intervalMs: number; justification: string };

/** 非生产环境（dev + test）发 dev 警告；prod 静默 */
const NON_PROD = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

/** 不变量④：startTimer justification dev 校验（缺则 warn，有则打内容） */
function warnJustification(j: string): void {
  if (!NON_PROD) return;
  if (!j || typeof j !== 'string' || j.trim() === '') console.warn('[lifecycle] polling enabled without justification');
  else console.warn('[lifecycle] polling:', j);
}

/** onInit 返回值规范化：含 `ctx` 键的对象视为 {ctx, buffer}；否则当裸 ctx（v0.0.94 兼容，buffer=null） */
function normalizeInitResult<TCtx, TBuffer>(result: LifecycleInitResult<TCtx, TBuffer> | TCtx): { ctx: TCtx; buffer: TBuffer | null } {
  if (result !== null && typeof result === 'object' && !Array.isArray(result) && 'ctx' in result) {
    const r = result as LifecycleInitResult<TCtx, TBuffer>;
    return { ctx: r.ctx, buffer: (r.buffer ?? null) as TBuffer | null };
  }
  return { ctx: result as TCtx, buffer: null };
}

/** onEvent/onTick 返回值规范化：void/null→{}；裸 ctx→ {ctx}；含 ctx/buffer 键直通 */
function normalizeMutation<TCtx, TBuffer>(result: LifecycleMutation<TCtx, TBuffer> | TCtx | void): LifecycleMutation<TCtx, TBuffer> {
  if (result === undefined || result === null) return {};
  if (typeof result !== 'object' || Array.isArray(result)) return { ctx: result as TCtx };
  if ('ctx' in result || 'buffer' in result) return result as LifecycleMutation<TCtx, TBuffer>;
  return { ctx: result as TCtx };
}

/** 组件生命周期抽象 hook（详见文件头）。泛型：TCtx 渲染态 / TEvent onEvent 第二参（v0.0.95 放第二位让既有 `<TCtx,TEvent>` hook 零改动）/ TBuffer 工作内存（默认 null，需 buffer 显式写第 3 位） */
export function useLifecycle<TCtx, TEvent = unknown, TBuffer = null>(
  opts: LifecycleContract<TCtx, TEvent, TBuffer>,
): LifecycleResult<TCtx, TBuffer> {
  const { onInit, onDestroy, onTick, onEvent, deps } = opts;
  const [ctx, setCtx] = useState<TCtx | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  // refs 持最新回调（避免 reload/interval/SSE handler 取 stale 值）
  const onInitRef = useRef(onInit);
  const onDestroyRef = useRef(onDestroy);
  const onTickRef = useRef(onTick);
  const onEventRef = useRef(onEvent);
  const ctxRef = useRef<TCtx | null>(null); // ① 永远最新：onEvent/onTick/mutateCtx 收它（非 React 快照）
  const bufferRef = useRef<TBuffer | null>(null); // ⑦ 永远最新：commitBuffer 不触发渲染
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef<boolean>(false); // generation cancelled 标记（cleanup/新 init 置 true）
  const timerSpecRef = useRef<TimerSpec | null>(null); // timer/SSE 声明（onInit 收集，resolve 后建，re-init/unmount 回收⑤）
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const subSpecsRef = useRef<SubscribeSpec[]>([]);
  const subHandlesRef = useRef<SubscribeHandle[]>([]);
  // 每 render 同步 ref（取最新回调）
  onInitRef.current = onInit;
  onDestroyRef.current = onDestroy;
  onTickRef.current = onTick;
  onEventRef.current = onEvent;

  /** 安全调 onDestroy：吞异常（不变量③兜底，onDestroy 须幂等但 hook defensive） */
  const safeDestroy = useCallback((targetCtx: TCtx | null, targetBuffer: TBuffer | null) => {
    try { onDestroyRef.current?.(targetCtx, targetBuffer); } catch { /* 异常静默吞，不阻塞 cleanup */ }
  }, []);

  /** 停 timer interval（幂等） */
  const stopTimer = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, []);

  /** 退订所有 SSE 句柄（幂等；best-effort，不阻塞 cleanup） */
  const unsubscribeAll = useCallback(() => {
    const handles = subHandlesRef.current;
    subHandlesRef.current = [];
    for (const h of handles) void h.unsubscribe().catch(() => {});
  }, []);

  /** ① ctx 写路径：新 ctx 同步写回 ctxRef + setCtx 触发渲染；void=不改数据，cancelled 丢弃（不变量②） */
  const commitCtx = useCallback((next: TCtx | void | undefined) => {
    if (cancelledRef.current || next === undefined) return;
    ctxRef.current = next; // 同步写 ref（下一帧立即读到，不等 React commit）
    setCtx(next);
  }, []);

  /** ⑦ buffer 写路径：新 buffer 同步写回 bufferRef（**不 setCtx 不渲染**）；void 跳写；cancelled 丢弃 */
  const commitBuffer = useCallback((next: TBuffer | null | void | undefined) => {
    if (cancelledRef.current || next === undefined) return;
    bufferRef.current = next === null ? null : next; // 允许显式置 null
  }, []);

  /** 把 onEvent/onTick 返回值分别走 ctx/buffer 双写路径（互不阻塞；某字段 undefined 跳写） */
  const applyMutation = useCallback(
    (result: LifecycleMutation<TCtx, TBuffer> | TCtx | void) => {
      const m = normalizeMutation<TCtx, TBuffer>(result);
      if (m.ctx !== undefined) commitCtx(m.ctx);
      if (m.buffer !== undefined) commitBuffer(m.buffer);
    },
    [commitCtx, commitBuffer],
  );

  /** SSE 帧到达：读 ctxRef+bufferRef（最新）→ onEvent(ctx,event,from,buffer) → applyMutation（双写）。
   * 不变量⑧ 串行调度：SseClient 顺序投递 + handler 同步无重入，一帧处理完才接下一帧（单 buffer race 防护）。 */
  const handleFrame = useCallback(
    (frame: SseFrame) => {
      const cb = onEventRef.current;
      if (!cb) return;
      // buffer 放最后传（D1：(ctx, event, from, buffer?) 向后兼容 v0.0.94）
      const result = cb(ctxRef.current, frame.data as TEvent, { topic: frame.topic, group: frame.group }, bufferRef.current);
      applyMutation(result);
    },
    [applyMutation],
  );

  /** onInit effect api：subscribe/startTimer 只收集声明；实际建订阅/起 interval 在 onInit resolve 后（runInit 内） */
  const makeInitApi = useCallback(
    (signal: AbortSignal): LifecycleInitApi => ({
      signal,
      startTimer: (opt) => {
        warnJustification(opt.justification);
        timerSpecRef.current = { intervalMs: opt.intervalMs, justification: opt.justification }; // 多次取最后（单 hook 单 timer）
      },
      subscribe: (topic, group) => { subSpecsRef.current.push({ topic, group }); }, // 收集声明（⑥可多次）
    }),
    [],
  );

  /** 起 timer interval：到点读 ctxRef+bufferRef → onTick → applyMutation（双写，不变量①⑦） */
  const startTimerInterval = useCallback(() => {
    const spec = timerSpecRef.current;
    if (!spec || intervalRef.current) return; // 防重复起
    intervalRef.current = setInterval(() => {
      const cb = onTickRef.current;
      if (!cb) return;
      // onTick 收 ctxRef+bufferRef（最新）；可 async 重读 API；异常吞掉（不杀 interval）
      void Promise.resolve(cb(ctxRef.current, bufferRef.current)).then(applyMutation).catch(() => {});
    }, spec.intervalMs);
  }, [applyMutation]);

  /** 按声明建实际 SSE 订阅（onInit resolve 后调；每声明一条 getSseClient().subscribe） */
  const establishSubscriptions = useCallback(() => {
    const specs = subSpecsRef.current;
    if (specs.length === 0) return;
    const sse = getSseClient();
    for (const spec of specs) {
      void sse
        .subscribe(spec.topic, spec.group, handleFrame)
        .then((handle) => {
          // subscribe resolve 前 generation 已关闭：立即退订防句柄泄漏
          if (cancelledRef.current) { void handle.unsubscribe().catch(() => {}); return; }
          subHandlesRef.current.push(handle);
        })
        .catch((e) => { if (NON_PROD) console.warn('[lifecycle] subscribe failed:', spec.topic, e); });
    }
  }, [handleFrame]);

  /** 主 init 流程：abort 旧 generation（回收 timer/SSE + destroy 旧 ctx+buffer）+ 跑新 onInit。mount/deps 变/reload/visibility 共用 */
  const runInit = useCallback(async () => {
    // 1. 关闭旧 generation：abort + cancelled + 回收 timer/SSE + destroy 旧 ctx+buffer（不变量⑤）
    const prevCtx = ctxRef.current;
    const prevBuffer = bufferRef.current;
    if (abortRef.current) abortRef.current.abort();
    cancelledRef.current = true;
    stopTimer();
    unsubscribeAll();
    safeDestroy(prevCtx, prevBuffer);
    ctxRef.current = null;
    bufferRef.current = null; // D2 ③：re-init 重置 bufferRef
    timerSpecRef.current = null; // 清声明缓冲 + stale ctx 视觉态（不等 onInit resolve）
    subSpecsRef.current = [];
    setCtx(null);

    // 2. 起新 generation
    cancelledRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const api = makeInitApi(controller.signal);
      const result = await onInitRef.current(api);
      if (cancelledRef.current || controller.signal.aborted) return; // 不变量②：abort 后不写数据
      const { ctx: nextCtx, buffer: nextBuffer } = normalizeInitResult(result); // 兼容裸 ctx / {ctx,buffer}
      ctxRef.current = nextCtx;
      bufferRef.current = nextBuffer;
      setCtx(nextCtx);
      setLoading(false);
      establishSubscriptions(); // onInit 成功后建订阅 + 起 timer（声明已收集⑤）
      startTimerInterval();
    } catch (err) {
      if (cancelledRef.current || controller.signal.aborted) return; // abort 触发的 reject 静默丢弃
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setLoading(false);
      safeDestroy(null, null); // onInit 失败也调 onDestroy（catch 兜底，传 null 因未拿到）
    }
  }, [stopTimer, unsubscribeAll, safeDestroy, makeInitApi, establishSubscriptions, startTimerInterval]);

  /** 命令式 reload：re-init 口子（abort 旧 generation + 重 onInit + 重订阅/起 timer） */
  const reload = useCallback(async () => { await runInit(); }, [runInit]);

  /** 命令式 mutateCtx：局部改 ctx 触发渲染（复用 commitCtx ref-latest 写回）。不重 init/不碰 timer/SSE */
  const mutateCtx = useCallback(
    (updater: (ctx: TCtx | null) => TCtx | void) => { commitCtx(updater(ctxRef.current)); },
    [commitCtx],
  );

  /** 命令式 mutateBuffer：局部改 buffer 不渲染（只写 ref 不 setCtx）。不重 init/不碰 timer/SSE */
  const mutateBuffer = useCallback(
    (updater: (buffer: TBuffer | null) => TBuffer | void) => { commitBuffer(updater(bufferRef.current)); },
    [commitBuffer],
  );

  // 主 lifecycle effect：deps 变化触发 onDestroy + 重 onInit
  useEffect(() => {
    void runInit();

    // visibilitychange poll-only（v0.0.92 T6）：hidden 停 timer / visible 仅声明了 timer 才 reload。纯订阅 hook 不重载（靠 SSE onResumed 续流）。
    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopTimer();
      } else if (timerSpecRef.current) {
        void reload(); // 仅 poll 场景切回前台 reload（刷新后台错过的数据 + 重起 timer）
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelledRef.current = true;
      abortRef.current?.abort();
      stopTimer();
      unsubscribeAll();
      safeDestroy(ctxRef.current, bufferRef.current);
      ctxRef.current = null;
      bufferRef.current = null; // D2 ③：unmount 重置 bufferRef
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ctx, loading, error, reload, mutateCtx, mutateBuffer, mutate: mutateCtx };
}

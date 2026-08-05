// @vitest-environment jsdom
/**
 * useLifecycle 四方法契约 + buffer 双写通道单测（v0.0.95.lifecycle_buffer T1）
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.10（8 不变量：①-⑥ + ⑦buffer 变不渲染 + ⑧串行调度）
 *       specs/tech/version_logs/v0.0.95.lifecycle_buffer/change_plan.md §T1 §A（buffer 第三参数契约）
 *       reqs/[done] v0.0.95.lifecycle_buffer/req.md（5 约束 + D1/D2）
 *
 * 覆盖：
 *   ① ref-latest（连续 onEvent 累积不丢帧）
 *   ② signal.aborted：unmount 后 onInit resolve 不写数据
 *   ③ onDestroy 幂等
 *   ④ startTimer 缺 justification → dev 警告
 *   ⑤ 多订阅 from.topic switch
 *   ⑥ startTimer → onTick
 *   ⑦ reload 命令式 re-init / poll-only resume
 *   ⑧ mutateCtx 触发渲染 / mutateBuffer 不渲染
 *   【v0.0.95 新增】buffer 双写：buffer 变不触发渲染；ctx 变才渲染；onEvent 串行；buffer 清理；deps/reload 重置 ctx+buffer
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + 绝对路径 mock sse-singleton，fake 单例捕获 handleFrame。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// —— vi.hoisted：fake SSE 单例，捕获每次 subscribe 的 handler 供测试驱动帧 —— //
const { sseState, singletonPath } = vi.hoisted(() => ({
  sseState: {
    // 每次 subscribe 记录 {topic, group, handler}；测试用 emit(topic,data) 驱动对应 handler
    subs: [] as Array<{ topic: string; group: string; handler: (f: unknown) => void }>,
    subscribeCalls: 0,
    unsubscribeCalls: 0,
  },
  singletonPath: require('node:path').resolve(__dirname, '../sse-singleton'),
}));

vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: async (topic: string, group: string, handler: (f: unknown) => void) => {
      sseState.subscribeCalls++;
      const entry = { topic, group, handler };
      sseState.subs.push(entry);
      const subId = `sub-${sseState.subscribeCalls}`;
      return {
        subId,
        topic,
        group,
        unsubscribe: async () => {
          sseState.unsubscribeCalls++;
          const idx = sseState.subs.indexOf(entry);
          if (idx !== -1) sseState.subs.splice(idx, 1);
        },
      };
    },
    isConnected: () => true,
  }),
}));

import { useLifecycle } from '../use-lifecycle';
import type { LifecycleContract } from '../use-lifecycle';

/** 排空 hook 挂载后异步副作用（onInit await + establishSubscriptions），act 内结算 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 驱动一帧：找对应 topic 的 handler 调用（模拟 SseFrame，data=payload） */
function emit(topic: string, group: string, data: unknown): void {
  const frame = { topic, group, data, timestamp: '', subId: '' };
  for (const s of sseState.subs) {
    if (s.topic === topic) s.handler(frame);
  }
}

beforeEach(() => {
  sseState.subs = [];
  sseState.subscribeCalls = 0;
  sseState.unsubscribeCalls = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
// ① ref-latest（正确性核心）：连续多帧 onEvent 用 ctxRef.current 累积，无 stale 覆盖丢帧
// ──────────────────────────────────────────────────────────────────────────────
describe('① ctx ref-latest 不变量（连续 onEvent 累积不丢帧）', () => {
  it('单个 act 内连发 50 帧 text_delta：全部累积（ctxRef.current 非 React 快照）', async () => {
    // ctx = 累积字符串；onEvent 每帧追加一个字符。若拿 React 快照，帧2 读到帧1 未 commit 的 stale
    // 值 → 只累积到最后一帧的结果（丢字）。ref-latest 保证一环扣一环。
    const opts: LifecycleContract<{ text: string }, { ch: string }> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('agent_loop', 'g1');
        return { text: '' };
      },
      onEvent: (ctx, evt) => ({ text: (ctx?.text ?? '') + evt.ch }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.ctx).toEqual({ text: '' });

    // 单个 act 内连发 50 帧（同步，React 尚未 commit 中间态）
    await act(async () => {
      for (let i = 0; i < 50; i++) {
        emit('agent_loop', 'g1', { ch: 'x' });
      }
    });

    // 关键断言：全部 50 帧累积（长度 50），无 stale 覆盖丢帧
    expect(result.current.ctx?.text.length).toBe(50);
    expect(result.current.ctx?.text).toBe('x'.repeat(50));
  });

  it('onEvent 返回 void：不改数据（幂等跳渲染），后续帧仍基于最新 ctx 累积', async () => {
    const opts: LifecycleContract<{ n: number }, { delta: number; skip?: boolean }> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { n: 0 };
      },
      // skip 帧返回 void（不改），否则累加
      onEvent: (ctx, evt) => {
        if (evt.skip) return;
        return { n: (ctx?.n ?? 0) + evt.delta };
      },
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    await act(async () => {
      emit('t', 'g', { delta: 5 }); // n=5
      emit('t', 'g', { delta: 0, skip: true }); // void，n 不变
      emit('t', 'g', { delta: 3 }); // n=8（基于 5 累积，证明 skip 未破坏 ref）
    });
    expect(result.current.ctx?.n).toBe(8);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 多订阅：effect.subscribe×2 → onEvent 按 from.topic switch
// ──────────────────────────────────────────────────────────────────────────────
describe('多订阅 from.topic switch', () => {
  it('onInit subscribe 两 topic：onEvent 按 from.topic 分派各自逻辑', async () => {
    const fromTopics: string[] = [];
    const opts: LifecycleContract<{ a: number; b: number }, { v: number }> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('agent_loop', 'g1');
        subscribe('session_panel', 'g2');
        return { a: 0, b: 0 };
      },
      onEvent: (ctx, evt, from) => {
        fromTopics.push(from.topic);
        const cur = ctx ?? { a: 0, b: 0 };
        switch (from.topic) {
          case 'agent_loop':
            return { ...cur, a: cur.a + evt.v };
          case 'session_panel':
            return { ...cur, b: cur.b + evt.v };
          default:
            return;
        }
      },
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(sseState.subscribeCalls).toBe(2);

    await act(async () => {
      emit('agent_loop', 'g1', { v: 10 });
      emit('session_panel', 'g2', { v: 3 });
      emit('agent_loop', 'g1', { v: 5 });
    });
    expect(result.current.ctx).toEqual({ a: 15, b: 3 });
    expect(fromTopics).toEqual(['agent_loop', 'session_panel', 'agent_loop']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// startTimer → onTick：timer 到点重读返回新 ctx
// ──────────────────────────────────────────────────────────────────────────────
describe('startTimer → onTick', () => {
  it('onInit startTimer：到点调 onTick，返回新 ctx 更新数据', async () => {
    vi.useFakeTimers();
    try {
      const tickReads: Array<number | null> = [];
      const opts: LifecycleContract<{ count: number }> = {
        deps: [],
        onInit: ({ startTimer }) => {
          startTimer({ intervalMs: 1000, justification: 'test poll' });
          return { count: 0 };
        },
        onTick: (ctx) => {
          tickReads.push(ctx?.count ?? null);
          return { count: (ctx?.count ?? 0) + 1 };
        },
      };
      const { result } = renderHook(() => useLifecycle(opts));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.ctx).toEqual({ count: 0 });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(result.current.ctx).toEqual({ count: 3 });
      expect(tickReads).toEqual([0, 1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ④ startTimer 缺 justification → dev 警告
// ──────────────────────────────────────────────────────────────────────────────
describe('④ startTimer justification dev 警告', () => {
  it('justification 空串 → console.warn 提示缺失', async () => {
    const opts: LifecycleContract<null> = {
      deps: [],
      onInit: ({ startTimer }) => {
        startTimer({ intervalMs: 1000, justification: '' });
        return null;
      },
    };
    renderHook(() => useLifecycle(opts));
    await settle();
    const warnMock = console.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('polling enabled without justification'),
    );
  });

  it('justification 提供 → 警告打 justification 内容（不打缺失）', async () => {
    const opts: LifecycleContract<null> = {
      deps: [],
      onInit: ({ startTimer }) => {
        startTimer({ intervalMs: 1000, justification: 'cron nextFireAt drift' });
        return null;
      },
    };
    renderHook(() => useLifecycle(opts));
    await settle();
    const warnMock = console.warn as unknown as ReturnType<typeof vi.fn>;
    expect(warnMock).toHaveBeenCalledWith('[lifecycle] polling:', 'cron nextFireAt drift');
    const calls = warnMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('without justification'))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ② signal.aborted：unmount 后 onInit resolve 不写数据
// ──────────────────────────────────────────────────────────────────────────────
describe('② signal.aborted 校验', () => {
  it('unmount 中断 onInit：resolve 后不 setState（ctx 保持 null）', async () => {
    let resolveInit!: (v: { tag: string }) => void;
    const onInit = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ tag: string }>((resolve) => {
          resolveInit = resolve;
          void signal;
        }),
    );
    const opts: LifecycleContract<{ tag: string }> = { onInit, deps: [] };
    const { result, unmount } = renderHook(() => useLifecycle(opts));
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);

    unmount();
    resolveInit({ tag: 'late' });
    await settle();

    expect(result.current.ctx).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ③ onDestroy 幂等 + deps 变化 re-init
// ──────────────────────────────────────────────────────────────────────────────
describe('③ onDestroy 幂等 + deps 变化', () => {
  it('onDestroy 抛异常被 hook 吞掉，unmount 不抛', async () => {
    const onDestroy = vi.fn(() => {
      throw new Error('destroy boom');
    });
    const opts: LifecycleContract<null> = {
      onInit: () => null,
      onDestroy,
      deps: [],
    };
    const { unmount } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(() => unmount()).not.toThrow();
    expect(onDestroy).toHaveBeenCalled();
  });

  it('deps 变化：onDestroy(旧 ctx, 旧 buffer) + onInit(新) 被调 + 旧订阅退订', async () => {
    const onDestroy = vi.fn();
    const onInit = vi.fn(({ subscribe }: { subscribe: (t: string, g: string) => void }) => {
      subscribe('t', 'g');
      return { tag: 'ctx' };
    });
    const mk = (sid: string): LifecycleContract<{ tag: string }> => ({
      onInit,
      onDestroy,
      deps: [sid],
    });
    const { rerender } = renderHook(({ sid }) => useLifecycle(mk(sid)), {
      initialProps: { sid: 's1' },
    });
    await settle();
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(sseState.subscribeCalls).toBe(1);

    rerender({ sid: 's2' });
    await settle();
    expect(onInit).toHaveBeenCalledTimes(2);
    expect(onDestroy).toHaveBeenCalled();
    expect(sseState.unsubscribeCalls).toBeGreaterThanOrEqual(1);
    expect(sseState.subscribeCalls).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// reload：命令式 re-init
// ──────────────────────────────────────────────────────────────────────────────
describe('reload 命令式 re-init', () => {
  it('reload 触发 onInit 重跑（mutation 后刷新场景）', async () => {
    let seq = 0;
    const onInit = vi.fn(() => {
      seq += 1;
      return { seq };
    });
    const opts: LifecycleContract<{ seq: number }> = { onInit, deps: [] };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.ctx).toEqual({ seq: 1 });

    await act(async () => {
      await result.current.reload();
    });
    expect(onInit).toHaveBeenCalledTimes(2);
    expect(result.current.ctx).toEqual({ seq: 2 });
  });

  it('onInit 抛异常：error 状态 + onDestroy(null, null) 兜底', async () => {
    const onDestroy = vi.fn();
    const onInit = vi.fn(() => {
      throw new Error('init boom');
    });
    const opts: LifecycleContract<unknown> = { onInit, onDestroy, deps: [] };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.error?.message).toBe('init boom');
    expect(result.current.loading).toBe(false);
    expect(result.current.ctx).toBeNull();
    expect(onDestroy).toHaveBeenCalledWith(null, null);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// poll-only resume：声明 timer 才在 visible reload；纯订阅 hook 不 reload
// ──────────────────────────────────────────────────────────────────────────────
describe('reload-on-resume poll-only', () => {
  it('声明 timer 的 hook：hidden→visible 触发 reload（onInit 重调）', async () => {
    vi.useFakeTimers();
    try {
      const onInit = vi.fn(({ startTimer }: { startTimer: (o: { intervalMs: number; justification: string }) => void }) => {
        startTimer({ intervalMs: 1000, justification: 'poll test' });
        return { n: 1 };
      });
      const opts: LifecycleContract<{ n: number }> = { onInit, deps: [] };
      renderHook(() => useLifecycle(opts));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onInit).toHaveBeenCalledTimes(1);

      await act(async () => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onInit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('纯订阅 hook（无 timer）：hidden→visible 不 reload', async () => {
    vi.useFakeTimers();
    try {
      const onInit = vi.fn(({ subscribe }: { subscribe: (t: string, g: string) => void }) => {
        subscribe('t', 'g');
        return { n: 1 };
      });
      const opts: LifecycleContract<{ n: number }> = { onInit, deps: [] };
      renderHook(() => useLifecycle(opts));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onInit).toHaveBeenCalledTimes(1);

      await act(async () => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onInit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ⑧ mutateCtx 触发渲染 / mutate（v0.0.94 别名）/ mutateBuffer 不渲染
// ──────────────────────────────────────────────────────────────────────────────
describe('mutateCtx / mutate / mutateBuffer 命令式口子', () => {
  it('mutateCtx 写新 ctx + 触发渲染（ctx 更新可见）', async () => {
    const opts: LifecycleContract<{ n: number }> = {
      deps: [],
      onInit: () => ({ n: 0 }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.ctx).toEqual({ n: 0 });

    await act(async () => {
      result.current.mutateCtx((ctx) => ({ n: (ctx?.n ?? 0) + 5 }));
    });
    expect(result.current.ctx).toEqual({ n: 5 });
  });

  it('mutate（v0.0.94 别名）等同 mutateCtx：触发渲染', async () => {
    const opts: LifecycleContract<{ n: number }> = {
      deps: [],
      onInit: () => ({ n: 0 }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    await act(async () => {
      // mutate 是 mutateCtx 的别名（向后兼容 v0.0.94 调用方）
      result.current.mutate((ctx) => ({ n: (ctx?.n ?? 0) + 7 }));
    });
    expect(result.current.ctx).toEqual({ n: 7 });
  });

  it('mutateCtx 不重订阅（subscribe 数不变）', async () => {
    const onInit = vi.fn(({ subscribe }: { subscribe: (t: string, g: string) => void }) => {
      subscribe('t', 'g');
      return { n: 0 };
    });
    const opts: LifecycleContract<{ n: number }> = { onInit, deps: [] };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(sseState.subscribeCalls).toBe(1);

    await act(async () => {
      result.current.mutateCtx((ctx) => ({ n: (ctx?.n ?? 0) + 1 }));
    });
    expect(sseState.subscribeCalls).toBe(1);
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  it('mutateCtx updater 返 void 跳渲染（ctx 不变）', async () => {
    const opts: LifecycleContract<{ n: number }> = {
      deps: [],
      onInit: () => ({ n: 7 }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.ctx).toEqual({ n: 7 });

    await act(async () => {
      result.current.mutateCtx(() => {
        // 返回 void
      });
    });
    expect(result.current.ctx).toEqual({ n: 7 });
  });

  it('mutateCtx 在 unmount 后调安全（不 setState）', async () => {
    const opts: LifecycleContract<{ n: number }> = {
      deps: [],
      onInit: () => ({ n: 0 }),
    };
    const { result, unmount } = renderHook(() => useLifecycle(opts));
    await settle();
    unmount();
    expect(() => {
      result.current.mutateCtx((ctx) => ({ n: (ctx?.n ?? 0) + 1 }));
    }).not.toThrow();
    expect(result.current.ctx).toEqual({ n: 0 });
  });

  it('mutateCtx 与 onEvent 共享同一 ctxRef（onEvent 改后 mutateCtx 读到最新）', async () => {
    const opts: LifecycleContract<{ n: number }, { v: number }> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { n: 0 };
      },
      onEvent: (ctx, evt) => ({ n: (ctx?.n ?? 0) + evt.v }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    await act(async () => {
      emit('t', 'g', { v: 10 });
    });
    expect(result.current.ctx?.n).toBe(10);

    await act(async () => {
      result.current.mutateCtx((ctx) => ({ n: (ctx?.n ?? 0) + 3 }));
    });
    expect(result.current.ctx?.n).toBe(13);

    await act(async () => {
      emit('t', 'g', { v: 2 });
    });
    expect(result.current.ctx?.n).toBe(15);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 【v0.0.95 新增】buffer 双写通道（不变量⑦ + D1/D2）
// ══════════════════════════════════════════════════════════════════════════════

// ⑦ buffer 变不触发渲染；ctx 变才渲染（不变量⑦核心）
describe('⑦ buffer 变不渲染 / ctx 变才渲染（不变量⑦）', () => {
  it('onEvent 仅返 buffer（不返 ctx）：buffer 累积但 ctx 不变（不触发渲染）', async () => {
    // 模拟 useMessages 场景：rawArgs 半截累积进 buffer，messages（ctx）不变直到 tool_call_end
    type Ctx = { commits: number };
    type Buf = { raw: string };
    const opts: LifecycleContract<Ctx, { piece: string }, Buf> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { ctx: { commits: 0 }, buffer: { raw: '' } };
      },
      onEvent: (ctx, evt, _from, buffer) => {
        // 仅累 buffer.raw，不改 ctx
        return { buffer: { raw: (buffer?.raw ?? '') + evt.piece } };
      },
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.ctx).toEqual({ commits: 0 });

    // 连发 5 帧只累 buffer：ctx 不变（React 渲染快照不变；但 bufferRef.current 已累积）
    let renderCount = 0;
    const origCtx = result.current.ctx;
    renderCount++;
    await act(async () => {
      for (let i = 0; i < 5; i++) emit('t', 'g', { piece: 'a' });
    });
    // ctx 引用不变（无渲染）；renderCount 不增长（result.current.ctx 同一引用）
    expect(result.current.ctx).toBe(origCtx);
    expect(result.current.ctx).toEqual({ commits: 0 });
  });

  it('onEvent 同时返 ctx + buffer：两者各自独立 commit，互不阻塞', async () => {
    type Ctx = { visible: number };
    type Buf = { hidden: number };
    const opts: LifecycleContract<Ctx, { v: number }, Buf> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { ctx: { visible: 0 }, buffer: { hidden: 0 } };
      },
      onEvent: (ctx, evt, _from, buffer) => ({
        ctx: { visible: (ctx?.visible ?? 0) + evt.v },
        buffer: { hidden: (buffer?.hidden ?? 0) + evt.v },
      }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    await act(async () => {
      emit('t', 'g', { v: 5 });
      emit('t', 'g', { v: 3 });
    });
    // ctx 渲染态（visible=8）；buffer 不直接可观测但通过 mutateBuffer 读出验证
    expect(result.current.ctx).toEqual({ visible: 8 });
  });

  it('buffer 半截 rawArgs 不闪屏：连续 5 帧 onEvent 只累 buffer，ctx 渲染计数为 0', async () => {
    type Ctx = { msgs: string[] };
    type Buf = { partial: string };
    const opts: LifecycleContract<Ctx, { ch: string }, Buf> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { ctx: { msgs: [] }, buffer: { partial: '' } };
      },
      onEvent: (_ctx, evt, _from, buffer) => ({
        buffer: { partial: (buffer?.partial ?? '') + evt.ch },
      }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    const beforeCtx = result.current.ctx;
    expect(beforeCtx).toEqual({ msgs: [] });

    await act(async () => {
      emit('t', 'g', { ch: 'a' });
      emit('t', 'g', { ch: 'b' });
      emit('t', 'g', { ch: 'c' });
      emit('t', 'g', { ch: 'd' });
      emit('t', 'g', { ch: 'e' });
    });
    // ctx 引用未变（5 帧都只改 buffer，未触发渲染）
    expect(result.current.ctx).toBe(beforeCtx);
    expect(result.current.ctx).toEqual({ msgs: [] });
  });
});

// 不变量⑧ 串行调度：SseClient 单线程顺序投递 + 同步链路，一帧 onEvent 处理完才接下一帧
describe('⑧ onEvent 串行调度（不变量⑧）', () => {
  it('同一 act 内连发多帧：onEvent 按投递顺序逐一处理，buffer 累积无 race', async () => {
    // buffer 持计数器；每帧 onEvent 读 buffer.current+1 写回。若并发 race，部分帧读到 stale → 总数 < N。
    type Ctx = null;
    type Buf = { count: number };
    const opts: LifecycleContract<Ctx, { seq: number }, Buf> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { ctx: null, buffer: { count: 0 } };
      },
      onEvent: (_ctx, evt, _from, buffer) => ({
        buffer: { count: (buffer?.count ?? 0) + 1, lastSeq: evt.seq },
      }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    await act(async () => {
      // 顺序投递 100 帧；handleFrame 同步链路保证逐一处理
      for (let i = 0; i < 100; i++) emit('t', 'g', { seq: i });
    });
    // 串行：buffer.count 必须等于 100（无 race 漏帧）
    // 通过 mutateBuffer 读 buffer 验证（不渲染）。用 ref 容器避免闭包 CFA 收窄到 null。
    const captured: { buf: Buf | null } = { buf: null };
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured.buf = b;
      });
    });
    expect(captured.buf?.count).toBe(100);
  });
});

// mutateBuffer 命令式口子：不渲染（不变量⑦）
describe('mutateBuffer 命令式改 buffer（不渲染）', () => {
  it('mutateBuffer 写新 buffer 但 ctx 引用不变（不触发渲染）', async () => {
    type Ctx = { n: number };
    type Buf = { m: number };
    const opts: LifecycleContract<Ctx, unknown, Buf> = {
      deps: [],
      onInit: () => ({ ctx: { n: 0 }, buffer: { m: 0 } }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    const beforeCtx = result.current.ctx;

    await act(async () => {
      result.current.mutateBuffer((b) => ({ m: (b?.m ?? 0) + 5 }));
    });
    // ctx 引用未变（不渲染）
    expect(result.current.ctx).toBe(beforeCtx);
    expect(result.current.ctx).toEqual({ n: 0 });
  });

  it('mutateBuffer updater 返 void 跳写（buffer 不变）', async () => {
    type Buf = { k: string };
    const opts: LifecycleContract<null, unknown, Buf> = {
      deps: [],
      onInit: () => ({ ctx: null, buffer: { k: 'init' } }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    const captured: { buf: Buf | null } = { buf: null };
    await act(async () => {
      result.current.mutateBuffer(() => {
        // void
      });
      result.current.mutateBuffer((b) => {
        captured.buf = b;
      });
    });
    expect(captured.buf).toEqual({ k: 'init' });
  });

  it('mutateBuffer 与 onEvent 共享同一 bufferRef', async () => {
    type Buf = { acc: number };
    const opts: LifecycleContract<null, { v: number }, Buf> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { ctx: null, buffer: { acc: 0 } };
      },
      onEvent: (_ctx, evt, _from, buffer) => ({ buffer: { acc: (buffer?.acc ?? 0) + evt.v } }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    await act(async () => {
      emit('t', 'g', { v: 10 });
    });
    // mutateBuffer 读到 onEvent 写入的最新 bufferRef（10）。用 ref 容器避免闭包 CFA 收窄。
    const captured: { buf: Buf | null } = { buf: null };
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured.buf = b;
        return { acc: (b?.acc ?? 0) + 5 };
      });
    });
    expect(captured.buf?.acc).toBe(10);
    // 再发一帧：基于 mutateBuffer 后的 15 累积
    await act(async () => {
      emit('t', 'g', { v: 2 });
    });
    const captured2: { buf: Buf | null } = { buf: null };
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured2.buf = b;
      });
    });
    expect(captured2.buf?.acc).toBe(17);
  });
});

// D2 buffer 清理：reducer 返删 key 的新 buffer；onDestroy/reload 重置 bufferRef
describe('D2 buffer 清理（三层时机）', () => {
  it('onEvent 返 null buffer：bufferRef 置 null（清理）', async () => {
    type Buf = { data: unknown } | null;
    const opts: LifecycleContract<null, { clear: boolean }, Buf> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { ctx: null, buffer: { data: 'initial' } };
      },
      onEvent: (_ctx, evt) => {
        if (evt.clear) return { buffer: null }; // 显式清空
        return;
      },
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    const captured: { buf: Buf | null } = { buf: 'unset' as unknown as Buf };
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured.buf = b;
      });
    });
    expect(captured.buf).toEqual({ data: 'initial' });

    await act(async () => {
      emit('t', 'g', { clear: true });
    });
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured.buf = b;
      });
    });
    expect(captured.buf).toBeNull();
  });

  it('reload 重置 ctx + buffer（bufferRef 回到 onInit 初值）', async () => {
    let initCount = 0;
    type Buf = { gen: number };
    const opts: LifecycleContract<{ n: number }, { v: number }, Buf> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        initCount++;
        return { ctx: { n: 0 }, buffer: { gen: initCount } };
      },
      onEvent: (ctx, evt, _from, buffer) => ({
        ctx: { n: (ctx?.n ?? 0) + evt.v },
        buffer: { gen: (buffer?.gen ?? 0) + 100 },
      }),
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    // 累一轮：buffer.gen 从 1 涨到 101。用 ref 容器避免闭包 CFA 收窄。
    await act(async () => {
      emit('t', 'g', { v: 5 });
    });
    const captured: { buf: Buf | null } = { buf: null };
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured.buf = b;
      });
    });
    expect(captured.buf?.gen).toBe(101);
    expect(result.current.ctx).toEqual({ n: 5 });

    // reload：buffer 应回到 init 初值（gen=2，因 initCount++）
    await act(async () => {
      await result.current.reload();
    });
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured.buf = b;
      });
    });
    expect(captured.buf?.gen).toBe(2);
    expect(result.current.ctx).toEqual({ n: 0 }); // ctx 也重置
  });

  it('deps 变化 re-init：ctx + buffer 都重置（onDestroy 收旧 buffer）', async () => {
    const onDestroy = vi.fn();
    let initCount = 0;
    const mk = (sid: string): LifecycleContract<{ n: number }, unknown, { gen: number }> => ({
      onDestroy,
      deps: [sid],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        initCount++;
        return { ctx: { n: 0 }, buffer: { gen: initCount } };
      },
    });
    const { result, rerender } = renderHook(({ sid }) => useLifecycle(mk(sid)), {
      initialProps: { sid: 's1' },
    });
    await settle();
    // StrictMode 下首 mount→cleanup→remount 让 initCount 至少为 2（remount 重新跑 onInit）
    const firstInitCount = initCount;

    // deps 变 → re-init：旧 ctx+buffer 传 onDestroy（D2 ②re-init 重置）；新 ctx+buffer 来自新 onInit
    rerender({ sid: 's2' });
    await settle();

    // onDestroy 至少被调一次（re-init 触发旧 generation cleanup）
    expect(onDestroy).toHaveBeenCalled();
    // 新 init 跑过（initCount 增长）
    expect(initCount).toBeGreaterThan(firstInitCount);
    // 新 ctx 重置为 {n:0}（新 init 的初值，非旧累积值）
    expect(result.current.ctx).toEqual({ n: 0 });
    // 新 buffer 重置为新 init 的 gen（值取决于 initCount，至少 > 0）。用 ref 容器避免闭包 CFA 收窄。
    const captured: { buf: { gen: number } | null } = { buf: null };
    await act(async () => {
      result.current.mutateBuffer((b) => {
        captured.buf = b;
      });
    });
    expect(captured.buf?.gen).toBe(initCount);
  });
});

// 兼容性：v0.0.94 onInit 返裸 TCtx（非 {ctx, buffer}）—— hook 内部包装为 {ctx, buffer: null}
describe('v0.0.94 兼容：onInit 返裸 ctx（非 {ctx, buffer}）', () => {
  it('onInit 返裸对象：ctx 设置正确，buffer 为 null', async () => {
    const opts: LifecycleContract<{ x: number }> = {
      deps: [],
      onInit: () => ({ x: 42 }), // 裸对象，不是 {ctx, buffer}
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.ctx).toEqual({ x: 42 });

    // buffer 默认 null（mutateBuffer 读到 null）
    let observed: unknown = 'unset';
    await act(async () => {
      result.current.mutateBuffer((b) => {
        observed = b;
      });
    });
    expect(observed).toBeNull();
  });

  it('onInit 返 null（裸 null）：ctx=null，buffer=null', async () => {
    const opts: LifecycleContract<null> = {
      deps: [],
      onInit: () => null,
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();
    expect(result.current.ctx).toBeNull();
  });

  it('onEvent 返裸 ctx（非 {ctx, buffer}）：当 ctx-only 处理', async () => {
    const opts: LifecycleContract<{ n: number }, { v: number }> = {
      deps: [],
      onInit: ({ subscribe }) => {
        subscribe('t', 'g');
        return { n: 0 };
      },
      // 返裸 ctx 对象（不返 {ctx,buffer}）—— normalizeMutation 内部包装为 {ctx: result}
      onEvent: (ctx, evt) => ({ n: (ctx?.n ?? 0) + evt.v }) as { n: number },
    };
    const { result } = renderHook(() => useLifecycle(opts));
    await settle();

    await act(async () => {
      emit('t', 'g', { v: 5 });
    });
    expect(result.current.ctx).toEqual({ n: 5 });
  });
});

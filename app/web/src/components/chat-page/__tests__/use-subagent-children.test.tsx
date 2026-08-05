// @vitest-environment jsdom
/**
 * useSubagentChildren hook 单测（v0.0.28）
 * 参考: specs/api/overall/10-multi-agent.md §3（GET /session/:id/children）
 *       specs/ui/components/chat-page/_overview.md §5 交互8（parent children 拉取）
 *
 * 覆盖 acceptanceCriteria：
 *   - refreshChildren(parentSid) → 调 listChildren（GET /session/:id/children）
 *   - 成功响应写入 store.childrenByParent[parentSid]
 *   - 失败静默（不抛、不写 store）
 *
 * mock 策略（bun runtime 兼容）：
 *   bun --bun runtime 下 vitest 的 vi.mock 对相对路径在 jsdom 环境偶发不生效
 *   （bun resolver 与 vitest mock 拦截器的兼容问题）。
 *   全量套件高并发下相对路径 mock 失效 → listChildren 走真实 mock（非 vi.fn）
 *   → `(chatApi.listChildren as ...).mockResolvedValue is not a function`。
 *   根治：vi.hoisted 提升模块级 mock fn + 绝对路径 mock + vi.mocked() 断言。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// —— vi.hoisted 提升模块级 mock fn —— //
// 工厂被 hoisting 到顶部，工厂内不能引用外部变量；用 vi.hoisted 跨越 hoisting 边界。
const { listChildrenMock, chatApiPath } = vi.hoisted(() => ({
  listChildrenMock: vi.fn<(parentSid: string) => Promise<unknown>>(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

// —— mock chat-api：listChildren 为 spy —— //
// 工厂内用函数包装引用 hoisted spy（避免工厂顶层执行时引用未初始化变量）。
// 仅 mock 被测 hook 用到的 listChildren；其他导出由 vitest 自动透传真实模块。
vi.mock(chatApiPath, async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/chat-api')>();
  return {
    ...actual,
    listChildren: (...args: Parameters<typeof listChildrenMock>) => listChildrenMock(...args),
  };
});

import { useSubagentChildren } from '../use-subagent-children';
import { useChatStore } from '../../../store/chat-slice';
import type { ChildrenView } from '../types';

beforeEach(() => {
  vi.clearAllMocks();
  // 重置 store
  useChatStore.setState({ childrenByParent: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSubagentChildren hook（v0.0.28）', () => {
  it('refreshChildren 调用 listChildren(parentSid)（GET /session/:id/children）', async () => {
    const mockChildren: ChildrenView = {
      parentSessionId: 'p1',
      running: [{ sessionId: 'r1', name: 'explorer', state: 'running', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T00:00:00.000Z' }],
      terminated: [],
    };
    listChildrenMock.mockResolvedValue(mockChildren);

    const { result } = renderHook(() => useSubagentChildren());
    await act(async () => {
      await result.current.refreshChildren('p1');
    });

    // GET /session/:id/children 被调一次，参数 = parentSid
    expect(listChildrenMock).toHaveBeenCalledWith('p1');
  });

  it('成功响应写入 store.childrenByParent[parentSid]', async () => {
    const mockChildren: ChildrenView = {
      parentSessionId: 'p1',
      running: [{ sessionId: 'r1', name: 'explorer', state: 'running', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T00:00:00.000Z' }],
      terminated: [{ sessionId: 't1', name: 'explorer', state: 'idle', subAgentTemplateType: 'explorer', updatedAt: '2026-06-27T00:00:00.000Z' }],
    };
    listChildrenMock.mockResolvedValue(mockChildren);

    const { result } = renderHook(() => useSubagentChildren());
    await act(async () => {
      await result.current.refreshChildren('p1');
    });

    const stored = useChatStore.getState().childrenByParent['p1'];
    expect(stored).toEqual(mockChildren);
    expect(stored?.running).toHaveLength(1);
    expect(stored?.terminated).toHaveLength(1);
  });

  it('listChildren 失败静默（不抛、不写 store）', async () => {
    listChildrenMock.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useSubagentChildren());
    await act(async () => {
      await result.current.refreshChildren('p1');
    });

    // store 未写入（失败静默）
    expect(useChatStore.getState().childrenByParent['p1']).toBeUndefined();
  });

  it('fetchedRef 初始空 Set（mount 去重用）', async () => {
    const { result } = renderHook(() => useSubagentChildren());
    expect(result.current.fetchedRef.current).toBeInstanceOf(Set);
    expect(result.current.fetchedRef.current.size).toBe(0);
    // [v0.0.92.sse_opt W6] useLifecycle mount effect 异步结算（避免 act 告警）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// [v0.0.92.sse_opt W6] signal-safety：useLifecycle.destroy 中断 in-flight
// 不变量1（useLifecycle §7.2）：await 后必须 signal.aborted 校验才能写 store
// ──────────────────────────────────────────────────────────────────────────────
describe('useSubagentChildren signal-safety（v0.0.92.sse_opt W6）', () => {
  it('unmount 触发 destroy：in-flight listChildren 被 abort，resolve 后不写 store', async () => {
    // 让 listChildren 在测试控制下 resolve（先 unmount 再 resolve）
    let resolveList!: (v: ChildrenView) => void;
    listChildrenMock.mockImplementation(
      () =>
        new Promise<ChildrenView>((resolve) => {
          resolveList = resolve;
        }),
    );

    const { result, unmount } = renderHook(() => useSubagentChildren());
    // 启动 refreshChildren（listChildren pending）
    await act(async () => {
      void result.current.refreshChildren('p1');
      await new Promise((r) => setTimeout(r, 0));
    });

    // unmount → useLifecycle.destroy → abort 所有 in-flight controllers
    unmount();

    // listChildren 后续 resolve：因 controller 已 abort，setChildren 不被调用
    await act(async () => {
      resolveList({ parentSessionId: 'p1', running: [], terminated: [] });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useChatStore.getState().childrenByParent['p1']).toBeUndefined();
  });

  it('同 parentSid 二次 refreshChildren：旧 in-flight 被 abort，旧 resolved 不覆盖 store', async () => {
    // 第一次慢（受控 resolve），第二次立即 resolve
    let resolveFirst!: (v: ChildrenView) => void;
    let callCount = 0;
    listChildrenMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise<ChildrenView>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve<ChildrenView>({
        parentSessionId: 'p1',
        running: [
          {
            sessionId: 'NEW',
            name: 'n',
            state: 'running',
            subAgentTemplateType: 'explorer',
            updatedAt: 't',
          },
        ],
        terminated: [],
      });
    });

    const { result } = renderHook(() => useSubagentChildren());
    // 第一次 refresh（pending，不 resolve）
    await act(async () => {
      void result.current.refreshChildren('p1');
      await new Promise((r) => setTimeout(r, 0));
    });
    // 第二次 refresh（abort 第一次，立即 resolve 写 store）
    await act(async () => {
      await result.current.refreshChildren('p1');
    });
    // 第一次后续 resolve（应被 signal.aborted 拦截，不覆盖）
    await act(async () => {
      resolveFirst({
        parentSessionId: 'p1',
        running: [
          {
            sessionId: 'OLD',
            name: 'o',
            state: 'running',
            subAgentTemplateType: 'explorer',
            updatedAt: 't',
          },
        ],
        terminated: [],
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    const stored = useChatStore.getState().childrenByParent['p1'];
    expect(stored?.running[0]?.sessionId).toBe('NEW');
  });
});

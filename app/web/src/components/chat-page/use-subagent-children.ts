/**
 * useSubagentChildren —— parent session 子代理（swarm）拉取 hook
 * 参考: specs/ui/components/chat-page/_overview.md §5 交互8（subagent 展开 + session_meta 挂 parent tree）
 *       specs/api/overall/10-multi-agent.md §3（GET /session/:id/children）/ §2.3（session_meta 广播）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 契约）
 *
 * 职责：parent children 视图拉取 + session_meta 增量刷新。
 *   - session_meta subagent 到达 → 刷新其 parent 的 children（UC-28.3 running→terminated 转移）
 *   - 调用方（page-chat / component-conversation-item）按需触发 refreshChildren(parentSid)
 * 返回：{ refreshChildren } —— 供 page-chat 在 session_meta 回调中调用。
 *
 * 状态写入：调 store.setChildren(parentSid, ChildrenView)；store.childrenByParent 由组件订阅。
 *
 * useLifecycle 用法特殊：parentSid 是每次 refreshChildren 调用动态传入（一个 page-chat 实例服务多个
 *   parent），不在 hook 级 deps；本 hook 无 mount-fetch / SSE 订阅 / 定时器（只是 useCallback 包
 *   listChildren+setChildren）。故只借 useLifecycle 接管 unmount 时的 in-flight abort（onDestroy 幂等清
 *   controllersRef），refreshChildren 内部按 parentSid 维护 AbortController 池 + signal.aborted 校验
 *   （不变量1 精神：杜绝 unmount 后写 store 的 race）。reload-on-resume poll-only 不 abort in-flight。
 */
import { useCallback, useRef } from 'react';
import { listChildren } from '../../lib/chat-api';
import { useChatStore } from '../../store/chat-slice';
import { useLifecycle } from '../../lib/use-lifecycle';

/**
 * parent children 视图拉取 hook。
 * 返回 refreshChildren(parentSid) —— 拉 GET /session/:id/children 写入 store；失败静默。
 * 返回 fetchedRef —— 调用方记录已拉过的 parent（避免重复 GET）。
 */
export function useSubagentChildren() {
  const setChildren = useChatStore((s) => s.setChildren);
  // 已拉过 children 的 parent id（避免 mount 时重复 GET /session/:id/children）
  const fetchedRef = useRef<Set<string>>(new Set());
  // in-flight AbortController 池（per parentSid）：
  //   - 同 parentSid 新请求 abort 旧（避免乱序覆盖：旧 resolved 晚于新时被丢弃）
  //   - unmount 时 useLifecycle.onDestroy 全部 abort（signal-safety）
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  // useLifecycle 仅用其 unmount cleanup（onDestroy 内 abort 所有 in-flight）。
  // onInit 为 no-op（返 null）：本 hook 无 mount-fetch / 订阅 / 定时器（parentSid 动态）。
  useLifecycle<null>({
    onInit: () => null,
    onDestroy: () => {
      controllersRef.current.forEach((c) => c.abort());
      controllersRef.current.clear();
    },
    deps: [],
  });

  const refreshChildren = useCallback(
    async (parentSid: string) => {
      // 取消同 parentSid 的旧 in-flight 请求（避免乱序：旧 resolved 后于新时被 signal.aborted 拦截）
      controllersRef.current.get(parentSid)?.abort();
      const controller = new AbortController();
      controllersRef.current.set(parentSid, controller);
      try {
        const children = await listChildren(parentSid);
        // 不变量1（useLifecycle §7.2）：await 后必须 signal.aborted 校验才能写
        // （unmount 或同 parentSid 新请求会 abort 旧 controller）
        if (controller.signal.aborted) return;
        setChildren(parentSid, children);
      } catch (e) {
        // abort 触发的 rejection 静默丢弃；其余失败保旧行为（console.warn 不抛）
        if (controller.signal.aborted) return;
        console.warn('listChildren failed:', e);
      } finally {
        // 仅当仍是当前 controller 时清掉（避免清错新请求的 controller）
        if (controllersRef.current.get(parentSid) === controller) {
          controllersRef.current.delete(parentSid);
        }
      }
    },
    [setChildren],
  );

  return { refreshChildren, fetchedRef };
}

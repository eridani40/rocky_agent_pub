/**
 * use-session-panel-fanout —— session_panel 边角事件扇出 area-hook
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §4.2（workspace/read 扇出归此受控例外）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法）
 *
 * 职责：唯一负责把 session_panel 的边角事件转发给全局 store 的 area-hook（扇出枢纽）：
 *   - `session_workspace_file_changed` / `session_workspace_dir_changed` → store.setLastWorkspaceEvent(evt)
 *     （供 SectionWorkspacePanel 消费）
 *   - `session_read_update` → store.setSessionUnread(evt.sessionId, false)（红点实时消失）
 *   - `session_todo_changed` → store.setLastTodoEvent(evt)（第三类扇出，供 useTodoCrud 静默 refetch）
 *
 * 受控例外（spec §4.2 显式标明）：onEvent 副作用写 store 是扇出枢纽的本质职责（非纯 ctx）。
 *   ctx 为 null（无自己的渲染数据——它只转发给 store）；onEvent 返回 void。借 useLifecycle 管订阅
 *   生命周期（onInit 声明 subscribe + 切 session 自动重订阅），同 useMessages 借 lifecycle 管订阅、
 *   onEvent 副作用写 store 的受控例外模式。
 *
 * MUST NOT 处理 status/usage/summary/messages_cleared（归各 area-hook）；只管 workspace + read + todo 三类。
 */
import { useLifecycle } from '../../lib/use-lifecycle';
import { useChatStore } from '../../store/chat-slice';
import type { SessionEvent } from '../../store/session-slice-reducer';
import type { WorkspaceEvent } from './workspace-types';

/**
 * session_panel 边角事件扇出 area-hook。sessionId 变化时 useLifecycle 自动重订阅。
 * @param sessionId 当前查看的 session id
 */
export function useSessionPanelFanout(sessionId: string): void {
  useLifecycle<null, SessionEvent>({
    deps: [sessionId],
    onInit: async ({ subscribe }) => {
      subscribe('session_panel', `session_id:${sessionId}`);
      return null;
    },
    // onEvent：副作用写 store（受控例外——扇出枢纽本质副作用），返回 void 不走 ctx 通道
    onEvent: (_ctx, event) => {
      switch (event.type) {
        case 'session_workspace_file_changed':
        case 'session_workspace_dir_changed': {
          useChatStore.getState().setLastWorkspaceEvent(event as WorkspaceEvent);
          return;
        }
        case 'session_read_update': {
          // session_read_update：sessionId 在事件顶层（data.unread 恒 false，CAS 成功 emit）
          useChatStore.getState().setSessionUnread(event.sessionId, false);
          return;
        }
        case 'session_todo_changed': {
          // todo 变更轻量信号 → store.lastTodoEvent（useTodoCrud effect 匹配 sid 后静默 refetch）
          useChatStore.getState().setLastTodoEvent(event);
          return;
        }
        default:
          // status/usage/summary/messages_cleared 归各 area-hook，本 hook 忽略
          return;
      }
    },
  });
}

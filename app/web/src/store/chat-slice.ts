/**
 * chat-slice —— chat 页**列表 / 拓扑 / workspace 扇出**状态（v0.0.39 P2 重构：run 态迁至 useSessionRunState）
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.4（共享 run 态引擎 + store 瘦身契约）
 *       specs/tech/app/frontend/[P0]sse_channel.md §10.5（session_meta 广播订阅）/ §9（session_panel）
 *
 * 职责（B 重构后仅保留非 run-state）：
 *   - sessions[] 会话列表 + activeSessionId
 *   - session_meta `_all` 广播 reducer（applySessionMetaEvent，含 P1 bizType 守卫防 studio 泄漏）
 *   - setSessionUnread（红点）+ session_read_update 扇出（由 useSessionRunState onSessionRead 回调触发）
 *   - subagent tree（childrenByParent / activeSubId）
 *   - lastWorkspaceEvent（workspace SSE 扇出，section-workspace-panel 读；由 useSessionRunState onWorkspaceEvent 回调触发）
 *   - lastTodoEvent（todo SSE 扇出，useTodoCrud 读；由 useSessionPanelFanout 写入）
 *   - drafts（[v0.0.267] sessionId → 输入区草稿缓存，内存级；saveDraft/clearDraft 幂等）
 *
 * [v0.0.39 P2] run 态（messages/runActive/loadingPhase/lastRunFinish/sessionRunning/enqueueItems/usage/
 *   summaryTask 及其 actions）已迁至 `app/web/src/components/chat-page/use-session-run-state.ts`（共享引擎，
 *   playground + studio 单聊共用）。逻辑本体仍是 chat-slice-reducer.ts / session-slice-reducer.ts 的纯 reducer，
 *   改由 hook 调用而非 store——纯 reducer 文件不动。
 *
 * re-export：AgentEvent / applyAgentEventToMessages / SessionEvent 从 reducer 文件导出（消费方 + 既有 UT
 *   import 一处即可；纯 reducer UT 仍从本文件 import，不变）。
 */
import { create } from 'zustand';
import type { ChildrenView, Session } from '../components/chat-page/types';
import type { WorkspaceEvent } from '../components/chat-page/workspace-types';
import {
  applyAgentEventToMessages,
  type AgentEvent,
  type ReducerFullResult,
} from './chat-slice-reducer';
import type { SessionEvent, SessionTodoChangedEvent } from './session-slice-reducer';

// v0.0.95 T1：re-export ReducerFullResult（reducer 纯化后含 runCtx 返回值，useMessages 按返回写回 buffer.runCtx）
export { applyAgentEventToMessages, type AgentEvent, type SessionEvent, type ReducerFullResult };

/**
 * [v0.0.267] 输入草稿内容 = `serializeEditorContent` 序列化字符串
 * （文本 + `<mention …/>` 内联 tag，`\n` 段落分隔）——与发送通道（onSend 的 content）同构，
 * mention 保真；空串 = 无草稿（saveDraft 不存 key）。参考 PRD §2.1/§3.1 + change_plan 决策①。
 */
export type DraftContent = string;

/**
 * [v0.0.231] 会话列表统一排序比较器（spec _overview.md §4.1 统一排序契约）。
 * 列表顺序 = 置顶组在前、非置顶组在后，同组内 updatedAt 倒序（最新在上）。
 * 所有写路径（setSessions / applySessionMetaEvent）收敛到本比较器重排——排序是列表常驻属性，
 * 新建/对话(updatedAt 推进)/置顶切换/重拉任何变化都自动归位，单一数据源。
 * 纯函数无副作用；pinned 用 === true 判（undefined 安全）；Array.sort 稳定排序保同 updatedAt 插入序。
 */
export function compareSessionsForList(a: Session, b: Session): number {
  const ap = a.pinned === true;
  const bp = b.pinned === true;
  if (ap !== bp) return ap ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * [v0.0.27] session_meta topic 事件（广播，spec session_event.md §3a）。
 * 会话列表 subscribe (session_meta, _all) 一次收所有 session meta 变更；reducer 按 data.id 整条替换。
 */
export interface SessionMetaUpdateEvent {
  id: string;
  type: 'session_meta_update';
  sessionId: string;
  createdAt: string;
  /** 全量最新态 SessionMetaView（非 diff），reducer 整条替换 sessions[] */
  data: Session;
}

/** chat slice 状态（v0.0.39 P2：仅列表/拓扑/workspace；run 态在 useSessionRunState） */
export interface ChatSliceState {
  sessions: Session[];
  activeSessionId: string | null;
  /**
   * [v0.0.17] 最近一条 workspace SSE 事件（session_workspace_file_changed / dir_changed）。
   * 由 useSessionRunState 的 onWorkspaceEvent 回调写入（session_panel 订阅在引擎内）；
   * section-workspace-panel 监听本字段 dispatch 到 workspace reducer。
   * 按 createdAt 幂等（SSE 重连重发同事件不重复触发；消费端按 sessionId 过滤）。
   */
  lastWorkspaceEvent: WorkspaceEvent | null;
  lastWorkspaceEventAt: string | null;

  /**
   * 最近一条 todo 变更轻量信号（session_todo_changed，session_panel topic）。
   * 由 useSessionPanelFanout 写入；useTodoCrud 监听本字段（匹配 sessionId）触发静默 refetch。
   * 幂等键 = event.id（理由见 session-slice-reducer SessionTodoChangedEvent）。
   */
  lastTodoEvent: SessionTodoChangedEvent | null;

  /**
   * [v0.0.28] parent → children 视图（GET /session/:id/children 拉取，api 10-multi-agent.md §3）。
   * parent conv-item 展开时挂载 component-subagent-tree；activeSubId 指向当前选中 subagent。
   * subagent session 不作顶层独立项（page-chat 据 type==="subagent" 过滤顶层 sessions[]）。
   */
  childrenByParent: Record<string, ChildrenView>;
  /** [v0.0.28] 当前 active 的 subagent sessionId（subagent-tree 高亮 + 只读页路由） */
  activeSubId: string | null;
  /**
   * [v0.0.267] sessionId → 输入区草稿（序列化字符串）。内存级（无 persist middleware）：
   * ChatComposer onUpdate 实时写（saveDraft）、切回 session mount 恢复、发送后 clearDraft。
   * 空串不存 key（saveDraft 空内容 = 清除）；值相同不 set（幂等，防恢复回写同值触发订阅）。
   */
  drafts: Record<string, DraftContent>;

  // —— actions —— //
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  /**
   * [v0.0.27] 更新单个 session 的 unread 字段（POST /session/:id/read 响应 / SSE session_read_update）。
   * 用于红点实时消失，无须整体重拉 sessions 列表。
   */
  setSessionUnread: (sessionId: string, unread: boolean) => void;
  /**
   * [v0.0.27] 应用一条 SessionMetaUpdateEvent（SSE session_meta 广播 reducer）。
   * 会话列表 subscribe (session_meta, _all) 收到 → 按 data.id 整条替换 sessions[]（不存在则插入）。
   * spec sse_channel.md §10.5 / decision.md §3（全量 payload，reducer 整条替换，无需 merge）。
   * [v0.0.231] upsert 后按 compareSessionsForList 统一重排（排序即时归位，spec _overview.md §4.1）。
   */
  applySessionMetaEvent: (evt: SessionMetaUpdateEvent) => void;
  /** [v0.0.17] 写入最近一条 workspace 事件（useSessionRunState onWorkspaceEvent 回调调用） */
  setLastWorkspaceEvent: (evt: WorkspaceEvent | null) => void;
  /** 写入最近一条 todo 变更事件（useSessionPanelFanout 调用；同 id 幂等 skip） */
  setLastTodoEvent: (evt: SessionTodoChangedEvent) => void;
  /**
   * [v0.0.28] 设置某 parent 的 children 视图（GET /session/:id/children 响应写入）。
   * parent conv-item 展开时 component-subagent-tree 消费此 map 渲染三段树。
   */
  setChildren: (parentSessionId: string, children: ChildrenView) => void;
  /**
   * [v0.0.28] 设置当前 active 的 subagent sessionId（点 subagent-item-{sid} 切到只读页）。
   * null = 无 active subagent（回到 parent 顶层会话）。
   */
  setActiveSubId: (subSessionId: string | null) => void;
  /**
   * [v0.0.267] 保存某 session 的输入草稿：空内容（!content.trim()）→ 删 key 等价清除（幂等，无 key 不 set）；
   * 非空 → 不可变写（spread 新建）；值相同不 set（防恢复回写同值触发订阅）。
   */
  saveDraft: (sessionId: string, content: DraftContent) => void;
  /** [v0.0.267] 清除某 session 的输入草稿；key 不存在 no-op 不 set（幂等） */
  clearDraft: (sessionId: string) => void;
}

/** 创建 chat slice store（工厂便于单测隔离） */
export function createChatSliceStore() {
  return create<ChatSliceState>((set, get) => ({
    sessions: [],
    activeSessionId: null,
    lastWorkspaceEvent: null,
    lastWorkspaceEventAt: null,
    lastTodoEvent: null,
    // [v0.0.28] subagent tree 状态：parent → children 视图 + active subagent
    childrenByParent: {},
    activeSubId: null,
    // [v0.0.267] sessionId → 输入草稿（内存级，无 persist）
    drafts: {},

    setSessions(sessions) {
      // [v0.0.231] 统一排序契约：写入前按 compareSessionsForList 重排（spread 后 sort，不 mutate 入参）
      set({ sessions: [...sessions].sort(compareSessionsForList) });
    },
    setActiveSession(id) {
      set({ activeSessionId: id });
    },
    setSessionUnread(sessionId, unread) {
      // [v0.0.27] 仅更新对应 session 的 unread，不触动其他 session / 不重渲整列表
      set((s) => ({
        sessions: s.sessions.map((it) =>
          it.id === sessionId ? { ...it, unread } : it,
        ),
      }));
    },
    applySessionMetaEvent(evt) {
      // [v0.0.27] session_meta 广播 reducer（spec sse_channel.md §10.5 / decision.md §3）：
      // 全量 payload，按 data.id 整条替换 sessions[]（不存在则插入，再由统一比较器落位）。
      const incoming = evt.data;
      // [v0.0.39] playground 列表隔离守卫：session_meta 是 `_all` 共享广播，后端对 studio
      // session（biz:'studio'，session-meta-broadcaster.ts:87）也会推送。本 store 是
      // playground 专属（useChatStore），studio-page 不共用，故 studio 会话一律拒纳，
      // 避免其 running 时广播 meta 被 upsert 进 playground sessions[]（缺省/undefined 视为
      // playground，正常纳入）。参考 specs/tech/agent/session/[P0]session_biztype.md。
      // [v0.0.210] academy 同理拒纳（biz:'academy' 会话走 academy-page 自己的列表，
      //   防教室 head/coach/student session 泄漏进 playground 列表）。
      if (incoming.biz === 'studio' || incoming.biz === 'academy') return;
      set((s) => {
        const exists = s.sessions.some((it) => it.id === incoming.id);
        // [v0.0.231] upsert 后统一重排（原位替换 → 归位重排；新会话按 updatedAt/pinned 落位）
        const sessions = (
          exists
            ? s.sessions.map((it) => (it.id === incoming.id ? incoming : it))
            : [incoming, ...s.sessions]
        ).sort(compareSessionsForList);
        return { sessions };
      });
    },
    setLastWorkspaceEvent(evt) {
      // 幂等：同 createdAt 不重复触发（SSE 重连可能重发）；null 重置
      const createdAt = evt?.createdAt ?? '';
      if (evt && get().lastWorkspaceEventAt === createdAt) return;
      set({
        lastWorkspaceEvent: evt,
        lastWorkspaceEventAt: evt ? createdAt : null,
      });
    },
    setLastTodoEvent(evt) {
      // 幂等：同 id 不重复触发（ulid 必唯一，SSE 重连重发同事件不重复 refetch）
      if (get().lastTodoEvent?.id === evt.id) return;
      set({ lastTodoEvent: evt });
    },
    setChildren(parentSessionId, children) {
      // [v0.0.28] 写入 parent 的 children 视图（GET /session/:id/children 响应）
      set((s) => ({
        childrenByParent: { ...s.childrenByParent, [parentSessionId]: children },
      }));
    },
    setActiveSubId(subSessionId) {
      // [v0.0.28] 切 active subagent（null = 回到 parent 顶层会话）
      set({ activeSubId: subSessionId });
    },
    saveDraft(sessionId, content) {
      // [v0.0.267] 输入草稿保存（PRD §2.2/§3.1，决策③ 性能护栏）：
      // 空内容 = 清除（clearContent 触发 onUpdate → serialize '' → saveDraft 空）；
      // 值相同不 set（恢复回写同值不触发订阅）；不可变更新（spread 新建，不 mutate）。
      if (!content.trim()) {
        if (!(sessionId in get().drafts)) return;
        set((s) => {
          const next = { ...s.drafts };
          delete next[sessionId];
          return { drafts: next };
        });
        return;
      }
      if (get().drafts[sessionId] === content) return;
      set((s) => ({ drafts: { ...s.drafts, [sessionId]: content } }));
    },
    clearDraft(sessionId) {
      // [v0.0.267] 发送后清除（PRD §3.4）：幂等——key 不存在 no-op 不 set
      if (!(sessionId in get().drafts)) return;
      set((s) => {
        const next = { ...s.drafts };
        delete next[sessionId];
        return { drafts: next };
      });
    },
  }));
}

/** 全局单例（App 消费） */
export const useChatStore = createChatSliceStore();

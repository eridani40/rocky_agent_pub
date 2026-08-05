/**
 * agent.query action —— list_children + query_agent（v0.0.28 task-2）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §7（管理工具 + 筛选/限量）
 *       specs/tech/agent/tools/[P1]agent_tools.md §1（agent.query 合并 list+query）
 *       specs/api/overall/10-multi-agent.md §3（GET /session/:id/children 同源）
 *
 * 语义（agent_tools §1）：
 *   - 带 ref → 单 child 详情（status/usage/lastUpdatedAt）
 *   - 不带 ref + filter → list_children（running/terminated 分组 + templateType 筛 + limit）
 *
 * 数据源：与 GET /session/:id/children 同源（store.listChildren 逻辑）；
 * 入口不同——HTTP 给 UI，agent.query 给 LLM（a2a_protocol §1.2 + api 10a §1.2）。
 *
 * 单文件 ≤300 行。
 */
import type { ChildrenView, ChildSummary, SessionUsageView } from '../session-store-types';

/** query 依赖注入接口 */
export interface QueryDeps {
  /** parent sessionId（caller 的 session.id） */
  parentSessionId: string;
  /** listChildren（注入 store.listChildren） */
  listChildren(parentSid: string, filter?: {
    status?: 'running' | 'terminated';
    templateType?: string;
    limit?: number;
  }): Promise<ChildrenView>;
  /** 单 child 详情（注入：store.getSession + store.getUsageView）。
   *  [v0.0.101] state 加 'suspended'（subagent 可悬浮）。 */
  getChildDetail(childSid: string): Promise<{
    state:
      | 'idle'
      | 'running'
      | 'interrupting'
      | 'interrupted'
      | 'error'
      | 'suspended';
    usage: SessionUsageView;
    updatedAt: string;
    subAgentTemplateType: string | null;
  } | null>;
  /** 解析 ref（AgentRef struct / sessionId / "parent" 别名）→ childSessionId */
  resolveRef(ref: unknown): string | null;
}

/** query_agent 单详情结果。
 *  [v0.0.101] state 加 'suspended'（subagent 可悬浮）。 */
export interface QueryAgentDetail {
  sessionId: string;
  state:
    | 'idle'
    | 'running'
    | 'interrupting'
    | 'interrupted'
    | 'error'
    | 'suspended';
  usage: SessionUsageView;
  lastUpdatedAt: string;
  subAgentTemplateType: string | null;
}

/** query 结果联合（带 ref=单详情；不带=列表） */
export type QueryAgentResult =
  | { kind: 'detail'; detail: QueryAgentDetail | null }
  | { kind: 'list'; view: ChildrenView };

/**
 * 执行 agent.query action（derivation §7 + agent_tools §1）。
 * - input.ref 存在 → resolve ref → 单 child 详情（state/usage/lastUpdatedAt/subAgentTemplateType）
 * - input.ref 不存在 → list_children（filter.status/templateType/limit；返 running/terminated 分组）
 *
 * @param input  QueryAgentInput
 * @param deps   注入依赖（parentSessionId / listChildren / getChildDetail / resolveRef）
 * @returns QueryAgentResult（detail 或 list）
 */
export async function executeQuery(
  input: { ref?: unknown; filter?: { status?: 'running' | 'terminated'; templateType?: string; limit?: number } },
  deps: QueryDeps,
): Promise<QueryAgentResult> {
  // 带 ref → 单详情
  if (input.ref !== undefined && input.ref !== null && input.ref !== '') {
    const childSid = deps.resolveRef(input.ref);
    if (!childSid) {
      return { kind: 'detail', detail: null };
    }
    const detail = await deps.getChildDetail(childSid);
    if (!detail) return { kind: 'detail', detail: null };
    return {
      kind: 'detail',
      detail: {
        sessionId: childSid,
        state: detail.state,
        usage: detail.usage,
        lastUpdatedAt: detail.updatedAt,
        subAgentTemplateType: detail.subAgentTemplateType,
      },
    };
  }
  // 不带 ref → list_children（同源 store.listChildren，filter 透传）
  const view = await deps.listChildren(deps.parentSessionId, input.filter);
  return { kind: 'list', view };
}

/** 导出 ChildSummary 供 agent-tool 序列化引用 */
export type { ChildSummary };

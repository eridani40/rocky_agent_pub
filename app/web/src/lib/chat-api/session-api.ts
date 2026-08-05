/**
 * session-api —— session CRUD HTTP 客户端（从 chat-api.ts 拆出）
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §2（session CRUD）
 *       specs/api/overall/04-agent-session.md §2（session 接口契约）
 *
 * 含共享 req helper（本模块 export，兄弟模块 message-api/usage-summary-api/workspace-api 复用）。
 * v0.0.156 拆分重构：从原单文件 chat-api.ts move，**签名/错误处理 100% 等价**（INV-B-3/G1）。
 */
import { resolveApiBase } from '../api-base';
import type { ChildrenView, Session } from '../../components/chat-page/types';

/** 统一 fetch 封装（与 api-client 同风格；本模块 export 供兄弟 chat-api 子模块复用） */
export async function req<T>(path: string, init?: RequestInit, base?: string): Promise<T> {
  const res = await fetch(`${resolveApiBase(base)}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

/** POST /session —— 创建会话（§2.1） */
export async function createSession(
  body?: { title?: string; providerId?: string; modelId?: string },
  base?: string,
): Promise<Session> {
  return req<Session>('/session', {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  }, base);
}

/** GET /session —— 会话列表（§2.2，按 updatedAt desc） */
export async function listSessions(base?: string): Promise<Session[]> {
  const r = await req<{ items: Session[] }>('/session', undefined, base);
  return r.items ?? [];
}

/** GET /session/:id —— 会话详情（§2.3） */
export async function getSession(id: string, base?: string): Promise<Session> {
  return req<Session>(`/session/${encodeURIComponent(id)}`, undefined, base);
}

/**
 * PUT /session/:id —— v0.0.9 部分更新（title/providerId/modelId，手动选 model 持久化）。
 * [v0.0.17] body 扩展支持 workspaceDir（切工作区目录，后端 stop→set→start watch + emit dir_changed）。
 * [v0.0.47] body 扩展支持 titled（手动改名时同步置 titled:true，防 AI 名返回覆盖；详见
 *           specs/api/overall/04-agent-session.md §2.5）。
 * 返回更新后的 Session。
 */
export async function updateSession(
  id: string,
  body: {
    title?: string;
    providerId?: string;
    modelId?: string;
    workspaceDir?: string;
    titled?: boolean;
    /** [v0.0.148] session 级 effort 推理强度（4 档语义键），对齐后端 UpdateSessionBody */
    effort?: 'default' | 'low' | 'high' | 'max';
    /** [v0.0.148] session 级审批模式（normal/greenlight），对齐后端 UpdateSessionBody */
    approvalMode?: 'normal' | 'greenlight';
    /** [v0.0.231] 置顶标记（true 置顶 / false 取消），对齐后端 UpdateSessionBody；
     *  caller 保持 fire-and-forget 语义（.catch warn，不 await 归位） */
    pinned?: boolean;
  },
  base?: string,
): Promise<Session> {
  return req<Session>(
    `/session/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(body) },
    base,
  );
}

/** DELETE /session/:id —— 删除会话（§2.4，级联删） */
export async function deleteSession(id: string, base?: string): Promise<void> {
  await req<{ ok?: true }>(`/session/${encodeURIComponent(id)}`, { method: 'DELETE' }, base);
}

/**
 * [v0.0.28] GET /session/:id/children —— 列出 parent 派生的 children（swarm）。
 * 对齐 api 10-multi-agent.md §3。返回 running/terminated 两组（组内按 updatedAt desc）。
 * 前端 component-subagent-tree 展开 parent 项时拉取此端点（§5 交互8）。
 * query:
 *   - status: 'running' | 'terminated'（不传 = 两组都返）
 *   - limit: number（单组上限，默认 20）
 */
export async function listChildren(
  sessionId: string,
  opts?: { status?: 'running' | 'terminated'; limit?: number },
  base?: string,
): Promise<ChildrenView> {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const q = params.toString();
  return req<ChildrenView>(
    `/session/${encodeURIComponent(sessionId)}/children${q ? `?${q}` : ''}`,
    undefined,
    base,
  );
}

/**
 * [v0.0.27] POST /session/:id/read —— 标记已读（清未读，api §2.3.1）。
 * CAS unread:true→false + 后端 emit session_read_update；幂等（已 false 不发事件）。
 * 前端进入会话时显式调用（GET /session/:id 纯读无副作用，详见 api §2.3 修订说明）。
 * 失败由 caller catch 忽略（不阻塞 UI，类似 abort/cancel fire-and-forget 处理）。
 */
export async function markSessionRead(
  id: string,
  base?: string,
): Promise<{ ok: true; session: Session }> {
  return req<{ ok: true; session: Session }>(
    `/session/${encodeURIComponent(id)}/read`,
    { method: 'POST', body: '{}' },
    base,
  );
}

// ============================================================
// [v0.0.216] GET /session/:id/chrome —— 统一 chat 装配层装饰数据源
// 参考: specs/api/overall/04a-session-chrome.md（权威契约，与后端
//       services/session-chrome.ts 三类型逐字段对齐）
// ============================================================

/** chrome kind 闭合枚举（api 04a §3.1 派生规则） */
export type ChromeKind =
  | 'playground' | 'studio_member' | 'studio_group'
  | 'academy_head' | 'academy_coach' | 'academy_student';

/** 能力开关集（后端静态表唯一权威，前端只消费；api 04a §4） */
export interface SessionCapabilities {
  /** run 态订阅 + 停止按钮（前端据此给 useRunState/useSummary 过 enabled 门） */
  runState: boolean;
  /** 提问卡 + 审批卡透传 */
  hitl: boolean;
  /** 排队区 */
  enqueue: boolean;
  effortPicker: boolean;
  approvalPicker: boolean;
  /** usage 三件套 */
  usage: boolean;
  /** CompactBtn */
  compact: boolean;
  /** ClearBtn + 清空 modal */
  clear: boolean;
  /** 历史 query minimap */
  minimap: boolean;
  /** 右上悬浮菜单 */
  floatMenu: boolean;
  /** 悬浮菜单内定时任务项（false = hideCron） */
  cron: boolean;
  /** 群聊渲染策略（白名单 filter + a2a actor + 窄输入区） */
  groupRender: boolean;
}

/** GET /session/:id/chrome 响应体（各 kind 同构，字段集恒定；api 04a §2） */
export interface SessionChromeView {
  sessionId: string;
  kind: ChromeKind;
  /** derivation==='subagent' → true（只读观察；覆盖层，与 kind 正交） */
  readOnly: boolean;
  /** session.title（titled=false 时前端按语义显 defaultTitle） */
  title: string;
  titled: boolean;
  /** 身份 tag：studio="squad.name · role|群聊"；academy/playground='' */
  tag: string;
  /** session 持久 model；保留字/空 → null（picker 显默认态） */
  sessionModel: { providerId: string; modelId: string } | null;
  /** 该 kind 的默认模型（picker「默认模型」项数据源）；未配置 → null */
  defaultModel: { providerId?: string; modelId: string } | null;
  effort: 'default' | 'low' | 'high' | 'max' | null;
  approvalMode: 'normal' | 'greenlight' | null;
  /** studio: squad 全体成员投影（群聊 actor 解析用）；其他 kind 恒 [] */
  members: { id: string; name: string; role: string }[];
  /** studio_member: 对端 member id；其他 kind → null */
  memberId: string | null;
  capabilities: SessionCapabilities;
}

/** GET /session/:id/chrome —— 会话装饰数据（同构 shape；404=session 不存在） */
export async function getSessionChrome(id: string, base?: string): Promise<SessionChromeView> {
  return req<SessionChromeView>(`/session/${encodeURIComponent(id)}/chrome`, undefined, base);
}

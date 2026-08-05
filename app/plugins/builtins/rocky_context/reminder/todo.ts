/**
 * builtin rocky_context plugin — system_reminder provider: todo（v0.0.223 填壳）
 * 参考: specs/tech/agent/tools/[P1]todo_tools.md §6（todo reminder 权威）
 *       specs/tech/agent/context/[P0]system_reminder.md §3 row 5（todo provider 位）
 *       specs/prd/version_logs/v0.0.223.md §2.5（parent.main only + 标头 [todo]）
 *
 * 职责：贡献当前 session 双层 todo 进度 reminder（`[todo]` 标头）。
 *   - 数据源：ctx.todoStore.listBySession(config.sessionId) → 未结束主 item 摘要 + 步骤 N/M 进度
 *   - 角色 filter：parent.main only（readSessionType 判 leader/mate/squad + 非 subagent；
 *     subagent/forked 不产出，避免噪声——todo_tools.md §6）
 *   - MUST NOT 读 task_tools（语义已重定义为 session todo 进度，与 task reminder 完全两回事）
 *   - 空（无未结束 todo）→ 返 []
 *
 * todo vs task（prompt 差别）：todo = session 手头双层待办；task = squad 团队跨 session 工作项。
 * EP: system_reminder，priority 500。
 */
import {
  ContextImplBase,
  type ReminderCtx,
  type SystemReminder,
  type SystemReminderProvider,
  type TodoItemLike,
} from '../types';
import { readSessionType } from '../prompt/squad_reminder_shared';

/** 已结束状态（不进 reminder，todo_tools.md §2.3） */
const FINISHED = new Set(['done', 'skipped']);

/** todo reminder 标头（独立 const，todo_tools.md §6） */
const TODO_HEADER = '[todo]';

/**
 * todo provider：贡献当前 session 双层 todo 进度 reminder。
 * parent.main only（leader/mate/squad；subagent 不产出）；空 → []。
 */
export default class TodoReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  async provide(ctx: ReminderCtx): Promise<SystemReminder[]> {
    // 角色 filter：parent.main only（subagent/forked 不产出，避免噪声）
    const sessionType = readSessionType(ctx);
    if (sessionType === 'subagent') return [];
    // readSessionType 归一化：leader/mate/squad → 产出；undefined（standalone/rocky）→ 也产出
    // （playground / standalone parent.main 同样有 todo；仅 subagent 排除）

    const sid = (ctx.config as { sessionId?: unknown }).sessionId;
    if (typeof sid !== 'string' || sid.length === 0) return [];

    const store = ctx.todoStore;
    if (!store || typeof store.listBySession !== 'function') return [];

    let items: TodoItemLike[];
    try {
      const raw = await store.listBySession(sid);
      items = Array.isArray(raw) ? raw.filter(isTodoItem) : [];
    } catch {
      // 读失败降级：不贡献（不中断 reminder 链）
      return [];
    }
    // 仅未结束主 item（done/skipped 不进 reminder，todo_tools.md §6）
    const active = items.filter((it) => !FINISHED.has(it.status));
    if (active.length === 0) return [];

    const content = formatTodoReminder(active);
    if (!content) return [];
    return [{ id: 'todo', tier: 'info', content }];
  }
}

/** 鸭子类型守卫：确保 item 形状合法 */
function isTodoItem(v: unknown): v is TodoItemLike {
  if (!v || typeof v !== 'object') return false;
  const it = v as { id?: unknown; desc?: unknown; status?: unknown };
  return typeof it.id === 'string' && typeof it.desc === 'string' && typeof it.status === 'string';
}

/** 渲染 todo reminder（[todo] 标头 + 主 item + 步骤 N/M 进度） */
function formatTodoReminder(items: TodoItemLike[]): string {
  const lines = items.map((it) => {
    const status = ` [${it.status}]`;
    const steps = Array.isArray(it.steps) ? it.steps : [];
    const progress =
      steps.length > 0
        ? ` (${steps.filter((s) => FINISHED.has(s.status)).length}/${steps.length} 步骤)`
        : '';
    const memo = typeof it.memo === 'string' && it.memo ? ` · ${it.memo}` : '';
    return `- ${it.desc}${status}${progress}${memo}`;
  });
  return `${TODO_HEADER}\n当前 session 待办：\n${lines.join('\n')}`;
}

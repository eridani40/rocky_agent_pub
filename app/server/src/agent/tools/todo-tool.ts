/**
 * todo 工具（单工具，7 action）— 当前 session 手头双层待办管理。
 * 参考: specs/tech/agent/tools/[P1]todo_tools.md §3/§4（action schema + 存储路线 B 权威）
 *       specs/tech/agent/tools/task-tool.ts（action-based dispatch 范式）
 *       specs/prd/version_logs/v0.0.223.md §2.3（free-form 状态机 + session 级无角色）
 *
 * 设计（仿 task-tool action 模式，去权限/DAG/CAS）：
 *   - 单工具 `todo`，7 action：add_item / update_item / add_step / update_step / delete_item / list / cleanup_finished
 *   - run() 读 rtc.selfSessionId 索引 store（todo session 级，无 squad/角色概念）
 *   - 状态 free-form：仅 enum 校验，不校验跃迁路径（todo_tools.md §2.3）
 *   - 无 leader/mate 权限校验（session 内唯一 agent，todo_tools.md §1）
 *   - todoStore 经 rtc.sessionDeps.todoStore 注入（bootstrap 装配）
 *
 * 错误码（todo_tools.md §3）：invalid_action / invalid_status / item_not_found / step_not_found / desc_required。
 * MUST NOT 有 forbidden / illegal_transition（session 级无角色 + free-form）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import { readRuntimeContext } from './runtime-context';
import type { AgentToolRuntimeContext } from './runtime-context';
import {
  isTodoStatus,
  parseTodoSource,
  parseTodoOutput,
  type TodoItem,
  type TodoStep,
  type TodoStatus,
} from '../todo/todo-store';
import type { TodoStore } from '../todo/todo-store';
import { ReminderQueueStore } from '../system-reminder-queue';

/** 允许的 action 集（todo_tools.md §3） */
export const TODO_ACTIONS = [
  'add_item', 'update_item', 'add_step', 'update_step',
  'delete_item', 'list', 'cleanup_finished',
] as const;
type TodoAction = (typeof TODO_ACTIONS)[number];

/**
 * [v0.0.361 T4] todo 变化行写 reminder queue（仅本 session；todo 是 session 级）。
 * value = 已渲染注入行（change_plan §1.5/§2 样例 A）；key = `todo:{itemId}`。
 * 写失败 catch 吞：reminder 是 best-effort 通知，绝不阻断工具返回（§1.5 AC）。
 * fsRoot 取 rtc.sessionDeps.dataDir（DATA_DIR 绝对路径）；缺省 → no-op。
 * queue 实例 per-call new：write 临界区纯同步 JS（readFileSync+atomicWriteSync），
 * 事件循环串行，多实例并发写不交错（system-reminder-queue 设计注释）。
 */
async function writeTodoReminder(
  dataDir: string | undefined, sid: string, itemId: string, value: string,
): Promise<void> {
  try {
    if (!dataDir) return;
    await new ReminderQueueStore({ fsRoot: dataDir }).write(sid, `todo:${itemId}`, value);
  } catch { /* 写失败静默（不阻断工具返回） */ }
}

/** todoStore 鸭子类型（rtc.sessionDeps.todoStore 形状，避免窄类型耦合） */
interface TodoStoreLike {
  listBySession(sid: string): Promise<TodoItem[]>;
  upsertItem(sid: string, item: TodoItem): Promise<void>;
  removeItem(sid: string, itemId: string): Promise<boolean>;
  cleanupFinished(sid: string): Promise<number>;
  nextId(): string;
}

/** 从 rtc.sessionDeps 读 todoStore（缺省 → null，工具报 runtime error） */
function resolveTodoStore(rtc: AgentToolRuntimeContext): TodoStoreLike | null {
  const s = (rtc.sessionDeps as { todoStore?: unknown }).todoStore;
  if (!s || typeof s !== 'object') return null;
  const like = s as { listBySession?: unknown; upsertItem?: unknown; removeItem?: unknown; cleanupFinished?: unknown; nextId?: unknown };
  if (
    typeof like.listBySession !== 'function' ||
    typeof like.upsertItem !== 'function' ||
    typeof like.removeItem !== 'function' ||
    typeof like.cleanupFinished !== 'function' ||
    typeof like.nextId !== 'function'
  ) {
    return null;
  }
  return like as unknown as TodoStoreLike;
}

/** todo 工具（单例导出，registry defaultTools 引用）。 */
export const todoTool: Tool = {
  definition: {
    name: 'todo',
    description:
      '当前 session 手头双层待办管理（7 action）。todo = session 级（不跨 session）+ 主 item + 步骤，状态 free-form。' +
      'action="add_item" (desc, status?, source?, output?, memo?) — 建主 item；' +
      'action="update_item" (itemId, patch:{desc?,status?,source?,output?,memo?}) — 改主 item；' +
      'action="add_step" (itemId, desc, status?) — 加步骤；' +
      'action="update_step" (itemId, stepId, patch:{desc?,status?}) — 改步骤；' +
      'action="delete_item" (itemId) — 删主 item（含步骤）；' +
      'action="list" — 列当前 session 全部 todo；' +
      'action="cleanup_finished" — 清理 status ∈ {done, skipped} 的主 item。' +
      'status: not_started|in_progress|done|skipped|error（free-form，任意跃迁）。',
    intro: 'Manage this session\'s two-layer todo list (items + steps).',
    inputSchema: {
      type: 'object', required: ['action'],
      properties: {
        action: { type: 'string', enum: [...TODO_ACTIONS], description: 'todo action' },
        desc: { type: 'string', description: 'add_item/add_step: 一句话描述（必填）；update_item/update_step: 新描述' },
        itemId: { type: 'string', description: 'update_item/add_step/update_step/delete_item: 主 item id' },
        stepId: { type: 'string', description: 'update_step: 步骤 id' },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'done', 'skipped', 'error'], description: 'add_item/add_step 缺省 not_started；update_item/update_step 改状态（free-form，无跃迁限制）' },
        source: {
          type: 'object', description: 'add_item: 任务来源 {type:"task"|"user_message"|"agent", refId?}；update_item: 更新',
          properties: {
            type: { type: 'string', enum: ['task', 'user_message', 'agent'] },
            refId: { type: 'string' },
          },
        },
        output: {
          type: 'object', description: 'add_item: 产出目标 {type:"file"|"reply_session"|"reply_agent", refId?}；update_item: 更新',
          properties: {
            type: { type: 'string', enum: ['file', 'reply_session', 'reply_agent'] },
            refId: { type: 'string' },
          },
        },
        memo: { type: 'string', description: 'add_item/update_item: 自由文本备忘（补充说明）' },
        patch: {
          type: 'object', description: 'update_item: 覆盖字段 {desc?,status?,source?,output?,memo?}；update_step: {desc?,status?}',
          properties: {
            desc: { type: 'string' },
            status: { type: 'string', enum: ['not_started', 'in_progress', 'done', 'skipped', 'error'] },
            source: { type: 'object' },
            output: { type: 'object' },
            memo: { type: 'string' },
          },
        },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const action = String(input.action ?? '').trim();
    if (!isTodoAction(action)) return errorResult(`todo: invalid_action "${action}"`);
    let rtc: AgentToolRuntimeContext;
    try { rtc = readRuntimeContext(ctx.config); }
    catch (e) { return errorResult(`todo: ${e instanceof Error ? e.message : String(e)}`); }
    const store = resolveTodoStore(rtc);
    if (!store) return errorResult(`todo.${action}: runtime error: todoStore not injected (sessionDeps.todoStore missing)`);
    const sid = rtc.selfSessionId;
    if (!sid) return errorResult(`todo.${action}: runtime error: selfSessionId missing`);
    // [v0.0.361 T4] reminder queue 写入根（DATA_DIR；缺省 → 变化行 no-op，不影响工具主路径）
    const dataDir = (rtc.sessionDeps as { dataDir?: string } | undefined)?.dataDir;
    try {
      if (action === 'add_item') return await runAddItem(input, store, sid, dataDir);
      if (action === 'update_item') return await runUpdateItem(input, store, sid, dataDir);
      if (action === 'add_step') return await runAddStep(input, store, sid, dataDir);
      if (action === 'update_step') return await runUpdateStep(input, store, sid, dataDir);
      if (action === 'delete_item') return await runDeleteItem(input, store, sid, dataDir);
      if (action === 'cleanup_finished') return await runCleanupFinished(store, sid, dataDir);
      return await runList(store, sid);
    } catch (e) {
      return errorResult(`todo.${action}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

function isTodoAction(a: string): a is TodoAction {
  return (TODO_ACTIONS as readonly string[]).includes(a);
}

/** add_item：建主 item（steps=[]），status 缺省 not_started（todo_tools.md §3） */
async function runAddItem(input: ToolInput, store: TodoStoreLike, sid: string, dataDir?: string): Promise<ToolRunResult> {
  const desc = String(input.desc ?? '').trim();
  if (!desc) return errorResult('todo.add_item: desc_required (desc is required)');
  const status = parseStatus(input.status, 'not_started');
  if (!status) return errorResult(`todo.add_item: invalid_status "${input.status}"`);
  const now = new Date().toISOString();
  const item: TodoItem = {
    id: store.nextId(),
    desc,
    status,
    steps: [],
    createdAt: now,
    updatedAt: now,
    ...(input.source != null ? { source: parseTodoSource(input.source) } : {}),
    ...(input.output != null ? { output: parseTodoOutput(input.output) } : {}),
    ...(input.memo != null ? { memo: String(input.memo) } : {}),
  };
  await store.upsertItem(sid, item);
  await writeTodoReminder(dataDir, sid, item.id, `[todo] item「${desc}」→ ${status}`);
  return textResult(JSON.stringify({ itemId: item.id }));
}

/** update_item：改主 item 字段（partial，todo_tools.md §3） */
async function runUpdateItem(input: ToolInput, store: TodoStoreLike, sid: string, dataDir?: string): Promise<ToolRunResult> {
  const itemId = String(input.itemId ?? '').trim();
  if (!itemId) return errorResult('todo.update_item: item_not_found (itemId required)');
  const items = await store.listBySession(sid);
  const item = items.find((it) => it.id === itemId);
  if (!item) return errorResult(`todo.update_item: item_not_found (${itemId})`);
  const patch = (input.patch ?? {}) as Record<string, unknown>;
  const next: TodoItem = { ...item, steps: [...item.steps] };
  // 顶层 desc/status/source/output/memo 也可作平铺入参（add_item 风格），patch 优先
  if (typeof patch.desc === 'string' || typeof input.desc === 'string') {
    next.desc = typeof patch.desc === 'string' ? patch.desc.trim() || next.desc : String(input.desc);
  }
  if (patch.status != null || input.status != null) {
    const raw = (patch.status ?? input.status) as string;
    const st = parseStatus(raw);
    if (!st) return errorResult(`todo.update_item: invalid_status "${raw}"`);
    next.status = st;
  }
  if (patch.source != null) next.source = parseTodoSource(patch.source);
  else if (input.source != null) next.source = parseTodoSource(input.source);
  if (patch.output != null) next.output = parseTodoOutput(patch.output);
  else if (input.output != null) next.output = parseTodoOutput(input.output);
  if (typeof patch.memo === 'string') next.memo = patch.memo;
  else if (input.memo != null) next.memo = String(input.memo);
  await store.upsertItem(sid, next);
  await writeTodoReminder(dataDir, sid, itemId, `[todo] item「${next.desc}」→ ${next.status}`);
  return textResult(JSON.stringify({ itemId }));
}

/** add_step：给主 item 加步骤（status 缺省 not_started，todo_tools.md §3） */
async function runAddStep(input: ToolInput, store: TodoStoreLike, sid: string, dataDir?: string): Promise<ToolRunResult> {
  const itemId = String(input.itemId ?? '').trim();
  if (!itemId) return errorResult('todo.add_step: item_not_found (itemId required)');
  const desc = String(input.desc ?? '').trim();
  if (!desc) return errorResult('todo.add_step: desc_required (desc is required)');
  const status = parseStatus(input.status, 'not_started');
  if (!status) return errorResult(`todo.add_step: invalid_status "${input.status}"`);
  const items = await store.listBySession(sid);
  const item = items.find((it) => it.id === itemId);
  if (!item) return errorResult(`todo.add_step: item_not_found (${itemId})`);
  const step: TodoStep = { id: store.nextId(), desc, status };
  const next: TodoItem = { ...item, steps: [...item.steps, step] };
  await store.upsertItem(sid, next);
  await writeTodoReminder(dataDir, sid, item.id, `[todo] item「${item.desc}」step「${desc}」→ ${status}`);
  return textResult(JSON.stringify({ itemId, stepId: step.id }));
}

/** update_step：改步骤字段（todo_tools.md §3） */
async function runUpdateStep(input: ToolInput, store: TodoStoreLike, sid: string, dataDir?: string): Promise<ToolRunResult> {
  const itemId = String(input.itemId ?? '').trim();
  const stepId = String(input.stepId ?? '').trim();
  if (!itemId) return errorResult('todo.update_step: item_not_found (itemId required)');
  if (!stepId) return errorResult('todo.update_step: step_not_found (stepId required)');
  const items = await store.listBySession(sid);
  const item = items.find((it) => it.id === itemId);
  if (!item) return errorResult(`todo.update_step: item_not_found (${itemId})`);
  const stepIdx = item.steps.findIndex((s) => s.id === stepId);
  if (stepIdx < 0) return errorResult(`todo.update_step: step_not_found (${stepId})`);
  const patch = (input.patch ?? {}) as Record<string, unknown>;
  const step = { ...item.steps[stepIdx]! };
  if (typeof patch.desc === 'string' || typeof input.desc === 'string') {
    step.desc = typeof patch.desc === 'string' ? patch.desc.trim() || step.desc : String(input.desc);
  }
  if (patch.status != null || input.status != null) {
    const raw = (patch.status ?? input.status) as string;
    const st = parseStatus(raw);
    if (!st) return errorResult(`todo.update_step: invalid_status "${raw}"`);
    step.status = st;
  }
  const steps = [...item.steps];
  steps[stepIdx] = step;
  await store.upsertItem(sid, { ...item, steps });
  await writeTodoReminder(dataDir, sid, item.id, `[todo] item「${item.desc}」step「${step.desc}」→ ${step.status}`);
  return textResult(JSON.stringify({ itemId, stepId }));
}

/** delete_item：删主 item（含步骤，todo_tools.md §3） */
async function runDeleteItem(input: ToolInput, store: TodoStoreLike, sid: string, dataDir?: string): Promise<ToolRunResult> {
  const itemId = String(input.itemId ?? '').trim();
  if (!itemId) return errorResult('todo.delete_item: item_not_found (itemId required)');
  const items = await store.listBySession(sid);
  const desc = items.find((it) => it.id === itemId)?.desc;
  const removed = await store.removeItem(sid, itemId);
  if (!removed) return errorResult(`todo.delete_item: item_not_found (${itemId})`);
  // 删除语义 = 显式「已删除」文本行（change_plan §1.2：LLM 可感知消失；非 tombstone）
  await writeTodoReminder(dataDir, sid, itemId, `[todo] item「${desc ?? itemId}」已删除`);
  return textResult(JSON.stringify({ itemId }));
}

/** list：列当前 session 全部 todo（含已结束未清理，todo_tools.md §3） */
async function runList(store: TodoStoreLike, sid: string): Promise<ToolRunResult> {
  const items = await store.listBySession(sid);
  return textResult(JSON.stringify(items));
}

/** cleanup_finished：删所有 status ∈ {done, skipped} 的主 item（todo_tools.md §3） */
async function runCleanupFinished(store: TodoStoreLike, sid: string, dataDir?: string): Promise<ToolRunResult> {
  // 先读待清理明细（store 返 count，desc 需在删除前捕获）
  const removedItems = (await store.listBySession(sid)).filter((it) => it.status === 'done' || it.status === 'skipped');
  const removed = await store.cleanupFinished(sid);
  for (const it of removedItems) {
    await writeTodoReminder(dataDir, sid, it.id, `[todo] item「${it.desc}」已删除`);
  }
  return textResult(JSON.stringify({ removed }));
}

/** 解析 status 入参（缺省返 fallback；非合法 enum 返 null） */
function parseStatus(raw: unknown, fallback?: TodoStatus): TodoStatus | null {
  if (raw == null || raw === '') return fallback ?? null;
  return typeof raw === 'string' && isTodoStatus(raw) ? raw : null;
}

// re-export TodoStore 类型便于外部窄化（registry/handler 注入点）
export type { TodoStore };

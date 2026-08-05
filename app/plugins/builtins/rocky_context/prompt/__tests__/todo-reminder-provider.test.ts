/**
 * TodoReminderProvider UT — 填壳 + parent.main only + [todo] 标头 + 不读 task_tools。
 * 参考: specs/tech/agent/tools/[P1]todo_tools.md §6（todo reminder 权威）
 *       states/v0.0.223/verify/test-plan.md §3（UT 范围）
 *
 * 覆盖：
 *   - 填壳：读 ctx.todoStore.listBySession → 未结束主 item 摘要
 *   - parent.main only（subagent 不产出；leader/mate/squad/standalone 产出）
 *   - 标头 `[todo]`（独立 const，非 [squad:todo]）
 *   - 已结束 item（done/skipped）不进 reminder
 *   - 步骤 N/M 进度
 *   - 空 → []
 *   - todoStore 未注入 → []
 *   - 不读 task_tools（语义：从 ctx.todoStore 读，非 squadContext）
 */
import { describe, it, expect } from 'vitest';
import TodoReminderProvider from '../../reminder/todo';
import type { TodoItemLike } from '../../types';

/** 构造 ctx（含 todoStore + kind 控制 sessionType） */
function mkCtx(over: {
  sessionType?: string;
  sessionId?: string;
  todoStore?: { listBySession(sid: string): Promise<unknown[]> | unknown[] } | null;
}): { config: Record<string, unknown>; todoStore?: unknown } {
  const isSubagent = over.sessionType === 'subagent';
  const isStudio = ['leader', 'mate', 'squad'].includes(over.sessionType ?? '');
  const kind: Record<string, unknown> = {
    role: isSubagent ? 'rocky' : (over.sessionType ?? 'rocky'),
    isSubagent,
    isStudio,
  };
  const ctx: { config: Record<string, unknown>; todoStore?: unknown } = {
    config: {
      modelId: 'm',
      kind,
      sessionId: over.sessionId ?? 'SESS-1',
    },
  };
  if (over.todoStore !== undefined && over.todoStore !== null) ctx.todoStore = over.todoStore;
  return ctx;
}

/** mock todoStore（listBySession 返固定 items） */
function mkTodoStore(items: TodoItemLike[]): { listBySession(sid: string): Promise<TodoItemLike[]> } {
  return {
    listBySession: async () => items,
  };
}

describe('TodoReminderProvider — 填壳', () => {
  const items: TodoItemLike[] = [
    { id: 'TI-1', desc: '写文档', status: 'in_progress', steps: [{ id: 'S-1', desc: 's1', status: 'done' }, { id: 'S-2', desc: 's2', status: 'not_started' }] },
    { id: 'TI-2', desc: '过 review', status: 'not_started', steps: [] },
  ];

  it('leader → 产出 [todo] reminder（未结束主 item + 步骤进度）', async () => {
    const ctx = mkCtx({ sessionType: 'leader', todoStore: mkTodoStore(items) });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('todo');
    expect(out[0]!.tier).toBe('info');
    expect(out[0]!.content).toContain('[todo]');
    expect(out[0]!.content).toContain('写文档');
    expect(out[0]!.content).toContain('1/2 步骤');
    expect(out[0]!.content).toContain('过 review');
  });

  it('已结束 item（done/skipped）不进 reminder', async () => {
    const ctx = mkCtx({
      sessionType: 'leader',
      todoStore: mkTodoStore([
        { id: 'TI-1', desc: '进行中', status: 'in_progress', steps: [] },
        { id: 'TI-2', desc: '已完成', status: 'done', steps: [] },
        { id: 'TI-3', desc: '已跳过', status: 'skipped', steps: [] },
      ]),
    });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('进行中');
    expect(out[0]!.content).not.toContain('已完成');
    expect(out[0]!.content).not.toContain('已跳过');
  });

  it('标头 [todo] 独立 const（非 [squad:todo]）', async () => {
    const ctx = mkCtx({ sessionType: 'mate', todoStore: mkTodoStore(items) });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('[todo]');
    expect(out[0]!.content).not.toContain('[squad:todo]');
  });
});

describe('TodoReminderProvider — 角色 filter（parent.main only）', () => {
  const items: TodoItemLike[] = [{ id: 'TI-1', desc: 'x', status: 'in_progress', steps: [] }];

  it('subagent → []（不产出，避免噪声）', async () => {
    const ctx = mkCtx({ sessionType: 'subagent', todoStore: mkTodoStore(items) });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('leader / mate / squad / standalone 均产出（parent.main）', async () => {
    for (const t of ['leader', 'mate', 'squad', undefined]) {
      const ctx = mkCtx({ sessionType: t, todoStore: mkTodoStore(items) });
      const out = await new TodoReminderProvider('todo', {}).provide(ctx);
      expect(out).toHaveLength(1);
    }
  });
});

describe('TodoReminderProvider — 边界', () => {
  it('空 todo（无未结束 item）→ []', async () => {
    const ctx = mkCtx({ sessionType: 'leader', todoStore: mkTodoStore([]) });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('全已结束 → []', async () => {
    const ctx = mkCtx({
      sessionType: 'leader',
      todoStore: mkTodoStore([{ id: 'TI-1', desc: 'x', status: 'done', steps: [] }]),
    });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('todoStore 未注入 → []（向后兼容）', async () => {
    const ctx = mkCtx({ sessionType: 'leader', todoStore: null });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('sessionId 缺 → []', async () => {
    const ctx = mkCtx({ sessionType: 'leader', sessionId: '', todoStore: mkTodoStore([{ id: 'TI-1', desc: 'x', status: 'in_progress', steps: [] }]) });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('todoStore.listBySession 抛错 → []（降级不中断 reminder 链）', async () => {
    const ctx = mkCtx({
      sessionType: 'leader',
      todoStore: { listBySession: async () => { throw new Error('read fail'); } },
    });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('memo 注入到 reminder（自由文本补充说明）', async () => {
    const ctx = mkCtx({
      sessionType: 'leader',
      todoStore: mkTodoStore([{ id: 'TI-1', desc: '写文档', status: 'in_progress', steps: [], memo: '参考 v2 版本' }]),
    });
    const out = await new TodoReminderProvider('todo', {}).provide(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('参考 v2 版本');
  });
});

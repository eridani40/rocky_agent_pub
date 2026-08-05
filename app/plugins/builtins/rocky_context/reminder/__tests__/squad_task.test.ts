/**
 * SquadTaskReminderProvider UT — squad_task reminder provider 角色过滤 + 产出格式.
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md §4（squad_task provider）
 *       specs/tech/squad/[P1]panorama_builtin.md §5（reminder contract）
 *
 * 覆盖：leader 全队 / mate owner∪依赖 / SquadChat 返空 / archived 不入 / waiting 显依赖提示 / 空态.
 * Mock：squadContext.listActiveTasks（不真读盘；listMembers 给 owner_name 软解析）.
 */
import { describe, it, expect } from 'vitest';
import SquadTaskReminderProvider from '../squad_task';
import type { TaskLike, SquadContextService } from '../../types';

function mkTask(partial: Partial<TaskLike> & Pick<TaskLike, 'id' | 'title'>): TaskLike {
  return {
    owner: null,
    dependencies: [],
    status: 'todo',
    archived: false,
    ...partial,
  };
}

/** 构造 mock squadContext（listActiveTasks / listMembers 可定制） */
function mkCtx(opts: {
  sessionType?: string;
  squadId?: string;
  memberId?: string;
  squadContext?: Partial<SquadContextService>;
}) {
  const sessionType = opts.sessionType;
  const kind = sessionType === undefined
    ? undefined
    : sessionType === 'subagent'
      ? { role: 'rocky', isSubagent: true }
      : { role: sessionType };
  return {
    config: {
      squadId: opts.squadId ?? 'sq-1',
      memberId: opts.memberId,
      kind,
    },
    squadContext: opts.squadContext as SquadContextService | undefined,
  };
}

describe('SquadTaskReminderProvider — 角色过滤', () => {
  it('leader → 全队活跃 task', async () => {
    const tasks = [
      mkTask({ id: 'task-0001', title: 'A', owner: 'm1', status: 'todo' }),
      mkTask({ id: 'task-0002', title: 'B', owner: 'm2', status: 'in_progress' }),
    ];
    const ctx = mkCtx({
      sessionType: 'leader',
      squadContext: {
        listActiveTasks: async () => tasks,
        listMembers: async () => [
          { id: 'm1', name: 'Alice' },
          { id: 'm2', name: 'Bob' },
        ],
      },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('squad_task');
    expect(out[0]!.tier).toBe('info');
    const content = out[0]!.content;
    expect(content).toContain('leader 视角');
    expect(content).toContain('A（Alice，未开始）');
    expect(content).toContain('B（Bob，进行中）');
  });

  it('mate → owner=self ∪ 我 block 别人（依赖含 owner==self 的 task）', async () => {
    // mate=m1：own task-0001；task-0003 依赖 task-0001（我 block 别人）→ 也应见
    const tasks = [
      mkTask({ id: 'task-0001', title: 'Mine', owner: 'm1', status: 'todo' }),
      mkTask({ id: 'task-0002', title: 'Other', owner: 'm2', status: 'todo' }),
      mkTask({ id: 'task-0003', title: 'BlockedByMe', owner: 'm2', status: 'waiting', dependencies: ['task-0001'] }),
    ];
    const ctx = mkCtx({
      sessionType: 'mate',
      memberId: 'm1',
      squadContext: {
        listActiveTasks: async (_sid, viewer) => {
          // 模拟 service 层 owner∪依赖过滤
          if (viewer === null) return tasks;
          const myIds = new Set(tasks.filter((t) => t.owner === viewer).map((t) => t.id));
          return tasks.filter((t) => t.owner === viewer || t.dependencies.some((d) => myIds.has(d)));
        },
        listMembers: async () => [{ id: 'm1', name: 'Alice' }, { id: 'm2', name: 'Bob' }],
      },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    const content = out[0]!.content;
    expect(content).toContain('mate 视角');
    expect(content).toContain('Mine（Alice，未开始）');
    expect(content).toContain('BlockedByMe（Bob，等待中）');
    expect(content).not.toContain('- Other');
  });

  it('SquadChat（role=squad）→ 不产出（返空）', async () => {
    const ctx = mkCtx({
      sessionType: 'squad',
      squadContext: { listActiveTasks: async () => [] },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('subagent → 不产出（返空）', async () => {
    const ctx = mkCtx({
      sessionType: 'subagent',
      squadContext: { listActiveTasks: async () => [] },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('standalone（无 kind）→ 不产出', async () => {
    const ctx = { config: { squadId: 'sq-1' }, squadContext: undefined };
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out).toEqual([]);
  });

  it('无 squadContext → 返空（不抛错）', async () => {
    const ctx = mkCtx({ sessionType: 'leader', squadContext: undefined });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out).toEqual([]);
  });
});

describe('SquadTaskReminderProvider — 产出格式', () => {
  it('waiting 显「（等 N 项）」（N=未 done 依赖数）', async () => {
    const tasks = [
      mkTask({ id: 'task-0001', title: 'Waiting', status: 'waiting', dependencies: ['task-0002', 'task-0003'] }),
      mkTask({ id: 'task-0002', title: 'Done', status: 'done' }),
      mkTask({ id: 'task-0003', title: 'Todo', status: 'todo' }),
    ];
    const ctx = mkCtx({
      sessionType: 'leader',
      squadContext: {
        listActiveTasks: async () => tasks,
        listMembers: async () => [],
      },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    // task-0001 waiting，依赖 task-0002(done) + task-0003(todo) → 等 1 项
    expect(out[0]!.content).toContain('Waiting（未指派，等待中）（等 1 项）');
  });

  it('owner=null 显「未指派」', async () => {
    const ctx = mkCtx({
      sessionType: 'leader',
      squadContext: {
        listActiveTasks: async () => [mkTask({ id: 'task-0001', title: 'No owner', owner: null })],
        listMembers: async () => [],
      },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out[0]!.content).toContain('No owner（未指派');
  });

  it('无活跃 task → 显空态「当前无待办任务」', async () => {
    const ctx = mkCtx({
      sessionType: 'leader',
      squadContext: {
        listActiveTasks: async () => [],
        listMembers: async () => [],
      },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('当前无待办任务');
  });

  it('archived 不入（service 层已过滤；provider 不二次过滤但确认契约）', async () => {
    // service 层契约：listActiveTasks 永远不返 archived=true；provider 直接消费
    const ctx = mkCtx({
      sessionType: 'leader',
      squadContext: {
        listActiveTasks: async () => [
          mkTask({ id: 'task-0001', title: 'Active', status: 'todo', archived: false }),
        ],
        listMembers: async () => [],
      },
    });
    const out = await new SquadTaskReminderProvider('squad_task', {}).provide(ctx);
    expect(out[0]!.content).toContain('Active');
    // archived=true 的 task 不会出现在 service 返回里（service 层已过滤）
  });
});

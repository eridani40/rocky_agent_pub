/**
 * rocky_context plugin system_reminder provider 单测
 * 参考: specs/tech/agent/context/[P0]system_reminder.md §3
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.6
 *
 * 覆盖：
 *   - tool_error [D1.1] no-op → 空贡献
 *   - todo [D1.1] no-op → 空贡献
 *
 * [v0.0.361] env / workspace / squad_workspace 三静态 provider 退役（逻辑平移进
 * prompt/session_states.ts mapper——输出等价断言见 prompt/__tests__/session-states-mapper.test.ts）。
 * [v0.0.361 T3] time provider 退役（时间固定段平移进 injector 内部，双模式恒出——
 * 时间格式断言见 ingest-handlers.test.ts system_reminder_injector describe）。
 */
import { describe, it, expect } from 'vitest';
import ToolErrorReminderProvider from '../reminder/tool_error';
import TodoReminderProvider from '../reminder/todo';

function mkCtx(overrides: Record<string, unknown> = {}): { config: Record<string, unknown> } {
  return { config: { modelId: 'test-model', ...overrides } };
}

describe('system_reminder providers', () => {
  it('tool_error [D1.1] no-op → 空贡献', () => {
    const out = new ToolErrorReminderProvider('tool_error', {}).provide(mkCtx());
    expect(out).toEqual([]);
  });

  it('todo v0.0.223 填壳：无 todoStore 注入 → 空贡献（向后兼容；有 store 详见 todo-reminder-provider.test）', async () => {
    const out = await new TodoReminderProvider('todo', {}).provide(mkCtx());
    expect(out).toEqual([]);
  });
});

/**
 * academy-training-task-shared 单测 — mapEngineError 错误码映射（纯函数）
 * 参考: specs/api/overall/18-academy.md §7（错误码总览）
 *
 * v0.0.221：nothing_to_adopt 删除（acceptTask 删）；新增 task_at_maxturns（resume 硬门）。
 */
import { describe, it, expect } from 'vitest';
import { mapEngineError } from '../academy-training-task-shared';

describe('mapEngineError — engine error → HTTP 错误码（spec §7）', () => {
  const bodyOf = async (r: Response) => ({ status: r.status, ...(await r.json()) as object }) as
    { status: number; error: string; detail: string };

  it('状态机不允许 action → 409 invalid_task_state', async () => {
    const r = await bodyOf(mapEngineError(new Error('resumeTask: task t1 status running 不允许 resume')));
    expect(r).toMatchObject({ status: 409, error: 'invalid_task_state' });
  });

  it('task_at_maxturns（resume 硬门到顶）→ 409 task_at_maxturns + 指引 update-task', async () => {
    const r = await bodyOf(mapEngineError(
      new Error('resumeTask: task t1 task_at_maxturns（maxTurns 到顶，须先 update_task 调大 maxTurns 才能续训）'),
    ));
    expect(r).toMatchObject({ status: 409, error: 'task_at_maxturns' });
    expect(r.detail).toMatch(/update-task|update_task|调大 maxTurns/);
  });

  it('lock 冲突 → 409 task_already_running；未识别 → 500 internal_error', async () => {
    expect((await bodyOf(mapEngineError(new Error('reviseCandidate: task t1 已有 in-flight 推进（lock 冲突）')))))
      .toMatchObject({ status: 409, error: 'task_already_running' });
    expect((await bodyOf(mapEngineError(new Error('boom')))))
      .toMatchObject({ status: 500, error: 'internal_error' });
  });
});

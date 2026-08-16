/**
 * todoTool UT — 7 action dispatch + 5 态 free-form + selfSessionId 索引。
 * 参考: specs/tech/agent/tools/[P1]todo_tools.md §3（action schema + 错误码权威）
 *       states/v0.0.223/verify/test-plan.md §3（UT 范围）
 *
 * 覆盖：
 *   - 7 action 链路：add_item / update_item / add_step / update_step / delete_item / list / cleanup_finished
 *   - 5 态 free-form（任意跃迁不报 illegal_transition，仅 enum 校验 → invalid_status）
 *   - selfSessionId 索引（不同 session 隔离）
 *   - 错误码：invalid_action / invalid_status / item_not_found / step_not_found / desc_required
 *   - runtime error：todoStore 未注入 / selfSessionId 缺
 *
 * 白盒：真实 TodoStore（tmpdir）+ mock rtc（sessionDeps.todoStore）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { todoTool, TODO_ACTIONS } from '../todo-tool';
import { TodoStore } from '../../todo/todo-store';
import type { AgentToolRuntimeContext } from '../runtime-context';
import type { ToolInput, ToolRunResult, ToolCtx } from '../../../tools/types';

let tmpRoot: string;
let store: TodoStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-tool-ut-'));
  store = new TodoStore({ fsRoot: tmpRoot });
});
afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/** 构造 rtc（sessionDeps.todoStore 注入 + selfSessionId） */
function makeRtc(over: { sessionId?: string; todoStore?: TodoStore | null; dataDir?: string | null } = {}): AgentToolRuntimeContext {
  return {
    parentSessionId: 'PARENT-1',
    parentRunId: 'r',
    parentType: undefined,
    parentName: 'p',
    parentScope: undefined,
    selfSessionId: over.sessionId ?? 'SESS-1',
    selfType: 'leader',
    selfName: 'self',
    agentManager: {} as never,
    store: {} as never,
    sessionDeps: {
      todoStore: over.todoStore === undefined ? store : over.todoStore,
      // [v0.0.361 T4] reminder queue 写入根（null → 模拟缺省 no-op 路径）
      ...(over.dataDir === null ? {} : { dataDir: over.dataDir ?? tmpRoot }),
    } as never,
  };
}

/** 调工具 run → { text, isError, parsed } */
async function run(
  rtc: AgentToolRuntimeContext,
  inputFields: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; parsed: unknown }> {
  const ctx = { config: { agentToolContext: rtc } } as unknown as ToolCtx;
  const res: ToolRunResult = await todoTool.run(inputFields as unknown as ToolInput, ctx);
  const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = blocks.map((b) => b?.text ?? '').join('');
  let parsed: unknown = undefined;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { text, isError: res.isError, parsed };
}

// ============================================================
// TODO_ACTIONS 常量
// ============================================================
describe('TODO_ACTIONS', () => {
  it('含 7 个 action（add_item/update_item/add_step/update_step/delete_item/list/cleanup_finished）', () => {
    expect(TODO_ACTIONS).toEqual([
      'add_item', 'update_item', 'add_step', 'update_step',
      'delete_item', 'list', 'cleanup_finished',
    ]);
  });
});

// ============================================================
// add_item
// ============================================================
describe('todo.add_item', () => {
  it('建主 item（desc + status 缺省 not_started + steps=[]）', async () => {
    const rtc = makeRtc();
    const { isError, parsed } = await run(rtc, {
      action: 'add_item', desc: '写文档',
      source: { type: 'task', refId: 'T-1' },
      output: { type: 'file', refId: '/tmp/x.md' },
      memo: '备忘',
    });
    expect(isError).toBe(false);
    const itemId = (parsed as { itemId: string }).itemId;
    expect(itemId).toBeTruthy();
    const items = await store.listBySession('SESS-1');
    expect(items).toHaveLength(1);
    expect(items[0]!.desc).toBe('写文档');
    expect(items[0]!.status).toBe('not_started');
    expect(items[0]!.steps).toEqual([]);
    expect(items[0]!.source).toEqual({ type: 'task', refId: 'T-1' });
    expect(items[0]!.output).toEqual({ type: 'file', refId: '/tmp/x.md' });
    expect(items[0]!.memo).toBe('备忘');
  });

  it('缺 desc → desc_required', async () => {
    const rtc = makeRtc();
    const { isError, text } = await run(rtc, { action: 'add_item' });
    expect(isError).toBe(true);
    expect(text).toMatch(/desc_required/);
  });

  it('非法 status → invalid_status', async () => {
    const rtc = makeRtc();
    const { isError, text } = await run(rtc, { action: 'add_item', desc: 'x', status: 'finished' });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid_status/);
  });

  it('status 缺省 not_started；显式传 5 态均 OK（free-form）', async () => {
    const rtc = makeRtc();
    for (const s of ['not_started', 'in_progress', 'done', 'skipped', 'error']) {
      const { isError, parsed } = await run(rtc, { action: 'add_item', desc: `item-${s}`, status: s });
      expect(isError).toBe(false);
      expect((parsed as { itemId: string }).itemId).toBeTruthy();
    }
  });
});

// ============================================================
// update_item
// ============================================================
describe('todo.update_item', () => {
  it('patch 改 desc/status/memo（partial）', async () => {
    const rtc = makeRtc();
    const { parsed } = await run(rtc, { action: 'add_item', desc: '原', status: 'not_started' });
    const itemId = (parsed as { itemId: string }).itemId;
    const { isError } = await run(rtc, {
      action: 'update_item', itemId, patch: { desc: '新', status: 'in_progress', memo: 'm' },
    });
    expect(isError).toBe(false);
    const items = await store.listBySession('SESS-1');
    expect(items[0]!.desc).toBe('新');
    expect(items[0]!.status).toBe('in_progress');
    expect(items[0]!.memo).toBe('m');
  });

  it('free-form 跃迁：done → not_started（不报 illegal_transition）', async () => {
    const rtc = makeRtc();
    const { parsed } = await run(rtc, { action: 'add_item', desc: 'x', status: 'done' });
    const itemId = (parsed as { itemId: string }).itemId;
    const { isError, text } = await run(rtc, { action: 'update_item', itemId, patch: { status: 'not_started' } });
    expect(isError).toBe(false);
    expect(text).not.toMatch(/illegal_transition/);
    const items = await store.listBySession('SESS-1');
    expect(items[0]!.status).toBe('not_started');
  });

  it('非法 patch.status → invalid_status', async () => {
    const rtc = makeRtc();
    const { parsed } = await run(rtc, { action: 'add_item', desc: 'x' });
    const itemId = (parsed as { itemId: string }).itemId;
    const { isError, text } = await run(rtc, { action: 'update_item', itemId, patch: { status: 'bogus' } });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid_status/);
  });

  it('itemId 不存在 → item_not_found', async () => {
    const rtc = makeRtc();
    const { isError, text } = await run(rtc, { action: 'update_item', itemId: 'GHOST', patch: { desc: 'x' } });
    expect(isError).toBe(true);
    expect(text).toMatch(/item_not_found/);
  });
});

// ============================================================
// add_step / update_step
// ============================================================
describe('todo.add_step / update_step', () => {
  it('add_step 加步骤（status 缺省 not_started）', async () => {
    const rtc = makeRtc();
    const { parsed: add } = await run(rtc, { action: 'add_item', desc: '主' });
    const itemId = (add as { itemId: string }).itemId;
    const { isError, parsed } = await run(rtc, { action: 'add_step', itemId, desc: '步骤1' });
    expect(isError).toBe(false);
    const stepId = (parsed as { stepId: string }).stepId;
    expect(stepId).toBeTruthy();
    const items = await store.listBySession('SESS-1');
    expect(items[0]!.steps).toHaveLength(1);
    expect(items[0]!.steps[0]!.status).toBe('not_started');
  });

  it('update_step 改步骤 desc/status', async () => {
    const rtc = makeRtc();
    const { parsed: add } = await run(rtc, { action: 'add_item', desc: '主' });
    const itemId = (add as { itemId: string }).itemId;
    const { parsed: addStep } = await run(rtc, { action: 'add_step', itemId, desc: '步骤1' });
    const stepId = (addStep as { stepId: string }).stepId;
    const { isError } = await run(rtc, { action: 'update_step', itemId, stepId, patch: { status: 'done' } });
    expect(isError).toBe(false);
    const items = await store.listBySession('SESS-1');
    expect(items[0]!.steps[0]!.status).toBe('done');
  });

  it('add_step 缺 desc → desc_required', async () => {
    const rtc = makeRtc();
    const { parsed: add } = await run(rtc, { action: 'add_item', desc: '主' });
    const itemId = (add as { itemId: string }).itemId;
    const { isError, text } = await run(rtc, { action: 'add_step', itemId });
    expect(isError).toBe(true);
    expect(text).toMatch(/desc_required/);
  });

  it('update_step stepId 不存在 → step_not_found', async () => {
    const rtc = makeRtc();
    const { parsed: add } = await run(rtc, { action: 'add_item', desc: '主' });
    const itemId = (add as { itemId: string }).itemId;
    const { isError, text } = await run(rtc, { action: 'update_step', itemId, stepId: 'GHOST', patch: { status: 'done' } });
    expect(isError).toBe(true);
    expect(text).toMatch(/step_not_found/);
  });
});

// ============================================================
// delete_item / list / cleanup_finished
// ============================================================
describe('todo.delete_item / list / cleanup_finished', () => {
  it('delete_item 删主 item（含步骤）', async () => {
    const rtc = makeRtc();
    const { parsed: add } = await run(rtc, { action: 'add_item', desc: '主' });
    const itemId = (add as { itemId: string }).itemId;
    await run(rtc, { action: 'add_step', itemId, desc: '步骤' });
    const { isError } = await run(rtc, { action: 'delete_item', itemId });
    expect(isError).toBe(false);
    expect(await store.listBySession('SESS-1')).toHaveLength(0);
  });

  it('list 列当前 session 全部（含已结束未清理）', async () => {
    const rtc = makeRtc();
    await run(rtc, { action: 'add_item', desc: 'a', status: 'in_progress' });
    await run(rtc, { action: 'add_item', desc: 'b', status: 'done' });
    const { isError, parsed } = await run(rtc, { action: 'list' });
    expect(isError).toBe(false);
    expect(parsed as unknown[]).toHaveLength(2);
  });

  it('cleanup_finished 清掉 done/skipped（返 removed 数）', async () => {
    const rtc = makeRtc();
    await run(rtc, { action: 'add_item', desc: 'a', status: 'in_progress' });
    await run(rtc, { action: 'add_item', desc: 'b', status: 'done' });
    await run(rtc, { action: 'add_item', desc: 'c', status: 'skipped' });
    const { isError, parsed } = await run(rtc, { action: 'cleanup_finished' });
    expect(isError).toBe(false);
    expect((parsed as { removed: number }).removed).toBe(2);
    const { parsed: list } = await run(rtc, { action: 'list' });
    expect(list as unknown[]).toHaveLength(1);
  });
});

// ============================================================
// selfSessionId 索引 + 错误码 + runtime error
// ============================================================
describe('todo selfSessionId 索引 + 错误码', () => {
  it('不同 session 隔离（selfSessionId 索引）', async () => {
    await run(makeRtc({ sessionId: 'SESS-A' }), { action: 'add_item', desc: 'a1' });
    await run(makeRtc({ sessionId: 'SESS-B' }), { action: 'add_item', desc: 'b1' });
    const { parsed: listA } = await run(makeRtc({ sessionId: 'SESS-A' }), { action: 'list' });
    const { parsed: listB } = await run(makeRtc({ sessionId: 'SESS-B' }), { action: 'list' });
    expect((listA as Array<{ desc: string }>)[0]!.desc).toBe('a1');
    expect((listB as Array<{ desc: string }>)[0]!.desc).toBe('b1');
  });

  it('invalid_action（非合法 action）', async () => {
    const rtc = makeRtc();
    const { isError, text } = await run(rtc, { action: 'frobnicate' });
    expect(isError).toBe(true);
    expect(text).toMatch(/invalid_action/);
  });

  it('todoStore 未注入 → runtime error', async () => {
    const rtc = makeRtc({ todoStore: null });
    const { isError, text } = await run(rtc, { action: 'list' });
    expect(isError).toBe(true);
    expect(text).toMatch(/todoStore not injected/);
  });
});

// ============================================================
// [v0.0.361 T4] reminder queue 写入（change_plan §1.5/§2 样例 A）
// ============================================================
describe('todo reminder queue 写入', () => {
  /** 读 reminder_queue.json entries */
  function readQueue(sid: string): Array<{ key: string; value: string }> {
    const p = path.join(tmpRoot, 'sessions', sid, 'reminder_queue.json');
    if (!fs.existsSync(p)) return [];
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { entries: Array<{ key: string; value: string }> }).entries;
  }

  it('add_item → todo:{itemId} 渲染行 `[todo] item「X」→ {status}`（仅本 session）', async () => {
    const rtc = makeRtc();
    const { parsed } = await run(rtc, { action: 'add_item', desc: '落四件套' });
    const itemId = (parsed as { itemId: string }).itemId;
    expect(readQueue('SESS-1').map((e) => [e.key, e.value])).toEqual([
      [`todo:${itemId}`, '[todo] item「落四件套」→ not_started'],
    ]);
    expect(readQueue('OTHER')).toEqual([]);
  });

  it('update_item → 同 key 删旧追新（状态变化覆盖）', async () => {
    const rtc = makeRtc();
    const { parsed } = await run(rtc, { action: 'add_item', desc: 'X' });
    const itemId = (parsed as { itemId: string }).itemId;
    await run(rtc, { action: 'update_item', itemId, patch: { status: 'in_progress' } });
    const q = readQueue('SESS-1');
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ key: `todo:${itemId}`, value: '[todo] item「X」→ in_progress' });
  });

  it('add_step / update_step → item + step 双层渲染行', async () => {
    const rtc = makeRtc();
    const { parsed } = await run(rtc, { action: 'add_item', desc: '落四件套' });
    const itemId = (parsed as { itemId: string }).itemId;
    const { parsed: addStep } = await run(rtc, { action: 'add_step', itemId, desc: '写 change_plan' });
    const stepId = (addStep as { stepId: string }).stepId;
    await run(rtc, { action: 'update_step', itemId, stepId, patch: { status: 'done' } });
    const q = readQueue('SESS-1');
    // add_item + add_step + update_step 三条（不同 key 不去重：step 行 key 也是 todo:{itemId}，同 key 覆盖）
    expect(q.map((e) => e.key)).toEqual([`todo:${itemId}`]);
    expect(q[0]!.value).toBe('[todo] item「落四件套」step「写 change_plan」→ done');
  });

  it('delete_item → 「已删除」行（§1.2 删除语义：显式文本非 tombstone）', async () => {
    const rtc = makeRtc();
    const { parsed } = await run(rtc, { action: 'add_item', desc: '旧任务' });
    const itemId = (parsed as { itemId: string }).itemId;
    await run(rtc, { action: 'delete_item', itemId });
    const q = readQueue('SESS-1');
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ key: `todo:${itemId}`, value: '[todo] item「旧任务」已删除' });
  });

  it('cleanup_finished → 每个 done/skipped item 各一条「已删除」行', async () => {
    const rtc = makeRtc();
    await run(rtc, { action: 'add_item', desc: 'A' });
    await run(rtc, { action: 'add_item', desc: 'B' });
    await run(rtc, { action: 'add_item', desc: 'C' });
    const list = (await run(rtc, { action: 'list' })).parsed as Array<{ id: string; desc: string }>;
    for (const it of list) {
      if (it.desc !== 'C') await run(rtc, { action: 'update_item', itemId: it.id, patch: { status: 'done' } });
    }
    await run(rtc, { action: 'cleanup_finished' });
    const q = readQueue('SESS-1');
    const deleted = q.map((e) => e.value);
    expect(deleted).toContain('[todo] item「A」已删除');
    expect(deleted).toContain('[todo] item「B」已删除');
    expect(deleted).not.toContain(expect.stringContaining('item「C」已删除') as unknown as string);
  });

  it('dataDir 缺省 → 变化行 no-op（工具主路径不受影响）', async () => {
    const rtc = makeRtc({ dataDir: null });
    const { isError, parsed } = await run(rtc, { action: 'add_item', desc: 'X' });
    expect(isError).toBe(false);
    expect((parsed as { itemId: string }).itemId).toBeTruthy();
    expect(readQueue('SESS-1')).toEqual([]);
  });
});

/**
 * session-cascade 单测（白盒）—— v0.0.192 删除链路级联删 + 清调度
 * 参考: specs/tech/version_logs/v0.0.192.delete_cleanup/change_plan.md
 *       specs/prd/version_logs/v0.0.192.delete_cleanup.md §3.2（任意深度级联）
 *
 * 覆盖：
 *   - collectDescendants BFS 多层（A→B→C）/ 环防御 / 无 children 返空
 *   - listSessionsBySquad 过滤（含 spawn child 带 squadId、排除其他 squad）
 *   - 级联删每 descendant + parent 各触发 onSessionDestroyed（堵潜伏调度，N3）
 *   - 时序约束：删 parent 前快照（删后再查 childrenIndex 已清 → 漏子孙）
 *
 * 真实落盘：fs engine + 临时 DATA_DIR（os.tmpdir + mkdtempSync）+ afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../session-store';
import { ChildrenIndex } from '../session-children-index';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-cascade-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 创建 session（带可选 parent/squad），返回 sessionId */
async function mkSession(opts: {
  id?: string;
  parentSessionId?: string;
  squadId?: string;
} = {}): Promise<string> {
  const id = opts.id ?? ulid();
  await store.createSession({
    id,
    title: id,
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
    ...(opts.squadId !== undefined ? { squadId: opts.squadId } : {}),
  });
  return id;
}

describe('collectDescendants — BFS 任意深度收集', () => {
  it('多层级联：A→B→C + A→D，删 A 收集全部子孙 [B,C,D]', async () => {
    const a = await mkSession();
    const b = await mkSession({ parentSessionId: a });
    const c = await mkSession({ parentSessionId: b });
    const d = await mkSession({ parentSessionId: a });

    const out = await store.collectDescendants(a);
    expect(out.sort()).toEqual([b, c, d].sort());
  });

  it('环防御：A→B→A 环不死循环（visited Set 去重）', () => {
    const idx = new ChildrenIndex();
    idx.build([
      { id: 'B', parentSessionId: 'A' },
      { id: 'A', parentSessionId: 'B' }, // 环
    ]);
    // A 起 → B 入列 → B 的 child 是 A（已 visited 跳过）→ 终止，不死循环
    const out = idx.collectDescendants('A');
    expect(out).toEqual(['B']);
  });

  it('无 children 返 []；索引未建也返 []', async () => {
    const a = await mkSession();
    const out = await store.collectDescendants(a);
    expect(out).toEqual([]);
  });

  it('不含 parent 自身', async () => {
    const a = await mkSession();
    const b = await mkSession({ parentSessionId: a });
    const out = await store.collectDescendants(a);
    expect(out).not.toContain(a);
    expect(out).toEqual([b]);
  });
});

describe('listSessionsBySquad — 按 squadId 平铺查全量', () => {
  it('返回 squadId 命中的全部 session（含 spawn child），排除其他 squad / playground', async () => {
    const sid = ulid();
    const mainId = await mkSession({ squadId: sid });
    // spawn child 带 squadId（agent-tool.ts:318 行为）
    const childId = await mkSession({ squadId: sid, parentSessionId: mainId });
    await mkSession({ squadId: ulid() }); // 其他 squad
    await mkSession(); // playground 无 squad

    const out = await store.listSessionsBySquad(sid);
    expect(out.length).toBe(2);
    expect(out).toContain(mainId);
    expect(out).toContain(childId);
  });

  it('squadId 无命中返 []', async () => {
    await mkSession({ squadId: ulid() });
    const out = await store.listSessionsBySquad('NOPE');
    expect(out).toEqual([]);
  });
});

describe('级联删 — onSessionDestroyed 触发计数 + 时序约束', () => {
  it('每 descendant + parent 各触发一次 onSessionDestroyed（堵潜伏调度，N3）', async () => {
    const a = await mkSession();
    const b = await mkSession({ parentSessionId: a });
    const c = await mkSession({ parentSessionId: b });

    const destroyed: string[] = [];
    store.onSessionDestroyed = async (sid) => { destroyed.push(sid); };

    // 模拟 handleSessionItem DELETE 编排：先 collectDescendants，逐个删，最后 parent
    const descs = await store.collectDescendants(a);
    for (const sid of descs) await store.deleteSession(sid);
    await store.deleteSession(a);

    // 触发次数 = descendants 数 + 1（parent）
    expect(destroyed.length).toBe(descs.length + 1);
    // 全部被物理删
    expect(await store.getSession(a)).toBeNull();
    expect(await store.getSession(b)).toBeNull();
    expect(await store.getSession(c)).toBeNull();
  });

  it('时序约束：idx 已 ready 时删 parent 后 collectDescendants 查空（必须删前快照）', async () => {
    const a = await mkSession();
    const b = await mkSession({ parentSessionId: a });

    // 先 warm idx（模拟业务运行中 listChildren 已被调过，idx 常驻 ready）
    const before = await store.collectDescendants(a);
    expect(before).toEqual([b]);
    expect(store.childrenIndex.isReady).toBe(true);

    // 删 parent（onDeleted 清掉 A 的 child set）
    await store.deleteSession(a);

    // 删后再查 → idx 中 A 的 set 已清，返空（这正是「必须删前快照」的原因）
    const after = await store.collectDescendants(a);
    expect(after).toEqual([]);
    // b 成孤儿残留（旧行为的 bug，级联删修好后不会再出现）
    expect(await store.getSession(b)).not.toBeNull();
  });
});

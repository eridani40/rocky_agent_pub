/**
 * SessionWorkspaceManager 单元测试 —— 懒监听编排器（v0.0.139 重写适配）
 * 参考: specs/tech/agent/session/[P0]session_workspace_manager.md（v1.1 lazy 权威源）
 *       specs/tech/agent/session/[P0]session_event.md §2/§3
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块5
 *
 * [v0.0.139 适配] 旧递归模型 startWatch/stopWatch API 已删（全文件重写），改测新懒监听
 * API：watch/unwatch/releaseTab/recycleSession/switchDir/stopAll/getStatus。
 *
 * 覆盖（task4 acceptanceCriteria 白盒维度）：
 *   - watch/unwatch 基础生命周期 + 幂等（重复 watch 不叠加、unwatch 未持有 no-op）
 *   - 多 tab 同目录 refcount 合并（2 tab→1 物理 watcher，关一个不停全关才停）
 *   - releaseTab/recycleSession 两层回收无泄漏（getStatus 空 invariant）
 *   - 快速 watch→unwatch→watch 同目录不崩（串行化防重入）
 *   - depth:0 非递归端到端（manager 层，含大子目录不扫内部）
 *   - 100ms debounce + event payload（kind/relPath/isDir）
 *   - switchDir 顺序（recycleSession→setDirCb，不重启新目录监听）
 *   - lazy 钩子接线（SseChannel onSubscribe/onUnsubscribe 通用机制，与 manager 解耦独立可用）
 *
 * chokidar 配置常量断言见 workspace-dir-watcher.test.ts（T1）；registry 纯记账断言见
 * workspace-watch-registry.test.ts（T1）；本文件聚焦 manager 编排层真实 fs 端到端行为。
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReplayableEventBus } from '../event-bus';
import { EventHub } from '../event-hub';
import { SessionWorkspaceManager } from '../session-workspace-manager';
import { collectEvents, waitForFileEvent } from '../__helpers__/workspace-test-helpers';

let statusBus: ReplayableEventBus;
let manager: SessionWorkspaceManager;
let tmpRoot: string;

beforeEach(() => {
  EventHub.resetForTest();
  statusBus = new ReplayableEventBus({ replayable: false });
  manager = new SessionWorkspaceManager({ statusBus });
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-wsm-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 1. watch/unwatch 基础生命周期 + 幂等
// ============================================================

describe('SessionWorkspaceManager — watch/unwatch 基础生命周期 + 幂等', () => {
  it('watch(根) → getStatus 含该 sid/absDir/refcount=1；unwatch → 移除', async () => {
    const sid = '01TEST00000000000000000001';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.watch(sid, 'c1', dir, '');
    const status1 = manager.getStatus();
    expect(status1).toHaveLength(1);
    expect(status1[0]).toMatchObject({ sessionId: sid, absDir: dir, refcount: 1, ready: true });

    await manager.unwatch(sid, 'c1', dir, '');
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('unwatch 未持有的 (tab,path) → 静默 no-op（幂等，不抛错）', async () => {
    await expect(manager.unwatch('nonexistent-sid', 'c1', tmpRoot, '')).resolves.toBeUndefined();
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('同 tab 重复 watch 同 path → 幂等 no-op（不叠加 refcount）', async () => {
    const sid = '01TEST00000000000000000002';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.watch(sid, 'c1', dir, '');
    await manager.watch(sid, 'c1', dir, '');
    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.refcount).toBe(1); // 未叠加
  });

  it('watch 不存在目录 → 忽略（不报错，不登记）', async () => {
    const sid = '01TEST00000000000000000003';
    await manager.watch(sid, 'c1', resolve(tmpRoot, 'not-exists'), '');
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('watch 传入文件（非目录）→ 忽略', async () => {
    const sid = '01TEST00000000000000000004';
    const file = resolve(tmpRoot, 'afile');
    writeFileSync(file, 'x');
    // 用文件路径本身当 workspaceDir 根传入 → resolveAbsDir 后 statSync 非目录
    await manager.watch(sid, 'c1', file, '');
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('stopAll：close 所有物理 watcher + 清空全部记账', async () => {
    const sid1 = '01TEST00000000000000000005';
    const sid2 = '01TEST00000000000000000006';
    const dir1 = resolve(tmpRoot, 'ws1', sid1);
    const dir2 = resolve(tmpRoot, 'ws2', sid2);
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    await manager.watch(sid1, 'c1', dir1, '');
    await manager.watch(sid2, 'c1', dir2, '');
    expect(manager.getStatus()).toHaveLength(2);

    await manager.stopAll();
    expect(manager.getStatus()).toHaveLength(0);
  });
});

// ============================================================
// 2. 多 tab 同目录 refcount 合并
// ============================================================

describe('SessionWorkspaceManager — 多 tab 同目录 refcount 合并', () => {
  it('2 个 tab watch 同目录 → refcount=2，仅 1 个物理 watcher entry', async () => {
    const sid = '01TEST00000000000000000030';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.watch(sid, 'c1', dir, '');
    await manager.watch(sid, 'c2', dir, '');
    const status = manager.getStatus();
    expect(status).toHaveLength(1); // 只 1 个物理 watcher（非 2）
    expect(status[0]?.refcount).toBe(2);
  });

  it('关一个 tab 不停物理 watcher（refcount 2→1）；全关才真正停（refcount 1→0）', async () => {
    const sid = '01TEST00000000000000000031';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.watch(sid, 'c1', dir, '');
    await manager.watch(sid, 'c2', dir, '');

    await manager.unwatch(sid, 'c1', dir, '');
    let status = manager.getStatus();
    expect(status).toHaveLength(1); // 仍在监听（c2 还持有）
    expect(status[0]?.refcount).toBe(1);

    await manager.unwatch(sid, 'c2', dir, '');
    status = manager.getStatus();
    expect(status).toHaveLength(0); // 全关才真正停
  });
});

// ============================================================
// 3. releaseTab / recycleSession 两层回收无泄漏
// ============================================================

describe('SessionWorkspaceManager — releaseTab/recycleSession 两层回收无泄漏', () => {
  it('releaseTab 只回收该 tab 名下监听；其他 tab 不受影响', async () => {
    const sid = '01TEST00000000000000000040';
    const dirA = resolve(tmpRoot, 'ws', 'a');
    const dirB = resolve(tmpRoot, 'ws', 'b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    await manager.watch(sid, 'c1', dirA, ''); // c1 watch dirA
    await manager.watch(sid, 'c2', dirB, ''); // c2 watch dirB
    expect(manager.getStatus()).toHaveLength(2);

    await manager.releaseTab(sid, 'c1');
    const status = manager.getStatus();
    expect(status).toHaveLength(1); // 只剩 c2 的 dirB
    expect(status[0]?.absDir).toBe(dirB);
  });

  it('recycleSession 回收该 session 名下全部 tab → getStatus 空（无泄漏 invariant）', async () => {
    const sid = '01TEST00000000000000000041';
    const dirA = resolve(tmpRoot, 'ws', 'a2');
    const dirB = resolve(tmpRoot, 'ws', 'b2');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    await manager.watch(sid, 'c1', dirA, '');
    await manager.watch(sid, 'c2', dirB, '');
    expect(manager.getStatus()).toHaveLength(2);

    await manager.recycleSession(sid);
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('releaseTab/recycleSession 幂等：无记录 tab/session → no-op 不抛错', async () => {
    await expect(manager.releaseTab('nope-sid', 'nope-c')).resolves.toBeUndefined();
    await expect(manager.recycleSession('nope-sid')).resolves.toBeUndefined();
    expect(manager.getStatus()).toHaveLength(0);
  });
});

// ============================================================
// 4. 快速 watch→unwatch→watch 同目录不崩（串行化防重入）
// ============================================================

describe('SessionWorkspaceManager — 快速 watch→unwatch→watch 同目录（spec §7 防重入）', () => {
  it('并发 watch/unwatch/watch 同目录不抛错；记账同步段保证最终已 watch（refcount=1）', async () => {
    const sid = '01TEST00000000000000000050';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    // registry.addTabDir/removeTabDir 在 enqueue 外同步执行，三次调用的同步段按数组顺序
    // watch→unwatch→watch 依次落地；物理 watcher create/close 走 per-absDir 串行队列，
    // 不交错崩溃。最终态 = 已 watch（tab 集里最后一次是 watch）。
    await expect(
      Promise.all([
        manager.watch(sid, 'c1', dir, ''),
        manager.unwatch(sid, 'c1', dir, ''),
        manager.watch(sid, 'c1', dir, ''),
      ]),
    ).resolves.toBeDefined();

    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.absDir).toBe(dir);
    expect(status[0]?.refcount).toBe(1);
  });

  it('顺序 await 的 watch→unwatch→watch（同目录）→ 最终一致已 watch', async () => {
    const sid = '01TEST00000000000000000051';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.watch(sid, 'c1', dir, '');
    await manager.unwatch(sid, 'c1', dir, '');
    await manager.watch(sid, 'c1', dir, '');

    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.refcount).toBe(1);
  });
});

// ============================================================
// 5. depth:0 非递归端到端（manager 层，懒监听核心回归防线）
// ============================================================

describe('SessionWorkspaceManager — depth:0 非递归端到端（含大子目录不扫内部）', () => {
  it('watch 根：大子目录（预置多文件）内部变化零事件；根目录直接子项变化才产生 event', async () => {
    const sid = '01TEST00000000000000000060';
    const dir = resolve(tmpRoot, 'ws', sid);
    const bigSub = join(dir, 'big');
    mkdirSync(bigSub, { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(bigSub, `f${i}.txt`), 'x');
    const col = collectEvents(sid, statusBus);

    await manager.watch(sid, 'c1', dir, '');
    await sleep(150);
    col.events.length = 0;

    // 大子目录内部文件变化 → depth:0 不下降进 big/，零事件
    writeFileSync(join(bigSub, 'f0.txt'), 'modified');
    await sleep(300);
    expect(col.events.length).toBe(0);

    // 根目录直接子项变化 → 应产生 event
    writeFileSync(join(dir, 'top.txt'), 'hi');
    await waitForFileEvent(col, (e) => e.data.path === 'top.txt');
    col.sub.cancel();
    expect(col.events.some((e) => (e as { data: { path: string } }).data.path === 'top.txt')).toBe(true);
  });
});

// ============================================================
// 6. 100ms debounce + event payload（kind/relPath/isDir）
// ============================================================

describe('SessionWorkspaceManager — 文件变化 → event', () => {
  it('add 文件 → 100ms 后 emit session_workspace_file_changed { kind:add, isDir:false }', async () => {
    const sid = '01TEST00000000000000000010';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });
    const col = collectEvents(sid, statusBus);

    await manager.watch(sid, 'c1', dir, '');
    await sleep(150);
    col.events.length = 0;

    writeFileSync(join(dir, 'a.txt'), 'hello');
    await waitForFileEvent(col, (e) => e.data.path === 'a.txt' && e.data.kind === 'add');

    col.sub.cancel();
    expect(col.events.length).toBeGreaterThanOrEqual(1);
    // 用 find 而非「取数组最后一项」：真实文件系统在系统负载高时可能把一次写 coalesce 成
    // add+change 两条事件（同一 debounce 窗口内两个不同 key，均会被 flush），取最后一项会
    // 偶发抓到 change 而非本用例关心的 add——按 kind 精确查找才是稳健断言。
    const ev = col.events.find(
      (e) => (e as { data: { path: string } }).data.path === 'a.txt',
    ) as { type: string; sessionId: string; data: { path: string; kind: string; isDir: boolean } };
    expect(ev).toBeDefined();
    expect(ev.type).toBe('session_workspace_file_changed');
    expect(ev.sessionId).toBe(sid);
    expect(ev.data.path).toBe('a.txt');
    expect(ev.data.kind).toBe('add');
    expect(ev.data.isDir).toBe(false);
  });

  it('relPath 相对 workspaceDir（展开子目录后文件路径含 /；depth:0 下子目录须显式 watch 才产事件）', async () => {
    const sid = '01TEST00000000000000000011';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'sub'));
    const col = collectEvents(sid, statusBus);

    // depth:0 非递归：仅 watch 根不会捕获 sub/ 内部变化，须显式展开（watch sub 本身，relDir='sub'）
    await manager.watch(sid, 'c1', dir, '');
    await manager.watch(sid, 'c1', dir, 'sub');
    await sleep(150);
    col.events.length = 0;

    writeFileSync(join(dir, 'sub', 'b.txt'), 'x');
    await waitForFileEvent(col, (e) => e.data.path === 'sub/b.txt');

    col.sub.cancel();
    // find 而非取最后一项：同上，写操作可能被系统 coalesce 成 add+change 两条
    const ev = col.events.find(
      (e) => (e as { data: { path: string } }).data.path === 'sub/b.txt',
    ) as { data: { path: string } };
    expect(ev).toBeDefined();
    expect(ev.data.path).toBe('sub/b.txt');
  });

  it('addDir → isDir:true', async () => {
    const sid = '01TEST00000000000000000012';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });
    const col = collectEvents(sid, statusBus);

    await manager.watch(sid, 'c1', dir, '');
    await sleep(150);
    col.events.length = 0;

    mkdirSync(join(dir, 'newfolder'));
    await waitForFileEvent(col, (e) => e.data.path === 'newfolder');

    col.sub.cancel();
    const ev = col.events[col.events.length - 1] as {
      data: { path: string; kind: string; isDir: boolean }
    };
    expect(ev.data.kind).toBe('addDir');
    expect(ev.data.isDir).toBe(true);
    expect(ev.data.path).toBe('newfolder');
  });

  it('unlink → kind:unlink', async () => {
    const sid = '01TEST00000000000000000014';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'del.txt');
    writeFileSync(file, 'x');
    const col = collectEvents(sid, statusBus);

    await manager.watch(sid, 'c1', dir, '');
    await sleep(150);
    col.events.length = 0;

    unlinkSync(file);
    await waitForFileEvent(col, (e) => e.data.kind === 'unlink');

    col.sub.cancel();
    const ev = col.events[col.events.length - 1] as { data: { kind: string; path: string } };
    expect(ev.data.kind).toBe('unlink');
    expect(ev.data.path).toBe('del.txt');
  });
});

// ============================================================
// 7. switchDir（recycleSession→setDirCb，不重启新目录监听，spec §9）
// ============================================================

describe('SessionWorkspaceManager — switchDir（recycle→set，不重启）', () => {
  it('recycleSession 在前、setDirCb 在后（顺序保证）；旧目录监听全部清空', async () => {
    const sid = '01TEST00000000000000000020';
    const oldDir = resolve(tmpRoot, 'old', sid);
    const newDir = resolve(tmpRoot, 'new', sid);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });

    await manager.watch(sid, 'c1', oldDir, '');
    expect(manager.getStatus()).toHaveLength(1);

    const calls: string[] = [];
    const setDirCb = async (_sid: string, dir: string) => { calls.push(`set:${dir}`); };

    await manager.switchDir(sid, newDir, setDirCb);

    expect(calls).toEqual([`set:${newDir}`]);
    expect(manager.getStatus()).toHaveLength(0); // 旧监听已清，不自动重启新目录
  });

  it('不在前台切目录（无监听）：只调 setDirCb，无副作用', async () => {
    const sid = '01TEST00000000000000000021';
    const newDir = resolve(tmpRoot, 'new', sid);
    mkdirSync(newDir, { recursive: true });

    expect(manager.getStatus()).toHaveLength(0);

    const calls: string[] = [];
    const setDirCb = async (_sid: string, dir: string) => { calls.push(`set:${dir}`); };

    await manager.switchDir(sid, newDir, setDirCb);

    expect(calls).toEqual([`set:${newDir}`]);
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('多 tab 同 session 的全部监听在 switchDir 时一并清空', async () => {
    const sid = '01TEST00000000000000000022';
    const oldDir = resolve(tmpRoot, 'old2', sid);
    const newDir = resolve(tmpRoot, 'new2', sid);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });

    await manager.watch(sid, 'c1', oldDir, '');
    await manager.watch(sid, 'c2', oldDir, '');
    expect(manager.getStatus()[0]?.refcount).toBe(2);

    await manager.switchDir(sid, newDir, async () => {});
    expect(manager.getStatus()).toHaveLength(0);
  });
});

// ============================================================
// 8. lazy 钩子接线（SseChannel 通用机制，独立于 manager 具体 API）
// ============================================================

describe('SessionWorkspaceManager 场景 — lazy 钩子接线（SseChannel 集成）', () => {
  it('SseChannel.subscribe(session_panel, session_id:sid, subId) → onSubscribe 钩子触发', async () => {
    const { SseChannel } = await import('../../sse/sse-channel');
    const channel = new SseChannel(EventHub.singleton());
    let hooked = '';
    channel.setSubscribeHooks({
      onSubscribe: (_t, g) => { hooked = g; },
    });
    channel.subscribe('session_panel', 'session_id:01TESTHOOK0000000000000001', 'sub-hook-1');
    expect(hooked).toBe('session_id:01TESTHOOK0000000000000001');
  });

  it('SseChannel.unsubscribe(subId) → onUnsubscribe 钩子触发', async () => {
    const { SseChannel } = await import('../../sse/sse-channel');
    const channel = new SseChannel(EventHub.singleton());
    let hooked = '';
    channel.setSubscribeHooks({
      onUnsubscribe: (_t, g) => { hooked = g; },
    });
    channel.subscribe('session_panel', 'session_id:01TESTHOOK0000000000000002', 'sub-hook-2');
    channel.unsubscribe('sub-hook-2');
    expect(hooked).toBe('session_id:01TESTHOOK0000000000000002');
  });

  it('重复 subscribe 同 subId → onSubscribe 只触发一次（0→1）', async () => {
    const { SseChannel } = await import('../../sse/sse-channel');
    const channel = new SseChannel(EventHub.singleton());
    let count = 0;
    channel.setSubscribeHooks({
      onSubscribe: () => { count++; },
    });
    channel.subscribe('session_panel', 'session_id:01TESTHOOK0000000000000003', 'sub-hook-3');
    channel.subscribe('session_panel', 'session_id:01TESTHOOK0000000000000003', 'sub-hook-3');
    expect(count).toBe(1);
  });
});

// ============================================================
// 9. applyWatchSet（v0.0.271 声明式 watch-set：全量 diff + 泄漏收敛 + 多 tab 合并）
// ============================================================

describe('SessionWorkspaceManager — applyWatchSet 全量 diff（v0.0.271）', () => {
  it('初始集合 → 全部建 watcher；同集合再调 → 幂等不变', async () => {
    const sid = '01TEST00000000000000000060';
    const dir = resolve(tmpRoot, 'ws', sid);
    const sub = resolve(dir, 'sub');
    mkdirSync(sub, { recursive: true });

    await manager.applyWatchSet(sid, 'c1', dir, ['', 'sub']);
    let status = manager.getStatus();
    expect(status).toHaveLength(2);
    expect(status.map((s) => s.absDir).sort()).toEqual([dir, sub].sort());
    expect(status.every((s) => s.refcount === 1)).toBe(true);

    // 幂等：同集合再调 → diff 全空 → 不叠加
    await manager.applyWatchSet(sid, 'c1', dir, ['', 'sub']);
    status = manager.getStatus();
    expect(status).toHaveLength(2);
    expect(status.every((s) => s.refcount === 1)).toBe(true);
  });

  it('移除路径 → 物理 watcher close（不在新集合一律 close，泄漏收敛）', async () => {
    const sid = '01TEST00000000000000000061';
    const dir = resolve(tmpRoot, 'ws', sid);
    const sub = resolve(dir, 'sub');
    mkdirSync(sub, { recursive: true });

    await manager.applyWatchSet(sid, 'c1', dir, ['', 'sub']);
    expect(manager.getStatus()).toHaveLength(2);

    await manager.applyWatchSet(sid, 'c1', dir, ['']);
    const status = manager.getStatus();
    expect(status).toHaveLength(1); // sub 已 close
    expect(status[0]?.absDir).toBe(dir);
  });

  it('多 tab 合并：c1 移除但 c2 仍持有 → refcount>0 → 不 close', async () => {
    const sid = '01TEST00000000000000000062';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.applyWatchSet(sid, 'c1', dir, ['']);
    await manager.applyWatchSet(sid, 'c2', dir, ['']);
    let status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.refcount).toBe(2); // 两 tab 合并 1 watcher

    // c1 移出（空集合）→ refcount 2→1 → 不 close
    await manager.applyWatchSet(sid, 'c1', dir, []);
    status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.refcount).toBe(1);

    // c2 也移出 → refcount 1→0 → close
    await manager.applyWatchSet(sid, 'c2', dir, []);
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('新增 + 移除混合：集合从 {a,b} → {b,c} → a close、c 建、b 保持', async () => {
    const sid = '01TEST00000000000000000063';
    const dir = resolve(tmpRoot, 'ws', sid);
    const a = resolve(dir, 'a');
    const b = resolve(dir, 'b');
    const c = resolve(dir, 'c');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    mkdirSync(c, { recursive: true });

    await manager.applyWatchSet(sid, 'c1', dir, ['a', 'b']);
    expect(manager.getStatus()).toHaveLength(2);

    await manager.applyWatchSet(sid, 'c1', dir, ['b', 'c']);
    const status = manager.getStatus();
    expect(status).toHaveLength(2);
    expect(status.map((s) => s.absDir).sort()).toEqual([b, c].sort());
    expect(status.every((s) => s.refcount === 1)).toBe(true);
  });

  it('不存在/非目录路径 → 静默跳过（不登记不报错）', async () => {
    const sid = '01TEST00000000000000000064';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, 'afile');
    writeFileSync(file, 'x');

    await manager.applyWatchSet(sid, 'c1', dir, ['', 'not-exists', 'afile']);
    const status = manager.getStatus();
    expect(status).toHaveLength(1); // 只有根
    expect(status[0]?.absDir).toBe(dir);
  });

  it('越界路径 → resolveAbsDir 返 null 跳过（不登记）', async () => {
    const sid = '01TEST00000000000000000065';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.applyWatchSet(sid, 'c1', dir, ['', '../../outside']);
    const status = manager.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]?.absDir).toBe(dir);
  });

  it('空集合 → 清空该 tab 全部监听（与 releaseTab 语义一致）', async () => {
    const sid = '01TEST00000000000000000066';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.applyWatchSet(sid, 'c1', dir, ['']);
    expect(manager.getStatus()).toHaveLength(1);

    await manager.applyWatchSet(sid, 'c1', dir, []);
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('stopAll 后 applyWatchSet → no-op（stopped 短路）', async () => {
    const sid = '01TEST00000000000000000067';
    const dir = resolve(tmpRoot, 'ws', sid);
    mkdirSync(dir, { recursive: true });

    await manager.stopAll();
    await expect(manager.applyWatchSet(sid, 'c1', dir, [''])).resolves.toBeUndefined();
    expect(manager.getStatus()).toHaveLength(0);
  });

  it('4 条回收路径交互：applyWatchSet 建立后 releaseTab / recycleSession 均能收敛', async () => {
    const sid = '01TEST00000000000000000068';
    const dir = resolve(tmpRoot, 'ws', sid);
    const sub = resolve(dir, 'sub');
    mkdirSync(sub, { recursive: true });

    // applyWatchSet 建立集合
    await manager.applyWatchSet(sid, 'c1', dir, ['', 'sub']);
    expect(manager.getStatus()).toHaveLength(2);

    // releaseTab（旧增量回收路径）清空该 tab → 全部 close
    await manager.releaseTab(sid, 'c1');
    expect(manager.getStatus()).toHaveLength(0);

    // 重新 applyWatchSet → 重建
    await manager.applyWatchSet(sid, 'c1', dir, ['', 'sub']);
    expect(manager.getStatus()).toHaveLength(2);

    // recycleSession 清空整个 session
    await manager.recycleSession(sid);
    expect(manager.getStatus()).toHaveLength(0);
  });
});

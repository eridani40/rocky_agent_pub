/**
 * task-hooks UT — afterTaskWrite 自动依赖 transition（panorama_builtin §4）.
 * 参考: specs/tech/squad/[P1]panorama_builtin.md §4 + §8（不变量#3）
 *       change_plan 模块 F（覆盖：依赖未满足→waiting / 全 done→todo / 同值跳过 / 环保护 / in_progress 不被改）
 *
 * 底层用真 PanoramaEntityStore + tmpdir（无 mock；隔离 by mkdtempSync + afterEach 清理）.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PanoramaEntityStore } from '../../store/panorama_store';
import { afterTaskWrite, parseDeps } from '../task-hooks';
import { TASK_STATUS, TASK_ENTITY_DEF, TASK_VIEW_DEF } from '../task-schema';

let tmpDir: string;
let store: PanoramaEntityStore;
const squadId = 'sq-th';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-hooks-'));
  fs.mkdirSync(path.join(tmpDir, 'squads', squadId, 'panorama', 'entities'), { recursive: true });
  store = new PanoramaEntityStore({ root: tmpDir, squadId });
  // afterTaskWrite 直查 board.yaml 的 task entity（v0.0.243 改普通 entity 后不再 builtin 合成），
  // 测试 setup 需先 writeBoard 让 task entity 存在（模拟生产 ensureSystemEntities 后状态）
  store.writeBoard({
    meta: { version: '1.0' },
    entities: { task: TASK_ENTITY_DEF },
    views: [TASK_VIEW_DEF],
  });
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** 创建 task 实例（status 默认 todo） */
function mkTask(id: string, deps: string, status: string = TASK_STATUS.TODO, owner = 'm1') {
  store.createInstance('task', id, {
    id, title: `T-${id}`, owner, dependencies: deps, status, archived: false,
  });
}

describe('parseDeps', () => {
  it('逗号分隔 → 数组', () => {
    expect(parseDeps('task-0001,task-0002')).toEqual(['task-0001', 'task-0002']);
  });
  it('空格/混合分隔 → 数组', () => {
    expect(parseDeps('task-0001 task-0002  task-0003')).toEqual(['task-0001', 'task-0002', 'task-0003']);
  });
  it('空串 → 空数组', () => expect(parseDeps('')).toEqual([]));
  it('非 string → 空数组（容错）', () => {
    expect(parseDeps(undefined)).toEqual([]);
    expect(parseDeps(null)).toEqual([]);
    expect(parseDeps(['a', 'b'])).toEqual([]);
  });
});

describe('afterTaskWrite — 自动依赖 transition', () => {
  it('依赖未满足 + todo → waiting', () => {
    mkTask('task-0001', 'task-0002');          // dep on 0002 (todo)
    mkTask('task-0002', '', TASK_STATUS.TODO);
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.WAITING);
  });

  it('依赖全 done + waiting → todo（自动解除）', () => {
    mkTask('task-0001', 'task-0002', TASK_STATUS.WAITING);
    mkTask('task-0002', '', TASK_STATUS.DONE);
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.TODO);
  });

  it('同值跳过（已是目标态不写事件，幂等 + 防洪水）', () => {
    mkTask('task-0001', 'task-0002', TASK_STATUS.WAITING);  // 依赖未满足且已 waiting
    mkTask('task-0002', '', TASK_STATUS.TODO);
    const eventsBefore = store.readEvents(0, 1000).length;
    afterTaskWrite(store);
    const eventsAfter = store.readEvents(0, 1000).length;
    // task-0001 已是 waiting，hook 不应再 append transition 事件
    expect(eventsAfter).toBe(eventsBefore);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.WAITING);
  });

  it('in_progress 不被 hook 改（即便依赖未满足）', () => {
    mkTask('task-0001', 'task-0002', TASK_STATUS.IN_PROGRESS);
    mkTask('task-0002', '', TASK_STATUS.TODO);
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.IN_PROGRESS);
  });

  it('done 不被 hook 改（终态）', () => {
    mkTask('task-0001', 'task-0002', TASK_STATUS.DONE);
    mkTask('task-0002', '', TASK_STATUS.TODO);
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.DONE);
  });

  it('多依赖部分 done：未全 done + waiting → 维持 waiting', () => {
    mkTask('task-0001', 'task-002,task-003', TASK_STATUS.WAITING);
    mkTask('task-002', '', TASK_STATUS.DONE);
    mkTask('task-003', '', TASK_STATUS.TODO);  // 一个未 done
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.WAITING);
  });

  it('多依赖全 done + waiting → todo', () => {
    mkTask('task-0001', 'task-002,task-003', TASK_STATUS.WAITING);
    mkTask('task-002', '', TASK_STATUS.DONE);
    mkTask('task-003', '', TASK_STATUS.DONE);
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.TODO);
  });

  it('无依赖的 todo 不被改（无依赖不参与 waiting 维护）', () => {
    mkTask('task-0001', '', TASK_STATUS.TODO);
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.TODO);
  });

  it('环依赖保护：A↔B 同时 todo → 都转 waiting，不递归死循环', () => {
    // A 依赖 B，B 依赖 A（环）；hook 单层不递归 → 都判定为依赖未满足 → 都 waiting
    mkTask('task-0001', 'task-0002', TASK_STATUS.TODO);
    mkTask('task-0002', 'task-0001', TASK_STATUS.TODO);
    afterTaskWrite(store);
    expect(store.getInstance('task', 'task-0001')!.status).toBe(TASK_STATUS.WAITING);
    expect(store.getInstance('task', 'task-0002')!.status).toBe(TASK_STATUS.WAITING);
  });

  it('系统 transition 写 source=system 事件', () => {
    mkTask('task-0001', 'task-0002', TASK_STATUS.TODO);
    mkTask('task-0002', '', TASK_STATUS.TODO);
    afterTaskWrite(store);
    const events = store.readEvents(0, 1000);
    const sysTransition = events.find(
      (e) => e.type === 'entity.transition' && e.source === 'system',
    );
    expect(sysTransition).toBeDefined();
  });
});

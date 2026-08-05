/**
 * scheduler-state UT — scheduler.json 读写（squad 级 v2 平铺形态）。
 * 参考: specs/tech/squad/[P1]scheduler.md §7（持久化 state）
 *       specs/tech/scheduling/[P1]heartbeat_handler.md §3（v2 schema + v1→v2 清理方案）
 *
 * [v0.0.116] 测 v2 schema：writeSquad/readSquad（旧 writeRole/readRole/readAll 已删）。
 *
 * 覆盖：
 *   - writeSquad → readSquad 往返（lastFiredAt/lastResult）
 *   - readSquad 文件不存在 → undefined
 *   - writeSquad 落盘 v2 schema（version:2 平铺，无 roles 分桶）
 *   - v1 旧 roles{} 文件 → readSquad 返 {lastFiredAt:null}（保存时收敛）
 *   - 路径 .rocky/state/scheduler.json（squadRoot 下）
 *   - 按 squadId 分片（squadA/squadB 独立）
 *
 * 文件系统隔离：mkdtempSync + afterEach rmSync，无 ~/.oobt-desktop 写入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulerStateStore } from '../scheduler-state';

let tmpRoot: string;
let store: SchedulerStateStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sched-state-'));
  store = new SchedulerStateStore(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SchedulerStateStore — 路径', () => {
  it('filePath = {root}/squads/{squadId}/.rocky/state/scheduler.json', () => {
    const p = store.filePath('sq1');
    expect(p).toBe(join(tmpRoot, 'squads', 'sq1', '.rocky', 'state', 'scheduler.json'));
  });
});

describe('SchedulerStateStore — 缺省读', () => {
  it('readSquad 文件不存在 → undefined', () => {
    expect(store.readSquad('sq1')).toBeUndefined();
  });
});

describe('SchedulerStateStore — write/read 往返（v2 squad 级平铺）', () => {
  it('writeSquad → readSquad 返回写入的 lastFiredAt/lastResult', () => {
    store.writeSquad('sq1', { lastFiredAt: '2026-01-15T10:00:00.000Z', lastResult: 'fired' });
    const entry = store.readSquad('sq1');
    expect(entry).toEqual({
      lastFiredAt: '2026-01-15T10:00:00.000Z',
      lastResult: 'fired',
    });
  });

  it('lastFiredAt=null 合法持久化（首次未触发场景）', () => {
    store.writeSquad('sq1', { lastFiredAt: null, lastResult: 'skipped_window' });
    const entry = store.readSquad('sq1');
    expect(entry?.lastFiredAt).toBeNull();
    expect(entry?.lastResult).toBe('skipped_window');
  });

  it('各 lastResult 值域可持久化', () => {
    const results = ['fired', 'skipped_window', 'skipped_budget', 'skipped_busy', 'skipped_killswitch'] as const;
    for (const r of results) {
      store.writeSquad(`sq-${r}`, { lastFiredAt: null, lastResult: r });
    }
    for (const r of results) {
      expect(store.readSquad(`sq-${r}`)?.lastResult).toBe(r);
    }
  });

  it('重复 writeSquad 覆盖旧值（不堆积历史）', () => {
    store.writeSquad('sq1', { lastFiredAt: '2026-01-15T10:00:00.000Z', lastResult: 'fired' });
    store.writeSquad('sq1', { lastFiredAt: '2026-01-15T11:00:00.000Z', lastResult: 'skipped_budget' });
    const entry = store.readSquad('sq1');
    expect(entry?.lastFiredAt).toBe('2026-01-15T11:00:00.000Z');
    expect(entry?.lastResult).toBe('skipped_budget');
  });
});

describe('SchedulerStateStore — 按 squadId 分片', () => {
  it('squadA/squadB 各自 scheduler.json，互不串', () => {
    store.writeSquad('sqA', { lastFiredAt: '2026-01-15T10:00:00.000Z', lastResult: 'fired' });
    store.writeSquad('sqB', { lastFiredAt: '2026-01-15T11:00:00.000Z', lastResult: 'skipped_busy' });

    expect(store.readSquad('sqA')?.lastFiredAt).toBe('2026-01-15T10:00:00.000Z');
    expect(store.readSquad('sqB')?.lastFiredAt).toBe('2026-01-15T11:00:00.000Z');
    expect(store.filePath('sqA')).not.toBe(store.filePath('sqB'));
  });
});

describe('SchedulerStateStore — 落盘文件实际内容（v2 schema）', () => {
  it('writeSquad 落盘 v2 schema：{version:2, lastFiredAt, lastResult}（无 roles 分桶）', () => {
    store.writeSquad('sq1', { lastFiredAt: '2026-01-15T10:00:00.000Z', lastResult: 'fired' });
    const file = store.filePath('sq1');
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.lastFiredAt).toBe('2026-01-15T10:00:00.000Z');
    expect(raw.lastResult).toBe('fired');
    expect(raw.roles).toBeUndefined(); // v2 无 roles 分桶
  });
});

describe('SchedulerStateStore — v1→v2 向前兼容', () => {
  it('读到 v1 旧 roles{} 文件 → 返 {lastFiredAt:null}（保存时收敛）', () => {
    // 手动写入 v1 格式文件
    const filePath = store.filePath('sq1');
    const dir = join(tmpRoot, 'squads', 'sq1', '.rocky', 'state');
    mkdirSync(dir, { recursive: true });
    const v1Content = JSON.stringify({
      version: 1,
      roles: {
        'M-1': { lastFiredAt: '2026-01-15T09:00:00.000Z', lastResult: 'fired' },
      },
    });
    writeFileSync(filePath, v1Content, 'utf8');
    // readSquad 应忽略 v1 roles，返 lastFiredAt=null
    const entry = store.readSquad('sq1');
    expect(entry).toBeDefined();
    expect(entry?.lastFiredAt).toBeNull();
  });

  it('v1 文件 readSquad 后 writeSquad 覆盖为 v2（保存时收敛）', () => {
    const filePath = store.filePath('sq1');
    const dir = join(tmpRoot, 'squads', 'sq1', '.rocky', 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: 1, roles: { 'M-1': { lastFiredAt: null, lastResult: 'fired' } } }), 'utf8');
    // 写入 v2
    store.writeSquad('sq1', { lastFiredAt: '2026-01-15T12:00:00.000Z', lastResult: 'fired' });
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.roles).toBeUndefined();
  });
});

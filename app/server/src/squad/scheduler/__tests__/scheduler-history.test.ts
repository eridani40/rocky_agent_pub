/**
 * scheduler-history UT — ring buffer + append history.jsonl + getHistory 倒序。
 * 参考: specs/tech/squad/[P1]scheduler.md §8（自动工作历史）
 *       states/v0.0.33.4/verify/test-plan.md §2（scheduler-history UT 清单）
 *
 * 覆盖（task acceptance + test-plan §2 scheduler-history P12）：
 *   - append → getHistory 取到
 *   - ring buffer 容量 100（FIFO 淘汰最旧）
 *   - getHistory 倒序（最新在前）
 *   - getHistory limit
 *   - getHistory roleId 过滤
 *   - 路径 .rocky/state/history.jsonl
 *   - 重启场景：内存空 → 读 jsonl 兜底
 *   - 存量 jsonl 历史 file-changed 条目（功能已删）读盘时过滤
 *
 * 文件系统隔离：mkdtempSync + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulerHistory, type HistoryEntry } from '../scheduler-history';

let tmpRoot: string;
let history: SchedulerHistory;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sched-history-'));
  history = new SchedulerHistory(tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造 history entry */
function mkEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    roleId: 'm1',
    at: '2026-01-15T10:00:00.000Z',
    reason: 'heartbeat',
    result: 'fired',
    ...overrides,
  };
}

describe('SchedulerHistory — 路径', () => {
  it('filePath = {root}/squads/{squadId}/.rocky/state/history.jsonl', () => {
    expect(history.filePath('sq1')).toBe(
      join(tmpRoot, 'squads', 'sq1', '.rocky', 'state', 'history.jsonl'),
    );
  });
});

describe('SchedulerHistory — append + getHistory 基础', () => {
  it('append 一条 → getHistory 取到', () => {
    history.append('sq1', mkEntry({ at: '2026-01-15T10:00:00.000Z' }));
    const items = history.getHistory('sq1');
    expect(items).toHaveLength(1);
    expect(items[0]!.at).toBe('2026-01-15T10:00:00.000Z');
  });

  it('heartbeat reason 条目正常往返', () => {
    history.append('sq1', mkEntry({ reason: 'heartbeat' }));
    const items = history.getHistory('sq1');
    expect(items[0]!.reason).toBe('heartbeat');
  });
});

describe('SchedulerHistory — 倒序（最新在前）', () => {
  it('append 3 条 → getHistory 返回顺序为最新→最旧', () => {
    history.append('sq1', mkEntry({ at: '2026-01-15T10:00:00.000Z' }));
    history.append('sq1', mkEntry({ at: '2026-01-15T11:00:00.000Z' }));
    history.append('sq1', mkEntry({ at: '2026-01-15T12:00:00.000Z' }));

    const items = history.getHistory('sq1');
    expect(items.map(i => i.at)).toEqual([
      '2026-01-15T12:00:00.000Z',   // 最新
      '2026-01-15T11:00:00.000Z',
      '2026-01-15T10:00:00.000Z',   // 最旧
    ]);
  });
});

describe('SchedulerHistory — limit', () => {
  it('limit 缺省=50', () => {
    for (let i = 0; i < 60; i++) {
      history.append('sq1', mkEntry({ at: `2026-01-15T10:${String(i).padStart(2, '0')}:00.000Z` }));
    }
    expect(history.getHistory('sq1')).toHaveLength(50);
  });

  it('limit 显式传值生效', () => {
    for (let i = 0; i < 10; i++) {
      history.append('sq1', mkEntry({ at: `2026-01-15T10:${String(i).padStart(2, '0')}:00.000Z` }));
    }
    expect(history.getHistory('sq1', 3)).toHaveLength(3);
    // 最新 3 条（倒序）
    expect(history.getHistory('sq1', 3).map(i => i.at)).toEqual([
      '2026-01-15T10:09:00.000Z',
      '2026-01-15T10:08:00.000Z',
      '2026-01-15T10:07:00.000Z',
    ]);
  });
});

describe('SchedulerHistory — roleId 过滤', () => {
  it('? roleId 过滤（多 role 混合）', () => {
    history.append('sq1', mkEntry({ roleId: 'leader', at: '2026-01-15T10:00:00.000Z' }));
    history.append('sq1', mkEntry({ roleId: 'm1', at: '2026-01-15T11:00:00.000Z' }));
    history.append('sq1', mkEntry({ roleId: 'leader', at: '2026-01-15T12:00:00.000Z' }));

    const leaderItems = history.getHistory('sq1', 50, 'leader');
    expect(leaderItems).toHaveLength(2);
    expect(leaderItems.every(i => i.roleId === 'leader')).toBe(true);
    // 倒序：最新 12:00 在前
    expect(leaderItems[0]!.at).toBe('2026-01-15T12:00:00.000Z');
  });

  it('? roleId 不匹配 → 空', () => {
    history.append('sq1', mkEntry({ roleId: 'leader' }));
    expect(history.getHistory('sq1', 50, 'nobody')).toEqual([]);
  });
});

describe('SchedulerHistory — ring buffer 容量 100', () => {
  it('append > 100 条 → 仅保留最近 100 条（FIFO 淘汰最旧）', () => {
    // 用 i 序号作为唯一标识分钟字段（部分值 > 60，仅为唯一可辨识，不要求合法 ISO 时间）
    for (let i = 0; i < 105; i++) {
      history.append('sq1', mkEntry({ at: `2026-01-15T10:${String(i).padStart(3, '0')}:00.000Z` }));
    }
    const items = history.getHistory('sq1', 200);
    expect(items).toHaveLength(100);
    // 最新 = 第 105 条（index 104）；最旧 = 第 6 条（index 5，前 5 条被 FIFO 淘汰）
    expect(items[0]!.at).toContain('T10:104:00');   // 最新在前
    expect(items[items.length - 1]!.at).toContain('T10:005:00');   // 最旧
  });
});

describe('SchedulerHistory — 按 squadId 分片（多 squad 隔离 TBD9）', () => {
  it('squadA/squadB 内存 buffer 互不串', () => {
    history.append('sqA', mkEntry({ roleId: 'leader', at: '2026-01-15T10:00:00.000Z' }));
    history.append('sqB', mkEntry({ roleId: 'mate1', at: '2026-01-15T11:00:00.000Z' }));

    expect(history.getHistory('sqA')).toHaveLength(1);
    expect(history.getHistory('sqB')).toHaveLength(1);
    expect(history.getHistory('sqA')[0]!.roleId).toBe('leader');
    expect(history.getHistory('sqB')[0]!.roleId).toBe('mate1');
  });
});

describe('SchedulerHistory — 落盘 jsonl + 重启读盘', () => {
  it('append 后 jsonl 文件存在（append-only，每行一条）', () => {
    history.append('sq1', mkEntry({ at: '2026-01-15T10:00:00.000Z' }));
    history.append('sq1', mkEntry({ at: '2026-01-15T11:00:00.000Z' }));

    const file = history.filePath('sq1');
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(2);
    // 顺序 = append 顺序（旧→新）
    expect(JSON.parse(lines[0]!).at).toBe('2026-01-15T10:00:00.000Z');
    expect(JSON.parse(lines[1]!).at).toBe('2026-01-15T11:00:00.000Z');
  });

  it('重启场景：新实例内存为空 → getHistory 读盘兜底（倒序）', () => {
    history.append('sq1', mkEntry({ at: '2026-01-15T10:00:00.000Z' }));
    history.append('sq1', mkEntry({ at: '2026-01-15T11:00:00.000Z' }));

    // 模拟重启：新 SchedulerHistory 实例（内存 buffer 空）
    const restored = new SchedulerHistory(tmpRoot);
    const items = restored.getHistory('sq1');
    expect(items).toHaveLength(2);
    // 读盘后倒序（最新在前）
    expect(items[0]!.at).toBe('2026-01-15T11:00:00.000Z');
    expect(items[1]!.at).toBe('2026-01-15T10:00:00.000Z');
  });

  it('读盘 + roleId 过滤 + limit 组合', () => {
    history.append('sq1', mkEntry({ roleId: 'leader', at: '2026-01-15T10:00:00.000Z' }));
    history.append('sq1', mkEntry({ roleId: 'm1', at: '2026-01-15T11:00:00.000Z' }));
    history.append('sq1', mkEntry({ roleId: 'leader', at: '2026-01-15T12:00:00.000Z' }));

    const restored = new SchedulerHistory(tmpRoot);
    const leaderItems = restored.getHistory('sq1', 1, 'leader');
    expect(leaderItems).toHaveLength(1);
    expect(leaderItems[0]!.at).toBe('2026-01-15T12:00:00.000Z');   // 最新 leader
  });

  it('jsonl 文件不存在 → 重启读盘返空（不抛）', () => {
    const restored = new SchedulerHistory(tmpRoot);
    expect(restored.getHistory('never')).toEqual([]);
  });

  it('存量 jsonl 含历史 file-changed 条目（功能已删）→ 读盘时过滤，只剩 heartbeat', () => {
    // 直写 jsonl 模拟功能删除前的存量数据（append 类型已收窄，无法再产生 file-changed）
    history.append('sq1', mkEntry({ at: '2026-01-15T10:00:00.000Z' }));
    const file = history.filePath('sq1');
    const legacy = `${JSON.stringify({ roleId: 'm1', at: '2026-01-15T09:00:00.000Z', reason: 'file-changed', path: 'outputs/x.md', result: 'fired' })}\n`;
    appendFileSync(file, legacy, 'utf8');

    const restored = new SchedulerHistory(tmpRoot);
    const items = restored.getHistory('sq1');
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toBe('heartbeat');
  });
});

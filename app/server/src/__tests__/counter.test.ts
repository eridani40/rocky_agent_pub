/**
 * counter store 单测
 * 参考: specs/api/overall/01-counter.md §3.2（持久化到 ${DATA_DIR}/counter.json）
 *
 * 校验点：
 *   - 文件不存在时读出 { value: 0, updatedAt: <非空ISO8601> }，不写盘
 *   - inc 持久化后 value +1 并更新 updatedAt
 *   - 多次 inc 累计
 *   - 文件存在时按文件 value 读出
 */
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { readCounter, incrementCounter, type CounterState } from '../counter';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

describe('counter store', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-counter-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('文件不存在时返回初始值 value=0 且不写盘', () => {
    const state = readCounter(dataDir);
    expect(state.value).toBe(0);
    expect(state.updatedAt).toMatch(ISO8601);
    expect(existsSync(join(dataDir, 'counter.json'))).toBe(false);
  });

  it('incrementCounter 写盘后 value=1，updatedAt 推进', () => {
    const before = readCounter(dataDir);
    const after = incrementCounter(dataDir);
    expect(after.value).toBe(before.value + 1);
    expect(after.updatedAt).toMatch(ISO8601);
    // 落盘形态与内存一致
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'counter.json'), 'utf-8')) as CounterState;
    expect(onDisk.value).toBe(after.value);
    expect(onDisk.updatedAt).toBe(after.updatedAt);
  });

  it('多次 increment 累计到 3', () => {
    incrementCounter(dataDir);
    incrementCounter(dataDir);
    const third = incrementCounter(dataDir);
    expect(third.value).toBe(3);
    expect(readCounter(dataDir).value).toBe(3);
  });

  it('文件存在时按文件 value 读出', () => {
    writeFileSync(
      join(dataDir, 'counter.json'),
      JSON.stringify({ value: 42, updatedAt: '2026-06-19T07:30:00.000Z' }),
    );
    const state = readCounter(dataDir);
    expect(state.value).toBe(42);
    expect(state.updatedAt).toBe('2026-06-19T07:30:00.000Z');
  });
});

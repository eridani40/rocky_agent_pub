/**
 * counter store — 计数器持久化层（${DATA_DIR}/counter.json）
 * 参考: specs/api/overall/01-counter.md §2.3 / §3.2
 *
 * 职责：
 *   - readCounter：读当前计数；文件不存在返回初始 { value:0, updatedAt:now } 且不写盘
 *   - incrementCounter：value+1、写盘、返回新状态
 *
 * 不依赖 electron（package_structure §3.3）。IO 异常向上抛，由调用方决定响应策略。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 计数器状态 schema（CounterResponse §2.3） */
export interface CounterState {
  /** 当前计数（整数语义） */
  value: number;
  /** 上次更新时间 ISO8601 UTC */
  updatedAt: string;
}

const FILE = 'counter.json';

/** 返回当前 UTC 时间的 ISO8601 字符串（毫秒精度） */
function nowISO(): string {
  return new Date().toISOString();
}

/** counter.json 的绝对路径 */
export function counterFilePath(dataDir: string): string {
  return join(dataDir, FILE);
}

/**
 * 读当前计数。
 * 文件不存在时返回 { value:0, updatedAt:<now> }，**不写盘**（spec §3.2）。
 */
export function readCounter(dataDir: string): CounterState {
  const p = counterFilePath(dataDir);
  if (!existsSync(p)) {
    return { value: 0, updatedAt: nowISO() };
  }
  const raw = readFileSync(p, 'utf-8');
  const parsed = JSON.parse(raw) as CounterState;
  return { value: parsed.value, updatedAt: parsed.updatedAt };
}

/**
 * 自增 1 并写盘。DATA_DIR 不存在时递归创建。
 * 返回自增后的新状态（spec §2.2：POST /counter/inc 返回新值）。
 */
export function incrementCounter(dataDir: string): CounterState {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const before = readCounter(dataDir);
  const after: CounterState = { value: before.value + 1, updatedAt: nowISO() };
  writeFileSync(counterFilePath(dataDir), JSON.stringify(after), 'utf-8');
  return after;
}

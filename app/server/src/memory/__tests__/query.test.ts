/**
 * memory query 单测 —— readMemoryEntry / searchMemory（统一 MemoryScope + dir store）
 * 参考: specs/tech/agent/memory/[P0]memory_tool.md §2/§3
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *
 * 覆盖：三 scope 路由（global→<dataDir>/memory/ / session→<sessionWs>/.rocky/memory/ /
 *       group→<groupWs>/.rocky/memory/）+ 缺依赖报错 + 跨 scope 兜底只合并 session+global
 *       （不含 group，隔离 invariant）+ scope stamp（位置即 scope）。
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globalMemoryDir,
  wsMemoryDir,
} from '../memory-dir-store';
import { writeEntry } from '../memory-dir-write';
import { readMemoryEntry, searchMemory } from '../query';

let tmpRoot: string;
let sessionWs: string;
let groupWs: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-memq-'));
  sessionWs = join(tmpRoot, 'ws-session');
  groupWs = join(tmpRoot, 'ws-group');
  // 三介质各置一条同名异物 + 一条独有 entry
  await writeEntry(globalMemoryDir(tmpRoot), { name: 'shared', intro: 'g', type: 'user', body: 'from global' }, {});
  await writeEntry(globalMemoryDir(tmpRoot), { name: 'g-only', intro: 'gg', type: 'user', body: 'global only' }, {});
  await writeEntry(wsMemoryDir(sessionWs), { name: 'shared', intro: 's', type: 'user', body: 'from session' }, {});
  await writeEntry(wsMemoryDir(sessionWs), { name: 's-only', intro: 'ss', type: 'user', body: 'session only' }, {});
  await writeEntry(wsMemoryDir(groupWs), { name: 'grp-only', intro: 'gr', type: 'user', body: 'group only' }, {});
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const deps = () => ({ dataDir: tmpRoot, sessionWsDir: sessionWs, groupWsDir: groupWs });

describe('readMemoryEntry — scope 路由', () => {
  it("scope='global' → 读 global 介质并 stamp scope='global'", () => {
    const e = readMemoryEntry({ ...deps(), scope: 'global', name: 'shared' });
    expect(e.body).toBe('from global');
    expect(e.scope).toBe('global');
  });
  it("scope='session' → 读 session 介质并 stamp scope='session'", () => {
    const e = readMemoryEntry({ ...deps(), scope: 'session', name: 'shared' });
    expect(e.body).toBe('from session');
    expect(e.scope).toBe('session');
  });
  it("scope='group' → 读 group 介质并 stamp scope='group'", () => {
    const e = readMemoryEntry({ ...deps(), scope: 'group', name: 'grp-only' });
    expect(e.body).toBe('group only');
    expect(e.scope).toBe('group');
  });
  it('未命中 → 抛 not found', () => {
    expect(() => readMemoryEntry({ ...deps(), scope: 'global', name: 'ghost' })).toThrow(/not found/i);
  });
  it("scope='session' 缺 sessionWsDir → 抛错", () => {
    expect(() => readMemoryEntry({ dataDir: tmpRoot, scope: 'session', name: 'x' })).toThrow(/session memory requires/);
  });
  it("scope='group' 缺 groupWsDir → 抛错", () => {
    expect(() => readMemoryEntry({ dataDir: tmpRoot, scope: 'group', name: 'x' })).toThrow(/group memory requires/);
  });
});

describe('readMemoryEntry — 跨 scope（undefined）', () => {
  it('先 session 命中即返（不含 group 兜底）', () => {
    const e = readMemoryEntry({ ...deps(), name: 'shared' });
    expect(e.scope).toBe('session');
  });
  it('session 未命中 → 回退 global', () => {
    const e = readMemoryEntry({ ...deps(), name: 'g-only' });
    expect(e.scope).toBe('global');
  });
  it('group 独有 entry 跨 scope 不命中（隔离 invariant）', () => {
    expect(() => readMemoryEntry({ ...deps(), name: 'grp-only' })).toThrow(/not found/i);
  });
  it('两源都未命中 → 抛 not found', () => {
    expect(() => readMemoryEntry({ ...deps(), name: 'ghost' })).toThrow(/not found/i);
  });
});

describe('searchMemory', () => {
  it("scope='global' 只搜 global 介质", () => {
    const hits = searchMemory({ ...deps(), scope: 'global', keyword: 'only' });
    expect(hits.map((h) => h.name)).toEqual(['g-only']);
    expect(hits[0]!.scope).toBe('global');
  });
  it("scope='group' 只搜 group 介质", () => {
    const hits = searchMemory({ ...deps(), scope: 'group', keyword: 'only' });
    expect(hits.map((h) => h.name)).toEqual(['grp-only']);
  });
  it('跨 scope 合并 session+global（不含 group）；search 不返 body（不变量#5）', () => {
    const hits = searchMemory({ ...deps(), keyword: 'only' });
    const names = hits.map((h) => h.name).sort();
    expect(names).toEqual(['g-only', 's-only']);
    expect(hits[0]).not.toHaveProperty('body');
  });
  it('keyword 匹配 body 字段', () => {
    const hits = searchMemory({ ...deps(), scope: 'session', keyword: 'session only' });
    expect(hits.map((h) => h.name)).toEqual(['s-only']);
  });
  it("scope='session' 缺 sessionWsDir → 抛错", () => {
    expect(() => searchMemory({ dataDir: tmpRoot, scope: 'session', keyword: 'x' })).toThrow(/session memory requires/);
  });
});

/**
 * memory-dir-store 单测 —— per-entry md 目录存储（三介质统一）
 * 参考: specs/tech/agent/memory/[P0]memory_definition.md §3/§5/§5.1
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A1
 *
 * 覆盖：路径 helper / assertEntryName 防逃逸 / parse+serialize roundtrip（兼容读 + 显式写）/
 *       writeEntry（upsert + 长度硬限 + evolvable gate + source/updatedAt 盖戳 + 归档复活）/
 *       createEntry（409 语义锁内判定）/ archiveEntry（gate + not found）/
 *       listMetas/listEntries/readEntry（坏文件跳过 + archived 过滤 + name 排序）。
 *
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertEntryName,
  globalMemoryDir,
  listEntries,
  listMetas,
  parseEntryFile,
  readEntry,
  serializeEntryFile,
  wsMemoryDir,
  type MemoryEntry,
} from '../memory-dir-store';
import { archiveEntry, createEntry, writeEntry } from '../memory-dir-write';
import { MemoryNonEvolvableError, MemoryCharLimitError } from '../policy';

let tmpRoot: string;
let dir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-memdir-'));
  dir = join(tmpRoot, 'mem');
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const INPUT = { name: 'e1', intro: 'first', type: 'user' as const, body: 'hello body' };

describe('路径 helper', () => {
  it('globalMemoryDir = <dataDir>/memory/', () => {
    expect(globalMemoryDir('/data')).toBe(join('/data', 'memory'));
  });
  it('wsMemoryDir = <wsDir>/.rocky/memory/', () => {
    expect(wsMemoryDir('/ws')).toBe(join('/ws', '.rocky', 'memory'));
  });
});

describe('assertEntryName 防逃逸', () => {
  it('正常 name 直通', () => {
    expect(assertEntryName('prefer-real-llm')).toBe('prefer-real-llm');
  });
  it.each(['', '  ', 'a/b', 'a\\b', '.', '..', 'a\nb', 'a\tb'])('非法 name %j → 抛错', (n) => {
    expect(() => assertEntryName(n)).toThrow();
  });
});

describe('parseEntryFile / serializeEntryFile', () => {
  it('roundtrip：全字段保真（不含 scope——位置即 scope）', () => {
    const e: MemoryEntry = {
      name: 'e1', intro: 'i', type: 'feedback', archived: true,
      evolvable: false, source: 'user', updatedAt: '2026-01-01T00:00:00.000Z',
      body: 'b', why: 'w', howToApply: 'h',
    };
    const parsed = parseEntryFile(serializeEntryFile(e));
    expect(parsed).toEqual(e);
    // frontmatter 不落 scope 字段
    expect(serializeEntryFile(e)).not.toContain('scope');
  });
  it('兼容读：description 回退 + 缺省 evolvable=true / source=agent / updatedAt=""', () => {
    const raw = '---\nname: old\ndescription: legacy intro\nmetadata:\n  type: project\n---\nbody text\n';
    const e = parseEntryFile(raw)!;
    expect(e.intro).toBe('legacy intro');
    expect(e.evolvable).toBe(true);
    expect(e.source).toBe('agent');
    expect(e.updatedAt).toBe('');
  });
  it('坏文件（缺 name / 非法 type / 坏 yaml）→ null', () => {
    expect(parseEntryFile('---\nmetadata:\n  type: user\n---\nb\n')).toBeNull();
    expect(parseEntryFile('---\nname: x\nmetadata:\n  type: bogus\n---\nb\n')).toBeNull();
    expect(parseEntryFile('not a frontmatter file')).toBeNull();
  });
});

describe('writeEntry（upsert）', () => {
  it('新建：mkdir -p + 落盘 + 盖戳 evolvable/source/updatedAt', async () => {
    const out = await writeEntry(dir, INPUT, { defaultEvolvable: true, source: 'agent' });
    expect(out.evolvable).toBe(true);
    expect(out.source).toBe('agent');
    expect(out.updatedAt).not.toBe('');
    const onDisk = parseEntryFile(readFileSync(join(dir, 'e1.md'), 'utf8'))!;
    expect(onDisk.body).toBe('hello body');
    expect(onDisk.source).toBe('agent');
  });
  it('更新既有：保留既有 evolvable/source（origin 不可变）+ 刷新 updatedAt + archived 复位 false', async () => {
    await writeEntry(dir, INPUT, { defaultEvolvable: false, source: 'user' });
    await archiveEntry(dir, 'e1');
    const out = await writeEntry(dir, { ...INPUT, body: 'v2' }, { defaultEvolvable: true, source: 'agent' });
    expect(out.evolvable).toBe(false); // 保留既有
    expect(out.source).toBe('user'); // origin 不可变
    expect(out.archived).toBe(false); // write 复活归档
    expect(out.body).toBe('v2');
  });
  it('body>500 字符硬限：超限 throw MemoryCharLimitError 且不落盘', async () => {
    const big = 'x'.repeat(501); // 501 字符超 500 硬限
    await expect(writeEntry(dir, { ...INPUT, body: big }, {})).rejects.toBeInstanceOf(MemoryCharLimitError);
    expect(listEntries(dir)).toEqual([]);
  });
  it('intro>50 字符硬限：超限 throw MemoryCharLimitError 且不落盘', async () => {
    const big = 'y'.repeat(51); // 51 字符超 50 硬限
    await expect(writeEntry(dir, { ...INPUT, intro: big }, {})).rejects.toBeInstanceOf(MemoryCharLimitError);
    expect(listEntries(dir)).toEqual([]);
  });
  it('evolvable gate：enforceEvolvable + 既有 evolvable=false → MemoryNonEvolvableError', async () => {
    await writeEntry(dir, INPUT, { defaultEvolvable: false });
    await expect(
      writeEntry(dir, { ...INPUT, body: 'v2' }, { enforceEvolvable: true }),
    ).rejects.toBeInstanceOf(MemoryNonEvolvableError);
  });
  it('name 含路径分隔符 → 抛错（防逃逸）', async () => {
    await expect(writeEntry(dir, { ...INPUT, name: '../evil' }, {})).rejects.toThrow();
  });
});

describe('createEntry（UI POST 409 语义）', () => {
  it('name 不存在 → 新建成功', async () => {
    const out = await createEntry(dir, INPUT, { defaultEvolvable: false, source: 'user' });
    expect(out.name).toBe('e1');
    expect(out.evolvable).toBe(false);
  });
  it('name 已存在（含 archived）→ 抛 already exists', async () => {
    await createEntry(dir, INPUT, {});
    await expect(createEntry(dir, INPUT, {})).rejects.toThrow(/already exists/i);
  });
});

describe('archiveEntry', () => {
  it('置 archived=true 不删文件；保留 source/updatedAt 戳', async () => {
    const w = await writeEntry(dir, INPUT, { source: 'user' });
    const a = await archiveEntry(dir, 'e1');
    expect(a.archived).toBe(true);
    expect(a.source).toBe(w.source);
    expect(a.updatedAt).toBe(w.updatedAt); // archive 非 write 路径不刷戳
  });
  it('未命中 → 抛 not found', async () => {
    await expect(archiveEntry(dir, 'ghost')).rejects.toThrow(/not found/i);
  });
  it('evolvable gate：enforceEvolvable + evolvable=false → MemoryNonEvolvableError', async () => {
    await writeEntry(dir, INPUT, { defaultEvolvable: false });
    await expect(archiveEntry(dir, 'e1', { enforceEvolvable: true })).rejects.toBeInstanceOf(MemoryNonEvolvableError);
  });
});

describe('list / read', () => {
  it('listEntries：默认滤 archived；includeArchived 返全；按 name 升序', async () => {
    await writeEntry(dir, { ...INPUT, name: 'b2' }, {});
    await writeEntry(dir, { ...INPUT, name: 'a1' }, {});
    await writeEntry(dir, { ...INPUT, name: 'c3' }, {});
    await archiveEntry(dir, 'c3');
    expect(listEntries(dir).map((e) => e.name)).toEqual(['a1', 'b2']);
    expect(listEntries(dir, { includeArchived: true }).map((e) => e.name)).toEqual(['a1', 'b2', 'c3']);
  });
  it('listMetas：不含 body + 含 archived 标记；坏文件跳过不抛', async () => {
    await writeEntry(dir, INPUT, {});
    writeFileSync(join(dir, 'broken.md'), '---\nmetadata:\n  type: bogus\n---\nb\n');
    mkdirSync(join(dir, 'not-md')); // 非 .md 跳过
    const metas = listMetas(dir);
    expect(metas).toHaveLength(1);
    expect(metas[0]).not.toHaveProperty('body');
    expect(metas[0]!.archived).toBe(false);
  });
  it('目录不存在 → 空数组', () => {
    expect(listEntries(join(tmpRoot, 'ghost'))).toEqual([]);
    expect(listMetas(join(tmpRoot, 'ghost'))).toEqual([]);
  });
  it('readEntry：命中返全文（archived 可读）；未命中抛 not found', async () => {
    await writeEntry(dir, INPUT, {});
    await archiveEntry(dir, 'e1');
    expect(readEntry(dir, 'e1').archived).toBe(true);
    expect(() => readEntry(dir, 'ghost')).toThrow(/not found/i);
  });
});

/**
 * file-write 单测（v0.0.38 T3 回归）
 * 参考: specs/tech/agent/tools/[P0]file_op_tools.md §3
 *       specs/tech/persistence/[P1]file_write_lock.md §5（atomicWriteSync 替换 writeFileSync 不回归）
 *
 * 覆盖：新建/覆盖/readSet/父目录/相对路径 + atomicWrite 写后无 .tmp 残留。
 * 文件系统隔离：os.tmpdir() + mkdtempSync；afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileWriteTool } from '../file-write';
import { fileReadTool } from '../file-read';
import { makeCtx, textOf, expectNoTmpResidue } from './_helpers';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'file-write-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('file-write — 回归', () => {
  it('新建文件无 read 约束 → 成功', async () => {
    const p = join(tmpRoot, 'new.txt');
    const res = await fileWriteTool.run({ filePath: p, content: 'hello' }, makeCtx(tmpRoot));
    expect(res.isError).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  it('覆盖已存在文件未 read → isError', async () => {
    const p = join(tmpRoot, 'exist.txt');
    writeFileSync(p, 'old');
    const res = await fileWriteTool.run({ filePath: p, content: 'new' }, makeCtx(tmpRoot));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not_read/i);
  });

  it('read 后覆盖 → 成功 + readSet 标记', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'rw.txt');
    writeFileSync(p, 'old');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileWriteTool.run({ filePath: p, content: 'new content' }, ctx);
    expect(res.isError).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('new content');
    expect(ctx.readSet?.has(p)).toBe(true);
  });

  it('新建文件父目录不存在 → 自动 mkdir -p（write 自建父链）', async () => {
    const p = join(tmpRoot, 'nested', 'deep', 'file.txt');
    const res = await fileWriteTool.run({ filePath: p, content: 'x' }, makeCtx(tmpRoot));
    expect(res.isError).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('x');
  });

  it('相对路径 → isError', async () => {
    const res = await fileWriteTool.run({ filePath: 'rel/x.txt', content: 'x' }, makeCtx(tmpRoot));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/path_not_absolute/i);
  });

  it('atomicWrite 写后无 .tmp 残留', async () => {
    const p = join(tmpRoot, 'atomic.txt');
    await fileWriteTool.run({ filePath: p, content: 'atomic-content' }, makeCtx(tmpRoot));
    expectNoTmpResidue(tmpRoot);
  });
});

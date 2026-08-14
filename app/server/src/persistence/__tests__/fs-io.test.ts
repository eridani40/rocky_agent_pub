/**
 * fs-io 单元测试（v0.0.345 新增 atomicWriteAsync）
 * 参考: specs/tech/version_logs/v0.0.345/change_plan.md C 组
 *       specs/tech/persistence/[P1]file_write_lock.md §5（tmp→fsync→rename 崩溃原子）
 *
 * 覆盖：
 *   - 原子写语义：写后内容完整 + 无 .tmp 残留（tmp 同目录 → fsync → rename）
 *   - 嵌套父目录自动创建（recursive mkdir）
 *   - 覆盖已存在文件
 *   - rename 失败（目标是已存在目录）→ 抛错 + 清理 tmp 不残留
 *
 * 文件系统隔离：os.tmpdir() + mkdtempSync；afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteAsync } from '../fs-io';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fs-io-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 断言目录下无 .tmp 残留（原子写完成标志） */
function expectNoTmpResidue(dir: string): void {
  const names = readdirSync(dir);
  expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
}

describe('atomicWriteAsync — 原子写语义', () => {
  it('写后内容完整 + 无 .tmp 残留', async () => {
    const p = join(tmpRoot, 'a.txt');
    await atomicWriteAsync(p, 'hello async');
    expect(readFileSync(p, 'utf8')).toBe('hello async');
    expectNoTmpResidue(tmpRoot);
  });

  it('父目录不存在 → recursive 自动建链', async () => {
    const p = join(tmpRoot, 'nested', 'deep', 'b.txt');
    await atomicWriteAsync(p, 'deep content');
    expect(readFileSync(p, 'utf8')).toBe('deep content');
  });

  it('覆盖已存在文件 → 新内容生效 + 无 .tmp 残留', async () => {
    const p = join(tmpRoot, 'c.txt');
    await atomicWriteAsync(p, 'old');
    await atomicWriteAsync(p, 'new content');
    expect(readFileSync(p, 'utf8')).toBe('new content');
    expectNoTmpResidue(tmpRoot);
  });
});

describe('atomicWriteAsync — 异常清理', () => {
  it('rename 失败（目标是已存在目录）→ 抛错 + 清理 tmp 不残留', async () => {
    // 目标路径是已存在目录：open/写/fsync 成功，rename(file → dir) 必失败（EISDIR）
    const targetDir = join(tmpRoot, 'target-dir');
    mkdirSync(targetDir);
    await expect(atomicWriteAsync(targetDir, 'cannot rename onto dir')).rejects.toThrow();
    // tmp 已清理：目录下无 .tmp 文件，且 target-dir 仍是目录
    expectNoTmpResidue(tmpRoot);
    expect(existsSync(targetDir)).toBe(true);
  });
});

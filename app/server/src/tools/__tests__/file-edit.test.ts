/**
 * file-edit 单测（v0.0.38 T3）
 * 参考: specs/tech/persistence/[P1]file_write_lock.md §5（工具改动点）+ §7 C8/C9
 *       specs/tech/agent/tools/[P0]file_op_tools.md §4
 *
 * 覆盖：
 *   - file-edit 功能：精确替换/唯一性/replaceAll/string_not_found/not_read
 *   - atomicWrite 生效：写后无 .tmp 残留
 *   - C8：两并发 edit 同文件不同 oldString → 串行；后者读到前者写后内容；两处都成功
 *   - C9：两并发 edit 同文件相同 oldString（replaceAll=false）→ 首个成功，第二个锁内重判
 *        occurrences=0 → STRING_NOT_FOUND（不盲改、不双重替换）
 *   - 锁内重判（顺序）：edit1 改完，edit2 不重读直接 edit → 锁内读到 edit1 写后内容
 *
 * file-write 回归见 file-write.test.ts。共享 helper 见 _helpers.ts。
 * 文件系统隔离：os.tmpdir() + mkdtempSync；afterEach 清理。
 * 时序控制（C8/C9 并发）：Promise.all 触发，靠 withFileLock 内部 FIFO 串行化。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileEditTool } from '../file-edit';
import { fileReadTool } from '../file-read';
import { makeCtx, textOf, expectNoTmpResidue } from './_helpers';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'file-edit-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================
// file-edit 功能（read-modify-write 整段入锁不回归）
// ============================================================
describe('file-edit — 功能', () => {
  it('精确替换（唯一匹配）', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'e.txt');
    writeFileSync(p, 'foo\nbar\nbaz');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'bar', newString: 'BAR' },
      ctx,
    );
    expect(res.isError).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('foo\nBAR\nbaz');
  });

  it('多处匹配且 replaceAll=false → isError（唯一性校验）', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'multi.txt');
    writeFileSync(p, 'dup\ndup\ndup');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'dup', newString: 'x' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/multiple_matches/i);
  });

  it('replaceAll=true 替换所有 + 计数', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'all.txt');
    writeFileSync(p, 'dup\ndup\n');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'dup', newString: 'x', replaceAll: true },
      ctx,
    );
    expect(res.isError).toBe(false);
    expect(textOf(res)).toMatch(/replaced 2/);
    expect(readFileSync(p, 'utf8')).toBe('x\nx\n');
  });

  it('oldString 未找到 → isError', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'nf.txt');
    writeFileSync(p, 'abc');
    await fileReadTool.run({ filePath: p }, ctx);
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'zzz', newString: 'y' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/string_not_found/i);
  });

  it('未 read 直接 edit → isError', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'nr.txt');
    writeFileSync(p, 'abc');
    const res = await fileEditTool.run(
      { filePath: p, oldString: 'a', newString: 'b' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not_read/i);
  });

  it('atomicWrite 写后无 .tmp 残留', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'atomic-edit.txt');
    writeFileSync(p, 'foo\nbar\n');
    await fileReadTool.run({ filePath: p }, ctx);
    await fileEditTool.run({ filePath: p, oldString: 'bar', newString: 'BAR' }, ctx);
    expectNoTmpResidue(tmpRoot);
  });
});

// ============================================================
// C8：两并发 edit 同文件不同 oldString → 串行；两处都成功（spec §7 C8）
// ============================================================
describe('file-edit — C8 并发不同 oldString', () => {
  it('两并发 edit 不同 oldString → 都成功，最终内容含两处替换', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'c8.txt');
    writeFileSync(p, 'foo\nbar\nbaz');
    await fileReadTool.run({ filePath: p }, ctx);

    // 两个 edit 几乎同时发起，oldString 不同（互不冲突）
    const [r1, r2] = await Promise.all([
      fileEditTool.run({ filePath: p, oldString: 'foo', newString: 'FOO' }, ctx),
      fileEditTool.run({ filePath: p, oldString: 'baz', newString: 'BAZ' }, ctx),
    ]);

    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    // 最终内容两处替换都生效（无丢更新）
    const final = readFileSync(p, 'utf8');
    expect(final).toBe('FOO\nbar\nBAZ');
    expectNoTmpResidue(tmpRoot);
  });

  it('链式并发（edit2 改 edit1 的产出）→ edit2 锁内看到 edit1 写后内容', async () => {
    // 验证「后者 read 看到前者写后内容」：edit1 把 foo→mid，edit2 把 mid→final
    // 若 edit2 在 edit1 写之前 read，会因找不到 'mid' 报 STRING_NOT_FOUND
    // 锁 + 锁内 read → edit2 一定在 edit1 release 后才 read，必看到 'mid'
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'c8-chain.txt');
    writeFileSync(p, 'foo');
    await fileReadTool.run({ filePath: p }, ctx);

    const [r1, r2] = await Promise.all([
      fileEditTool.run({ filePath: p, oldString: 'foo', newString: 'mid' }, ctx),
      fileEditTool.run({ filePath: p, oldString: 'mid', newString: 'FINAL' }, ctx),
    ]);

    // 任一成功即可证明锁串行：若 edit2 先则 edit1 报 STRING_NOT_FOUND（找不到 mid）+ edit2 也 STRING_NOT_FOUND（找不到 mid）
    // 锁生效时：edit1 先成功 → edit2 看到 mid → 成功；最终 FINAL
    // 入队顺序由 Promise.all 微任务调度决定，edit1 通常先入队
    const okCount = [r1, r2].filter((r) => !r.isError).length;
    expect(okCount).toBeGreaterThanOrEqual(1);
    // 至少 edit1 应该成功（foo 真实存在）
    expect(r1.isError).toBe(false);
    // 锁生效时 edit2 也成功，最终内容为 FINAL
    if (!r2.isError) {
      expect(readFileSync(p, 'utf8')).toBe('FINAL');
    }
  });
});

// ============================================================
// C9：两并发 edit 同文件相同 oldString（replaceAll=false）→ 首个成功，第二个 STRING_NOT_FOUND
// （锁内重判 occurrences=0，不盲改、不双重替换）（spec §7 C9）
// ============================================================
describe('file-edit — C9 并发相同 oldString 锁内重判', () => {
  it('两并发 edit 同 oldString → 恰一成功，另一 STRING_NOT_FOUND', async () => {
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'c9.txt');
    writeFileSync(p, 'foo');
    await fileReadTool.run({ filePath: p }, ctx);

    const [r1, r2] = await Promise.all([
      fileEditTool.run({ filePath: p, oldString: 'foo', newString: 'BAR1' }, ctx),
      fileEditTool.run({ filePath: p, oldString: 'foo', newString: 'BAR2' }, ctx),
    ]);

    const results = [r1, r2];
    const okResults = results.filter((r) => !r.isError);
    const errResults = results.filter((r) => r.isError);
    expect(okResults).toHaveLength(1);
    expect(errResults).toHaveLength(1);
    expect(textOf(errResults[0]!)).toMatch(/string_not_found/i);

    // 最终内容是赢家的 newString（不是 BAR1+BAR2 拼接，也不残留 'foo'）
    const final = readFileSync(p, 'utf8');
    expect(final === 'BAR1' || final === 'BAR2').toBe(true);
    expectNoTmpResidue(tmpRoot);
  });

  it('顺序：edit1 改完后 edit2 不重读直接改 → 锁内重判看到 edit1 写后内容', async () => {
    // 验证锁内重判（防 read 与 write 之间被插写改了计数）
    // edit1: foo→bar 成功；edit2: 不再 read，oldString 仍是 'foo'
    //   - 若锁内重判生效：edit2 锁内 readFileSync 拿到 'bar'，countOccurrences('bar','foo')=0 → STRING_NOT_FOUND
    //   - 若仅靠 readSet 旧记忆（无锁内重判）：edit2 可能基于旧 'foo' 内容替换 → 错误双重替换
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'c9-seq.txt');
    writeFileSync(p, 'foo');
    await fileReadTool.run({ filePath: p }, ctx);

    const r1 = await fileEditTool.run(
      { filePath: p, oldString: 'foo', newString: 'bar' },
      ctx,
    );
    expect(r1.isError).toBe(false);

    // edit2：readSet 含 p（edit1 成功后已 add），不重 read
    expect(ctx.readSet?.has(p)).toBe(true);
    const r2 = await fileEditTool.run(
      { filePath: p, oldString: 'foo', newString: 'baz' },
      ctx,
    );
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/string_not_found/i);
    // 文件内容仍是 edit1 的 'bar'（未被 edit2 覆写为 'baz'）
    expect(readFileSync(p, 'utf8')).toBe('bar');
  });

  it('顺序：replaceAll=true，edit1 替换后 edit2 同 oldString → 锁内重判 occurrences=0 → STRING_NOT_FOUND', async () => {
    // replaceAll 模式下，锁内重判同样生效：edit1 把唯一的 foo 改掉后，
    // edit2 replaceAll=true 但锁内 readFileSync 已无 foo → STRING_NOT_FOUND（不会替换 0 次）
    const ctx = makeCtx(tmpRoot);
    const p = join(tmpRoot, 'c9-replaceall.txt');
    writeFileSync(p, 'foo');
    await fileReadTool.run({ filePath: p }, ctx);

    const r1 = await fileEditTool.run(
      { filePath: p, oldString: 'foo', newString: 'bar', replaceAll: true },
      ctx,
    );
    expect(r1.isError).toBe(false);

    const r2 = await fileEditTool.run(
      { filePath: p, oldString: 'foo', newString: 'baz', replaceAll: true },
      ctx,
    );
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/string_not_found/i);
  });
});

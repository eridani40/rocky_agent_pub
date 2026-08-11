/**
 * file-grep P3 崩溃加固测试（v0.0.328 生产 crash 针对性加固）
 * 参考: specs/tech/agent/tools/[P0]file_op_tools.md §6
 *       leader P3 派单（老板拍板：崩溃点针对性加固，不移出白名单）
 *
 * 覆盖（leader 派单 UT 要求：模拟 rg 不可用/超时/异常 → 断言返回错误不崩进程）：
 *   - rg 探测 spawnSync 抛异常（rg 不可用）→ 降级 JS，正常出结果不崩
 *   - rg 探测 OK 但 runRipgrep 超时（signal）→ 降级 JS
 *   - rg 探测 OK 但 runRipgrep spawnSync 抛异常 → 降级 JS
 *   - rg 返回 status>1（rg 内部错误）→ 降级 JS
 *   - rg 正常路径不回归（仍走 rg，且调用带 timeout）
 *
 * mock 策略：vi.mock('node:child_process') 替换 spawnSync（file-grep.ts 唯一 native 子进程点），
 * 其余 fs/path 保持真实（隔离 tmpdir）。每个用例 resetModules 刷新模块级 _rgAvailable 缓存。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, textOf } from './_helpers';

// spawnSync 行为控制（每个用例重设 mock 实现）
const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'grep-robust-'));
  writeFileSync(join(tmpRoot, 'a.ts'), 'export const HELLO = 1;\n');
  spawnSyncMock.mockReset();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 每个用例重新 import（刷新模块级 _rgAvailable 缓存，保证 mock 序列独立） */
async function loadGrepTool() {
  vi.resetModules();
  const mod = await import('../file-grep');
  return mod.fileGrepTool;
}

describe('file-grep P3 崩溃加固', () => {
  it('rg 探测 spawnSync 抛异常（rg 不可用）→ 降级 JS 正常出结果（不崩进程）', async () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('rg binary corrupted');
    });
    const tool = await loadGrepTool();
    const res = await tool.run({ pattern: 'HELLO', path: tmpRoot }, makeCtx(tmpRoot));
    expect(res.isError).toBe(false);
    expect(textOf(res)).toContain('a.ts');
    // 只探测一次，失败后不再尝试 rg（直接 JS 降级）
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('rg 探测 OK 但 runRipgrep 超时（signal 被杀）→ 降级 JS 正常出结果', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, signal: null, error: undefined, stdout: '' }) // --version OK
      .mockReturnValueOnce({ status: null, signal: 'SIGTERM', error: undefined, stdout: '' }); // 搜索超时被杀
    const tool = await loadGrepTool();
    const res = await tool.run({ pattern: 'HELLO', path: tmpRoot }, makeCtx(tmpRoot));
    expect(res.isError).toBe(false);
    expect(textOf(res)).toContain('a.ts');
  });

  it('rg 探测 OK 但 runRipgrep spawnSync 抛异常 → 降级 JS 正常出结果', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, signal: null, error: undefined, stdout: '' })
      .mockImplementationOnce(() => {
        throw new Error('spawn boom');
      });
    const tool = await loadGrepTool();
    const res = await tool.run({ pattern: 'HELLO', path: tmpRoot }, makeCtx(tmpRoot));
    expect(res.isError).toBe(false);
    expect(textOf(res)).toContain('a.ts');
  });

  it('rg 返回 status>1（rg 内部错误）→ 降级 JS 正常出结果', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, signal: null, error: undefined, stdout: '' })
      .mockReturnValueOnce({ status: 2, signal: null, error: undefined, stdout: '' });
    const tool = await loadGrepTool();
    const res = await tool.run({ pattern: 'HELLO', path: tmpRoot }, makeCtx(tmpRoot));
    expect(res.isError).toBe(false);
    expect(textOf(res)).toContain('a.ts');
  });

  it('rg 正常路径不回归（走 rg + 调用带 timeout 保护）', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, signal: null, error: undefined, stdout: '' })
      .mockReturnValueOnce({ status: 0, signal: null, error: undefined, stdout: 'a.ts\n' });
    const tool = await loadGrepTool();
    const res = await tool.run({ pattern: 'HELLO', path: tmpRoot }, makeCtx(tmpRoot));
    expect(res.isError).toBe(false);
    expect(textOf(res)).toContain('a.ts');
    expect(spawnSyncMock).toHaveBeenCalledTimes(2); // 探测 + 搜索都走 rg
    // 探测与搜索调用都必须带 timeout（防 rg 卡死拖垮进程）
    for (const args of spawnSyncMock.mock.calls) {
      expect(args[2]).toMatchObject({ timeout: expect.any(Number) });
    }
  });
});

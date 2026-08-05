/**
 * snapshot-store 单测（截图本地化）
 * 参考: app/server/src/tools/snapshot-store.ts
 *       specs/tech/version_logs/v0.0.157/change_plan.md §1 T1 + INV-157-2/3/4
 *
 * 覆盖 saveSnapshot 全分支（成功 / base64 归一 / mediaType→ext / 覆盖写 / mkdir recursive /
 * toolCallId 缺省 fallback / 落盘失败抛）+ formatSnapshotText 各分支（带/不带 size、
 * browser/computer 标签）。
 *
 * 文件系统隔离：os.tmpdir() + mkdtempSync；afterEach 清理。不触真实截图（假 data Buffer/base64）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSnapshot, formatSnapshotText } from './snapshot-store';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'snapshot-store-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('saveSnapshot — 落盘成功', () => {
  it('Buffer 输入：文件存在 + 内容正确 + 返 relPath=png', async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const r = await saveSnapshot({
      workdir: tmpRoot,
      toolCallId: 'call_1',
      data,
      mediaType: 'image/png',
      width: 800,
      height: 600,
    });
    // 路径返回形态
    expect(r.relPath).toBe('snapshots/call_1.png');
    expect(r.absPath).toBe(join(tmpRoot, 'snapshots', 'call_1.png'));
    expect(r.mediaType).toBe('image/png');
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    // 文件物理存在 + 内容正确
    expect(existsSync(r.absPath)).toBe(true);
    const written = readFileSync(r.absPath);
    expect(written.equals(data)).toBe(true);
  });

  it('base64 字符串归一：Buffer.from base64 解码后落盘内容一致', async () => {
    // "hello" 的 base64 = "aGVsbG8="
    const b64 = 'aGVsbG8=';
    const expected = Buffer.from(b64, 'base64');
    const r = await saveSnapshot({
      workdir: tmpRoot,
      toolCallId: 'call_b64',
      data: b64,
      mediaType: 'image/png',
    });
    const written = readFileSync(r.absPath);
    expect(written.equals(expected)).toBe(true);
  });
});

describe('saveSnapshot — mediaType → 扩展名映射', () => {
  it('image/png → .png', async () => {
    const r = await saveSnapshot({
      workdir: tmpRoot, toolCallId: 'p', data: Buffer.from('x'), mediaType: 'image/png',
    });
    expect(r.relPath.endsWith('.png')).toBe(true);
  });

  it('image/jpeg → .jpg', async () => {
    const r = await saveSnapshot({
      workdir: tmpRoot, toolCallId: 'j', data: Buffer.from('x'), mediaType: 'image/jpeg',
    });
    expect(r.relPath.endsWith('.jpg')).toBe(true);
  });

  it('image/jpg（非标 MIME）→ .jpg', async () => {
    const r = await saveSnapshot({
      workdir: tmpRoot, toolCallId: 'j2', data: Buffer.from('x'), mediaType: 'image/jpg',
    });
    expect(r.relPath.endsWith('.jpg')).toBe(true);
  });

  it('未知 MIME（如 image/webp）→ fallback .png', async () => {
    const r = await saveSnapshot({
      workdir: tmpRoot, toolCallId: 'w', data: Buffer.from('x'), mediaType: 'image/webp',
    });
    expect(r.relPath.endsWith('.png')).toBe(true);
  });

  it('空 MIME → fallback .png', async () => {
    const r = await saveSnapshot({
      workdir: tmpRoot, toolCallId: 'empty', data: Buffer.from('x'), mediaType: '',
    });
    expect(r.relPath.endsWith('.png')).toBe(true);
  });
});

describe('saveSnapshot — 重复 toolCallId 覆盖写', () => {
  it('同 toolCallId 第二次写入覆盖第一次内容', async () => {
    const id = 'call_dup';
    const first = Buffer.from([1, 2, 3]);
    const second = Buffer.from([4, 5, 6, 7]);
    const r1 = await saveSnapshot({
      workdir: tmpRoot, toolCallId: id, data: first, mediaType: 'image/png',
    });
    expect(readFileSync(r1.absPath).equals(first)).toBe(true);
    // 第二次（如 replay 重放同 tool call）
    const r2 = await saveSnapshot({
      workdir: tmpRoot, toolCallId: id, data: second, mediaType: 'image/png',
    });
    expect(r2.absPath).toBe(r1.absPath);
    expect(readFileSync(r2.absPath).equals(second)).toBe(true);
    expect(readFileSync(r2.absPath).equals(first)).toBe(false);
  });
});

describe('saveSnapshot — mkdir recursive', () => {
  it('snapshots 子目录不存在 → 自动创建（recursive）', async () => {
    // tmpRoot 刚 mkdtemp 创建，无 snapshots 子目录
    expect(existsSync(join(tmpRoot, 'snapshots'))).toBe(false);
    const r = await saveSnapshot({
      workdir: tmpRoot, toolCallId: 'mkdir_test', data: Buffer.from('x'), mediaType: 'image/png',
    });
    expect(existsSync(join(tmpRoot, 'snapshots'))).toBe(true);
    expect(statSync(join(tmpRoot, 'snapshots')).isDirectory()).toBe(true);
    expect(existsSync(r.absPath)).toBe(true);
  });
});

describe('saveSnapshot — toolCallId 缺省 fallback', () => {
  it('toolCallId undefined → fallback unknown-<ts> 路径模式', async () => {
    const before = Date.now();
    const r = await saveSnapshot({
      workdir: tmpRoot, data: Buffer.from('x'), mediaType: 'image/png',
    });
    const after = Date.now();
    // 路径形态：snapshots/unknown-<digits>.png
    expect(r.relPath).toMatch(/^snapshots\/unknown-\d+\.png$/);
    // ts 在合理区间（前后边界内）
    const tsStr = r.relPath.match(/^snapshots\/unknown-(\d+)\.png$/)?.[1];
    expect(tsStr).toBeDefined();
    const ts = Number(tsStr);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('toolCallId 空串 → 同 fallback 路径', async () => {
    const r = await saveSnapshot({
      workdir: tmpRoot, toolCallId: '', data: Buffer.from('x'), mediaType: 'image/png',
    });
    expect(r.relPath).toMatch(/^snapshots\/unknown-\d+\.png$/);
  });
});

describe('saveSnapshot — 落盘失败抛', () => {
  it('workdir 路径不可写（文件占位）→ 抛异常（不返回 errorResult）', async () => {
    // 用一个已存在的文件作为 workdir → mkdir 会失败（ENOTDIR）
    const filePathAsWorkdir = join(tmpRoot, 'i-am-a-file');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(filePathAsWorkdir, 'x'),
    );
    await expect(saveSnapshot({
      workdir: filePathAsWorkdir,
      toolCallId: 'fail',
      data: Buffer.from('x'),
      mediaType: 'image/png',
    })).rejects.toThrow();
  });
});

describe('formatSnapshotText — 各分支', () => {
  it('computer 默认形态：带尺寸 + mediaType', () => {
    const txt = formatSnapshotText({
      relPath: 'snapshots/call_1.png',
      width: 800,
      height: 600,
      mediaType: 'image/png',
    });
    expect(txt).toBe(
      'Saved screenshot to snapshots/call_1.png (800x600, image/png). Use see_image tool to view it.',
    );
  });

  it('computer 形态：无 mediaType → 仅尺寸段', () => {
    const txt = formatSnapshotText({
      relPath: 'snapshots/call_1.png',
      width: 800,
      height: 600,
    });
    expect(txt).toBe(
      'Saved screenshot to snapshots/call_1.png (800x600). Use see_image tool to view it.',
    );
  });

  it('computer 形态：尺寸缺省 → 只路径', () => {
    const txt = formatSnapshotText({
      relPath: 'snapshots/call_1.png',
    });
    expect(txt).toBe(
      'Saved screenshot to snapshots/call_1.png. Use see_image tool to view it.',
    );
  });

  it('computer 形态：只 width 缺 height → 视为无尺寸 → 只路径', () => {
    const txt = formatSnapshotText({
      relPath: 'snapshots/call_1.png',
      width: 800,
    });
    expect(txt).toBe(
      'Saved screenshot to snapshots/call_1.png. Use see_image tool to view it.',
    );
  });

  it('browser 形态：固定无尺寸 + browser 标签', () => {
    const txt = formatSnapshotText({
      relPath: 'snapshots/call_b.png',
      source: 'browser',
    });
    expect(txt).toBe(
      'Saved browser screenshot to snapshots/call_b.png. Use see_image tool to view it.',
    );
  });

  it('browser 形态：即便传了 width/height 也忽略尺寸段', () => {
    const txt = formatSnapshotText({
      relPath: 'snapshots/call_b.png',
      width: 1024,
      height: 768,
      mediaType: 'image/png',
      source: 'browser',
    });
    expect(txt).toBe(
      'Saved browser screenshot to snapshots/call_b.png. Use see_image tool to view it.',
    );
  });
});

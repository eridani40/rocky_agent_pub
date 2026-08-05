/**
 * image-utils（base64 helper）单测
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §5.1
 *
 * 覆盖：inferMediaType 扩展名映射 + readImageAsBase64 读文件正确性。
 * 用 os.tmpdir()+mkdtempSync 隔离（禁读写真实 ~/.oobt-desktop/ 路径）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inferMediaType, readImageAsBase64 } from '../image-utils';

describe('inferMediaType: 扩展名 → media_type 映射', () => {
  it('.png → image/png', () => {
    expect(inferMediaType('/a/b/c.png')).toBe('image/png');
  });

  it('.jpg / .jpeg → image/jpeg', () => {
    expect(inferMediaType('/a/b/c.jpg')).toBe('image/jpeg');
    expect(inferMediaType('/a/b/c.jpeg')).toBe('image/jpeg');
  });

  it('.gif → image/gif', () => {
    expect(inferMediaType('/a/b/c.gif')).toBe('image/gif');
  });

  it('.webp → image/webp', () => {
    expect(inferMediaType('/a/b/c.webp')).toBe('image/webp');
  });

  it('大小写不敏感（.PNG）', () => {
    expect(inferMediaType('/a/b/c.PNG')).toBe('image/png');
  });

  it('未识别扩展名兜底 image/png（防御性，tool 层已校验扩展名合法）', () => {
    expect(inferMediaType('/a/b/c.bmp')).toBe('image/png');
  });
});

describe('readImageAsBase64: 读文件 → 裸 base64', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('返回裸 base64（无 data: 前缀），字节内容与源文件一致', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'see-image-ut-'));
    const filePath = path.join(tmpDir, 'test.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG magic bytes
    fs.writeFileSync(filePath, bytes);

    const b64 = await readImageAsBase64(filePath);
    expect(b64).toBe(bytes.toString('base64'));
    expect(b64.startsWith('data:')).toBe(false);
    // 反解回来字节一致
    expect(Buffer.from(b64, 'base64')).toEqual(bytes);
  });
});

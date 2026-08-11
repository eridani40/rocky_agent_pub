/**
 * mediaTypeFromPath 单测 —— 扩展名 → MIME 映射覆盖
 */
import { describe, it, expect } from 'vitest';
import { mediaTypeFromPath } from '../media-type';

describe('mediaTypeFromPath', () => {
  it('png → image/png', () => {
    expect(mediaTypeFromPath('/abs/path/to.png')).toBe('image/png');
  });

  it('jpg → image/jpeg', () => {
    expect(mediaTypeFromPath('photo.jpg')).toBe('image/jpeg');
  });

  it('jpeg → image/jpeg', () => {
    expect(mediaTypeFromPath('photo.jpeg')).toBe('image/jpeg');
  });

  it('gif → image/gif', () => {
    expect(mediaTypeFromPath('anim.gif')).toBe('image/gif');
  });

  it('webp → image/webp', () => {
    expect(mediaTypeFromPath('pic.webp')).toBe('image/webp');
  });

  it('svg → image/svg+xml', () => {
    expect(mediaTypeFromPath('icon.svg')).toBe('image/svg+xml');
  });

  it('大小写不敏感（PNG/JPEG/WebP）', () => {
    expect(mediaTypeFromPath('A.PNG')).toBe('image/png');
    expect(mediaTypeFromPath('B.JPEG')).toBe('image/jpeg');
    expect(mediaTypeFromPath('C.WebP')).toBe('image/webp');
  });

  it('未知扩展名 → application/octet-stream', () => {
    expect(mediaTypeFromPath('file.xyz')).toBe('application/octet-stream');
  });

  it('无扩展名 → application/octet-stream', () => {
    expect(mediaTypeFromPath('noext')).toBe('application/octet-stream');
  });

  it('空字符串 → application/octet-stream', () => {
    expect(mediaTypeFromPath('')).toBe('application/octet-stream');
  });

  it('路径含多点（a.b.png → image/png）', () => {
    expect(mediaTypeFromPath('dir/sub.dir/file.name.png')).toBe('image/png');
  });
});

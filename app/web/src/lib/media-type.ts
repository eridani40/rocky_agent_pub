/**
 * media-type —— 图片扩展名 → MIME 类型映射（单一权威）
 *
 * 从 component-ws-image-viewer.tsx 提取为共享函数，消除 primitive-markdown-image.tsx
 * 硬编码 `image/unknown` 的 BUG（Chromium 不认该 MIME → 图片加载失败）。
 * 6 格式白名单闭合；兜底 octet-stream 防御。
 */

/** 扩展名 → MIME 类型（6 格式白名单；未知扩展名兜底 octet-stream） */
const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/**
 * 从文件路径提取扩展名推断 MIME 类型。
 * - `/abs/path/to.png` → `image/png`
 * - `photo.JPEG` → `image/jpeg`（大小写不敏感）
 * - `unknown.xyz` → `application/octet-stream`（兜底）
 */
export function mediaTypeFromPath(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

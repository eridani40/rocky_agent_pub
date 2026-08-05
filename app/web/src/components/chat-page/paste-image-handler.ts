/**
 * paste-image-handler —— 粘贴剪切板图片 → 落盘 → 插 @file pill
 * 参考: specs/tech/mention/message-content.md §3.1/§3.2（file mention + icon='file'）
 * 多图顺序 await（保 pill DOM 顺序与剪切板 items 一致），失败 console.warn 不阻塞其他；
 * filename / ulid 由 server 单一权威生成，client 不参与命名。
 */
import type { Editor } from '@tiptap/react';
import { saveImage } from '../../lib/chat-api/workspace-api';

/**
 * 处理粘贴事件中的图片项：拦截 image/* item → 落盘 → 插 @file pill。
 *
 * @param editor Tiptap editor 实例（用于 chain().focus().insertMention）
 * @param sessionId 当前会话 ULID
 * @param clipboardData 粘贴事件的 DataTransfer
 * @returns 是否处理了至少一张图片（true 阻止 Tiptap 默认粘贴文本）
 */
export async function processImagePaste(
  editor: Editor,
  sessionId: string,
  clipboardData: DataTransfer,
): Promise<boolean> {
  // 从 items 中筛出 image/* 项（kind==='file' && type 以 image/ 开头）
  const items = Array.from(clipboardData.items);
  const imageItems = items.filter(
    (it) => it.kind === 'file' && it.type.startsWith('image/'),
  );
  if (imageItems.length === 0) return false;

  let inserted = false;
  // 多图顺序 await（禁 Promise.all，保 pill DOM 顺序与剪切板 items 一致）
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue; // item 类型为 file 但 getFile 失败 → 跳过
    try {
      const base64 = await blobToBase64(file);
      const { path: relPath } = await saveImage(sessionId, {
        mediaType: file.type || 'image/png',
        base64,
      });
      const filename = basename(relPath);
      editor
        .chain()
        .focus()
        .insertMention({ type: 'file', path: relPath, icon: 'file', label: filename })
        .run();
      inserted = true;
    } catch (err) {
      // 上传失败：warn + 不插对应 pill，继续处理下一张（不阻塞）
      console.warn('[paste-image-handler] save image failed', err);
    }
  }
  return inserted;
}

/**
 * Blob → 纯 base64 字符串（剥 data URL 的 base64 前缀）。
 * 用 Promise wrap FileReader.onload/onerror（不调 await blob.text()，避免乱码）。
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      // 剥 data:<mime>;base64, 前缀，返回纯 base64
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

/** 取 POSIX 路径最后一段（basename），用于 pill label（不带 path 前缀） */
function basename(posixPath: string): string {
  const idx = posixPath.lastIndexOf('/');
  return idx >= 0 ? posixPath.slice(idx + 1) : posixPath;
}

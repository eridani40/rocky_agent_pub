/**
 * see_image 内部 base64 helper —— 仅供 provider（minimax-provider.ts / zhipu-image-provider.ts）
 * 内部调用，不导出到 tool 层协议返回值。
 * 参考: specs/tech/agent/tools/[P1]see_image_tool.md §5.1
 *       tests/e2e/vision_check.py image_to_base64（media_type 映射蓝本）
 *
 * 硬约束：读文件 → base64 只发生在 vender 出站传输环节，绝不回流到 SeeImageResult
 * （tool 层协议出参）——两个 provider 的 understand() 内部消费本模块后即把 base64
 * 丢弃，只把纯文字理解结果放进返回值。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 扩展名 → media_type 映射（与 see-image/tool.ts 的 SUPPORTED_IMAGE_EXT 保持一致） */
const MEDIA_TYPE_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 按文件扩展名推断 media_type（小写匹配）。
 * tool 层已校验扩展名 ∈ SUPPORTED_IMAGE_EXT，未识别时兜底 image/png（防御性）。
 */
export function inferMediaType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  return MEDIA_TYPE_MAP[ext] ?? 'image/png';
}

/**
 * 读绝对路径图片文件 → 裸 base64（无 `data:` 前缀）。
 * 仅供 provider.understand() 内部调用；base64 只用于出站 API 传输 body 构造。
 */
export async function readImageAsBase64(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return buf.toString('base64');
}

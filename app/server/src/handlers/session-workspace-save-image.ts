/**
 * session-workspace-save-image handler —— 粘贴图片落盘 ws/images/image-<ulid>.<ext>
 * 参考: specs/api/overall/04-agent-session.md §2.6.6
 * 安全：filename 由 server 生成（ulid + 闭合 ext），仍守 absPath.startsWith(realRoot + sep) 兜底
 */
import * as fsp from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ulid } from '../config/ulid';
import type { SessionHandlerDeps } from './session';
import { json } from './session-workspace';

/** POST body（spec §2.6.6） */
interface SaveImageBody {
  /** MIME，必须 image/*（如 'image/png'），且在闭合集内 */
  mediaType: string;
  /** 纯 base64（无 data:image/...;base64, 前缀），非空 */
  base64: string;
}

/** 200 响应（spec §2.6.6） */
interface SaveImageResponse {
  /** 相对 workspaceDir 的 POSIX 路径，如 'images/image-01JK...' */
  path: string;
}

/** 按 mediaType 推导图片扩展名（闭合集合 4 类）；未识别 throw，caller 转 400。 */
function mediaTypeToImageExt(mediaType: string): string {
  switch (mediaType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      throw new Error('unsupported image mediaType');
  }
}

/**
 * POST /session/:id/workspace/save-image —— 粘贴图片落盘 + 返 relPath（spec §2.6.6）。
 * 错误：405 / 404 / 400（body 非法 / mediaType 不支持）/ 500（workspace / fs 失败）。
 * 安全：error message 不回显 base64 / 文件内容 / 绝对路径。
 */
export async function handleWorkspaceSaveImage(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // body 解析
  let bodyMedia = '';
  let bodyB64 = '';
  try {
    const parsed = (await req.json()) as Partial<SaveImageBody>;
    if (typeof parsed.mediaType === 'string') bodyMedia = parsed.mediaType;
    if (typeof parsed.base64 === 'string') bodyB64 = parsed.base64;
  } catch {
    return json(400, { error: 'invalid json body' });
  }

  // mediaType 必须是 image/*
  if (!bodyMedia.startsWith('image/')) {
    return json(400, { error: 'mediaType must be image/*' });
  }
  // base64 非空
  if (!bodyB64) {
    return json(400, { error: 'base64 required' });
  }

  // ext 推导（不识别 → 400）
  let ext: string;
  try {
    ext = mediaTypeToImageExt(bodyMedia);
  } catch {
    return json(400, { error: 'unsupported image mediaType' });
  }

  const workspaceDir = got.workspaceDir;
  if (!workspaceDir) {
    return json(500, { error: 'session has no workspaceDir' });
  }

  // realpath workspaceDir（防 workspaceDir 自身含 symlink 段）
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceDir);
  } catch {
    return json(500, { error: 'workspaceDir not readable' });
  }

  // 服务端生成 filename（ulid + 闭合 ext）→ 客户端无路径控制权
  const imageId = ulid();
  const filename = `image-${imageId}${ext}`;
  const dirAbs = resolve(realRoot, 'images');
  const absPath = resolve(dirAbs, filename);

  // 白名单二次守卫：absPath 必须在 realRoot 内（防 ulid/ext 注入；虽自生成仍守卫）
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (!absPath.startsWith(rootWithSep)) {
    return json(400, { error: 'path out of workspace (traversal denied)' });
  }

  // 落盘（fsp.mkdir recursive + writeFile；任一 reject → 500）
  try {
    await fsp.mkdir(dirAbs, { recursive: true });
    await fsp.writeFile(absPath, Buffer.from(bodyB64, 'base64'));
  } catch {
    return json(500, { error: 'image save failed' });
  }

  // relPath = POSIX 相对 workspaceDir（filename 由 server 生成，直接模板串拼，POSIX 一致）
  const relPath = `images/${filename}`;
  const responseBody: SaveImageResponse = { path: relPath };
  return json(200, responseBody);
}

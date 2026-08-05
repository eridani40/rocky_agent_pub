/**
 * skill 文件读写原语 —— /skill 域与 academy 版本 skill 域共用（单一权威实现）
 * 参考: specs/api/overall/06-skill.md §7.2/§7.3（读契约 + 越界/二进制/截断口径）
 *       specs/api/overall/18-academy.md §1.11（academy 版本 skill 单文件读/写复用本原语）
 *
 * 职责：给定「根目录 + 相对路径」，安全读/写单个文本文件。
 *   - 路径越界守卫（resolve 后必须落在根目录内）
 *   - 二进制识别（前 8000 字节含 NUL）
 *   - 大文件截断（256KB）
 *   - 写只覆写「已存在的非二进制文件」——不建文件/不建目录/不删文件（最小写权限面）
 *
 * 设计：错误走判别联合（不抛异常做流控），caller 按 error 映射 HTTP 状态码；
 * 本模块不认识 HTTP，也不认识 skill 定位规则（skillDir 由 caller 给定）。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** 大文件截断阈值（06-skill §7.2，256KB） */
export const MAX_FILE_CHARS = 256 * 1024;

/** 读成功结果（响应 shape 与 06-skill §7.2 / 18-academy §1.11.1 一致） */
export interface SkillFileReadOk {
  ok: true;
  /** 回显 caller 给的相对路径（不外泄绝对路径） */
  path: string;
  /** 文本内容；binary=true 时为空串 */
  content: string;
  /** 是否因超过 MAX_FILE_CHARS 被截断 */
  truncated: boolean;
  /** 是否二进制（前端显「不可预览」） */
  binary: boolean;
}

/** 写成功结果 */
export interface SkillFileWriteOk {
  ok: true;
  path: string;
}

/**
 * IO 失败原因（caller 映射 HTTP）：
 *   - invalid_path：相对路径缺失/越界 → 400
 *   - not_found：目标不存在或不是文件 → 404
 *   - binary_target：写目标是二进制文件（拒写，避免 utf8 覆写损坏字节流）→ 400
 */
export interface SkillFileIoError {
  ok: false;
  error: 'invalid_path' | 'not_found' | 'binary_target';
}

export type SkillFileReadResult = SkillFileReadOk | SkillFileIoError;
export type SkillFileWriteResult = SkillFileWriteOk | SkillFileIoError;

/**
 * 路径越界守卫：把 relPath 解析到 rootDir 内的绝对路径。
 * 越界（`../` 逃逸 / 绝对路径 / 同前缀兄弟目录冒充）返 null。
 *
 * 用 `sep` 结尾比较而非字符串 includes —— 防 `/a/bc` 冒充 `/a/b` 的前缀。
 *
 * @param rootDir 根目录绝对路径
 * @param relPath 相对路径（相对 rootDir）
 * @returns 目录内绝对路径；越界返 null
 */
export function resolveInsideDir(rootDir: string, relPath: string): string | null {
  const abs = resolve(rootDir, relPath);
  const rootWithSep = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  // abs + sep 保证 abs === rootDir 时也算「在内」（与既有 /skill/:name/file 行为一致）
  return (abs + sep).startsWith(rootWithSep) ? abs : null;
}

/**
 * 二进制识别：前 8000 字节含 NUL 视为二进制（06-skill §7.2 口径）。
 */
export function isBinaryBuffer(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 8000); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * 读 rootDir 内单文件（越界守卫 → 存在性 → 二进制标记 → utf8 + 截断）。
 *
 * @param rootDir skill 目录绝对路径
 * @param relPath 相对 rootDir 的路径（空串视为非法）
 */
export function readSkillFile(rootDir: string, relPath: string): SkillFileReadResult {
  if (!relPath) return { ok: false, error: 'invalid_path' };
  const abs = resolveInsideDir(rootDir, relPath);
  if (!abs) return { ok: false, error: 'invalid_path' };
  if (!isExistingFile(abs)) return { ok: false, error: 'not_found' };

  const buf = readFileSync(abs);
  if (isBinaryBuffer(buf)) {
    return { ok: true, path: relPath, content: '', truncated: false, binary: true };
  }
  let text = buf.toString('utf8');
  let truncated = false;
  if (text.length > MAX_FILE_CHARS) {
    text = text.slice(0, MAX_FILE_CHARS);
    truncated = true;
  }
  return { ok: true, path: relPath, content: text, truncated, binary: false };
}

/**
 * 覆写 rootDir 内已存在的文本文件（utf8）。
 *
 * 写权限面刻意最小：目标必须已存在且是文件、且非二进制——
 * 不创建新文件、不建目录、不删文件（无对应 UI，多余写权限就是多余风险面）。
 *
 * @param rootDir skill 目录绝对路径
 * @param relPath 相对 rootDir 的路径
 * @param content 新全文（utf8）
 */
export function writeSkillFile(
  rootDir: string,
  relPath: string,
  content: string,
): SkillFileWriteResult {
  if (!relPath) return { ok: false, error: 'invalid_path' };
  const abs = resolveInsideDir(rootDir, relPath);
  if (!abs) return { ok: false, error: 'invalid_path' };
  if (!isExistingFile(abs)) return { ok: false, error: 'not_found' };
  // 二进制目标拒写：utf8 覆写会损坏字节流（且本版无二进制编辑 UI）
  if (isBinaryBuffer(readFileSync(abs))) return { ok: false, error: 'binary_target' };

  writeFileSync(abs, content, 'utf8');
  return { ok: true, path: relPath };
}

/** 存在且是普通文件 */
function isExistingFile(abs: string): boolean {
  try {
    return existsSync(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

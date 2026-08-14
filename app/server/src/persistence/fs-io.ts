/**
 * FsCrudStore 通用 IO — 同步原子写 + JSON 读写（spec §3.6）
 * 参考: specs/tech/persistence/[P0]fs_crud_store_engine.md §3.6（原子写不变）
 *
 * CrudStore 契约是同步签名（crud-types.ts put/get 返回 StoredRecord 非 Promise），
 * 与 bun:sqlite 同步风格对齐；FS engine 用 node:fs 同步 API 实现。
 *
 * 所有写入走「写 <tmp> → fsync → renameSync」，保证崩溃原子性
 * （rename 在同一文件系统上原子；要么旧版本完整、要么新版本完整）。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** 确保目录存在（递归 mkdir，幂等） */
export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 原子写文件（spec §3.6）。
 *   1. 在目标同目录下写 <name>.tmp
 *   2. fsync 刷盘
 *   3. renameSync 覆盖目标（同 fs 原子）
 *
 * 目标与 tmp 同目录，保证 rename 不跨文件系统。
 */
export function atomicWriteSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * 原子写文件（async 版，fs.promises；语义同 atomicWriteSync）。
 * [v0.0.345] 工具层专用：tools/ 下 fs 操作一律真异步（libuv 线程池，不阻塞 event loop）。
 *
 *   1. 在目标同目录下写 <name>.tmp
 *   2. fsync 刷盘
 *   3. rename 覆盖目标（同 fs 原子）
 *
 * 目标与 tmp 同目录，保证 rename 不跨文件系统。
 * 异常时清理 tmp（finally 兜底），不残留半成品文件。
 */
export async function atomicWriteAsync(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  let written = false;
  try {
    await handle.writeFile(content);
    await handle.sync();
    written = true;
  } finally {
    await handle.close().catch(() => {});
    // 写/fsync 失败 → 清理 tmp，不残留半成品（finally 兜底）
    if (!written) await fsp.unlink(tmp).catch(() => {});
  }
  try {
    await fsp.rename(tmp, filePath);
  } catch (e) {
    // rename 失败（跨 fs / 权限等）→ 清理 tmp，不残留
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

/** 读 JSON 文件，文件不存在返回 undefined；存在但解析失败抛错（不静默吞） */
export function readJsonFileSync<T = unknown>(filePath: string): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(raw) as T;
}

/** 删除文件，返回是否实际删除（不存在返回 false） */
export function removeFileSync(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** 列目录项；不存在返回空数组 */
export function readDirSafeSync(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** 列目录项含类型；不存在返回空数组 */
export function readDirWithTypeSync(
  dir: string,
): { name: string; isDirectory: boolean }[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** 列某目录下所有 .jsonl 段文件名（去后缀），按字典序返回（spec §3.2 段名序=id 范围序） */
export function listSegmentIdsSync(segmentDir: string): string[] {
  return readDirSafeSync(segmentDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

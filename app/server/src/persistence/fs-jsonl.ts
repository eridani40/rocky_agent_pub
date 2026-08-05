/**
 * FsCrudStore jsonl 段文件读写（spec §3.2-§3.5）
 * 参考: specs/tech/persistence/[P0]fs_crud_store_engine.md §3.2-§3.5/§4
 *
 * 段文件语义：
 *   - 段名 = 段首条（最小 id）ULID（§3.2），段名集合字典序 = id 范围序
 *   - 段内每行一条记录、按 id 升序（§3.3）
 *   - 段达 jsonlMaxCount 封顶 → roll 新段（§3.3）
 *
 * insert 两条路径（§3.4）：
 *   - append 尾段：新 id > shard 最大 id；尾段满则新开一段
 *   - 重写插入：新 id < 最大 id（乱序回填）→ 二分定位段 + 重写段插到正确位置
 *
 * delete/update → 重写段，无 tombstone（§3.5）。
 * 所有重写走 atomicWriteSync（§3.6）。
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteSync, removeFileSync, listSegmentIdsSync } from './fs-io';
import { jsonlSegmentFile } from './fs-paths';

/** 段文件内一条记录 = 一行 JSON */
type Row = Record<string, unknown>;

/** 读单个段文件全部行（按行 JSON.parse）；文件不存在返回 undefined */
function readSegment(segPath: string): Row[] | undefined {
  let raw: string;
  try {
    raw = readRaw(segPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as Row);
}

// 直接读 utf8 文本（段文件需逐行 parse）
function readRaw(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** 写段：把 rows 序列化为每行 JSON，原子写覆盖 */
function writeSegment(segPath: string, rows: Row[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
  atomicWriteSync(segPath, body);
}

/** 段目录 */
function segPath(dir: string, segmentId: string): string {
  return path.join(dir, jsonlSegmentFile(segmentId));
}

/**
 * 二分定位 id 所属段（段名集合按字典序）。
 * 段名 = 段首条 ULID；id 落在 [segName, nextSegName) 区间。
 * 返回段名；id 小于首段名则返回首段（理论不会发生，因段名即首条 id）。
 */
function locateSegment(segNames: string[], id: string): string | undefined {
  if (segNames.length === 0) return undefined;
  // 找最大的 segName <= id
  let lo = 0;
  let hi = segNames.length - 1;
  let ans: string | undefined = segNames[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const name = segNames[mid];
    if (name !== undefined && name <= id) {
      ans = name;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * jsonl 段文件写入/更新一条记录（spec §3.3-§3.5 + §4 put 映射）。
 * @param dir entity 段目录（已含 dirTemplate 路径）
 * @param id 主键
 * @param stored 完整记录（含信封）
 * @param maxCount 单段最大记录数
 */
export function jsonlPut(dir: string, id: string, stored: Row, maxCount: number): void {
  const segNames = listSegmentIdsSync(dir);

  // 无段 → 新建首段（段名=id）
  if (segNames.length === 0) {
    writeSegment(segPath(dir, id), [stored]);
    return;
  }

  // 最大段名（= 当前 shard 最大 id 范围段）
  const lastSeg = segNames[segNames.length - 1] ?? id;
  const lastRows = readSegment(segPath(dir, lastSeg)) ?? [];

  // 取 shard 当前最大 id
  const lastRowId =
    lastRows.length > 0 ? ((lastRows[lastRows.length - 1] ?? {}).id as string | undefined) : lastSeg;
  const maxId = lastRowId ?? lastSeg;

  if (id > maxId) {
    // §3.4 append 尾段：尾段未满→append；满→新开一段（段名=id）
    if (lastRows.length < maxCount) {
      lastRows.push(stored); // 保证按 id 有序（id>maxId）
      writeSegment(segPath(dir, lastSeg), lastRows);
    } else {
      writeSegment(segPath(dir, id), [stored]);
    }
    return;
  }

  // §3.4 乱序/回填：二分定位段 + 重写段插到正确行位置
  const targetSeg = locateSegment(segNames, id) ?? segNames[0] ?? id;
  const targetPath = segPath(dir, targetSeg);
  const rows = readSegment(targetPath) ?? [];

  // 找到插入位置（段内按 id 升序）
  let i = 0;
  while (i < rows.length) {
    const rid = (rows[i]?.id as string) ?? '';
    if (rid >= id) break;
    i++;
  }
  const atRow = rows[i];
  if (atRow && atRow.id === id) {
    rows[i] = stored; // update（覆盖）
    writeSegment(targetPath, rows);
    return;
  }
  rows.splice(i, 0, stored); // 插入

  // 插入后段首条可能 < 段名 → 段名需更新为新的首条 ULID（spec §3.2 段名=段首条）
  const newFirstId = (rows[0]?.id as string) ?? id;
  if (newFirstId !== targetSeg) {
    removeFileSync(targetPath);
    writeSegment(segPath(dir, newFirstId), rows);
  } else {
    writeSegment(targetPath, rows);
  }
}

/** 从段文件读取一条记录（按 id 二分段名 + 段内行查找） */
export function jsonlGet(dir: string, id: string): Row | undefined {
  const segNames = listSegmentIdsSync(dir);
  if (segNames.length === 0) return undefined;
  const segName = locateSegment(segNames, id) ?? segNames[0];
  if (!segName) return undefined;
  const rows = readSegment(segPath(dir, segName));
  if (!rows) return undefined;
  // 段内有序，二分查找
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midId = (rows[mid]?.id as string) ?? '';
    if (midId === id) return rows[mid];
    if (midId < id) lo = mid + 1;
    else hi = mid - 1;
  }
  // 兜底：乱序历史可能跨段边界，线性扫一遍
  return rows.find((r) => r.id === id);
}

/** 删除一条记录：重写段删行（§3.5）；段空则删段文件 */
export function jsonlDelete(dir: string, id: string): boolean {
  const segNames = listSegmentIdsSync(dir);
  if (segNames.length === 0) return false;
  const segName = locateSegment(segNames, id) ?? segNames[0];
  if (!segName) return false;
  const target = segPath(dir, segName);
  const rows = readSegment(target);
  if (!rows) return false;
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) {
    // 兜底跨段扫描
    for (const sn of segNames) {
      const r2 = readSegment(segPath(dir, sn));
      const j = r2?.findIndex((r) => r.id === id) ?? -1;
      if (j >= 0 && r2) {
        r2.splice(j, 1);
        if (r2.length === 0) removeFileSync(segPath(dir, sn));
        else writeSegment(segPath(dir, sn), r2);
        return true;
      }
    }
    return false;
  }
  rows.splice(idx, 1);
  if (rows.length === 0) {
    removeFileSync(target);
  } else {
    // 段首条可能变了 → 段名需更新为新的首条 ULID（spec §3.2）
    const newFirst = (rows[0]?.id as string) ?? id;
    if (newFirst !== segName) {
      removeFileSync(target);
      writeSegment(segPath(dir, newFirst), rows);
    } else {
      writeSegment(target, rows);
    }
  }
  return true;
}

/**
 * 拉取段目录下所有记录（用于 query），按 id 升序返回。
 * 「最近 N」由上层 applyFilter 的 order/limit 处理。
 */
export function jsonlQuerySegments(dir: string): Row[] {
  const segNames = listSegmentIdsSync(dir);
  const out: Row[] = [];
  for (const sn of segNames) {
    const rows = readSegment(segPath(dir, sn)) ?? [];
    out.push(...rows);
  }
  // 按 id 升序（上层 applyFilter 再按 createdAt 排序）
  out.sort((a, b) => (a.id as string).localeCompare(b.id as string));
  return out;
}

/** 仅供测试断言段文件结构：返回 {段名 → 行数} 映射，按段名字典序 */
export function debugSegmentStats(dir: string): { name: string; count: number; firstId?: string; lastId?: string }[] {
  return listSegmentIdsSync(dir).map((name) => {
    const rows = readSegment(segPath(dir, name)) ?? [];
    return {
      name,
      count: rows.length,
      firstId: rows[0]?.id as string | undefined,
      lastId: rows[rows.length - 1]?.id as string | undefined,
    };
  });
}

/**
 * FsCrudStore 路径计算 — 纯函数（spec §2 目录布局 / §3.1 分片路由）
 * 参考: specs/tech/persistence/[P0]fs_crud_store_engine.md §2-§3
 *       states/v0.0.2/task.json keyDecisions.fsLayout
 *
 * 核心规则（keyDecisions.fsLayout「配什么就是什么」）：
 *   - root 是基目录，所有路径从它起拼接
 *   - dirTemplate 是相对 root 的分片路径模板（仅 fs.sharding 存在时消费）
 *   - engine 老实拼接 root + dirTemplate(已替换) + entity + 文件，不自加前缀
 *   - 不分片（无 sharding）时：{root}/{entity}/<file>
 *   - 分片：{root}/{dirTemplate 中 {shardKey} 替换为字段值}/{entity}/<file>
 *
 * 此处不含 IO，只算路径字符串；IO 见 fs-io.ts / fs-jsonl.ts。
 */
import type { SchemaDef } from './schema-types';

/** 规范化路径段拼接（保留首段前导斜杠为绝对路径，去尾斜杠与重复斜杠） */
function join(...parts: string[]): string {
  const clean = parts.map((p) => p.replace(/\/+$/, ''));
  // 首段保留前导斜杠（绝对路径），其余段去前导斜杠
  let leading = '';
  if (clean.length > 0 && clean[0] !== undefined) {
    const first = clean[0];
    leading = first.startsWith('/') ? '/' : '';
    clean[0] = first.replace(/^\/+/, '');
  }
  return (
    leading +
    clean
      .map((p) => p?.replace(/^\/+/, '') ?? '')
      .filter((p) => p.length > 0)
      .join('/')
  );
}

/**
 * 把 dirTemplate 中的 {shardKey} 替换为字段值，并 trim 尾斜杠。
 * 返回相对 root 的路径段（不含 root 前缀），如 `sessions/<sid>`。
 * 不分片 schema 调用此函数将抛错。
 */
export function resolveDirTemplate(schema: SchemaDef, shardKey: string): string {
  const sharding = schema.fs?.sharding;
  if (!sharding) {
    throw new Error(`entity ${schema.entity} 未配置 fs.sharding，不应调用 resolveDirTemplate`);
  }
  return sharding.dirTemplate.replace(/\{shardKey\}/g, shardKey).replace(/\/+$/, '');
}

/**
 * 计算 entity 目录（不含具体文件名）。
 *   - 不分片：{root}/{entity}
 *   - 分片：{root}/{dirTemplate(替换)}/{entity}
 *
 * @param shardKey 分片 schema 必填；不分片 schema 忽略
 */
export function entityDir(root: string, schema: SchemaDef, shardKey?: string): string {
  const parts = [root];
  if (schema.fs?.sharding) {
    if (shardKey === undefined) {
      throw new Error(
        `entity ${schema.entity} 是分片 schema，entityDir 必须传 shardKey`,
      );
    }
    parts.push(resolveDirTemplate(schema, shardKey));
  }
  parts.push(schema.entity);
  return join(...parts);
}

/**
 * 分片根目录（dirTemplate 头部静态段所在目录），用于 scatter 遍历各 shard。
 * 如 dirTemplate="sessions/{shardKey}/" → 返回 {root}/sessions。
 *
 * 实现思路：把 dirTemplate 中 {shardKey} 当作「终点」，取其前缀。
 * 若 {shardKey} 位于模板首段（如 "{shardKey}/"），shard 根即 {root}。
 */
export function shardRootPrefix(root: string, schema: SchemaDef): string {
  const sharding = schema.fs?.sharding;
  if (!sharding) {
    throw new Error(`entity ${schema.entity} 未配置 fs.sharding`);
  }
  const tpl = sharding.dirTemplate;
  const idx = tpl.indexOf('{shardKey}');
  if (idx < 0) {
    throw new Error(`dirTemplate 必须含 {shardKey} 占位符：${tpl}`);
  }
  const prefix = tpl.slice(0, idx).replace(/\/+$/, '');
  return prefix.length > 0 ? join(root, prefix) : join(root);
}

/**
 * 计算某个 shard 的根目录（dirTemplate 已替换），用于列举/落 shard 目录。
 * 返回 {root}/{dirTemplate(替换 shardKey)}。
 */
export function shardRootDir(root: string, schema: SchemaDef, shardKey: string): string {
  const sharding = schema.fs?.sharding;
  if (!sharding) {
    throw new Error(`entity ${schema.entity} 未配置 fs.sharding`);
  }
  return join(root, resolveDirTemplate(schema, shardKey));
}

/** json 单记录文件名：<id>.json */
export function jsonRecordFile(id: string): string {
  return `${id}.json`;
}

/** jsonl 段文件名：<segmentId>.jsonl（segmentId 即段首条 ULID） */
export function jsonlSegmentFile(segmentId: string): string {
  return `${segmentId}.jsonl`;
}

/** resolveRecordPath 的可选路由参数 */
export interface ResolvePathOpts {
  /** 分片 schema 必填 */
  shardKey?: string;
  /** jsonl 段名（= 段首条 ULID）；json 单记录格式不传 */
  segment?: string;
}

/**
 * 计算某条记录的完整文件路径。
 *   - 不分片 json：{root}/{entity}/{id}.json
 *   - 分片 json：{root}/{dirTemplate}/{entity}/{id}.json
 *   - 分片 jsonl：{root}/{dirTemplate}/{entity}/{segment}.jsonl（segment 调用方算出）
 *
 * 不分片 schema 传 shardKey/segment 会被忽略。
 */
export function resolveRecordPath(
  root: string,
  schema: SchemaDef,
  id: string,
  opts?: ResolvePathOpts,
): string {
  const dir = entityDir(root, schema, opts?.shardKey);
  const isJsonl = schema.fs?.format === 'jsonl';
  if (isJsonl) {
    if (!opts?.segment) {
      throw new Error(`entity ${schema.entity} 是 jsonl 格式，必须传 segment 段名`);
    }
    return join(dir, jsonlSegmentFile(opts.segment));
  }
  return join(dir, jsonRecordFile(id));
}

export { join };

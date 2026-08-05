/**
 * FsCrudStore 路径计算单测（spec §2 目录布局）
 * 参考: specs/tech/persistence/[P0]fs_crud_store_engine.md §2/§3.1
 *       states/v0.0.2/verify/test-plan.md §3 FsCrudStore 维度
 *
 * 覆盖 keyDecisions.fsLayout「root 基目录 + dirTemplate 相对 root + engine 老实拼接不自加前缀」：
 *   - 不分片：{root}/{entity}/<file>
 *   - 分片：{root}/{dirTemplate(已替换)}/{entity}/<file>
 *   - 同 shardKey 多 entity 聚同 shard 目录
 *   - dirTemplate 不写某段则不出现该段（不自加前缀）
 */
import { describe, it, expect } from 'vitest';
import {
  entityDir,
  shardRootDir,
  shardRootPrefix,
  jsonRecordFile,
  jsonlSegmentFile,
  resolveRecordPath,
} from '../fs-paths';
import type { SchemaDef } from '../schema-types';

// 不分片 entity（扁平目录 json）
const FlatSchema = {
  entity: 'app_config',
  engine: 'file',
  fields: { id: { type: 'ulid', required: true } },
} as const satisfies SchemaDef;

// 分片 entity（transcript 风格：sessions/{shardKey}/ + jsonl）
const ShardSchema = {
  entity: 'transcript',
  engine: 'file',
  fs: {
    sharding: { shardKeyField: 'sessionId', dirTemplate: 'sessions/{shardKey}/' },
    format: 'jsonl',
    jsonlMaxCount: 3,
  },
  fields: { id: { type: 'ulid', required: true }, sessionId: { type: 'ulid', required: true } },
} as const satisfies SchemaDef;

describe('fs-paths 不分片', () => {
  it('entityDir = {root}/{entity}', () => {
    expect(entityDir('/data', FlatSchema)).toBe('/data/app_config');
  });

  it('jsonRecordFile = <id>.json', () => {
    expect(jsonRecordFile('01KVCA58G80Y54TTF2S8ZPFR5M')).toBe(
      '01KVCA58G80Y54TTF2S8ZPFR5M.json',
    );
  });

  it('resolveRecordPath 不分片 = {root}/{entity}/{id}.json', () => {
    const p = resolveRecordPath('/data', FlatSchema, '01KVCA58G80Y54TTF2S8ZPFR5M');
    expect(p).toBe('/data/app_config/01KVCA58G80Y54TTF2S8ZPFR5M.json');
  });
});

describe('fs-paths 分片', () => {
  it('shardRootDir 把 {shardKey} 替换为字段值，root 前置不自加额外段', () => {
    expect(shardRootDir('/data', ShardSchema, '01KVCB00ABCDEFGH123456789A')).toBe(
      '/data/sessions/01KVCB00ABCDEFGH123456789A',
    );
  });

  it('entityDir 分片 = {root}/{dirTemplate(替换)}/{entity}', () => {
    expect(entityDir('/data', ShardSchema, '01KVCB00ABCDEFGH123456789A')).toBe(
      '/data/sessions/01KVCB00ABCDEFGH123456789A/transcript',
    );
  });

  it('同 shardKey 多 entity 聚同 shard 目录不同子目录', () => {
    const SummarySchema = {
      entity: 'summary',
      engine: 'file',
      fs: {
        sharding: { shardKeyField: 'sessionId', dirTemplate: 'sessions/{shardKey}/' },
      },
      fields: { id: { type: 'ulid', required: true }, sessionId: { type: 'ulid', required: true } },
    } as const satisfies SchemaDef;
    expect(entityDir('/data', SummarySchema, 'SID00000000000000000000001')).toBe(
      '/data/sessions/SID00000000000000000000001/summary',
    );
    expect(entityDir('/data', ShardSchema, 'SID00000000000000000000001')).toBe(
      '/data/sessions/SID00000000000000000000001/transcript',
    );
  });

  it('dirTemplate 不写 sessions/ 段 → 不出现 sessions 目录（不自加前缀）', () => {
    const DirectShardSchema = {
      entity: 'transcript',
      engine: 'file',
      fs: {
        sharding: { shardKeyField: 'sessionId', dirTemplate: '{shardKey}/' },
      },
      fields: { id: { type: 'ulid', required: true }, sessionId: { type: 'ulid', required: true } },
    } as const satisfies SchemaDef;
    expect(entityDir('/data', DirectShardSchema, 'SID00000000000000000000001')).toBe(
      '/data/SID00000000000000000000001/transcript',
    );
  });

  it('shardRootPrefix 取 {shardKey} 前的静态段（用于 scatter 遍历 shard 列表）', () => {
    expect(shardRootPrefix('/data', ShardSchema)).toBe('/data/sessions');
  });

  it('shardRootPrefix dirTemplate 首段即 {shardKey} → 返回 root（无静态前缀）', () => {
    const Direct = {
      entity: 'transcript',
      engine: 'file',
      fs: { sharding: { shardKeyField: 's', dirTemplate: '{shardKey}/' } },
      fields: { id: { type: 'ulid', required: true }, s: { type: 'ulid', required: true } },
    } as const satisfies SchemaDef;
    expect(shardRootPrefix('/data', Direct)).toBe('/data');
  });

  it('resolveRecordPath 分片 jsonl = {root}/{dirTemplate}/{entity}/{segment}.jsonl', () => {
    const p = resolveRecordPath('/data', ShardSchema, '01KVCA58G80Y54TTF2S8ZPFR5M', {
      shardKey: '01KVCB00ABCDEFGH123456789A',
      segment: '01KVCA58G80Y54TTF2S8ZPFR5M',
    });
    expect(p).toBe(
      '/data/sessions/01KVCB00ABCDEFGH123456789A/transcript/01KVCA58G80Y54TTF2S8ZPFR5M.jsonl',
    );
  });

  it('resolveRecordPath 分片 json = {root}/{dirTemplate}/{entity}/{id}.json', () => {
    const ShardJson = {
      entity: 'summary',
      engine: 'file',
      fs: { sharding: { shardKeyField: 'sessionId', dirTemplate: 'sessions/{shardKey}/' } },
      fields: { id: { type: 'ulid', required: true }, sessionId: { type: 'ulid', required: true } },
    } as const satisfies SchemaDef;
    const p = resolveRecordPath('/data', ShardJson, '01KVCA58G80Y54TTF2S8ZPFR5M', {
      shardKey: 'SID00000000000000000000001',
    });
    expect(p).toBe('/data/sessions/SID00000000000000000000001/summary/01KVCA58G80Y54TTF2S8ZPFR5M.json');
  });

  it('jsonlSegmentFile = <segmentId>.jsonl', () => {
    expect(jsonlSegmentFile('01KVCA58G80Y54TTF2S8ZPFR5M')).toBe(
      '01KVCA58G80Y54TTF2S8ZPFR5M.jsonl',
    );
  });
});

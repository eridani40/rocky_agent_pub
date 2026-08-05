/**
 * PluginScopeSchema + ScopeActivationSchema 形态单测（v0.0.26 task 1）
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §2（PluginScopeSchema）+ §3.2（ScopeActivationSchema）
 *
 * 验证 SchemaDef 形态与 spec 一致（entity/engine/fs.sharding/fields）+ spec gap 修正
 * （id 必须 ulid / dirTemplate 必须含 {shardKey} / createdAt 是信封保留名不声明）。
 *
 * Spec gap 修正记录（spec §2/§3.2 与 persistence 约束冲突）：
 *   1. spec §2 `id:{type:'string'}`（业务 scope id）→ persistence 强制 id=ulid
 *      → 修正：id=ulid 主键 + 业务字段 scopeId（snake_case，对应 spec id 语义）
 *   2. spec §2 `dirTemplate:'plugin_scope/'`（不含 {shardKey}）→ fs-paths 强制含 {shardKey}
 *      → 修正：dirTemplate='plugin_scope/{shardKey}/'（按 scopeId 分片，落盘 {root}/plugin_scope/{scopeId}/<id>.json）
 *   3. spec §2/§3.2 `createdAt` 业务字段 → 信封保留名 schema 禁声明
 *      → 修正：createdAt 不声明（store 自动注入信封）；ScopeActivationSchema 保留业务字段 activatedAt
 */
import { describe, it, expect } from 'vitest';
import { PluginScopeSchema } from '../schema_defs/plugin_scope';
import { ScopeActivationSchema } from '../schema_defs/scope_activation';
import { validateSchemaDef } from '../../persistence/schema-validation';

describe('PluginScopeSchema 形态（spec §2 + spec gap 修正）', () => {
  it('entity / engine 符合 spec §2', () => {
    expect(PluginScopeSchema.entity).toBe('plugin_scope');
    expect(PluginScopeSchema.engine).toBe('file');
  });

  it('fs.sharding 按 scopeId 分片（spec gap 修正：dirTemplate 必须含 {shardKey}）', () => {
    expect(PluginScopeSchema.fs?.sharding?.shardKeyField).toBe('scopeId');
    expect(PluginScopeSchema.fs?.sharding?.dirTemplate).toBe('plugin_scope/{shardKey}/');
    expect(PluginScopeSchema.fs?.format).toBe('json');
  });

  it('fields 形态：id=ulid（spec gap 修正）+ scopeId/name/description', () => {
    // spec gap 修正：persistence 强制 id={type:'ulid',required:true}（非 spec 原文 string）
    expect(PluginScopeSchema.fields.id).toEqual({ type: 'ulid', required: true });
    // 业务字段 scopeId 表达 spec §2 的 id 语义（snake_case 业务 scope id）
    expect(PluginScopeSchema.fields.scopeId).toEqual({ type: 'string', required: true });
    expect(PluginScopeSchema.fields.name).toEqual({ type: 'string', required: true });
    expect(PluginScopeSchema.fields.description).toEqual({ type: 'string', required: false });
  });

  it('不声明信封保留名 createdAt（spec gap 修正：信封保留名 schema 禁声明）', () => {
    expect('createdAt' in PluginScopeSchema.fields).toBe(false);
    expect('updatedAt' in PluginScopeSchema.fields).toBe(false);
    expect('version' in PluginScopeSchema.fields).toBe(false);
  });

  it('通过 persistence validateSchemaDef（不抛错）', () => {
    expect(() => validateSchemaDef(PluginScopeSchema)).not.toThrow();
  });
});

describe('ScopeActivationSchema 形态（spec §3.2 + D1 独立 entity）', () => {
  it('entity / engine 符合 spec §3.2（独立 activation entity）', () => {
    expect(ScopeActivationSchema.entity).toBe('ext_impl_scope_activation');
    expect(ScopeActivationSchema.engine).toBe('file');
  });

  it('fs.sharding 按 scopeId 分片（spec §3.2：cascade 删 scope 时整 shard 清）', () => {
    expect(ScopeActivationSchema.fs?.sharding?.shardKeyField).toBe('scopeId');
    expect(ScopeActivationSchema.fs?.sharding?.dirTemplate).toBe(
      'ext_impl_scope_activation/{shardKey}/',
    );
    expect(ScopeActivationSchema.fs?.format).toBe('json');
  });

  it('fields 形态：id=ulid + scopeId/pointId/activatedAt', () => {
    expect(ScopeActivationSchema.fields.id).toEqual({ type: 'ulid', required: true });
    expect(ScopeActivationSchema.fields.scopeId).toEqual({ type: 'string', required: true });
    expect(ScopeActivationSchema.fields.pointId).toEqual({ type: 'string', required: true });
    expect(ScopeActivationSchema.fields.activatedAt).toEqual({ type: 'isoDate', required: true });
  });

  it('不声明信封保留名 createdAt（spec gap 修正：信封保留名 schema 禁声明）', () => {
    expect('createdAt' in ScopeActivationSchema.fields).toBe(false);
    expect('updatedAt' in ScopeActivationSchema.fields).toBe(false);
    expect('version' in ScopeActivationSchema.fields).toBe(false);
  });

  it('通过 persistence validateSchemaDef（不抛错）', () => {
    expect(() => validateSchemaDef(ScopeActivationSchema)).not.toThrow();
  });
});

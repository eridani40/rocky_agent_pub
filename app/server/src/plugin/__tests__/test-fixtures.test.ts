/**
 * test-fixtures 单测 — BUG-004 测试专用扩展点注册
 * 参考: specs/tech/plugin_system/[P0]extension_point_interface.md（cardinality）
 *       specs/prd/overall/04-config-center-ui.md §3.9.4（exclusive/ordered/list）
 *
 * 覆盖：
 *   - isTestEnv() 在 APP_ENV=test/非 test 行为正确
 *   - registerTestFixtures 在 test env 注册 3 EP + 5 impl（含 configSchema）
 *   - 非 test env no-op（不污染 dev/prod registry）
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Registry } from '../registry';
import { registerTestFixtures, isTestEnv, buildTestScopeConfig } from '../test-fixtures';

describe('test-fixtures (BUG-004)', () => {
  const prevAppEnv = process.env.APP_ENV;

  beforeEach(() => {
    process.env.APP_ENV = 'test';
  });
  afterEach(() => {
    if (prevAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = prevAppEnv;
  });

  it('isTestEnv() 在 APP_ENV=test 返 true', () => {
    process.env.APP_ENV = 'test';
    expect(isTestEnv()).toBe(true);
  });

  it('isTestEnv() 在 APP_ENV=dev 返 false', () => {
    process.env.APP_ENV = 'dev';
    expect(isTestEnv()).toBe(false);
  });

  it('registerTestFixtures 在 test env 注册 test_chat_model（exclusive）扩展点 + 2 impl', () => {
    const reg = new Registry();
    registerTestFixtures(reg);
    const point = reg.getPoint('test_chat_model');
    expect(point).toBeDefined();
    expect(point?.cardinality).toBe('exclusive');
    const impls = reg.getByPoint('test_chat_model');
    expect(impls.length).toBe(2);
    const ids = impls.map((i) => i.manifest.implId).sort();
    expect(ids).toEqual(['test_chat_model_a', 'test_chat_model_b']);
  });

  it('registerTestFixtures 在 test env 注册 test_retriever（ordered）扩展点 + 3 impl', () => {
    const reg = new Registry();
    registerTestFixtures(reg);
    const point = reg.getPoint('test_retriever');
    expect(point?.cardinality).toBe('ordered');
    const impls = reg.getByPoint('test_retriever');
    expect(impls.length).toBe(3);
  });

  it('test_chat_model_a 带 configSchema（v0.0.71 D7：原 schemaConfig 已合并进 configSchema）', () => {
    const reg = new Registry();
    registerTestFixtures(reg);
    const entry = reg.getImplById('test_chat_model_a');
    // D7 后：configSchema 是唯一 schema 源（原 schemaConfig apiKey/model 已并入 properties）
    const props = entry?.manifest.configSchema?.properties as Record<string, Record<string, unknown>>;
    expect(entry?.manifest.configSchema).toBeDefined();
    expect(props?.apiKey?.type).toBe('string');
    // enum 候选值：JSON Schema 标准用 enum 字段（schemaConfig 原 options 字段已迁移）
    expect(props?.model?.type).toBe('string');
    expect(props?.model?.enum).toEqual(['gpt-4', 'gpt-3.5-turbo']);
  });

  it('fixture EP cardinality/description 字段就位（v0.0.71 D1 删除 group 后）', () => {
    const reg = new Registry();
    registerTestFixtures(reg);
    const point = reg.getPoint('test_chat_model');
    expect(point?.cardinality).toBe('exclusive');
    expect(point?.description).toContain('测试用 exclusive');
    expect(reg.getPoint('test_retriever')?.cardinality).toBe('ordered');
  });

  it('非 test env（APP_ENV=dev）registerTestFixtures no-op，不注册任何 fixture', () => {
    process.env.APP_ENV = 'dev';
    const reg = new Registry();
    registerTestFixtures(reg);
    expect(reg.getPoint('test_chat_model')).toBeUndefined();
    expect(reg.getPoint('test_retriever')).toBeUndefined();
    expect(reg.getImplById('test_chat_model_a')).toBeUndefined();
  });

  // ── BUG-009：纯 toggle test plugin（插件 tab 多 plugin 用） ──

  it('registerTestFixtures 在 test env 注册 2 个纯 toggle test plugin（test_plugin_a/b）', () => {
    const reg = new Registry();
    registerTestFixtures(reg);
    const pluginIds = reg.listPlugins();
    expect(pluginIds).toContain('test_plugin_a');
    expect(pluginIds).toContain('test_plugin_b');
    // 两个 plugin 的 manifest label/description 已填（插件 tab UI 展示用）
    const a = reg.getPluginManifest('test_plugin_a');
    const b = reg.getPluginManifest('test_plugin_b');
    expect(a?.label).toBe('Test Plugin A');
    expect(a?.description).toContain('toggle plugin A');
    expect(b?.label).toBe('Test Plugin B');
    expect(b?.description).toContain('toggle plugin B');
  });

  it('纯 toggle test plugin 无 ext impl（空 extImpls，仅 plugin 级开关可测）', () => {
    const reg = new Registry();
    registerTestFixtures(reg);
    const a = reg.getPluginManifest('test_plugin_a');
    expect(a?.extImpls).toEqual([]);
    const b = reg.getPluginManifest('test_plugin_b');
    expect(b?.extImpls).toEqual([]);
  });

  // ── v0.0.67 D5 + v0.0.71 返工：test_chat_model exclusive 选中改代码声明 buildTestScopeConfig ──

  it('v0.0.67 D5：registerTestFixtures 不再调 setExclusive 写 policy（signature 单参 registry-only）', () => {
    const reg = new Registry();
    // v0.0.67 起 registerTestFixtures(registry) 单参（不再接受 service 参数）
    expect(() => registerTestFixtures(reg)).not.toThrow();
    // test_chat_model 两个 impl 都登记（exclusive 选中由代码声明 buildTestScopeConfig，不在 manifest 体现）
    const impls = reg.getByPoint('test_chat_model');
    expect(impls.map((i) => i.manifest.implId).sort()).toEqual(['test_chat_model_a', 'test_chat_model_b']);
  });

  it('registerTestFixtures 不写 policy（v0.0.67 D5：纯 manifest 注册，无副作用）', () => {
    const reg = new Registry();
    expect(() => registerTestFixtures(reg)).not.toThrow();
    // 注册完成：test plugin + test EP + test impl 都在 registry
    expect(reg.listPlugins()).toContain('test_plugin_a');
    expect(reg.getPoint('test_chat_model')).toBeDefined();
    expect(reg.getImplById('test_chat_model_a')).toBeDefined();
  });

  // ── v0.0.71 返工：test fixture scope 改代码声明（原 scopes/test.json 删除） ──

  it('buildTestScopeConfig 返回 test ScopeConfig（v0.0.179 membership 模型：impls 全量声明）', () => {
    const cfg = buildTestScopeConfig();
    expect(cfg.scopeId).toBe('test');
    expect(cfg.name).toBe('Test');
    expect(cfg.description).toContain('test 环境 fixture scope');
    // 激活 test_chat_model（exclusive）+ test_retriever（ordered）
    expect(cfg.activatedPoints).toEqual(['test_chat_model', 'test_retriever']);
    // v0.0.179：test_chat_model exclusive 恰好 1 active（test_chat_model_a）
    //   test_retriever ordered 3 impl 全 active（order 1/2/3）
    expect(cfg.impls).toEqual({
      test_chat_model_a: { order: 1 },
      test_retriever_a: { order: 1 },
      test_retriever_b: { order: 2 },
      test_retriever_c: { order: 3 },
    });
    // v0.0.179：无 exclusivePicks 字段（已废）
    expect((cfg as unknown as { exclusivePicks?: unknown }).exclusivePicks).toBeUndefined();
  });

  it('buildTestScopeConfig 不依赖 APP_ENV（纯函数，任意 env 调用均返 test ScopeConfig）', () => {
    process.env.APP_ENV = 'dev';
    expect(buildTestScopeConfig().scopeId).toBe('test');
    process.env.APP_ENV = 'production';
    expect(buildTestScopeConfig().scopeId).toBe('test');
  });
});

/**
 * @vitest-environment jsdom
 * T4 providers ns 结构单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4（bundle 物理结构）+ §3（KKV 协议）
 *       specs/tech/i18n/index.md（10 ns 之一：providers）
 *       states/v0.0.59.i18n/i18n-backlog-frontend.md B3（providers ns ~6 条，作起点）
 *       task.json T4 description（含全扫清单 — 吸取 T2 教训：扫整个 providers/ 目录）
 *
 * 覆盖：
 *   - providers ns 顶层分组完整（B3 + 全扫发现的漏盘：subtitle/addProvider/enableHint
 *     /dirty/saved/modelsTitle/fieldEditHint/labelPlaceholder/deleteAria 等）
 *   - 各分组的 leaf 文案符合预期（zh-CN/en 对齐）
 *   - 含插值占位符的 key 校验（subtitle/modelsTitle/modelCount）
 *   - zh-CN / en key 集合一致（与 keys-aligned.test.ts 互补）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { diffNsKeys } from './_test-helpers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('T4 providers ns 顶层分组（B3 + 全扫漏盘补迁）', () => {
  it('providers ns 顶层分组覆盖 B3 + 全扫清单全部域', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'providers');
    // B3 列出的分组：section / fields / list / detail / model / modelList
    // 注：B3 用 `fields` 但实际命名统一为 `field`
    const expectedGroups = [
      'section',
      'field',
      'list',
      'detail',
      'model',
      'modelList',
    ];
    for (const g of expectedGroups) {
      expect(zh[g], `providers.${g} 顶层分组应存在`).toBeDefined();
    }
  });

  it('providers.section 含 title/subtitle/addProvider 3 leaf（B3 title/loading + 全扫漏盘 subtitle/addProvider）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'providers');
    const en = i18n.getResourceBundle('en', 'providers');
    for (const leaf of ['title', 'subtitle', 'addProvider'] as const) {
      expect(typeof zh.section?.[leaf], `zh providers.section.${leaf}`).toBe('string');
      expect(typeof en.section?.[leaf], `en providers.section.${leaf}`).toBe('string');
    }
    // subtitle 含 providerCount + modelCount 双插值
    expect(zh.section.subtitle).toContain('{{providerCount}}');
    expect(zh.section.subtitle).toContain('{{modelCount}}');
    expect(en.section.subtitle).toContain('{{providerCount}}');
    expect(en.section.subtitle).toContain('{{modelCount}}');
  });

  it('providers.field 含 9 leaf（B3 6 + 全扫漏盘 3：apiKeyHint/protocolHint/urlEmpty）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'providers');
    const en = i18n.getResourceBundle('en', 'providers');
    for (const leaf of [
      'nameLabel',
      'namePlaceholder',
      'apiKeyHint',
      'protocolHint',
      'urlLabel',
      'urlHint',
      'urlEmpty',
      'enableTitle',
      'enableHint',
    ] as const) {
      expect(typeof zh.field?.[leaf], `zh providers.field.${leaf}`).toBe('string');
      expect(typeof en.field?.[leaf], `en providers.field.${leaf}`).toBe('string');
    }
  });

  it('providers.list 含 3 leaf（modelCount + enabled/disabled 徽章）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'providers');
    const en = i18n.getResourceBundle('en', 'providers');
    for (const leaf of ['modelCount', 'enabled', 'disabled'] as const) {
      expect(typeof zh.list?.[leaf], `zh providers.list.${leaf}`).toBe('string');
      expect(typeof en.list?.[leaf], `en providers.list.${leaf}`).toBe('string');
    }
    // modelCount 含 {{count}} 插值
    expect(zh.list.modelCount).toContain('{{count}}');
    expect(en.list.modelCount).toContain('{{count}}');
  });

  it('providers.detail 含 7 leaf（B3 3 + 全扫漏盘 4：dirty/saved/modelsTitle/addModel）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'providers');
    const en = i18n.getResourceBundle('en', 'providers');
    for (const leaf of [
      'newTitle',
      'connectionTitle',
      'dirty',
      'saved',
      'modelsTitle',
      'addModel',
      'emptyModels',
    ] as const) {
      expect(typeof zh.detail?.[leaf], `zh providers.detail.${leaf}`).toBe('string');
      expect(typeof en.detail?.[leaf], `en providers.detail.${leaf}`).toBe('string');
    }
    // modelsTitle 含 {{count}} 插值
    expect(zh.detail.modelsTitle).toContain('{{count}}');
    expect(en.detail.modelsTitle).toContain('{{count}}');
  });

  it('providers.model 含 10 leaf（B3 8 + 全扫漏盘 2：fieldEditHint/labelPlaceholder）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'providers');
    const en = i18n.getResourceBundle('en', 'providers');
    for (const leaf of [
      'add',
      'edit',
      'fieldEditHint',
      'labelName',
      'labelPlaceholder',
      'labelId',
      'labelCtx',
      'labelMaxOutput',
      'enableTitle',
      'enableHint',
    ] as const) {
      expect(typeof zh.model?.[leaf], `zh providers.model.${leaf}`).toBe('string');
      expect(typeof en.model?.[leaf], `en providers.model.${leaf}`).toBe('string');
    }
  });

  it('providers.modelList 含 2 leaf（disabled + deleteAria）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'providers');
    const en = i18n.getResourceBundle('en', 'providers');
    for (const leaf of ['disabled', 'deleteAria'] as const) {
      expect(typeof zh.modelList?.[leaf], `zh providers.modelList.${leaf}`).toBe('string');
      expect(typeof en.modelList?.[leaf], `en providers.modelList.${leaf}`).toBe('string');
    }
  });
});

describe('T4 providers ns zh-CN ↔ en key 集合对齐', () => {
  it('zh-CN 与 en providers ns key 集合完全一致（与 keys-aligned.test.ts 互补，本测试给细节）', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('providers');
    expect(onlyInZh, `仅 zh-CN 有的 providers key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 providers key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

describe('T4 providers ns 关键文案语义校验（防 en/zh 拿反）', () => {
  it('section.title: zh 模型提供商 / en Model Providers', () => {
    const tZh = i18n.getFixedT('zh-CN', 'providers');
    const tEn = i18n.getFixedT('en', 'providers');
    expect(tZh('section.title')).toBe('模型提供商');
    expect(tEn('section.title')).toBe('Model Providers');
  });

  it('list.enabled / list.disabled 双语区分（component-provider-list-card 徽章）', () => {
    const tZh = i18n.getFixedT('zh-CN', 'providers');
    const tEn = i18n.getFixedT('en', 'providers');
    expect(tZh('list.enabled')).toBe('已启用');
    expect(tEn('list.enabled')).toBe('Enabled');
    expect(tZh('list.disabled')).toBe('已禁用');
    expect(tEn('list.disabled')).toBe('Disabled');
  });

  it('subtitle 插值渲染（zh-CN 含「个提供商」「个模型」单位词）', () => {
    const tZh = i18n.getFixedT('zh-CN', 'providers');
    const rendered = tZh('section.subtitle', { providerCount: 2, modelCount: 5 });
    expect(rendered).toContain('2');
    expect(rendered).toContain('5');
    expect(rendered).toContain('个提供商');
    expect(rendered).toContain('个模型');
  });

  it('list.modelCount 插值渲染（zh 含「个模型」单位词）', () => {
    const tZh = i18n.getFixedT('zh-CN', 'providers');
    expect(tZh('list.modelCount', { count: 3 })).toBe('3 个模型');
  });

  it('detail.modelsTitle 插值渲染（zh 含「关联模型」前缀 + count）', () => {
    const tZh = i18n.getFixedT('zh-CN', 'providers');
    const rendered = tZh('detail.modelsTitle', { count: 4 });
    expect(rendered).toContain('关联模型');
    expect(rendered).toContain('4');
  });

  it('model.add / model.edit（component-model-edit-modal 标题分支）', () => {
    const tZh = i18n.getFixedT('zh-CN', 'providers');
    const tEn = i18n.getFixedT('en', 'providers');
    expect(tZh('model.add')).toBe('添加模型');
    expect(tEn('model.add')).toBe('Add Model');
    expect(tZh('model.edit')).toBe('编辑模型');
    expect(tEn('model.edit')).toBe('Edit Model');
  });

  it('modelList.deleteAria（component-model-list-card 删除按钮 aria-label）', () => {
    const tZh = i18n.getFixedT('zh-CN', 'providers');
    const tEn = i18n.getFixedT('en', 'providers');
    expect(tZh('modelList.deleteAria')).toBe('删除模型');
    expect(tEn('modelList.deleteAria')).toBe('Delete model');
  });
});

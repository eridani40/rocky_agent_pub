/**
 * @vitest-environment jsdom
 * T5 framework ns 结构单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4（bundle 物理结构）
 *       states/v0.0.59.i18n/i18n-backlog-frontend.md B8（framework ns ~2 条，作起点）
 *       task.json T5 description（含 nav-rail + drag-handle 全扫清单 + brand「Rocky」保留字面）
 *
 * 边界（task.json T5 硬约束）：
 *   brand「Rocky」是品牌名，**保留字面不翻译**（zh-CN/en 同值 "Rocky"）；
 *   仅 tooltip + aria-label 走 i18n。
 *
 * 覆盖：
 *   - framework ns 顶层分组完整（nav + dragHandle）
 *   - nav 6 leaf（playground/studio/skills/connector/settingsApp/brand）
 *   - brand「Rocky」字面值在 zh-CN/en 一致（不翻译）
 *   - dragHandle.ariaLabel leaf
 *   - zh-CN / en key 集合一致
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { diffNsKeys } from './_test-helpers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('T5 framework ns 顶层分组 + brand 字面保留', () => {
  it('framework ns 顶层分组（nav + dragHandle）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'framework');
    expect(zh.nav, 'framework.nav 分组应存在').toBeDefined();
    expect(zh.dragHandle, 'framework.dragHandle 分组应存在').toBeDefined();
  });

  it('framework.nav 6 leaf（playground/studio/skills/connector/settingsApp/brand）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'framework');
    for (const leaf of ['playground', 'studio', 'skills', 'connector', 'settingsApp', 'brand'] as const) {
      expect(typeof zh.nav?.[leaf], `zh framework.nav.${leaf}`).toBe('string');
    }
  });

  it('brand「Rocky」字面在 zh-CN / en 一致（不翻译，品牌名保留）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'framework');
    const en = i18n.getResourceBundle('en', 'framework');
    expect(zh.nav?.brand).toBe('Rocky');
    expect(en.nav?.brand).toBe('Rocky');
  });

  it('framework.dragHandle.ariaLabel leaf（drag-handle primitive aria）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'framework');
    const en = i18n.getResourceBundle('en', 'framework');
    expect(typeof zh.dragHandle?.ariaLabel).toBe('string');
    expect(typeof en.dragHandle?.ariaLabel).toBe('string');
  });
});

describe('T5 framework ns zh-CN ↔ en key 集合对齐', () => {
  it('zh-CN 与 en framework ns key 集合完全一致', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('framework');
    expect(onlyInZh, `仅 zh-CN 有的 framework key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 framework key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

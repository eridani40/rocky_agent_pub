/**
 * @vitest-environment jsdom
 * T5 plugin-config ns 结构单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4（bundle 物理结构）+ §3（KKV 协议）
 *       states/v0.0.59.i18n/i18n-backlog-frontend.md B4（plugin-config ns ~8 条，作起点）
 *       task.json T5 description（含全扫清单 — 吸取 T2 教训：扫整个 plugin-config-page/ 目录）
 *
 * 覆盖：
 *   - plugin-config ns 顶层分组完整（B4 + 全扫漏盘：tab/plugin toggle/implConfig/scope
 *     idPlaceholder/ep.inheritedHint/schemaConfig.title 等）
 *   - 各分组的关键 leaf 文案校验（zh-CN/en 对齐）
 *   - 含插值占位符的 key 校验（page.loadFail / scope.deleteBody / ep.deactivateBody / schemaConfig.title）
 *   - zh-CN / en key 集合一致（与 keys-aligned.test.ts 互补）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { diffNsKeys } from './_test-helpers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('T5 plugin-config ns 顶层分组（B4 + 全扫漏盘补迁）', () => {
  it('plugin-config ns 顶层分组覆盖 B4 + 全扫清单全部域', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'plugin-config');
    const expectedGroups = ['page', 'tab', 'plugin', 'impl', 'implConfig', 'scope', 'ep', 'schemaConfig', 'empty'];
    for (const g of expectedGroups) {
      expect(zh[g], `plugin-config.${g} 顶层分组应存在`).toBeDefined();
    }
  });

  it('plugin-config.tab 含 plugin/extpoint 双 tab（page-plugin-config 顶栏）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'plugin-config');
    const en = i18n.getResourceBundle('en', 'plugin-config');
    expect(typeof zh.tab?.plugin).toBe('string');
    expect(typeof zh.tab?.extpoint).toBe('string');
    expect(en.tab?.plugin).toBe('Plugins');
    expect(en.tab?.extpoint).toBe('Extension Points');
  });

  it('plugin-config.scope 含 8 leaf（defaultBadge/deleteAria/3 placeholder/createSubmit/createBtn/deleteTitle/deleteBody）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'plugin-config');
    for (const leaf of ['defaultBadge', 'deleteAria', 'idPlaceholder', 'namePlaceholder', 'descPlaceholder', 'createSubmit', 'createBtn', 'deleteTitle', 'deleteBody'] as const) {
      expect(typeof zh.scope?.[leaf], `zh plugin-config.scope.${leaf}`).toBe('string');
    }
    // deleteBody 含 {{name}} 插值
    expect(zh.scope.deleteBody).toContain('{{name}}');
  });

  it('plugin-config.ep 含 6 leaf（inheritedHint/activateBtn/deactivateBtn/deactivateTitle/deactivateBody/deactivateConfirm）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'plugin-config');
    for (const leaf of ['inheritedHint', 'activateBtn', 'deactivateBtn', 'deactivateTitle', 'deactivateBody', 'deactivateConfirm'] as const) {
      expect(typeof zh.ep?.[leaf], `zh plugin-config.ep.${leaf}`).toBe('string');
    }
    // deactivateBody 含 {{pointId}} 插值
    expect(zh.ep.deactivateBody).toContain('{{pointId}}');
  });

  it('plugin-config.page.loadFail 含 {{error}} 插值（page-plugin-config 错误 fallback）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'plugin-config');
    expect(zh.page?.loadFail).toContain('{{error}}');
  });

  it('plugin-config.schemaConfig.title 含 {{implId}} 插值（component-schema-config-modal 标题）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'plugin-config');
    expect(zh.schemaConfig?.title).toContain('{{implId}}');
  });
});

describe('T5 plugin-config ns zh-CN ↔ en key 集合对齐', () => {
  it('zh-CN 与 en plugin-config ns key 集合完全一致', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('plugin-config');
    expect(onlyInZh, `仅 zh-CN 有的 plugin-config key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 plugin-config key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

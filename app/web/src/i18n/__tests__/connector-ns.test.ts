/**
 * @vitest-environment jsdom
 * T5 connector ns 结构单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4（bundle 物理结构）+ §6（type code 累积映射表）
 *       states/v0.0.59.i18n/i18n-backlog-frontend.md B7（connector ns ~3 条，作起点）
 *       task.json T5 description（含全扫清单 + connector.browser.connection.<code> 4 leaf 占位）
 *
 * 覆盖：
 *   - connector ns 顶层分组完整（header/tab/browser.connection/browser.guide）
 *   - browser.connection 4 leaf（disconnected/connecting/connected/error — T6 type code 接表）
 *   - browser.switchOff 是 UI 层 overlay（switch=off 时显示，非 connection code）
 *   - browser.guide 4 step leaf（chrome remote debugging 引导）
 *   - zh-CN / en key 集合一致
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { diffNsKeys } from './_test-helpers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('T5 connector ns 顶层分组', () => {
  it('connector ns 顶层分组覆盖 B7 + 全扫清单全部域', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'connector');
    const expectedGroups = ['header', 'tab', 'browser'];
    for (const g of expectedGroups) {
      expect(zh[g], `connector.${g} 顶层分组应存在`).toBeDefined();
    }
    expect(zh.browser?.connection, 'connector.browser.connection 子分组应存在').toBeDefined();
    expect(zh.browser?.guide, 'connector.browser.guide 子分组应存在').toBeDefined();
  });

  it('connector.browser.connection 4 leaf（T6 type code 接表占位，对齐 connector-types.ts:18-22）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'connector');
    const en = i18n.getResourceBundle('en', 'connector');
    // 4 个 connection code leaf（switch=on 路径）
    for (const code of ['disconnected', 'connecting', 'connected', 'error'] as const) {
      expect(typeof zh.browser?.connection?.[code], `zh connector.browser.connection.${code}`).toBe('string');
      expect(typeof en.browser?.connection?.[code], `en connector.browser.connection.${code}`).toBe('string');
    }
  });

  it('connector.browser.switchOff 是 UI 层 overlay（switch=off 时显示，非 connection code 范畴）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'connector');
    expect(typeof zh.browser?.switchOff).toBe('string');
  });

  it('connector.browser 9 个直接 leaf + guide 4 step leaf（component 全域）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'connector');
    for (const leaf of ['name', 'desc', 'switchLabel', 'switchOff', 'connectingInline', 'errorDefault', 'retry', 'guideSubtitle'] as const) {
      expect(typeof zh.browser?.[leaf], `zh connector.browser.${leaf}`).toBe('string');
    }
    // guide 4 step leaf
    for (const step of ['step1', 'step2', 'step3', 'step4'] as const) {
      expect(typeof zh.browser?.guide?.[step]).toBe('string');
    }
  });

  it('connector.header.title/desc 双语区分（page-connector header）', () => {
    const tZh = i18n.getFixedT('zh-CN', 'connector');
    const tEn = i18n.getFixedT('en', 'connector');
    expect(tZh('header.title')).toBe('连接器');
    expect(tEn('header.title')).toBe('Connectors');
  });
});

describe('T5 connector ns zh-CN ↔ en key 集合对齐', () => {
  it('zh-CN 与 en connector ns key 集合完全一致', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('connector');
    expect(onlyInZh, `仅 zh-CN 有的 connector key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 connector key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

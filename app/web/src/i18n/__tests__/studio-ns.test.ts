/**
 * @vitest-environment jsdom
 * studio ns 结构单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §6（type code 累积映射表）
 *       specs/tech/i18n/index.md §⑥ type code 占位（role/memberState/autoWork*）
 *
 * 覆盖：
 *   - studio ns 顶层分组完整
 *   - role/memberState 2 leaf（type code 占位）
 *   - autoWorkReason 2 + autoWorkResult 5 camelCase leaf（接表范式）
 *   - zh-CN / en key 集合一致（与 keys-aligned.test.ts 互补，本测试聚焦 studio ns 结构）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { diffNsKeys } from './_test-helpers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('studio ns 结构', () => {
  it('studio ns 顶层分组覆盖 B2 + 全扫清单全部域', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'studio');
    // B2 列出的分组 + 全扫发现的 v0.0.57+ 补迁
    const expectedGroups = [
      'sidebar',
      'squadPanel',
      'tab',
      'empty',
      'toast',
      'chat',
      'squadTree',
      'newSquadModal',
      'benchModal',
      'memberCreate',
      'memberPanel',
      'heartbeat',
      'memberCard',
      'membersTab',
      'manageTab',
      'memory',
      'autonomy',
      'budget',
      'autoWork',
      // type code 占位
      'role',
      'memberState',
      'autoWorkReason',
      'autoWorkResult',
    ];
    for (const g of expectedGroups) {
      expect(zh[g], `studio.${g} 顶层分组应存在`).toBeDefined();
    }
  });

  it('studio.toast 含 9 leaf（page-studio + use-member-panel-handlers flash 文案）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'studio');
    for (const leaf of [
      'squadCreated',
      'memberHired',
      'memberBenched',
      'benchFail',
      'memberDeployed',
      'metaSaved',
      'roleSaved',
      'heartbeatSaved',
      'heartbeatCleared',
    ] as const) {
      expect(typeof zh.toast?.[leaf], `zh studio.toast.${leaf}`).toBe('string');
    }
    // 含插值的 toast 校验占位符
    expect(zh.toast.squadCreated).toContain('{{name}}');
    expect(zh.toast.memberHired).toContain('{{name}}');
    expect(zh.toast.memberBenched).toContain('{{name}}');
    expect(zh.toast.memberBenched).toContain('{{reason}}');
  });

  it('studio.heartbeat 含 12 leaf（errFormat/errOrder/errMin + 三态提示 + activeWindow/interval/rhythm/save/clear）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'studio');
    for (const leaf of [
      'errFormat',
      'errOrder',
      'errMin',
      'benchedWarning',
      'killswitchOff',
      'emptyHint',
      'activeWindowLabel',
      'intervalLabel',
      'rhythmHint',
      'save',
      'clear',
    ] as const) {
      expect(typeof zh.heartbeat?.[leaf], `zh studio.heartbeat.${leaf}`).toBe('string');
    }
    // 含 {{timezone}} / {{name}} 插值
    expect(zh.heartbeat.activeWindowLabel).toContain('{{timezone}}');
    expect(zh.heartbeat.rhythmHint).toContain('{{name}}');
  });

  it('studio.budget 含 9 leaf（label/loadFail/errorPrefix/三前缀/unlimited/windowEndLabel/overLimitHint）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'studio');
    for (const leaf of [
      'label',
      'loadFail',
      'errorPrefix',
      'consumedPrefix',
      'limitPrefix',
      'remainingPrefix',
      'unlimited',
      'windowEndLabel',
      'overLimitHint',
    ] as const) {
      expect(typeof zh.budget?.[leaf], `zh studio.budget.${leaf}`).toBe('string');
    }
  });
});

describe('studio ns type code 占位（接表范式：camelCase leaf）', () => {
  it('studio.role 2 leaf + studio.memberState 2 leaf（type code 占位）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'studio');
    const en = i18n.getResourceBundle('en', 'studio');
    for (const leaf of ['leader', 'mate'] as const) {
      expect(typeof zh.role?.[leaf]).toBe('string');
      expect(typeof en.role?.[leaf]).toBe('string');
    }
    for (const leaf of ['deployed', 'benched'] as const) {
      expect(typeof zh.memberState?.[leaf]).toBe('string');
      expect(typeof en.memberState?.[leaf]).toBe('string');
    }
  });

  it('studio.autoWorkReason 1 leaf（heartbeat，接 auto-work-history）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'studio');
    expect(typeof zh.autoWorkReason?.heartbeat).toBe('string');
  });

  it('studio.autoWorkResult 5 camelCase leaf（fired + 4 skipped_*，接 auto-work-history）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'studio');
    for (const leaf of ['fired', 'skippedBusy', 'skippedBudget', 'skippedWindow', 'skippedKillswitch'] as const) {
      expect(typeof zh.autoWorkResult?.[leaf], `zh studio.autoWorkResult.${leaf}`).toBe('string');
    }
  });
});

describe('studio ns zh-CN ↔ en key 集合对齐', () => {
  it('zh-CN 与 en studio ns key 集合完全一致（与 keys-aligned.test.ts 互补，本测试给细节）', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('studio');
    expect(onlyInZh, `仅 zh-CN 有的 studio key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 studio key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

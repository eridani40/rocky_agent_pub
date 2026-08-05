/**
 * @vitest-environment jsdom
 * T5 app-dev-config ns 结构单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4（bundle 物理结构）
 *       states/v0.0.59.i18n/i18n-backlog-frontend.md B5（app-dev-config ns，作起点）
 *       task.json T5 description（含全扫清单 — 吸取 T2 教训：扫整个 app-dev-config-page/ 目录 +
 *       observability-config/ 子目录 + app-settings-config-defs.ts schema desc）
 *
 * 覆盖：
 *   - app-dev-config ns 顶层分组完整（layout/userMemory/locale/observability/schema）
 *   - observability 子分组覆盖全扫域（sectionTitle/langfuseDesc/unnamed/emptyBaseUrl/newConfig
 *     /enabled/disabled/toggleLabel/toggleAria/deleteAria/deleteTitle/deleteBody/addTitle/addSubtitle
 *     /loading/retry/dirtyHint/savedHint/resetBtn/saveBtn/changeNotice/breadcrumbRoot/basic/field/auth
 *     /physical/dualRecord）
 *   - schema.<group>.<key>.desc 7 leaf（覆盖 KV_GROUPS 全部 desc 字段，由 component-key-card 解析）
 *   - 含插值占位符的 key 校验（observability.deleteBody/observability.toggleAria；
 *     v0.0.112：userMemory.scopeHint 去 token，改为纯文案，scope 词汇走 memory-user-scope-label 元素）
 *   - zh-CN / en key 集合一致
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { diffNsKeys } from './_test-helpers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('T5 app-dev-config ns 顶层分组', () => {
  it('app-dev-config ns 顶层分组覆盖 B5 + 全扫清单全部域', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    const expectedGroups = ['layout', 'group', 'userMemory', 'locale', 'observability', 'schema'];
    for (const g of expectedGroups) {
      expect(zh[g], `app-dev-config.${g} 顶层分组应存在`).toBeDefined();
    }
  });
});

/**
 * [v0.0.65 i18n Batch3] group.label 8 leaf（配置菜单 sidebar group label，M1）
 * 参考: reqs/[working] v0.0.65.i18n_batch3/req.md M1
 */
describe('T5 app-dev-config.group.<groupId>.label（M1 配置菜单 group label）', () => {
  it('group 8 leaf label 全部存在（appearance/providers/locale/user_memory/llm_request/observability/logs/plugin）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    const en = i18n.getResourceBundle('en', 'app-dev-config');
    const groups = ['appearance', 'providers', 'locale', 'user_memory', 'llm_request', 'observability', 'logs', 'plugin'] as const;
    for (const g of groups) {
      expect(typeof zh.group?.[g]?.label, `zh group.${g}.label`).toBe('string');
      expect(typeof en.group?.[g]?.label, `en group.${g}.label`).toBe('string');
    }
  });
});

describe('T5 app-dev-config.observability 全扫覆盖', () => {
  it('observability 26 leaf 全部存在（list/detail/item/delete-modal 视觉域）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    const en = i18n.getResourceBundle('en', 'app-dev-config');
    const leaves = [
      'sectionTitle', 'sectionDesc', 'langfuseDesc', 'unnamed', 'emptyBaseUrl',
      'newConfig', 'enabled', 'disabled', 'toggleLabel', 'toggleAria', 'deleteAria',
      'deleteTitle', 'deleteBody', 'addTitle', 'addSubtitle', 'loading', 'retry',
      'dirtyHint', 'savedHint', 'resetBtn', 'saveBtn', 'changeNotice', 'breadcrumbRoot',
    ] as const;
    for (const leaf of leaves) {
      expect(typeof zh.observability?.[leaf], `zh observability.${leaf}`).toBe('string');
      expect(typeof en.observability?.[leaf], `en observability.${leaf}`).toBe('string');
    }
    // 4 个子分组（basic/field/auth/physical/dualRecord）
    for (const sub of ['basic', 'field', 'auth', 'physical', 'dualRecord'] as const) {
      expect(zh.observability?.[sub], `zh observability.${sub} 子分组应存在`).toBeDefined();
    }
  });

  it('observability.deleteBody 含 {{name}} 插值（删除 modal body）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    expect(zh.observability?.deleteBody).toContain('{{name}}');
  });

  it('observability.toggleAria 含 {{name}} 插值（component-obs-item toggle aria）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    expect(zh.observability?.toggleAria).toContain('{{name}}');
  });

  it('observability.deleteAria 含 {{name}} 插值（component-obs-item delete aria）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    expect(zh.observability?.deleteAria).toContain('{{name}}');
  });

  it('observability.dualRecord 子分组 5 leaf（label/hint/ariaLabel/toggleLabel/tooltip）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    for (const leaf of ['label', 'hint', 'ariaLabel', 'toggleLabel', 'tooltip'] as const) {
      expect(typeof zh.observability?.dualRecord?.[leaf]).toBe('string');
    }
  });
});

describe('T5 app-dev-config.userMemory + layout + locale', () => {
  it('userMemory 5 leaf + scopeHint 为纯文案（v0.0.112 去 token）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    for (const leaf of ['title', 'scopeHint', 'create', 'loading', 'empty'] as const) {
      expect(typeof zh.userMemory?.[leaf]).toBe('string');
    }
    // v0.0.112 task5：scope 词汇改走 memory-user-scope-label 元素，scopeHint 文案不再含 {{token}} 插值
    expect(zh.userMemory.scopeHint).not.toContain('{{token}}');
  });

  it('layout 4 leaf（emptyGroups/emptyGroup/collapseAll/expandAll）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    for (const leaf of ['emptyGroups', 'emptyGroup', 'collapseAll', 'expandAll'] as const) {
      expect(typeof zh.layout?.[leaf]).toBe('string');
    }
  });

  it('locale 2 leaf（label/desc）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    expect(typeof zh.locale?.label).toBe('string');
    expect(typeof zh.locale?.desc).toBe('string');
  });
});

describe('T5 app-dev-config.schema.<group>.<key>.desc（KV_GROUPS 全 desc 字段）', () => {
  it('schema.appearance.theme.desc leaf 存在（app-settings-config-defs.ts 引用）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    expect(typeof zh.schema?.appearance?.theme?.desc).toBe('string');
  });

  it('schema.llm_request 2 key desc leaf（stall_timeout_s/max_retry_times）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    for (const key of ['stall_timeout_s', 'max_retry_times'] as const) {
      expect(typeof zh.schema?.llm_request?.[key]?.desc, `schema.llm_request.${key}.desc`).toBe('string');
    }
  });

  it('schema.logs 5 key desc leaf（enableLlmRequestLog/enableToolResultLog/enableAppApiLog/enableEventLog/enableErrorLog）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    for (const key of ['enableLlmRequestLog', 'enableToolResultLog', 'enableAppApiLog', 'enableEventLog', 'enableErrorLog'] as const) {
      expect(typeof zh.schema?.logs?.[key]?.desc, `schema.logs.${key}.desc`).toBe('string');
    }
  });
});

/**
 * [v0.0.65 i18n Batch3] schema.<group>.<key>.label 7 leaf（KV key label，M2）
 * 与 desc 平行，覆盖 KV_GROUPS 全部 key
 * 参考: reqs/[working] v0.0.65.i18n_batch3/req.md M2
 */
describe('T5 app-dev-config.schema.<group>.<key>.label（M2 KV key label）', () => {
  it('schema.appearance.theme.label leaf 存在（与 desc 平行）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    const en = i18n.getResourceBundle('en', 'app-dev-config');
    expect(typeof zh.schema?.appearance?.theme?.label, 'zh schema.appearance.theme.label').toBe('string');
    expect(typeof en.schema?.appearance?.theme?.label, 'en schema.appearance.theme.label').toBe('string');
  });

  it('schema.llm_request 2 key label leaf（stall_timeout_s/max_retry_times，与 desc 平行）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    const en = i18n.getResourceBundle('en', 'app-dev-config');
    for (const key of ['stall_timeout_s', 'max_retry_times'] as const) {
      expect(typeof zh.schema?.llm_request?.[key]?.label, `zh schema.llm_request.${key}.label`).toBe('string');
      expect(typeof en.schema?.llm_request?.[key]?.label, `en schema.llm_request.${key}.label`).toBe('string');
    }
  });

  it('schema.logs 5 key label leaf（与 desc 平行）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'app-dev-config');
    const en = i18n.getResourceBundle('en', 'app-dev-config');
    for (const key of ['enableLlmRequestLog', 'enableToolResultLog', 'enableAppApiLog', 'enableEventLog', 'enableErrorLog'] as const) {
      expect(typeof zh.schema?.logs?.[key]?.label, `zh schema.logs.${key}.label`).toBe('string');
      expect(typeof en.schema?.logs?.[key]?.label, `en schema.logs.${key}.label`).toBe('string');
    }
  });
});

describe('T5 app-dev-config ns zh-CN ↔ en key 集合对齐', () => {
  it('zh-CN 与 en app-dev-config ns key 集合完全一致', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('app-dev-config');
    expect(onlyInZh, `仅 zh-CN 有的 app-dev-config key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 app-dev-config key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

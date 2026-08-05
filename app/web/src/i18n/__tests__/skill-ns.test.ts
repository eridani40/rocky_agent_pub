/**
 * @vitest-environment jsdom
 * T5 skill ns 结构单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4（bundle 物理结构）
 *       states/v0.0.59.i18n/i18n-backlog-frontend.md B6（skill ns ~3 条，作起点）
 *       task.json T5 description（含全扫清单 — 吸取 T2 教训：扫整个 skill-page/ 目录）
 *
 * 边界（task.json invariants.no_skill_content_i18n）：
 *   system skill SKILL.md 内容不迁（协议约束）；本 ns 仅覆盖 skill-page 前端管理 UI。
 *
 * 覆盖：
 *   - skill ns 顶层分组完整（B6 + 全扫漏盘：tab/page.header/item/dropzone/list/deleteModal/previewModal）
 *   - 各分组的 leaf 文案符合预期（zh-CN/en 对齐）
 *   - 含插值占位符的 key 校验（item.toggleAria/evolvableAria/deleteAria + deleteModal.body）
 *   - zh-CN / en key 集合一致
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { diffNsKeys } from './_test-helpers';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('T5 skill ns 顶层分组（B6 + 全扫漏盘补迁）', () => {
  it('skill ns 顶层分组覆盖 B6 + 全扫清单全部域', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'skill');
    const expectedGroups = ['tab', 'page', 'item', 'dropzone', 'list', 'deleteModal', 'previewModal'];
    for (const g of expectedGroups) {
      expect(zh[g], `skill.${g} 顶层分组应存在`).toBeDefined();
    }
  });

  it('skill.page 4 error fallback leaf（loadFail/installFail/previewFail/deleteFail）+ headerTitle/headerDesc/loading', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'skill');
    const en = i18n.getResourceBundle('en', 'skill');
    for (const leaf of ['loadFail', 'installFail', 'previewFail', 'deleteFail', 'headerTitle', 'headerDesc', 'loading'] as const) {
      expect(typeof zh.page?.[leaf], `zh skill.page.${leaf}`).toBe('string');
      expect(typeof en.page?.[leaf], `en skill.page.${leaf}`).toBe('string');
    }
  });

  it('skill.item 9 leaf（含 3 个 {{name}} 插值的 aria）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'skill');
    for (const leaf of ['enabled', 'disabled', 'emptyDesc', 'enableLabel', 'evolvableLabel', 'toggleAria', 'evolvableAria', 'previewBtn', 'deleteTitle', 'deleteAria'] as const) {
      expect(typeof zh.item?.[leaf], `zh skill.item.${leaf}`).toBe('string');
    }
    expect(zh.item.toggleAria).toContain('{{name}}');
    expect(zh.item.evolvableAria).toContain('{{name}}');
    expect(zh.item.deleteAria).toContain('{{name}}');
  });

  it('skill.dropzone 4 leaf（title/subtitle/selectFile/selectFolder）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'skill');
    for (const leaf of ['title', 'subtitle', 'selectFile', 'selectFolder'] as const) {
      expect(typeof zh.dropzone?.[leaf]).toBe('string');
    }
  });

  it('skill.deleteModal 2 leaf（title/body 含 {{name}} 插值）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'skill');
    expect(typeof zh.deleteModal?.title).toBe('string');
    expect(zh.deleteModal.body).toContain('{{name}}');
  });

  it('skill.previewModal 7 leaf（emptyTree/loading/binary/emptyFile/truncated/readFail/selectHint）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'skill');
    for (const leaf of ['emptyTree', 'loading', 'binary', 'emptyFile', 'truncated', 'readFail', 'selectHint'] as const) {
      expect(typeof zh.previewModal?.[leaf]).toBe('string');
    }
  });
});

describe('T5 skill ns zh-CN ↔ en key 集合对齐', () => {
  it('zh-CN 与 en skill ns key 集合完全一致', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('skill');
    expect(onlyInZh, `仅 zh-CN 有的 skill key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 skill key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

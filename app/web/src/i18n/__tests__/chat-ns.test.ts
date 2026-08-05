/**
 * @vitest-environment jsdom
 * T2 chat ns 结构 + stop-reason helper 单测
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §6（type code 累积映射表）
 *       specs/tech/i18n/index.md §⑥ chat.run.stopReason.<camelCase> 6 leaf
 *       states/v0.0.59.i18n/i18n-backlog-frontend.md B1（chat ns ~28 条）
 *
 * 覆盖：
 *   - chat ns 顶层分组完整（覆盖 B1 全部条目域）
 *   - run.stopReason 6 camelCase leaf 存在（noToolCall/noNewMessages/.../interrupted）
 *   - camelCaseStopReason snake → camel 转换正确
 *   - localizedStopReason 查表正确返回 zh-CN 文案
 *   - zh-CN / en key 集合一致（与 keys-aligned.test.ts 互补，本测试聚焦 chat ns 结构）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { i18n, initI18n } from '../index';
import { camelCaseStopReason, localizedStopReason } from '../stop-reason';
import { diffNsKeys } from './_test-helpers';
import type { TFunction } from 'i18next';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('T2 chat ns 结构（B1 + spec §⑥ stopReason）', () => {
  it('chat ns 顶层分组覆盖 B1 全部域', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'chat');
    // B1 列出的所有分组：session / convPanel / composer.send / conversation.delete /
    // subagent / toolBatch / toolCall / run.stopReason + run.error / loading /
    // abort / memory + memory.editor / workspace.{unset,resize,tree,tab} /
    // usage.{row,leg,col,toggle,...} / readonlyBadge
    const expectedGroups = [
      'session',
      'convPanel',
      'composer',
      'conversation',
      'subagent',
      'toolBatch',
      'toolCall',
      'run',
      'loading',
      'abort',
      'memory',
      'workspace',
      'usage',
      'readonlyBadge',
      // [v0.0.62 T2 补迁] cron 集群 + 其他 chat-page P0 漏盘补迁
      'cron',
      'emptyState',
      'clearConfirm',
      'enqueue',
      'mention',
    ];
    for (const g of expectedGroups) {
      expect(zh[g], `chat.${g} 顶层分组应存在`).toBeDefined();
    }
  });

  it('chat.run.stopReason 6 camelCase leaf 全部存在（spec §⑥ + T6 type code 范式）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'chat');
    const en = i18n.getResourceBundle('en', 'chat');
    // 6 camelCase code（error 不进表，走 RunErrorInfo.displayReason 范式）
    // [v0.0.101] requireApproval → toolPending（HITL 悬挂态，O7 废弃 require_approval）
    const expectedCodes = [
      'noToolCall',
      'noNewMessages',
      'maxIterations',
      'doomLoop',
      'toolPending',
      'interrupted',
    ];
    for (const code of expectedCodes) {
      expect(typeof zh.run?.stopReason?.[code], `zh-CN chat.run.stopReason.${code} 应为 string`).toBe('string');
      expect(typeof en.run?.stopReason?.[code], `en chat.run.stopReason.${code} 应为 string`).toBe('string');
    }
  });

  it('chat.usage 4 row + 4 leg + 5 col leaf（B1 §4.7 cum-table 完整）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'chat');
    expect(zh.usage?.row?.current).toBeTruthy();
    expect(zh.usage?.row?.forked).toBeTruthy();
    expect(zh.usage?.row?.sub).toBeTruthy();
    expect(zh.usage?.row?.total).toBeTruthy();
    expect(zh.usage?.leg?.system).toBeTruthy();
    expect(zh.usage?.leg?.messages).toBeTruthy();
    expect(zh.usage?.leg?.tools).toBeTruthy();
    expect(zh.usage?.leg?.reserve).toBeTruthy();
    expect(zh.usage?.col?.source).toBeTruthy();
    expect(zh.usage?.col?.input).toBeTruthy();
    expect(zh.usage?.col?.cache).toBeTruthy();
    expect(zh.usage?.col?.output).toBeTruthy();
    expect(zh.usage?.col?.total).toBeTruthy();
  });

  it('chat.workspace.tab 4 leaf（cron tab 收敛进悬浮菜单弹层，tab.cron 孤儿 key 已删）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'chat');
    expect(zh.workspace?.tab?.workspace).toBeTruthy();
    expect(zh.workspace?.tab?.memory).toBeTruthy();
    expect(zh.workspace?.tab?.switchDir).toBeTruthy();
    expect(zh.workspace?.tab?.refresh).toBeTruthy();
    expect(zh.workspace?.tab?.collapse).toBeTruthy();
    // tab.cron 已随 ws-panel cron tab 删除（component-chat-float-menu 收纳），不再存在
    expect(zh.workspace?.tab?.cron).toBeUndefined();
  });

  it('chat.minimap / chat.floatMenu leaf（历史 query minimap + 右上悬浮菜单）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'chat');
    const en = i18n.getResourceBundle('en', 'chat');
    expect(typeof zh.minimap?.noReply).toBe('string');
    expect(typeof en.minimap?.noReply).toBe('string');
    expect(typeof zh.floatMenu?.memory).toBe('string');
    expect(typeof en.floatMenu?.memory).toBe('string');
    expect(typeof zh.floatMenu?.cron).toBe('string');
    expect(typeof en.floatMenu?.cron).toBe('string');
  });

  it('chat.cron 5 子分组（panel/form/freq/job/delete + error）覆盖 v0.0.58 cron 集群（B1 P0 漏盘补迁）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'chat');
    const en = i18n.getResourceBundle('en', 'chat');
    // 5 子分组 + error 全部存在
    for (const g of ['panel', 'form', 'freq', 'job', 'delete', 'error'] as const) {
      expect(zh.cron?.[g], `zh-CN chat.cron.${g} 子分组应存在`).toBeDefined();
      expect(en.cron?.[g], `en chat.cron.${g} 子分组应存在`).toBeDefined();
    }
    // freq 4 preset leaf + advanced（component-cron-freq-picker chip）
    for (const leaf of ['presetMinutes', 'presetHours', 'presetDaily', 'presetWeekly', 'advancedToggle', 'advancedSummary'] as const) {
      expect(typeof zh.cron?.freq?.[leaf]).toBe('string');
      expect(typeof en.cron?.freq?.[leaf]).toBe('string');
    }
    // job 4 state leaf（component-cron-job-card toggle + meta）
    for (const leaf of ['nextFire', 'notScheduled', 'disabled', 'enableAria', 'disableAria', 'stateEnabled', 'stateDisabled'] as const) {
      expect(typeof zh.cron?.job?.[leaf]).toBe('string');
    }
    expect(zh.cron?.job?.nextFire).toContain('{{time}}');
  });

  it('chat 其他 P0 补迁 leaf（emptyState/clearConfirm/enqueue/memory.entryCard/mention/workspace.expand）', () => {
    const zh = i18n.getResourceBundle('zh-CN', 'chat');
    // emptyState（component-empty-state，[v0.0.165] 严肃化 hero：newConversation CTA + eyebrow/subtitle/chip×3；welcomeTitle/welcomeHint 仍下线，因与 CTA 语义重复）
    expect(typeof zh.emptyState?.newConversation).toBe('string');
    expect(typeof zh.emptyState?.eyebrow).toBe('string');
    expect(typeof zh.emptyState?.subtitle).toBe('string');
    expect(typeof zh.emptyState?.chipFile).toBe('string');
    expect(typeof zh.emptyState?.chipResearch).toBe('string');
    expect(typeof zh.emptyState?.chipCode).toBe('string');
    expect(zh.emptyState?.welcomeTitle).toBeUndefined();
    expect(zh.emptyState?.welcomeHint).toBeUndefined();
    // clearConfirm（component-clear-confirm-modal）
    for (const leaf of ['title', 'body', 'confirm'] as const) {
      expect(typeof zh.clearConfirm?.[leaf]).toBe('string');
    }
    // enqueue（component-enqueue-view）
    expect(zh.enqueue?.queueHint).toContain('{{count}}');
    expect(typeof zh.enqueue?.expandFull).toBe('string');
    expect(typeof zh.enqueue?.dequeue).toBe('string');
    // memory.entryCard（component-memory-entry-card）
    for (const leaf of ['archived', 'collapseDetail', 'expandDetail', 'archive'] as const) {
      expect(typeof zh.memory?.entryCard?.[leaf]).toBe('string');
    }
    // mention（component-mention-popover）
    expect(typeof zh.mention?.searchPlaceholder).toBe('string');
    expect(typeof zh.mention?.noMatch).toBe('string');
    // workspace.expand（section-workspace-panel 收起态展开按钮）
    expect(typeof zh.workspace?.expand?.title).toBe('string');
    expect(typeof zh.workspace?.expand?.ariaLabel).toBe('string');
  });

  it('zh-CN 与 en chat ns key 集合完全一致（与 keys-aligned.test.ts 互补）', () => {
    const { onlyInZh, onlyInEn } = diffNsKeys('chat');
    expect(onlyInZh, `仅 zh-CN 有的 chat key: ${onlyInZh.join(', ')}`).toEqual([]);
    expect(onlyInEn, `仅 en 有的 chat key: ${onlyInEn.join(', ')}`).toEqual([]);
  });
});

describe('camelCaseStopReason（snake_case → camelCase 转换）', () => {
  it('6 个 StopReason code 转换正确', () => {
    expect(camelCaseStopReason('no_tool_call')).toBe('noToolCall');
    expect(camelCaseStopReason('no_new_messages')).toBe('noNewMessages');
    expect(camelCaseStopReason('max_iterations')).toBe('maxIterations');
    expect(camelCaseStopReason('doom_loop')).toBe('doomLoop');
    expect(camelCaseStopReason('tool_pending')).toBe('toolPending');
    // 单 word 不变
    expect(camelCaseStopReason('interrupted')).toBe('interrupted');
  });

  it('空字符串兜底返回空', () => {
    expect(camelCaseStopReason('')).toBe('');
  });
});

describe('localizedStopReason（chat.run.stopReason.<camelCase> 查表）', () => {
  // 用 i18n.getFixedT 取绑定 'chat' ns 的 t 函数（与 useTranslation('chat') 等价）
  const t = i18n.getFixedT('zh-CN', 'chat') as TFunction;

  it('no_tool_call → 已完成', () => {
    expect(localizedStopReason('no_tool_call', t)).toBe('已完成');
  });

  it('no_new_messages → 已完成（克制态）', () => {
    expect(localizedStopReason('no_new_messages', t)).toBe('已完成');
  });

  it('doom_loop → 检测到死循环，已停止', () => {
    expect(localizedStopReason('doom_loop', t)).toBe('检测到死循环，已停止');
  });

  it('max_iterations → 已达最大迭代数', () => {
    expect(localizedStopReason('max_iterations', t)).toBe('已达最大迭代数');
  });

  it('tool_pending → 等待输入（[v0.0.101] 替换原 require_approval 等待审批）', () => {
    expect(localizedStopReason('tool_pending', t)).toBe('等待输入');
  });

  it('interrupted → 已中断', () => {
    expect(localizedStopReason('interrupted', t)).toBe('已中断');
  });

  it('en locale 查表：no_tool_call → Completed', () => {
    const tEn = i18n.getFixedT('en', 'chat') as TFunction;
    expect(localizedStopReason('no_tool_call', tEn)).toBe('Completed');
  });

  it('未迁移的 code → 返回空串（defensive 兜底，理论不发生）', () => {
    // 自造一个不存在的 code（前端不会发，但 helper 应 defensive）
    // 注意：parseMissingKeyHandler 在 init 时返回「【资源 xxx 不存在】」
    // localizedStopReason 检测到该前缀 → 返回空串
    expect(localizedStopReason('some_unknown_code', t)).toBe('');
  });
});

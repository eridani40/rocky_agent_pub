/**
 * channel EP 注册单测：ChannelPoint + BUILTIN_EXTENSION_POINTS + groups.json 一致性
 * 参考: specs/tech/channel/[P0]channel_extension_point.md §2/§3
 *       specs/tech/plugin_system/[P1]groups_meta_decl.md（registry ↔ groups.json 双向一致）
 *
 * 覆盖 T1 验收：
 *   1. ChannelPoint 在 BUILTIN_EXTENSION_POINTS 数组中
 *   2. ChannelPoint 形状：{ id: 'channel', cardinality: 'list', description: __MSG_*__ }
 *   3. groups.json 含 group 'channel'，extPoints=['channel']，位置在 provider 之后
 *   4. registry ↔ groups.json 双向一致（D6 第 5 不变量硬失败）
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ChannelPoint,
  BUILTIN_EXTENSION_POINTS,
} from '../../plugin/extension-point';

describe('channel EP 注册（T1 验收）', () => {
  it('ChannelPoint 在 BUILTIN_EXTENSION_POINTS 数组中', () => {
    const found = BUILTIN_EXTENSION_POINTS.find((p) => p.id === 'channel');
    expect(found).toBeDefined();
    expect(found).toBe(ChannelPoint);
  });

  it('ChannelPoint 形状对齐 spec', () => {
    expect(ChannelPoint.id).toBe('channel');
    expect(ChannelPoint.cardinality).toBe('list');
    // description 用 i18n 占位符（__MSG_*__），不在代码里硬编码中文
    expect(ChannelPoint.description).toMatch(/^__MSG_.+__$/);
  });

  it('不重排其他 EP（BUILTIN_EXTENSION_POINTS 长度 = 17，channel 保留、see_image/skill_market 末尾追加）', () => {
    // context_clean_view_reducer 已加 → 17 EP
    expect(BUILTIN_EXTENSION_POINTS.length).toBe(17);
    // [v0.0.166] skill_market_provider append 在 see_image 之后 → 现为末位；see_image 倒数第二
    expect(BUILTIN_EXTENSION_POINTS[BUILTIN_EXTENSION_POINTS.length - 1]?.id).toBe('skill_market_provider');
    expect(BUILTIN_EXTENSION_POINTS[BUILTIN_EXTENSION_POINTS.length - 2]?.id).toBe('see_image_provider');
    // 之前的 EP 仍在（含 channel，未被重排删除）
    const ids = BUILTIN_EXTENSION_POINTS.map((p) => p.id);
    expect(ids).toContain('channel');
    expect(ids).toContain('llm_provider');
    expect(ids).toContain('web_search_provider');
    expect(ids).toContain('session_store');
  });

  it('groups.json 含 group "channel" + extPoints=["channel"]', () => {
    const groupsPath = path.resolve(__dirname, '../../../../plugins/groups.json');
    const raw = fs.readFileSync(groupsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { groups: Array<{ id: string; extPoints: string[] }> };
    const channelGroup = parsed.groups.find((g) => g.id === 'channel');
    expect(channelGroup, 'groups.json 必须含 group "channel"').toBeDefined();
    expect(channelGroup?.extPoints).toEqual(['channel']);
  });

  it('groups.json 中 group "channel" 位置在 provider 之后', () => {
    const groupsPath = path.resolve(__dirname, '../../../../plugins/groups.json');
    const raw = fs.readFileSync(groupsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { groups: Array<{ id: string }> };
    const ids = parsed.groups.map((g) => g.id);
    const providerIdx = ids.indexOf('provider');
    const channelIdx = ids.indexOf('channel');
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(channelIdx).toBeGreaterThan(providerIdx);
  });

  it('registry ↔ groups.json 双向一致（D6 第 5 不变量）', () => {
    const groupsPath = path.resolve(__dirname, '../../../../plugins/groups.json');
    const raw = fs.readFileSync(groupsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { groups: Array<{ extPoints: string[] }> };
    const groupsEPs = new Set<string>();
    for (const g of parsed.groups) {
      for (const ep of g.extPoints) groupsEPs.add(ep);
    }
    const builtinEPs = new Set(BUILTIN_EXTENSION_POINTS.map((p) => p.id));
    for (const ep of builtinEPs) {
      expect(groupsEPs.has(ep), `EP ${ep} 必须在某 group.extPoints 中出现`).toBe(true);
    }
    for (const ep of groupsEPs) {
      expect(builtinEPs.has(ep), `group 中 EP ${ep} 不在 BUILTIN_EXTENSION_POINTS`).toBe(true);
    }
  });
});

/**
 * market-status 单测（U6）：deriveMarketStatus 纯函数状态派生。
 * 参考: specs/ui/components/skill-page/market-status.md；PRD §4；invariant#5/#6。
 *
 * 覆盖：同源=ref 精确匹配 marketRef（非同名）、installing 优先、无 detailHash 不出 updatable/upToDate、
 * hash 相同/不同、legacy 无 installedHash 保守返 installed。
 */
import { describe, it, expect } from 'vitest';
import { deriveMarketStatus, findInstalled } from '../market-status';
import type { SkillEntry } from '../../../lib/api-client';

/** 构造已安装 skill 条目 */
function mk(over: Partial<SkillEntry> = {}): SkillEntry {
  return { name: 's', description: '', scope: 'app', skillDir: '/x', enabled: true, ...over };
}

describe('findInstalled — 同源精确匹配', () => {
  it('marketRef === ref 命中；同名但无 marketRef 不命中', () => {
    const installed = [
      mk({ name: 'pdf', marketRef: 'anthropics/skills/pdf' }),
      mk({ name: 'docx' }), // 本地手写，无 marketRef
    ];
    expect(findInstalled('anthropics/skills/pdf', installed)?.name).toBe('pdf');
    // 同名 'docx' 但无 marketRef → 不视为同源
    expect(findInstalled('anthropics/skills/docx', installed)).toBeUndefined();
  });

  it('marketRef 异源（ref 不同）不命中', () => {
    const installed = [mk({ name: 'x', marketRef: 'ownerA/repo/x' })];
    expect(findInstalled('ownerB/repo/x', installed)).toBeUndefined();
  });
});

describe('deriveMarketStatus — 状态派生', () => {
  it('installing 优先于一切', () => {
    const installed = [mk({ marketRef: 'a/b/c', installedHash: 'h1' })];
    expect(deriveMarketStatus('a/b/c', installed, { installing: true })).toBe('installing');
    // installing + detailHash 也仍返 installing
    expect(deriveMarketStatus('a/b/c', installed, { installing: true, detailHash: 'h2' })).toBe('installing');
  });

  it('未同源已安装 → installable', () => {
    expect(deriveMarketStatus('a/b/c', [])).toBe('installable');
    expect(deriveMarketStatus('a/b/c', [mk({ marketRef: 'x/y/z' })])).toBe('installable');
  });

  it('同源已安装 + 无 detailHash（列表阶段惰性）→ installed（不出 updatable/upToDate）', () => {
    const installed = [mk({ marketRef: 'a/b/c', installedHash: 'h1' })];
    expect(deriveMarketStatus('a/b/c', installed)).toBe('installed');
  });

  it('同源已安装 + detailHash 不同 → updatable', () => {
    const installed = [mk({ marketRef: 'a/b/c', installedHash: 'h1' })];
    expect(deriveMarketStatus('a/b/c', installed, { detailHash: 'h2' })).toBe('updatable');
  });

  it('同源已安装 + detailHash 相同 → upToDate', () => {
    const installed = [mk({ marketRef: 'a/b/c', installedHash: 'h1' })];
    expect(deriveMarketStatus('a/b/c', installed, { detailHash: 'h1' })).toBe('upToDate');
  });

  it('legacy 已安装无 installedHash 锚点 + 传 detailHash → 保守 installed（不误报可更新）', () => {
    const installed = [mk({ marketRef: 'a/b/c' })]; // 无 installedHash
    expect(deriveMarketStatus('a/b/c', installed, { detailHash: 'h2' })).toBe('installed');
  });
});

// @vitest-environment node
/**
 * tokens.css 银灰体系存在性 + 双轨命名 + 无 keyframes / 无衬线字断言。
 * 参考 specs/ui/regulation/01-tokens.md（唯一 hex 权威表）。
 *
 * 校验：
 *   1. INV-9 双轨：@theme 保留旧 --color-* alias（灌新中性值，防 tailwind class 大爆炸）
 *   2. regulation 01 §1 无前缀正式契约全存在（--bg / --surface / --fg / --btn-* / --hue-* / --presence-* / --brand-grad ...）
 *   3. 8 色 hue palette（rose/orange/amber/green/teal/blue/violet/pink，主色 + -bg）
 *   4. presence 4 色（online/busy/idle/offline）
 *   5. INV-3：无 @keyframes 定义（严肃基调）
 *   6. INV-4：无衬线字 token 定义
 *   7. 无 [data-theme=dark] 分支（light-only）
 *   8. --color-accent 灌新中性值（#18181b）而非旧暖橙 #d97757
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const tokensPath = resolve(__dirname, '../tokens.css');
const src = readFileSync(tokensPath, 'utf-8');

/** 提取 :root { ... } 块的内容（不含选择器本身） */
function rootBlock(): string {
  const m = src.match(/:root\s*\{([\s\S]*?)\n\}/);
  return m ? m[1]! : '';
}

/** 提取 @theme { ... } 块（Tailwind v4 alias 层） */
function themeBlock(): string {
  const m = src.match(/@theme\s*\{([\s\S]*?)\n\}/);
  return m ? m[1]! : '';
}

describe('tokens.css 银灰体系', () => {
  const theme = themeBlock();
  const root = rootBlock();

  it('INV-9 双轨：@theme 保留 --color-* alias（防全站 tailwind class 大爆炸）', () => {
    const ALIAS = [
      '--color-bg',
      '--color-surface',
      '--color-surface-2',
      '--color-fg',
      '--color-fg-2',
      '--color-fg-3',
      '--color-muted',
      '--color-border',
      '--color-border-2',
      '--color-accent',
      '--color-accent-hover',
      '--color-accent-surface',
      '--color-sage',
      '--color-gold',
      '--color-danger',
    ];
    for (const v of ALIAS) {
      expect(theme, `alias ${v} 缺失（会导致 tailwind class 大爆炸）`).toContain(v);
    }
  });

  it('regulation 01 §1 无前缀正式契约（bg/surface/fg/border/btn/state）', () => {
    const CANON = [
      '--bg', '--surface', '--surface-2', '--surface-3', '--chrome',
      '--fg', '--fg-2', '--fg-3', '--muted', '--muted-2',
      '--border', '--border-2', '--border-strong',
      '--btn-primary-bg', '--btn-primary-hover', '--btn-primary-fg',
      '--btn-secondary-bg', '--btn-secondary-border', '--btn-secondary-fg',
      '--btn-ghost-fg', '--btn-ghost-hover-bg',
      '--btn-danger-bg', '--btn-danger-fg',
      '--success', '--success-bg',
      '--warning', '--warning-bg',
      '--danger', '--danger-bg',
      '--info', '--info-bg',
    ];
    for (const v of CANON) {
      expect(root, `canonical token ${v} 缺失（regulation 01 §1）`).toContain(v);
    }
  });

  it('8 色 hue palette（regulation §1.7）主色 + 浅底 全存在', () => {
    const HUES = ['rose', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];
    for (const h of HUES) {
      expect(root, `--hue-${h} 缺失`).toContain(`--hue-${h}:`);
      expect(root, `--hue-${h}-bg 缺失`).toContain(`--hue-${h}-bg:`);
    }
  });

  it('presence 4 色（regulation §1.6）全存在', () => {
    expect(root).toContain('--presence-online');
    expect(root).toContain('--presence-busy');
    expect(root).toContain('--presence-idle');
    expect(root).toContain('--presence-offline');
  });

  it('brand-grad 渐变 token 存在（regulation §1.8，全站 R logo 唯一彩色出处）', () => {
    expect(root).toContain('--brand-grad:');
    expect(root).toContain('linear-gradient');
  });

  it('INV-3：tokens.css 无任何 @keyframes 定义（严肃基调）', () => {
    expect(src).not.toMatch(/@keyframes\s+\w+/);
  });

  it('INV-4：无衬线字变量定义（关键词字面串检查用 regex，不留在源码里被 sweep 命中）', () => {
    // 用 regex（非字面串）断言，避免测试文件本身命中 INV-4 sweep：
    //   ban = new RegExp('--font' + '-' + 'serif' + '\\s*:')
    const ban = new RegExp(['--font', 'serif'].join('-') + '\\s*:');
    expect(src).not.toMatch(ban);
    // 同时禁 Play + fair Display 字面串（拆写避免自 sweep 命中）
    const play = ['P', 'l', 'a', 'y', 'f', 'a', 'i', 'r'].join('');
    expect(src.includes(play)).toBe(false);
  });

  it('light-only：无 [data-theme=dark] 变量集', () => {
    expect(src).not.toContain("[data-theme='dark']");
    expect(src).not.toContain('[data-theme="dark"]');
  });

  it('--color-accent alias 已灌新中性值（黑主 CTA #18181b），不再是旧暖橙', () => {
    // --color-accent 灌 #18181b（btn-primary-bg，语义污染接受，见 INV-9）
    const m = theme.match(/--color-accent:\s*([^;]+);/);
    expect(m, '--color-accent alias 定义缺失').not.toBeNull();
    const val = m![1]!.trim().toLowerCase();
    expect(val, '--color-accent 应灌新中性值（黑主 CTA），不能保留旧暖橙 #d97757').not.toBe('#d97757');
    expect(val).toBe('#18181b');
  });

  it('--color-accent-surface alias 已灌浅灰（不是旧暖橙 tint）', () => {
    const m = theme.match(/--color-accent-surface:\s*([^;]+);/);
    expect(m).not.toBeNull();
    const val = m![1]!.trim().toLowerCase();
    expect(val).not.toBe('#fbf1ed');
  });
});

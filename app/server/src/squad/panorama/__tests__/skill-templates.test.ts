/**
 * panorama-designer skill + 模板库回归 UT（v0.0.189.dsl_board Task#6）.
 * ① templates/*.yaml 必须过 parseDsl + validateDsl（四层校验可达部分）——模板改动后自动拦非法 DSL
 * ② SKILL.md frontmatter 合法、name=panorama-designer、description 含「何时加载」
 * ③ SkillResolver 扫 builtin 层能发现 panorama-designer 且 enabled=true（fallback 默认开）
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDsl } from '../dsl';
import { validateDsl } from '../validation';
import { SkillResolver, builtinSkillRoot, parseSkillDir } from '../../../skills/resolver';

const SKILL_DIR = join(builtinSkillRoot(), 'panorama-designer');
const TEMPLATES_DIR = join(SKILL_DIR, 'templates');
const templateFiles = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.yaml'));

describe('panorama-designer templates', () => {
  it('模板库至少含 ci-cd.yaml 与 team-work.yaml', () => {
    expect(templateFiles).toContain('ci-cd.yaml');
    expect(templateFiles).toContain('team-work.yaml');
  });
  for (const f of templateFiles) {
    it(`${f} 过 parseDsl（syntax+schema 基础层）`, () => {
      const r = parseDsl(readFileSync(join(TEMPLATES_DIR, f), 'utf8'));
      expect(r.ok ? [] : r.errors).toEqual([]);
    });
    it(`${f} 过 validateDsl 四层校验`, () => {
      const r = validateDsl(readFileSync(join(TEMPLATES_DIR, f), 'utf8'));
      expect(r.ok ? [] : r.errors).toEqual([]);
    });
  }
});

describe('panorama-designer skill 注册', () => {
  it('SKILL.md frontmatter 合法且 name=panorama-designer', () => {
    const entry = parseSkillDir(SKILL_DIR, 'builtin');
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe('panorama-designer');
    expect(entry?.description).toContain('全景');
    expect(entry?.description).toContain('何时加载');
  });
  it('SkillResolver builtin 扫描含 panorama-designer 且 enabled=true', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'panorama-skill-'));
    const catalog = SkillResolver.resolve(dataDir, undefined, null, builtinSkillRoot());
    const entry = catalog.entries.find((e) => e.name === 'panorama-designer');
    expect(entry).toBeDefined();
    expect(entry?.scope).toBe('builtin');
    expect(entry?.enabled).toBe(true);
  });
});

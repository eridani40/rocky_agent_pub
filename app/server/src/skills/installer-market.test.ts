/**
 * installer-core 市场来源元数据 + 同源覆盖守卫 UT（v0.0.167，change_plan 模块 A+B）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §7.1
 *       specs/tech/agent/skills/[P0]skill_definition.md §2 §6.3
 *       specs/tech/version_logs/v0.0.167.skill_market_ui/change_plan.md 模块 A/B + §invariants#1/#2/#3
 *
 * 覆盖：
 *   U1 install 元数据：stageAndInstallFiles 传第 4 参 market → SKILL.md frontmatter 含
 *      market_ref/market_source/installed_hash；不传（multipart 风格 3 参）→ 这些键不写（零回归 invariant#3）。
 *   U2 同源覆盖守卫（correctness-critical，invariant#1）：overwrite=true + 磁盘 market_ref===ref → 覆盖 + 刷新
 *      installed_hash；磁盘无 market_ref（本地）→ conflict 不覆盖；磁盘 market_ref≠ref（异源）→ conflict 不覆盖；
 *      overwrite=false + 同名 → conflict（现有行为不变）。
 *   U3 resolver 读回：parseSkillDir 暴露 marketRef/marketSource/installedHash；legacy 缺字段 → undefined 不报错。
 *
 * 文件系统隔离：os.tmpdir() + mkdtempSync，afterEach 清理，不碰真实 dataDir。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { stageAndInstallFiles } from './installer-core';
import { parseSkillDir } from './resolver';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rocky-installer-market-ut-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** 合法 SKILL.md 文本（可自定义 frontmatter 片段 + 正文） */
function skillMd(name: string, extra = '', body = '正文'): string {
  return `---\nname: ${name}\ndescription: 演示 skill\n${extra}---\n\n# ${name}\n${body}\n`;
}

/** 读磁盘已装 skill 的 SKILL.md frontmatter data */
function readFm(name: string): Record<string, unknown> {
  return matter(readFileSync(join(dataDir, 'skills', name, 'SKILL.md'), 'utf8')).data;
}

describe('stageAndInstallFiles 市场来源元数据（U1）', () => {
  it('传第 4 参 market → frontmatter 含 market_ref/market_source/installed_hash', () => {
    const files = [{ path: 'mk/SKILL.md', contents: skillMd('mk') }];
    const { entry } = stageAndInstallFiles(files, dataDir, { scope: 'app' }, {
      marketRef: 'github/awesome/mk',
      marketSource: 'skills_sh',
      installedHash: 'hash-abc',
    });
    // 治理硬编码保留（invariant#2）
    expect(entry.productionMethod).toBe('download');
    expect(entry.evolvable).toBe(false);
    // 落盘 frontmatter 三来源键（snake_case）
    const fm = readFm('mk');
    expect(fm.market_ref).toBe('github/awesome/mk');
    expect(fm.market_source).toBe('skills_sh');
    expect(fm.installed_hash).toBe('hash-abc');
  });

  it('不传第 4 参（multipart 风格）→ 三来源键不写（零回归 invariant#3）', () => {
    const files = [{ path: 'plain/SKILL.md', contents: skillMd('plain') }];
    stageAndInstallFiles(files, dataDir, { scope: 'app' });
    const fm = readFm('plain');
    expect(fm.market_ref).toBeUndefined();
    expect(fm.market_source).toBeUndefined();
    expect(fm.installed_hash).toBeUndefined();
    // 治理仍写（download 路径恒 download/evolvable=false）
    expect(fm.production_method).toBe('download');
    expect(fm.evolvable).toBe(false);
  });

  it('installedHash 可省略 → 仅写 market_ref/market_source', () => {
    const files = [{ path: 'noh/SKILL.md', contents: skillMd('noh') }];
    stageAndInstallFiles(files, dataDir, { scope: 'app' }, {
      marketRef: 'github/awesome/noh',
      marketSource: 'skills_sh',
    });
    const fm = readFm('noh');
    expect(fm.market_ref).toBe('github/awesome/noh');
    expect(fm.installed_hash).toBeUndefined();
  });
});

describe('finalizeStagedSkill 同源覆盖守卫（U2，correctness-critical invariant#1）', () => {
  const ref = 'github/awesome/dup';
  const market = (installedHash: string) => ({ marketRef: ref, marketSource: 'skills_sh', installedHash });

  it('overwrite=true + 磁盘 market_ref===ref → 覆盖成功 + 刷新 installed_hash', () => {
    // 首装：ref + hash1 + 旧正文
    stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'OLD_BODY') }],
      dataDir, { scope: 'app' }, market('hash-1'),
    );
    // 同源覆盖：同 ref + hash2 + 新正文
    const { entry } = stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'NEW_BODY') }],
      dataDir, { scope: 'app', overwrite: true }, market('hash-2'),
    );
    expect(entry.name).toBe('dup');
    const fm = readFm('dup');
    expect(fm.installed_hash).toBe('hash-2'); // installed_hash 刷新
    expect(fm.market_ref).toBe(ref);
    // 正文被新内容替换（真覆盖，非追加）
    expect(readFileSync(join(dataDir, 'skills', 'dup', 'SKILL.md'), 'utf8')).toContain('NEW_BODY');
  });

  it('overwrite=true + 磁盘无 market_ref（本地手写）→ conflict，不覆盖本地', () => {
    // 首装：不传 market → 磁盘无 market_ref（本地来源）
    stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'LOCAL_BODY') }],
      dataDir, { scope: 'app' },
    );
    // 市场安装企图覆盖本地同名 → 必须 conflict
    expect(() => stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'HIJACK') }],
      dataDir, { scope: 'app', overwrite: true }, market('hash-x'),
    )).toThrowError(expect.objectContaining({ code: 'conflict' }));
    // 本地内容未被动
    expect(readFileSync(join(dataDir, 'skills', 'dup', 'SKILL.md'), 'utf8')).toContain('LOCAL_BODY');
    expect(readFm('dup').market_ref).toBeUndefined();
  });

  it('overwrite=true + 磁盘 market_ref≠ref（异源同名）→ conflict，不误覆盖异源', () => {
    // 首装：来源 ref-A
    stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'SOURCE_A') }],
      dataDir, { scope: 'app' },
      { marketRef: 'github/other/dup', marketSource: 'skills_sh', installedHash: 'ha' },
    );
    // 另一来源 ref-B 企图覆盖 → conflict
    expect(() => stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'SOURCE_B') }],
      dataDir, { scope: 'app', overwrite: true }, market('hb'),
    )).toThrowError(expect.objectContaining({ code: 'conflict' }));
    // 异源原内容/来源未被动
    const fm = readFm('dup');
    expect(fm.market_ref).toBe('github/other/dup');
    expect(fm.installed_hash).toBe('ha');
    expect(readFileSync(join(dataDir, 'skills', 'dup', 'SKILL.md'), 'utf8')).toContain('SOURCE_A');
  });

  it('overwrite=false（默认）+ 同名同源 → conflict（现有行为不变）', () => {
    stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'V1') }],
      dataDir, { scope: 'app' }, market('h1'),
    );
    // 即便同源，不开 overwrite 也应 409
    expect(() => stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup', '', 'V2') }],
      dataDir, { scope: 'app' }, market('h2'),
    )).toThrowError(expect.objectContaining({ code: 'conflict' }));
    expect(readFm('dup').installed_hash).toBe('h1'); // 未覆盖
  });
});

describe('parseSkillDir 来源字段读回（U3）', () => {
  it('市场安装 skill → parseSkillDir 暴露 marketRef/marketSource/installedHash', () => {
    stageAndInstallFiles(
      [{ path: 'mk/SKILL.md', contents: skillMd('mk') }],
      dataDir, { scope: 'app' },
      { marketRef: 'github/awesome/mk', marketSource: 'skills_sh', installedHash: 'hh' },
    );
    const entry = parseSkillDir(join(dataDir, 'skills', 'mk'), 'app');
    expect(entry?.marketRef).toBe('github/awesome/mk');
    expect(entry?.marketSource).toBe('skills_sh');
    expect(entry?.installedHash).toBe('hh');
  });

  it('legacy skill（无来源字段）→ 三字段 undefined，不报错', () => {
    // 直接写一个无来源锚点的 skill 目录（模拟本地/legacy）
    const dir = join(dataDir, 'skills', 'legacy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd('legacy'), 'utf8');
    const entry = parseSkillDir(dir, 'app');
    expect(entry).not.toBeNull();
    expect(entry?.marketRef).toBeUndefined();
    expect(entry?.marketSource).toBeUndefined();
    expect(entry?.installedHash).toBeUndefined();
  });
});

/**
 * installer UT —— stageAndInstallFiles（市场下载落盘，U6）+ installSkill multipart 无回归（U7）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §7
 *       specs/tech/version_logs/v0.0.166.skill_market/change_plan.md 模块 ⑤/⑧
 *
 * 覆盖：
 *   U6 stageAndInstallFiles —— files→落盘成功 + 治理 download/evolvable=false（含 frontmatter 持久化）；
 *      缺 SKILL.md/空 files/冲突/路径注入（../、绝对路径）被 assertWithinTmp 挡。
 *   U7 installSkill（multipart）—— folder/单 md 落盘、冲突 409 语义、finalizeStagedSkill 抽取不改语义、
 *      治理字段不被强改（保留源 frontmatter）。
 *
 * 文件系统隔离：os.tmpdir() + mkdtempSync，afterEach 清理，不碰真实 dataDir。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { installSkill, stageAndInstallFiles, InstallError } from './installer';
import { parseSkillDir } from './resolver';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rocky-installer-ut-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** 合法 SKILL.md 文本（可自定义 frontmatter 片段） */
function skillMd(name: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: 演示 skill\n${extra}---\n\n# ${name}\n正文\n`;
}

/** 构造 multipart folder upload（多 file 带 relativePath_* 字段） */
function folderForm(files: Array<{ filename: string; rel: string; content: string }>): FormData {
  const form = new FormData();
  for (const f of files) {
    form.append('file', new File([f.content], f.filename), f.filename);
    form.append(`relativePath_${f.filename}`, f.rel);
  }
  return form;
}

describe('stageAndInstallFiles（U6：市场下载落盘）', () => {
  it('合法 files → 落盘成功 + 治理 download/evolvable=false（含 frontmatter 持久化）', () => {
    const files = [
      { path: 'demo/SKILL.md', contents: skillMd('demo') },
      { path: 'demo/reference.md', contents: 'REF_BODY' },
    ];
    const { entry } = stageAndInstallFiles(files, dataDir, { scope: 'app' });
    expect(entry.name).toBe('demo');
    expect(entry.description).toBe('演示 skill');
    expect(entry.scope).toBe('app');
    expect(entry.enabled).toBe(true);
    expect(entry.productionMethod).toBe('download');
    expect(entry.evolvable).toBe(false);
    expect(entry.skillDir).toBe(join(dataDir, 'skills', 'demo'));
    // 引用文件一并落盘
    expect(existsSync(join(dataDir, 'skills', 'demo', 'reference.md'))).toBe(true);
    // frontmatter 持久化：重扫（resolver.parseSkillDir）也应见 download/evolvable=false（不只是返回对象覆盖）
    const reparsed = parseSkillDir(entry.skillDir, 'app');
    expect(reparsed?.productionMethod).toBe('download');
    expect(reparsed?.evolvable).toBe(false);
    const rawFm = matter(readFileSync(join(entry.skillDir, 'SKILL.md'), 'utf8')).data;
    expect(rawFm.production_method).toBe('download');
    expect(rawFm.evolvable).toBe(false);
  });

  it('源 frontmatter 声明 evolvable: true → 仍被强制 false（下载资产不给 agent 自改）', () => {
    const files = [
      { path: 'evo/SKILL.md', contents: skillMd('evo', 'evolvable: true\nproduction_method: handwritten\n') },
    ];
    const { entry } = stageAndInstallFiles(files, dataDir, { scope: 'app' });
    expect(entry.evolvable).toBe(false);
    expect(entry.productionMethod).toBe('download');
  });

  it('缺 SKILL.md → InstallError(bad_request)', () => {
    const files = [{ path: 'noskill/readme.md', contents: 'no skill md here' }];
    expect(() => stageAndInstallFiles(files, dataDir, { scope: 'app' }))
      .toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('空 files → InstallError(bad_request)', () => {
    expect(() => stageAndInstallFiles([], dataDir, { scope: 'app' }))
      .toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('同名已存在 → InstallError(conflict)', () => {
    const files = [{ path: 'dup/SKILL.md', contents: skillMd('dup') }];
    stageAndInstallFiles(files, dataDir, { scope: 'app' });
    expect(() => stageAndInstallFiles(
      [{ path: 'dup/SKILL.md', contents: skillMd('dup') }], dataDir, { scope: 'app' },
    )).toThrowError(expect.objectContaining({ code: 'conflict' }));
  });

  it('路径注入（../ 遍历）→ InstallError(bad_request)，不越界写', () => {
    const files = [{ path: '../escape/SKILL.md', contents: skillMd('demo') }];
    expect(() => stageAndInstallFiles(files, dataDir, { scope: 'app' }))
      .toThrowError(expect.objectContaining({ code: 'bad_request' }));
    expect(existsSync(join(dataDir, '..', 'escape'))).toBe(false);
  });

  it('路径注入（绝对路径）→ InstallError(bad_request)', () => {
    const files = [{ path: '/tmp/evil/SKILL.md', contents: skillMd('demo') }];
    expect(() => stageAndInstallFiles(files, dataDir, { scope: 'app' }))
      .toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('抛出的错误是 InstallError 实例', () => {
    try {
      stageAndInstallFiles([], dataDir, { scope: 'app' });
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InstallError);
    }
  });
});

describe('installSkill（U7：multipart 无回归 + finalize 抽取不改语义）', () => {
  it('folder install → name/description 来自 frontmatter，落 app scope', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: skillMd('demo') },
      { filename: 'reference.md', rel: 'demo/reference.md', content: 'ref body' },
    ]);
    const { entry } = await installSkill(form, dataDir, { scope: 'app' });
    expect(entry.name).toBe('demo');
    expect(entry.description).toBe('演示 skill');
    expect(entry.scope).toBe('app');
    expect(entry.enabled).toBe(true);
    expect(entry.skillDir).toBe(join(dataDir, 'skills', 'demo'));
    expect(existsSync(join(dataDir, 'skills', 'demo', 'reference.md'))).toBe(true);
  });

  it('multipart 不强改治理字段（无 governance → 保留源 frontmatter 默认）', async () => {
    // 源 frontmatter 无 production_method / evolvable → parseSkillDir 默认 undefined / false（非 download）
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'plain/SKILL.md', content: skillMd('plain') },
    ]);
    const { entry } = await installSkill(form, dataDir, { scope: 'app' });
    expect(entry.productionMethod).toBeUndefined();
    expect(entry.evolvable).toBe(false);
    // frontmatter 未被注入 production_method: download
    const rawFm = matter(readFileSync(join(entry.skillDir, 'SKILL.md'), 'utf8')).data;
    expect(rawFm.production_method).toBeUndefined();
  });

  it('单 .md install → 直接放置', async () => {
    const form = new FormData();
    form.append('file', new File([skillMd('lone')], 'SKILL.md'), 'SKILL.md');
    const { entry } = await installSkill(form, dataDir, { scope: 'app' });
    expect(entry.name).toBe('lone');
  });

  it('缺 SKILL.md → InstallError(bad_request)', async () => {
    const form = folderForm([
      { filename: 'readme.md', rel: 'noskill/readme.md', content: 'no skill md' },
    ]);
    await expect(installSkill(form, dataDir, { scope: 'app' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('frontmatter 缺 name → InstallError(bad_request)', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'x/SKILL.md', content: '---\ndescription: d\n---\nbody' },
    ]);
    await expect(installSkill(form, dataDir, { scope: 'app' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('同名已存在 → InstallError(conflict)，原内容不被覆盖', async () => {
    await installSkill(folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: skillMd('demo', 'ver: v1\n') },
    ]), dataDir, { scope: 'app' });
    await expect(installSkill(folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: skillMd('demo', 'ver: v2\n') },
    ]), dataDir, { scope: 'app' })).rejects.toThrowError(
      expect.objectContaining({ code: 'conflict' }),
    );
    const rawFm = matter(readFileSync(join(dataDir, 'skills', 'demo', 'SKILL.md'), 'utf8')).data;
    expect(rawFm.ver).toBe('v1');
  });

  it('relativePath 含 .. → InstallError(bad_request)，不越界写', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: '../escape/SKILL.md', content: skillMd('demo') },
    ]);
    await expect(installSkill(form, dataDir, { scope: 'app' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }));
    expect(existsSync(join(dataDir, '..', 'escape'))).toBe(false);
  });
});

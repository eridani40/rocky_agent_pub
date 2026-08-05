/**
 * skill governance service 单测 — PATCH /skill/:name/governance（v0.0.55 evolvable 改名）
 * 参考: specs/api/overall/06a-skill-governance.md §2（契约）+ §2.4（service 强制逻辑）
 *
 * v0.0.55 改名 + 删维度（mutable → evolvable；删 mutableLocked 403 路径）：
 *   - 所有 skill（含 source=user/system）UI 都能改 evolvable（用户对 dataDir 资产完全控制权）
 *   - 无 lock 维度 → 删原 mutableLocked=true 403 测试
 *
 * 注：直接调 governSkillEvolvable service（不经 router+bootstrap），与 skill-manage-tool UT 同风格。
 *   HTTP adapter 层（handleSkillGovernance）是薄包装，error→status 映射逻辑简单（不重复测）。
 *
 * 覆盖：
 *   - evolvable=false → 200 + skill.evolvable 翻转 true + 磁盘同步
 *   - evolvable=true → false（反向翻转）
 *   - source=user（默认 evolvable=false）UI 也能改（无 lock 约束，v0.0.55 关键设计）
 *   - 404 name 不存在
 *   - 400 body 错（缺 scope / 缺 evolvable / scope=workspace 缺 workspace / scope=builtin）
 *   - 并发写串行化（per-file lock，两请求最终一致）
 *   - 只改 evolvable，其他字段（description/source 等）不变
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { governSkillEvolvable, GovernanceError } from '../../skills/governance';
import { AppConfigService } from '../../config/app-config-service';

/** 造 fixture skill：dataDir/skills/<name>/SKILL.md（指定 evolvable / source） */
function seedSkill(
  dataDir: string,
  name: string,
  opts: { evolvable: boolean; description?: string; source?: string },
): string {
  const dir = join(dataDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  const fm: string[] = [
    `name: ${name}`,
    `description: ${opts.description ?? 'fixture'}`,
    `evolvable: ${opts.evolvable}`,
  ];
  if (opts.source) fm.push(`source: ${opts.source}`);
  const md = `---\n${fm.join('\n')}\n---\n\n# ${name}\n\nbody text\n`;
  writeFileSync(join(dir, 'SKILL.md'), md);
  return dir;
}

/** 读 SKILL.md frontmatter 字段（简易正则，UT 用，非生产逻辑；value 取行尾，含连字符） */
function fmVal(path: string, key: string): string {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(new RegExp(`^${key}:\\s*['"]?([^'"\\n\\r]+?)['"]?\\s*$`, 'm'));
  return m ? m[1]!.trim().toLowerCase() : '';
}

/** 读 frontmatter ISO 字段值（fmVal 的 [^'"] 取行尾可含 T/Z，但原样保留大小写；专给 updated 用） */
function fmIso(path: string, key: string): string | undefined {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(new RegExp(`^${key}:\\s*['"]?([\\dT:.+-Z]+)['"]?\\s*$`, 'm'));
  return m ? m[1] : undefined;
}

describe('governSkillEvolvable service (UI 改 evolvable)', () => {
  let dataDir: string;
  let appConfig: AppConfigService;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-gov-'));
    appConfig = new AppConfigService({ root: dataDir });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('evolvable=false → 翻转 true + 磁盘同步 + 无 mutableLocked 字段', async () => {
    seedSkill(dataDir, 's1', { evolvable: false, description: 'hand', source: 'user' });
    const skill = await governSkillEvolvable(dataDir, 's1', { scope: 'app', evolvable: true }, appConfig);
    expect(skill.name).toBe('s1');
    expect(skill.evolvable).toBe(true);
    expect(skill.scope).toBe('app');
    expect(skill).not.toHaveProperty('mutableLocked'); // v0.0.55 删字段
    // 磁盘同步
    const md = join(dataDir, 'skills/s1/SKILL.md');
    expect(fmVal(md, 'evolvable')).toBe('true');
    // 其他字段保留
    expect(fmVal(md, 'description')).toBe('hand');
    expect(fmVal(md, 'source')).toBe('user');
  });

  it('evolvable=true → false（反向翻转）', async () => {
    seedSkill(dataDir, 's2', { evolvable: true });
    const skill = await governSkillEvolvable(dataDir, 's2', { scope: 'app', evolvable: false }, appConfig);
    expect(skill.evolvable).toBe(false);
    expect(fmVal(join(dataDir, 'skills/s2/SKILL.md'), 'evolvable')).toBe('false');
  });

  it('source=user skill UI 也能改（v0.0.55 关键设计：无 lock 约束）', async () => {
    // 用户手写 skill（默认 evolvable=false），UI 解锁交给 consolidation —— 不再 403
    seedSkill(dataDir, 'handwritten', { evolvable: false, source: 'user' });
    const skill = await governSkillEvolvable(
      dataDir, 'handwritten', { scope: 'app', evolvable: true }, appConfig,
    );
    expect(skill.evolvable).toBe(true);
    expect(fmVal(join(dataDir, 'skills/handwritten/SKILL.md'), 'evolvable')).toBe('true');
  });

  it('frontmatter 缺 evolvable 字段 → 自动插入并写入新值', async () => {
    // 旧 skill 未写 evolvable，governance 设置时自动补字段
    const dir = join(dataDir, 'skills/legacy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: legacy\ndescription: old\n---\n\nbody\n');
    const skill = await governSkillEvolvable(dataDir, 'legacy', { scope: 'app', evolvable: true }, appConfig);
    expect(skill.evolvable).toBe(true);
    expect(fmVal(join(dataDir, 'skills/legacy/SKILL.md'), 'evolvable')).toBe('true');
  });

  it('name 不存在 → 404 Not Found', async () => {
    await expect(
      governSkillEvolvable(dataDir, 'ghost', { scope: 'app', evolvable: true }, appConfig),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('缺 scope → 400', async () => {
    seedSkill(dataDir, 's3', { evolvable: false });
    await expect(
      governSkillEvolvable(dataDir, 's3', { evolvable: true } as unknown as Record<string, unknown>, appConfig),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('缺 evolvable → 400', async () => {
    seedSkill(dataDir, 's4', { evolvable: false });
    await expect(
      governSkillEvolvable(dataDir, 's4', { scope: 'app' }, appConfig),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('scope=builtin → 400（governance 不可改内置固化 skill）', async () => {
    seedSkill(dataDir, 's5', { evolvable: false });
    await expect(
      governSkillEvolvable(dataDir, 's5', { scope: 'builtin', evolvable: true } as unknown as Record<string, unknown>, appConfig),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('scope=workspace 缺 workspace 参数 → 400', async () => {
    seedSkill(dataDir, 's6', { evolvable: false });
    await expect(
      governSkillEvolvable(dataDir, 's6', { scope: 'workspace', evolvable: true }, appConfig),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('非 boolean evolvable → 400', async () => {
    seedSkill(dataDir, 's7', { evolvable: false });
    await expect(
      governSkillEvolvable(dataDir, 's7', { scope: 'app', evolvable: 'yes' }, appConfig),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('无效 JSON body（null）→ 400', async () => {
    seedSkill(dataDir, 's8', { evolvable: false });
    await expect(
      governSkillEvolvable(dataDir, 's8', null, appConfig),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('per-file lock 串行化：两并发 PATCH 最终一致（evolvable 落盘为 true，不撕裂）', async () => {
    seedSkill(dataDir, 'race', { evolvable: false });
    // 两并发请求：都翻 true。串行化后磁盘应为 true，且 frontmatter 不撕裂
    const [s1, s2] = await Promise.all([
      governSkillEvolvable(dataDir, 'race', { scope: 'app', evolvable: true }, appConfig),
      governSkillEvolvable(dataDir, 'race', { scope: 'app', evolvable: true }, appConfig),
    ]);
    expect(s1.evolvable).toBe(true);
    expect(s2.evolvable).toBe(true);
    // 磁盘完整：能 parse 出 frontmatter，evolvable=true
    const raw = readFileSync(join(dataDir, 'skills/race/SKILL.md'), 'utf8');
    expect(raw).toMatch(/^---\n[\s\S]*\n---\n/);
    expect(fmVal(join(dataDir, 'skills/race/SKILL.md'), 'evolvable')).toBe('true');
    // body 未撕裂（仍含正文）
    expect(raw).toContain('body text');
  });

  it('改 evolvable 不影响其他 frontmatter 字段（source/description 保留）', async () => {
    seedSkill(dataDir, 'rich', {
      evolvable: false,
      description: 'orig-desc',
      source: 'user',
    });
    const skill = await governSkillEvolvable(dataDir, 'rich', { scope: 'app', evolvable: true }, appConfig);
    expect(skill.evolvable).toBe(true);
    const md = join(dataDir, 'skills/rich/SKILL.md');
    expect(fmVal(md, 'description')).toBe('orig-desc');
    expect(fmVal(md, 'source')).toBe('user');
    expect(fmVal(md, 'evolvable')).toBe('true');
  });

  it('workspace scope：合法 workspace → 翻转成功', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'rocky-ws-'));
    try {
      const wsSkillDir = join(ws, '.rocky/skills/wskill');
      mkdirSync(wsSkillDir, { recursive: true });
      writeFileSync(
        join(wsSkillDir, 'SKILL.md'),
        '---\nname: wskill\ndescription: ws\nevolvable: false\n---\n\n# wskill\n',
      );
      const skill = await governSkillEvolvable(
        dataDir, 'wskill', { scope: 'workspace', workspace: ws, evolvable: true }, appConfig,
      );
      expect(skill.scope).toBe('workspace');
      expect(skill.evolvable).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('GovernanceError 类型 + status 字段（HTTP adapter 映射依据）', async () => {
    seedSkill(dataDir, 'typed', { evolvable: false });
    let caught: unknown;
    try {
      await governSkillEvolvable(dataDir, 'ghost', { scope: 'app', evolvable: true }, appConfig);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GovernanceError);
    expect((caught as GovernanceError).status).toBe(404);
  });

  it('[v0.0.149] 改 evolvable 同时刷新 updated=now（外科式：保留其他字段）', async () => {
    // fixture 带旧 updated 戳 + source + description
    const dir = join(dataDir, 'skills/ts-gov');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      'name: ts-gov',
      'description: orig-desc',
      'evolvable: false',
      'source: user',
      'updated: 2020-01-01T00:00:00.000Z',
      '---',
      '',
      'body text',
    ].join('\n'), 'utf8');

    const before = Date.now();
    const skill = await governSkillEvolvable(dataDir, 'ts-gov', { scope: 'app', evolvable: true }, appConfig);
    expect(skill.evolvable).toBe(true);
    const md = join(dataDir, 'skills/ts-gov/SKILL.md');
    // updated 刷新为 now（ISO，不再是 2020 旧戳）
    const ts = fmIso(md, 'updated');
    expect(ts).toBeTruthy();
    expect(Date.parse(ts!)).toBeGreaterThanOrEqual(before);
    expect(ts).not.toBe('2020-01-01T00:00:00.000Z');
    // 其他字段保留（外科式不破坏）
    expect(fmVal(md, 'evolvable')).toBe('true');
    expect(fmVal(md, 'description')).toBe('orig-desc');
    expect(fmVal(md, 'source')).toBe('user');
    // 回读 SkillEntry.updatedAt 反映新戳（resolver 读 updated 短形）
    expect(skill.updatedAt).toBe(ts);
  });

  it('[v0.0.149] frontmatter 无 updated 字段 → governance 自动插入 updated=now', async () => {
    // 旧 skill 未写 updated，governance 改 evolvable 时自动补 updated 戳
    seedSkill(dataDir, 'no-ts', { evolvable: false });
    const skill = await governSkillEvolvable(dataDir, 'no-ts', { scope: 'app', evolvable: true }, appConfig);
    const md = join(dataDir, 'skills/no-ts/SKILL.md');
    const ts = fmIso(md, 'updated');
    expect(ts).toBeTruthy(); // 自动插入
    expect(skill.updatedAt).toBe(ts);
  });
});

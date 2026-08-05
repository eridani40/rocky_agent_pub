/**
 * academy-version-dir 单测 — 写入/读取版本工作区目录（spec §3.1 + §6.1）
 * 参考: specs/tech/academy/[P0]data_model.md §3.1（version.json 内容）+ §6.1（路径）
 *
 * 覆盖：
 *   - writeVersionDirFiles 建 AGENTS.md + version.json + .rocky/{skills,memory}/
 *   - resolveVersionContent 读回五元组（graceful 处理 0.0 空版本）
 *   - copyVersionDir dst 非空抛错（INV-5）
 *   - listVersionSkills 目录 + 文件树 + 每文件 hash（读侧契约 api §1.8）
 *   - versionSkillDir 非法 skillName 拒绝（路径穿越守卫）
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  writeVersionDirFiles,
  resolveVersionContent,
  copyVersionDir,
  listMemoryEntries,
} from '../academy-version-dir';
import {
  listVersionSkillNames,
  listVersionSkills,
  versionSkillDir,
} from '../academy-version-skills';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-vd-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('writeVersionDirFiles + resolveVersionContent', () => {
  it('写完整版本（含 AGENTS.md）+ 读回内容一致', async () => {
    const dir = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(dir, {
      versionLabel: '1.0',
      model: { providerId: 'p1', modelId: 'm1' },
      agentsMd: '# System Prompt',
      tools: ['read', 'write'],
    });
    const content = await resolveVersionContent(dir);
    expect(content.agentsMd).toBe('# System Prompt');
    expect(content.versionJson?.versionLabel).toBe('1.0');
    expect(content.versionJson?.model.providerId).toBe('p1');
    expect(content.versionJson?.tools).toEqual(['read', 'write']);
    expect(content.skillNames).toEqual([]);
  });

  it('0.0 空版本 graceful（无 AGENTS.md）', async () => {
    const dir = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(dir, {
      versionLabel: '0.0',
      model: { modelId: 'default' },
    });
    const content = await resolveVersionContent(dir);
    expect(content.agentsMd).toBe('');
    expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
    expect(content.versionJson?.versionLabel).toBe('0.0');
  });

  it('resolveVersionContent 缺 version.json 返 null', async () => {
    const dir = path.join(tmpRoot, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    // 不写 version.json，直接读
    const content = await resolveVersionContent(dir);
    expect(content.versionJson).toBeNull();
    expect(content.agentsMd).toBe('');
  });

  it('listVersionSkillNames 列 .rocky/skills/ 下目录（asc）', async () => {
    const dir = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(dir, {
      versionLabel: '1.0',
      model: { modelId: 'm' },
    });
    fs.mkdirSync(path.join(dir, '.rocky/skills/alpha'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.rocky/skills/beta'), { recursive: true });
    const names = await listVersionSkillNames(dir);
    expect(names).toEqual(['alpha', 'beta']);
  });

  it('listVersionSkillNames 目录不存在返 []', async () => {
    const dir = path.join(tmpRoot, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    const names = await listVersionSkillNames(dir);
    expect(names).toEqual([]);
  });
});

describe('copyVersionDir（INV-5 原子性）', () => {
  it('正常复制：src → dst 全量内容', async () => {
    const src = path.join(tmpRoot, 'src');
    const dst = path.join(tmpRoot, 'dst');
    await writeVersionDirFiles(src, {
      versionLabel: '1.0',
      model: { modelId: 'm' },
      agentsMd: '# P',
    });
    await copyVersionDir(src, dst);
    const content = await resolveVersionContent(dst);
    expect(content.agentsMd).toBe('# P');
    expect(content.versionJson?.model.modelId).toBe('m');
  });

  it('src 不存在 → throw', async () => {
    const src = path.join(tmpRoot, 'nope');
    const dst = path.join(tmpRoot, 'dst');
    await expect(copyVersionDir(src, dst)).rejects.toThrow(/不存在/);
  });

  it('dst 非空 → throw（INV-5 防覆盖）', async () => {
    const src = path.join(tmpRoot, 'src');
    const dst = path.join(tmpRoot, 'dst');
    await writeVersionDirFiles(src, {
      versionLabel: '1.0',
      model: { modelId: 'm' },
    });
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'existing.txt'), 'x');
    await expect(copyVersionDir(src, dst)).rejects.toThrow(/already exists and is not empty/);
  });

  it('dst 存在但空 → 允许复制', async () => {
    const src = path.join(tmpRoot, 'src');
    const dst = path.join(tmpRoot, 'dst');
    await writeVersionDirFiles(src, {
      versionLabel: '1.0',
      model: { modelId: 'm' },
    });
    fs.mkdirSync(dst, { recursive: true });
    await copyVersionDir(src, dst);
    expect(fs.existsSync(path.join(dst, 'version.json'))).toBe(true);
  });
});

describe('listVersionSkills（读侧 SkillSummary — api §1.8）', () => {
  /** 造一个 skill 目录（可选 SKILL.md frontmatter description + 附属文件） */
  function seedSkill(
    wsDir: string,
    name: string,
    opts: { description?: string; extra?: Record<string, string> } = {},
  ): void {
    const dir = path.join(wsDir, '.rocky/skills', name);
    fs.mkdirSync(dir, { recursive: true });
    if (opts.description !== undefined) {
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${opts.description}\n---\n\n# ${name}\n`,
        'utf8',
      );
    }
    for (const [rel, content] of Object.entries(opts.extra ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content, 'utf8');
    }
  }

  it('多 skill + 子目录 → name asc + 文件树含子目录文件 + description + fileCount 只数 file', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    seedSkill(ws, 'beta', { description: 'B skill' });
    seedSkill(ws, 'alpha', {
      description: 'A skill',
      extra: { 'references/guide.py': 'print(1)' },
    });

    const skills = await listVersionSkills(ws);
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta']);

    const alpha = skills[0]!;
    expect(alpha.description).toBe('A skill');
    // SKILL.md + references/（dir）+ references/guide.py → fileCount 只数 2 个 file
    expect(alpha.fileCount).toBe(2);
    const paths = alpha.files.map((f) => f.path).sort();
    expect(paths).toEqual(['SKILL.md', 'references', path.join('references', 'guide.py')].sort());
    // dir 节点无 hash，file 节点有 hash
    const dirNode = alpha.files.find((f) => f.type === 'dir')!;
    expect(dirNode.hash).toBeUndefined();
    for (const f of alpha.files.filter((n) => n.type === 'file')) {
      expect(f.hash).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('三级以上深层嵌套（templates/sub/deep/x.yaml）逐层入树 + 叶子有 hash', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    seedSkill(ws, 'deep-nest', {
      description: 'D',
      extra: {
        'templates/sub/deep/x.yaml': 'a: 1\n',
        'templates/sub/note.txt': 'hi',
      },
    });

    const deep = (await listVersionSkills(ws))[0]!;
    // 每层 dir 都有节点、叶子 path = 相对 skill 目录的全路径（不是只到两级）
    expect(deep.files.map((f) => f.path).sort()).toEqual(
      [
        'SKILL.md',
        'templates',
        path.join('templates', 'sub'),
        path.join('templates', 'sub', 'deep'),
        path.join('templates', 'sub', 'deep', 'x.yaml'),
        path.join('templates', 'sub', 'note.txt'),
      ].sort(),
    );
    // fileCount 只数 file（3 个），dir 不计
    expect(deep.fileCount).toBe(3);
    const leaf = deep.files.find((f) => f.path === path.join('templates', 'sub', 'deep', 'x.yaml'))!;
    expect(leaf.type).toBe('file');
    expect(leaf.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const d of deep.files.filter((f) => f.type === 'dir')) expect(d.hash).toBeUndefined();
  });

  it('无 SKILL.md 的目录仍入列（description undefined）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    seedSkill(ws, 'no-skill-md', { extra: { 'notes.txt': 'hi' } });

    const skills = await listVersionSkills(ws);
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe('no-skill-md');
    expect(skills[0]!.description).toBeUndefined();
    expect(skills[0]!.fileCount).toBe(1);
  });

  it('空 skills 根 / 目录不存在 → []（0.0 空版本 graceful）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '0.0', model: { modelId: 'm' } });
    expect(await listVersionSkills(ws)).toEqual([]);
    const bare = path.join(tmpRoot, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    expect(await listVersionSkills(bare)).toEqual([]);
  });

  it('hash 对同内容稳定、改内容即变（diff modified 判定依据，不用 size）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    seedSkill(ws, 'alpha', { description: 'A' });
    const first = await listVersionSkills(ws);
    const second = await listVersionSkills(ws);
    const h1 = first[0]!.files.find((f) => f.path === 'SKILL.md')!.hash;
    expect(second[0]!.files.find((f) => f.path === 'SKILL.md')!.hash).toBe(h1);

    // 同长度改动（size 不变）→ hash 必须变（size 判定会漏判，故契约钉 hash）
    const skillMd = path.join(ws, '.rocky/skills/alpha/SKILL.md');
    const orig = fs.readFileSync(skillMd, 'utf8');
    const mutated = orig.replace('description: A', 'description: B');
    expect(mutated.length).toBe(orig.length);
    fs.writeFileSync(skillMd, mutated, 'utf8');

    const third = await listVersionSkills(ws);
    const f = third[0]!.files.find((n) => n.path === 'SKILL.md')!;
    expect(f.hash).not.toBe(h1);
    expect(f.size).toBe(first[0]!.files.find((n) => n.path === 'SKILL.md')!.size);
  });
});

describe('versionSkillDir（skillName 校验）', () => {
  it('合法 kebab 名 → <ws>/.rocky/skills/<name>', () => {
    const ws = path.join(tmpRoot, 'ws');
    expect(versionSkillDir(ws, 'panorama-designer')).toBe(
      path.join(ws, '.rocky/skills/panorama-designer'),
    );
  });

  it('非法 skillName（穿越 / 斜杠 / 空 / 大写）→ null', () => {
    const ws = path.join(tmpRoot, 'ws');
    expect(versionSkillDir(ws, '..')).toBeNull();
    expect(versionSkillDir(ws, '../../etc')).toBeNull();
    expect(versionSkillDir(ws, 'a/b')).toBeNull();
    expect(versionSkillDir(ws, '')).toBeNull();
    expect(versionSkillDir(ws, 'Upper-Case')).toBeNull();
  });
});

describe('listMemoryEntries / resolveVersionContent.memoryEntries — memory 读侧（v0.0.219）', () => {
  it('有 md 文件 → 返非空 entries（name + size + 前 200 字符 preview）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    fs.mkdirSync(path.join(ws, '.rocky/memory'), { recursive: true });
    const planBody = '# 计划\n这是第一条记忆。';
    fs.writeFileSync(path.join(ws, '.rocky/memory', 'plan.md'), planBody, 'utf8');
    fs.writeFileSync(path.join(ws, '.rocky/memory', 'notes.md'), '短笔记', 'utf8');

    const content = await resolveVersionContent(ws);
    expect(content.memoryEntries).toHaveLength(2);
    const names = content.memoryEntries.map((m) => m.name).sort();
    expect(names).toEqual(['notes.md', 'plan.md']);
    const plan = content.memoryEntries.find((m) => m.name === 'plan.md')!;
    expect(plan.size).toBe(Buffer.byteLength(planBody, 'utf8'));
    expect(plan.preview).toBe(planBody);
  });

  it('preview 截断到前 200 字符（长内容仅取前 200，size 仍为完整字节数）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    fs.mkdirSync(path.join(ws, '.rocky/memory'), { recursive: true });
    const long = 'x'.repeat(500);
    fs.writeFileSync(path.join(ws, '.rocky/memory', 'long.md'), long, 'utf8');
    const content = await resolveVersionContent(ws);
    expect(content.memoryEntries).toHaveLength(1);
    expect(content.memoryEntries[0]!.preview).toHaveLength(200);
    expect(content.memoryEntries[0]!.size).toBe(500);
  });

  it('空 ws（缺 .rocky/memory）→ memoryEntries = []（0.0 graceful）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '0.0', model: { modelId: 'm' } });
    // writeVersionDirFiles 会建空 .rocky/memory 目录骨架，但无 md 文件 → entries 仍 []
    const content = await resolveVersionContent(ws);
    expect(content.memoryEntries).toEqual([]);
  });

  it('目录完全不存在（bare ws）→ listMemoryEntries 返 []', async () => {
    const ws = path.join(tmpRoot, 'bare-ws');
    fs.mkdirSync(ws, { recursive: true });
    expect(await listMemoryEntries(ws)).toEqual([]);
  });

  it('非 md 文件跳过（仅读 *.md）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    fs.mkdirSync(path.join(ws, '.rocky/memory'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rocky/memory', 'note.txt'), 'text', 'utf8');
    fs.writeFileSync(path.join(ws, '.rocky/memory', 'data.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(ws, '.rocky/memory', 'ok.md'), 'md', 'utf8');
    const content = await resolveVersionContent(ws);
    expect(content.memoryEntries.map((m) => m.name)).toEqual(['ok.md']);
  });

  it('子目录跳过（仅读文件）', async () => {
    const ws = path.join(tmpRoot, 'ws');
    await writeVersionDirFiles(ws, { versionLabel: '1.0', model: { modelId: 'm' } });
    fs.mkdirSync(path.join(ws, '.rocky/memory', 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rocky/memory', 'top.md'), 'top', 'utf8');
    const content = await resolveVersionContent(ws);
    expect(content.memoryEntries.map((m) => m.name)).toEqual(['top.md']);
  });
});

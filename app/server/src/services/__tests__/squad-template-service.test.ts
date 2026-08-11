/**
 * squad-template-service 单测（白盒）—— listTemplates / getTemplate / applyTemplate
 * 参考: specs/tech/squad/[P1]squad_templates.md §②-⑤
 *
 * 覆盖：
 *   - listTemplates：空目录返空 / 正常 manifest 返 TemplateSummary
 *   - getTemplate：存在 / 不存在 / path traversal 防护
 *   - applyTemplate：正常 hire+copy / 部分失败 best-effort / 复制策略
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  listTemplates,
  getTemplate,
  applyTemplate,
  TemplateNotFoundError,
  templatesDir,
} from '../squad-template-service';
import { syncBuiltinSquadTemplates } from '../../bootstrap/squad-templates-bootstrap';
import { createSquadService, type SquadServiceDeps } from '../squad-service';
import { SquadStore, MemberStore, squadRootDir } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadStore: SquadStore;
let memberStore: MemberStore;
let deps: SquadServiceDeps;

/** 造一个完整模板目录（manifest + AGENTS.md + .rocky/agents + skills） */
function makeTemplate(
  root: string,
  slug: string,
  members: Array<{ name: string; intro: string }>,
): void {
  const dir = path.join(root, 'squad-templates', slug);
  fs.mkdirSync(dir, { recursive: true });
  // manifest
  const manifest = {
    slug,
    name: slug.toUpperCase(),
    description: `Template ${slug}`,
    leaderName: 'Leader',
    builtin: true,
    members: members.map((m) => ({
      name: m.name,
      intro: m.intro,
      skillConfig: { mode: 'inherit', overrides: {} },
    })),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  // AGENTS.md
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# ${slug} AGENTS`);
  // .rocky/agents/{role}.md
  const agentsDir = path.join(dir, '.rocky', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const m of members) {
    fs.writeFileSync(path.join(agentsDir, `${m.name}.md`), `# ${m.name} agent`);
  }
  // leader 独立文件（manifest.leaderName 顶层字段，不在 members；role='leader'）
  fs.writeFileSync(path.join(agentsDir, 'leader.md'), '# Leader agent');
  // .rocky/skills/dummy-skill/SKILL.md
  const skillDir = path.join(dir, '.rocky', 'skills', 'dummy-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Dummy Skill');
  // .rocky/settings.json
  fs.mkdirSync(path.join(dir, '.rocky'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.rocky', 'settings.json'), '{"permissions":{}}');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tmpl-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  memberStore = new MemberStore({ root: tmpRoot });
  deps = { sessionStore, squadStore, memberStore, dataDir: tmpRoot };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── listTemplates ──

describe('listTemplates', () => {
  it('空目录返空数组', () => {
    expect(listTemplates(tmpRoot)).toEqual([]);
  });

  it('squad-templates 目录不存在返空数组', () => {
    expect(listTemplates('/nonexistent/path/xyz')).toEqual([]);
  });

  it('正常 manifest 返 TemplateSummary[]', () => {
    makeTemplate(tmpRoot, 'team-a', [
      { name: 'coder', intro: 'coder' },
      { name: 'tester', intro: 'tester' },
    ]);
    const list = listTemplates(tmpRoot);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      slug: 'team-a',
      name: 'TEAM-A',
      description: 'Template team-a',
      builtin: true,
      memberCount: 2,
      leaderName: 'Leader',
    });
  });

  it('manifest 读失败跳过（不 throw）', () => {
    const dir = path.join(templatesDir(tmpRoot), 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{invalid json');
    const list = listTemplates(tmpRoot);
    expect(list).toEqual([]);
  });

  it('多个模板都返回', () => {
    makeTemplate(tmpRoot, 'team-a', [{ name: 'coder', intro: 'c' }]);
    makeTemplate(tmpRoot, 'team-b', [
      { name: 'prd', intro: 'p' },
      { name: 'architect', intro: 'a' },
    ]);
    const list = listTemplates(tmpRoot);
    expect(list).toHaveLength(2);
    const slugs = list.map((t) => t.slug).sort();
    expect(slugs).toEqual(['team-a', 'team-b']);
  });
});

// ── getTemplate ──

describe('getTemplate', () => {
  it('slug 存在返 manifest', () => {
    makeTemplate(tmpRoot, 'team-a', [{ name: 'coder', intro: 'coder' }]);
    const m = getTemplate(tmpRoot, 'team-a');
    expect(m).toBeTruthy();
    expect(m!.slug).toBe('team-a');
    expect(m!.members).toHaveLength(1);
    expect(m!.members[0]!.name).toBe('coder');
  });

  it('slug 不存在返 undefined', () => {
    expect(getTemplate(tmpRoot, 'nonexistent')).toBeUndefined();
  });

  it('path traversal 防护（含 .. 的 slug 返 undefined）', () => {
    expect(getTemplate(tmpRoot, '../../../etc/passwd')).toBeUndefined();
    expect(getTemplate(tmpRoot, '..')).toBeUndefined();
    expect(getTemplate(tmpRoot, 'a/../b')).toBeUndefined();
  });

  it('非 kebab-case slug 返 undefined', () => {
    expect(getTemplate(tmpRoot, 'TeamA')).toBeUndefined();
    expect(getTemplate(tmpRoot, 'team_a')).toBeUndefined();
    expect(getTemplate(tmpRoot, '')).toBeUndefined();
  });
});

// ── applyTemplate ──

describe('applyTemplate', () => {
  it('正常 hire + copy 配置文件', async () => {
    makeTemplate(tmpRoot, 'team-a', [
      { name: 'coder', intro: 'coder' },
      { name: 'tester', intro: 'tester' },
    ]);
    // 先建 squad
    const created = await createSquadService(deps, {
      name: 'MySquad',
      modelDefault: 'claude-sonnet-4',
      leader: { name: 'Boss' },
    });
    // [v0.0.321] 传 leaderMemberId + leaderName → leader.md 改名 {leaderName}-{memberId}.md 实名格式
    const result = await applyTemplate(tmpRoot, created.squad.id, 'team-a', deps, created.leaderMember.id, 'Boss');

    expect(result.created).toEqual(['coder', 'tester']);
    expect(result.failed).toEqual([]);

    // members 已建
    const members = await memberStore.listMembers(created.squad.id);
    expect(members).toHaveLength(3); // leader + 2 mates

    // AGENTS.md 已复制
    const agentsMd = path.join(squadRootDir(tmpRoot, created.squad.id), 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    expect(fs.readFileSync(agentsMd, 'utf8')).toContain('team-a AGENTS');

    // agent 文件改名（{role}-{memberId}.md）
    const coderMember = members.find((m) => m.name === 'coder');
    expect(coderMember).toBeTruthy();
    const coderAgentFile = path.join(
      squadRootDir(tmpRoot, created.squad.id),
      '.rocky', 'agents', `coder-${coderMember!.id}.md`,
    );
    expect(fs.existsSync(coderAgentFile)).toBe(true);

    // leader agent 文件改名（[v0.0.321] 实名 Boss-{leaderMemberId}.md，与其他成员 name 前缀一致）
    const agentsDir = path.join(squadRootDir(tmpRoot, created.squad.id), '.rocky', 'agents');
    const leaderAgentFile = path.join(agentsDir, `Boss-${created.leaderMember.id}.md`);
    expect(fs.existsSync(leaderAgentFile)).toBe(true);
    // 不再残留未改名的 leader.md（旧 bug：nameToId 无 leader → 保留原名）
    expect(fs.existsSync(path.join(agentsDir, 'leader.md'))).toBe(false);

    // skills 已 merge 复制
    const skillMd = path.join(
      squadRootDir(tmpRoot, created.squad.id),
      '.rocky', 'skills', 'dummy-skill', 'SKILL.md',
    );
    expect(fs.existsSync(skillMd)).toBe(true);

    // settings.json 已复制
    const settingsFile = path.join(
      squadRootDir(tmpRoot, created.squad.id),
      '.rocky', 'settings.json',
    );
    expect(fs.existsSync(settingsFile)).toBe(true);
  });

  it('部分 hire 失败 best-effort（记 failed 不中断）', async () => {
    makeTemplate(tmpRoot, 'team-a', [
      { name: 'coder', intro: 'coder' },
      { name: 'coder', intro: 'duplicate name will fail' }, // name 冲突
    ]);
    const created = await createSquadService(deps, {
      name: 'MySquad',
      modelDefault: 'claude-sonnet-4',
      leader: { name: 'Boss' },
    });
    const result = await applyTemplate(tmpRoot, created.squad.id, 'team-a', deps);

    expect(result.created).toEqual(['coder']);
    expect(result.failed).toEqual(['coder']); // 第二个同名失败
  });

  it('settings.json 仅目标不存在才复制', async () => {
    makeTemplate(tmpRoot, 'team-a', [{ name: 'coder', intro: 'c' }]);
    const created = await createSquadService(deps, {
      name: 'S',
      modelDefault: 'claude-sonnet-4',
      leader: { name: 'Boss' },
    });
    // 预置目标 settings.json
    const destDir = squadRootDir(tmpRoot, created.squad.id);
    fs.mkdirSync(path.join(destDir, '.rocky'), { recursive: true });
    fs.writeFileSync(path.join(destDir, '.rocky', 'settings.json'), '{"existing":true}');

    await applyTemplate(tmpRoot, created.squad.id, 'team-a', deps);
    const content = fs.readFileSync(path.join(destDir, '.rocky', 'settings.json'), 'utf8');
    expect(JSON.parse(content).existing).toBe(true); // 未被覆盖
  });

  it('模板不存在抛 TemplateNotFoundError', async () => {
    const created = await createSquadService(deps, {
      name: 'S',
      modelDefault: 'claude-sonnet-4',
      leader: { name: 'Boss' },
    });
    await expect(
      applyTemplate(tmpRoot, created.squad.id, 'nonexistent', deps),
    ).rejects.toThrow(TemplateNotFoundError);
  });
});

// ── syncBuiltinSquadTemplates ──

describe('syncBuiltinSquadTemplates', () => {
  it('builtin:true 模板覆盖到用户目录', () => {
    // 造 builtin 源
    const builtinsDir = path.join(tmpRoot, 'builtins');
    makeTemplate(builtinsDir, 'builtin-team', [{ name: 'coder', intro: 'c' }]);

    // 同步前用户目录无模板
    expect(listTemplates(tmpRoot)).toEqual([]);

    syncBuiltinSquadTemplates(builtinsDir, tmpRoot);

    const list = listTemplates(tmpRoot);
    expect(list).toHaveLength(1);
    expect(list[0]!.slug).toBe('builtin-team');
  });

  it('用户自定义模板（builtin:false）不被覆盖', () => {
    const builtinsDir = path.join(tmpRoot, 'builtins');
    const srcDir = path.join(builtinsDir, 'squad-templates', 'custom-team');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'manifest.json'), JSON.stringify({
      slug: 'custom-team',
      name: 'Custom',
      description: 'User custom',
      leaderName: 'L',
      builtin: false,
      members: [],
    }));

    syncBuiltinSquadTemplates(builtinsDir, tmpRoot);

    // builtin:false 不被复制
    expect(listTemplates(tmpRoot)).toEqual([]);
  });

  it('builtinsDir 不存在不 throw', () => {
    expect(() => syncBuiltinSquadTemplates('/nonexistent', tmpRoot)).not.toThrow();
  });
});

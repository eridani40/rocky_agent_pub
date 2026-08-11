/**
 * team-sync-export-service 单测（v0.0.319 团队同步导出）
 * 参考: specs/prd/v0.0.319-team-sync.md §3（zip 结构 + 排除清单）
 *       specs/tech/version_logs/v0.0.319/change_plan.md D1
 *
 * 覆盖（test-plan §2 UT 组 1）：
 *   - buildManifest：leader 提顶层 leaderName+leaderIntro / mate 入 members[] / slug=原 squadId / builtin=false
 *   - buildManifest：members/*.json 不存在 → throw「团队数据异常：无成员记录」
 *   - exportSquadToZip：zip 含 manifest.json + AGENTS.md + .rocky 全套；agents 去 memberId；
 *     排除 members/outputs/reports/states/specs/panorama/images/project symlink
 *   - stripMemberIdSuffix：正则 /-[0-9A-HJKMNP-TV-Z]{26}\.md$/ 精确匹配；非 ULID 后缀原样返回
 *   - symlink 防护：lstatSync 检测 → skip（不打包 symlink 指向的内容）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildManifest, exportSquadToZip, stripMemberIdSuffix, restoreAgentFileName,
} from '../team-sync-export-service';
import type { SquadEntity } from '../../stores/squad-store';

const LEADER_ID = '01KZA61YTQBB05NBSWEWWCFWMX';
const MATE_ID = '01KZA6D535N86AM008T34N1B82';

let squadDir: string;
const squad = {
  id: 'SQUAD-ORIGINAL-ID',
  name: '研发团队',
  description: 'rocky_agent 研发',
} as unknown as SquadEntity;

/** 搭一个最小 squad 目录骨架（members + AGENTS.md + .rocky 全套） */
function setupSquadDir(): void {
  squadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-export-'));
  // members/*.json（leader + mate）
  fs.mkdirSync(path.join(squadDir, 'members'), { recursive: true });
  fs.writeFileSync(path.join(squadDir, 'members', `${LEADER_ID}.json`), JSON.stringify({
    id: LEADER_ID, name: 'Darvin', intro: '团队 leader', role: 'leader',
    skillConfig: { mode: 'inherit', overrides: {} },
  }));
  fs.writeFileSync(path.join(squadDir, 'members', `${MATE_ID}.json`), JSON.stringify({
    id: MATE_ID, name: 'coder', intro: '代码开发者', role: 'mate',
    skillConfig: { mode: 'custom', overrides: { bash: true } },
  }));
  // AGENTS.md
  fs.writeFileSync(path.join(squadDir, 'AGENTS.md'), '# 团队规则\n');
  // .rocky/agents/{name}-{memberId}.md
  const agentsDir = path.join(squadDir, '.rocky', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `Darvin-${LEADER_ID}.md`), '# leader 定义\n');
  fs.writeFileSync(path.join(agentsDir, `coder-${MATE_ID}.md`), '# coder 定义\n');
  // .rocky/{skills,memory,templates,commands}/ + settings.json
  for (const sub of ['skills', 'memory', 'templates', 'commands']) {
    const d = path.join(squadDir, '.rocky', sub);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${sub}-file.md`), `# ${sub}\n`);
  }
  fs.writeFileSync(path.join(squadDir, '.rocky', 'settings.json'), '{"permissions":{}}');
  // 应被排除的运行时/产物目录（导出侧白名单打包，天然不含；此处验证 zip 中确实没有）
  for (const excluded of ['outputs', 'reports', 'states', 'specs', 'panorama', 'images']) {
    fs.mkdirSync(path.join(squadDir, excluded), { recursive: true });
    fs.writeFileSync(path.join(squadDir, excluded, 'junk.txt'), 'junk');
  }
  fs.writeFileSync(path.join(squadDir, 'outputs', 'out.txt'), 'runtime output');
}

beforeEach(setupSquadDir);
afterEach(() => { fs.rmSync(squadDir, { recursive: true, force: true }); });

describe('buildManifest', () => {
  it('leader 提顶层 leaderName+leaderIntro；mate 入 members[]；slug=原 squadId；builtin=false', () => {
    const m = buildManifest(squadDir, squad);
    expect(m.slug).toBe('SQUAD-ORIGINAL-ID');
    expect(m.name).toBe('研发团队');
    expect(m.description).toBe('rocky_agent 研发');
    expect(m.leaderName).toBe('Darvin');
    expect(m.leaderIntro).toBe('团队 leader');
    expect(m.builtin).toBe(false);
    expect(m.members).toHaveLength(1);
    expect(m.members[0]!.name).toBe('coder');
    expect(m.members[0]!.intro).toBe('代码开发者');
    expect(m.members[0]!.skillConfig).toEqual({ mode: 'custom', overrides: { bash: true } });
    // leader 不出现在 members[]
    expect(m.members.some((mm) => mm.name === 'Darvin')).toBe(false);
  });

  it('members/*.json 不存在 → throw「团队数据异常：无成员记录」（PRD §5.6）', () => {
    fs.rmSync(path.join(squadDir, 'members'), { recursive: true, force: true });
    expect(() => buildManifest(squadDir, squad)).toThrow('团队数据异常：无成员记录');
  });
});

describe('stripMemberIdSuffix', () => {
  it('去 ULID 后缀：coder-01KZA6D535N86AM008T34N1B82.md → coder.md', () => {
    expect(stripMemberIdSuffix(`coder-${MATE_ID}.md`)).toBe('coder.md');
  });
  it('非 ULID 后缀原样返回（README.md / coder-abc.md）', () => {
    expect(stripMemberIdSuffix('README.md')).toBe('README.md');
    expect(stripMemberIdSuffix('coder-abc.md')).toBe('coder-abc.md');
  });
});

describe('restoreAgentFileName（v0.0.321 实名还原）', () => {
  it('实名 leader：Darvin-{ULID}.md → leader.md（模板 key）', () => {
    expect(restoreAgentFileName(`Darvin-${LEADER_ID}.md`, 'Darvin')).toBe('leader.md');
  });
  it('普通成员：coder-{ULID}.md → coder.md（走 strip）', () => {
    expect(restoreAgentFileName(`coder-${MATE_ID}.md`, 'Darvin')).toBe('coder.md');
  });
  it('无 memberId 后缀原样返回（README.md）', () => {
    expect(restoreAgentFileName('README.md', 'Darvin')).toBe('README.md');
  });
  it('旧格式兼容：leader-{ULID}.md → leader.md（319 前产出的 squad）', () => {
    expect(restoreAgentFileName(`leader-${LEADER_ID}.md`, 'Darvin')).toBe('leader.md');
  });
});

describe('exportSquadToZip', () => {
  it('zip 含 manifest.json + AGENTS.md + .rocky 全套；agents 去 memberId；排除产物目录', () => {
    const { buffer, memberCount } = exportSquadToZip(squadDir, squad);
    expect(memberCount).toBe(2); // leader + 1 mate
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map((e) => e.entryName);

    expect(names).toContain('manifest.json');
    expect(names).toContain('AGENTS.md');
    expect(names).toContain('.rocky/agents/leader.md');    // [v0.0.321] 实名 Darvin-{ULID}.md 还原模板 key
    expect(names).toContain('.rocky/agents/coder.md');
    expect(names).toContain('.rocky/settings.json');
    for (const sub of ['skills', 'memory', 'templates', 'commands']) {
      expect(names).toContain(`.rocky/${sub}/${sub}-file.md`);
    }
    // 排除清单：members/*.json 原文件 + 产物目录
    expect(names.some((n) => n.startsWith('members/'))).toBe(false);
    for (const excluded of ['outputs', 'reports', 'states', 'specs', 'panorama', 'images']) {
      expect(names.some((n) => n.startsWith(`${excluded}/`))).toBe(false);
    }
    // manifest 内容正确
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'));
    expect(manifest.leaderName).toBe('Darvin');
    expect(manifest.members[0].name).toBe('coder');
  });

  it('symlink 不打包（lstatSync 检测 skip）', () => {
    const linkPath = path.join(squadDir, '.rocky', 'agents', 'evil-link.md');
    fs.symlinkSync(path.join(squadDir, 'AGENTS.md'), linkPath);
    const { buffer } = exportSquadToZip(squadDir, squad);
    const names = new AdmZip(buffer).getEntries().map((e) => e.entryName);
    expect(names).not.toContain('.rocky/agents/evil-link.md');
  });

  it('无 AGENTS.md / 无 .rocky 子目录 → 正常导出（best-effort）', () => {
    fs.rmSync(path.join(squadDir, 'AGENTS.md'));
    fs.rmSync(path.join(squadDir, '.rocky', 'skills'), { recursive: true, force: true });
    const { buffer } = exportSquadToZip(squadDir, squad);
    const names = new AdmZip(buffer).getEntries().map((e) => e.entryName);
    expect(names).toContain('manifest.json');
    expect(names).not.toContain('AGENTS.md');
    expect(names.some((n) => n.startsWith('.rocky/skills/'))).toBe(false);
  });
});

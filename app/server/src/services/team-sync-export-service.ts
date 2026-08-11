/**
 * team-sync-export-service — 团队同步导出：squad 目录 → zip（v0.0.319）
 * 参考: specs/prd/v0.0.319-team-sync.md §3（zip 结构 + 排除清单）
 *       specs/tech/version_logs/v0.0.319/change_plan.md D1
 *
 * 职责：
 *   - buildManifest：读 members/*.json → 生成 ManifestSchema（leader 提顶层，mate 入 members[]）
 *   - exportSquadToZip：adm-zip 打包 manifest.json + AGENTS.md + .rocky 全套 → buffer
 *   - stripMemberIdSuffix：agents/{name}-{memberId}.md → {name}.md（精确 ULID 后缀正则）
 *
 * 安全约束：
 *   - 只读 squad 目录内文件；lstatSync 检测 symlink → skip（不跟随，防读 squad 外文件）
 *   - 排除 members/ outputs/ reports/ states/ specs/ panorama/ images/ project symlink
 */
import AdmZip from 'adm-zip';
import * as path from 'node:path';
import {
  existsSync, lstatSync, readdirSync, readFileSync,
} from 'node:fs';
import type { SquadEntity } from '../stores/squad-store';
import type { ManifestSchema, MemberSpec } from './squad-template-service';
import type { MemberSkillConfig } from '../agent/schema_defs/squad/member';

/** agents 文件 memberId 后缀正则（{name}-{ULID}.md，ULID = 26 字符 Crockford Base32） */
const MEMBER_ID_SUFFIX_RE = /-[0-9A-HJKMNP-TV-Z]{26}\.md$/;

/** members/*.json 的最小读取形状（仅取导出所需字段） */
interface MemberRecordLike {
  name?: string;
  intro?: string;
  role?: string;
  skillConfig?: MemberSkillConfig;
}

/**
 * 去 agents 文件名 memberId 后缀：`coder-01KZA....md` → `coder.md`。
 * 不匹配 ULID 后缀的文件名原样返回。
 */
export function stripMemberIdSuffix(fileName: string): string {
  return fileName.replace(MEMBER_ID_SUFFIX_RE, '.md');
}

/**
 * 还原导出 agents 文件名为模板 key（v0.0.321）。
 * 实名 leader 文件 `{leaderName}-{ULID}.md` → `leader.md`（模板 agents 目录的 key）；
 * 其他（普通成员 `{name}-{ULID}.md` / 旧格式 `leader-{ULID}.md`）走 stripMemberIdSuffix。
 *
 * @param fileName squad 目录 .rocky/agents/ 下的实际文件名
 * @param leaderName leader 实名（manifest.leaderName；可选，缺省时纯 strip 兼容）
 */
export function restoreAgentFileName(fileName: string, leaderName?: string): string {
  if (leaderName && fileName.startsWith(`${leaderName}-`) && MEMBER_ID_SUFFIX_RE.test(fileName)) {
    return 'leader.md';
  }
  return stripMemberIdSuffix(fileName);
}

/**
 * 从 squad 目录 members/*.json 生成 ManifestSchema。
 * leader（role=leader）→ 顶层 leaderName/leaderIntro；mate → members[]。
 * squad 级元数据（slug/name/description）从 squadEntity 取；builtin 固定 false。
 *
 * @throws Error members/*.json 不存在或无成员记录（PRD §5.6：团队数据异常）
 */
export function buildManifest(squadDir: string, squad: SquadEntity): ManifestSchema {
  const membersDir = path.join(squadDir, 'members');
  if (!existsSync(membersDir)) {
    throw new Error('团队数据异常：无成员记录');
  }
  const files = readdirSync(membersDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error('团队数据异常：无成员记录');
  }

  let leaderName = '';
  let leaderIntro: string | undefined;
  const members: MemberSpec[] = [];
  for (const file of files) {
    const stat = lstatSync(path.join(membersDir, file));
    if (stat.isSymbolicLink()) continue; // 不跟随 symlink
    let rec: MemberRecordLike;
    try {
      rec = JSON.parse(readFileSync(path.join(membersDir, file), 'utf8')) as MemberRecordLike;
    } catch (e) {
      console.warn(`[team-sync-export] skip unparsable member record: ${file}`, e);
      continue;
    }
    if (rec.role === 'leader') {
      leaderName = rec.name ?? '';
      leaderIntro = rec.intro;
    } else {
      members.push({
        name: rec.name ?? '',
        intro: rec.intro ?? '',
        skillConfig: rec.skillConfig ?? { mode: 'inherit', overrides: {} },
      });
    }
  }

  return {
    slug: squad.id as string,
    name: squad.name as string,
    description: (squad.description as string | undefined) ?? '',
    leaderName,
    ...(leaderIntro !== undefined ? { leaderIntro } : {}),
    builtin: false,
    members,
  };
}

/** 递归把目录加入 zip（跳过 symlink；zipPath 为 zip 内相对路径前缀） */
function addDirToZip(zip: AdmZip, srcDir: string, zipPrefix: string): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    try {
      if (lstatSync(srcPath).isSymbolicLink()) continue; // 不跟随 symlink
      if (entry.isDirectory()) {
        addDirToZip(zip, srcPath, `${zipPrefix}/${entry.name}`);
      } else {
        zip.addFile(`${zipPrefix}/${entry.name}`, readFileSync(srcPath));
      }
    } catch (e) {
      console.warn(`[team-sync-export] skip entry: ${srcPath}`, e);
    }
  }
}

/**
 * 导出 squad 为 zip buffer。
 * 内容：manifest.json + AGENTS.md（存在才加）+ .rocky/{agents(去memberId),skills,memory,templates,commands,settings.json}
 * 排除：members/ outputs/ reports/ states/ specs/ panorama/ images/ project symlink（仅打白名单内容，天然排除）
 *
 * @returns { buffer, memberCount } memberCount = leader + mate 总数（toast 展示用）
 */
export function exportSquadToZip(
  squadDir: string,
  squad: SquadEntity,
): { buffer: Buffer; memberCount: number } {
  const manifest = buildManifest(squadDir, squad);
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  // AGENTS.md（存在才加；symlink skip）
  const agentsMdPath = path.join(squadDir, 'AGENTS.md');
  if (existsSync(agentsMdPath) && !lstatSync(agentsMdPath).isSymbolicLink()) {
    zip.addFile('AGENTS.md', readFileSync(agentsMdPath));
  }

  // .rocky/agents/{name}-{memberId}.md → .rocky/agents/{name}.md（去 memberId）
  // [v0.0.321] leader 实名 {leaderName}-{memberId}.md 还原为模板 key leader.md
  const agentsDir = path.join(squadDir, '.rocky', 'agents');
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) continue;
      const srcPath = path.join(agentsDir, file);
      if (lstatSync(srcPath).isSymbolicLink()) continue;
      zip.addFile(`.rocky/agents/${restoreAgentFileName(file, manifest.leaderName)}`, readFileSync(srcPath));
    }
  }

  // .rocky/{skills,memory,templates,commands} → 递归（merge 语义在导入侧处理）
  for (const sub of ['skills', 'memory', 'templates', 'commands']) {
    const srcSub = path.join(squadDir, '.rocky', sub);
    if (existsSync(srcSub)) addDirToZip(zip, srcSub, `.rocky/${sub}`);
  }

  // .rocky/settings.json
  const settingsPath = path.join(squadDir, '.rocky', 'settings.json');
  if (existsSync(settingsPath) && !lstatSync(settingsPath).isSymbolicLink()) {
    zip.addFile('.rocky/settings.json', readFileSync(settingsPath));
  }

  return { buffer: zip.toBuffer(), memberCount: manifest.members.length + 1 };
}

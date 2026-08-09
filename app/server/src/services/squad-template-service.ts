/**
 * squad-template-service — Squad 模板读取 + 应用（hire + copy 配置文件）
 * 参考: specs/tech/squad/[P1]squad_templates.md §②-⑤
 *       specs/tech/version_logs/v0.0.298/change_plan.md T1
 *
 * 职责：
 *   - listTemplates：扫描 squad-templates 下各子目录的 manifest.json 返回 TemplateSummary[]
 *   - getTemplate：读单个模板 manifest（含 path traversal 防护）
 *   - applyTemplate：遍历 manifest.members 批量 createMemberService + 复制配置文件
 *
 * 复制策略（§⑤）：
 *   AGENTS.md → 覆盖；.rocky/agents/{role}.md → 改名 {role}-{memberId}.md；
 *   .rocky/{skills,memory,templates,commands} → merge 不覆盖；settings.json → 仅目标不存在才复制
 */
import * as path from 'node:path';
import {
  readdirSync, readFileSync, existsSync, mkdirSync,
  copyFileSync, cpSync, writeFileSync,
} from 'node:fs';
import type { MemberSkillConfig } from '../agent/schema_defs/squad/member';
import type { CreateMemberDeps } from './member-service';
import { createMemberService } from './member-service';
import { squadRootDir } from '../stores/squad-store';

// ── 类型定义（§② manifest schema）──

/** manifest.json 中的 member 定义 */
export interface MemberSpec {
  name: string;
  intro: string;
  skillConfig: MemberSkillConfig;
}

/** manifest.json 完整结构 */
export interface ManifestSchema {
  slug: string;
  name: string;
  description: string;
  leaderName: string;
  leaderIntro?: string;
  builtin: boolean;
  members: MemberSpec[];
}

/** listTemplates 返回的摘要（§④） */
export interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  builtin: boolean;
  memberCount: number;
  /** 预填 leader 名（UI 预填用，来自 manifest.leaderName） */
  leaderName: string;
}

/** applyTemplate 返回结果 */
export interface ApplyTemplateResult {
  created: string[];   // 成功创建的 member name 列表
  failed: string[];    // 失败的 member name 列表
}

/** kebab-case slug 校验（防 path traversal） */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── 路径工具 ──

/** 模板根目录 = {dataDir}/squad-templates */
export function templatesDir(dataDir: string): string {
  return path.join(dataDir, 'squad-templates');
}

/** 单个模板目录 = {dataDir}/squad-templates/{slug} */
function templateDir(dataDir: string, slug: string): string {
  return path.join(templatesDir(dataDir), slug);
}

// ── 模板读取 ──

/**
 * 扫描全部模板，返回 TemplateSummary[]。
 * 目录不存在或 manifest 读失败时跳过（不 throw，返空或已收集的）。
 */
export function listTemplates(dataDir: string): TemplateSummary[] {
  const dir = templatesDir(dataDir);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const result: TemplateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const manifestPath = path.join(dir, slug, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      const m = JSON.parse(raw) as ManifestSchema;
      result.push({
        slug: m.slug,
        name: m.name,
        description: m.description,
        builtin: m.builtin,
        memberCount: Array.isArray(m.members) ? m.members.length : 0,
        leaderName: m.leaderName ?? '',
      });
    } catch (e) {
      console.warn(`[squad-template] skip template "${slug}": manifest read failed`, e);
    }
  }
  return result;
}

/**
 * 读单个模板 manifest。slug 不合法或不存在返 undefined。
 * slug 校验 kebab-case，防 path traversal（如 `../xxx`）。
 */
export function getTemplate(dataDir: string, slug: string): ManifestSchema | undefined {
  if (!SLUG_RE.test(slug)) return undefined;
  const manifestPath = path.join(templateDir(dataDir, slug), 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    return JSON.parse(raw) as ManifestSchema;
  } catch {
    return undefined;
  }
}

// ── 模板应用 ──

/**
 * 应用模板到已建好的 squad：批量 hire + 复制配置文件。
 *
 * 步骤：
 *   1. 读 manifest（不存在 throw → handler 转 400 template_not_found）
 *   2. 遍历 members 批量 createMemberService（mode=fresh）；失败不中断 best-effort
 *   3. 复制模板配置文件到 squad 目录
 *
 * @returns { created: string[], failed: string[] }
 */
export async function applyTemplate(
  dataDir: string,
  squadId: string,
  slug: string,
  deps: CreateMemberDeps,
): Promise<ApplyTemplateResult> {
  const manifest = getTemplate(dataDir, slug);
  if (!manifest) throw new TemplateNotFoundError(`template "${slug}" not found`);

  const created: string[] = [];
  const failed: string[] = [];
  /** member name → memberId 映射（用于 agent 文件改名） */
  const nameToId = new Map<string, string>();

  // ── 批量 hire（best-effort，失败记 failed 不中断）──
  for (const spec of manifest.members) {
    try {
      const result = await createMemberService(deps, {
        squadId,
        mode: 'fresh',
        name: spec.name,
        intro: spec.intro,
        skillConfig: spec.skillConfig,
      });
      created.push(spec.name);
      nameToId.set(spec.name, result.member.id);
    } catch (e) {
      console.warn(`[squad-template] hire member "${spec.name}" failed:`, e);
      failed.push(spec.name);
    }
  }

  // ── 复制配置文件 ──
  const srcDir = templateDir(dataDir, slug);
  const destDir = squadRootDir(dataDir, squadId);
  copyTemplateFiles(srcDir, destDir, nameToId);

  return { created, failed };
}

/** 模板不存在错误（handler 转 400 template_not_found） */
export class TemplateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateNotFoundError';
  }
}

// ── 文件复制 ──

/**
 * 复制模板配置文件到 squad 目录（§⑤ 复制策略）。
 * AGENTS.md → 覆盖；agents → 改名；skills/memory/templates/commands → merge；settings.json → 仅不存在才复制。
 * 全部 best-effort（console.warn 不阻断）。
 */
function copyTemplateFiles(
  srcDir: string,
  destDir: string,
  nameToId: Map<string, string>,
): void {
  // 1. AGENTS.md → 覆盖
  copyIfExists(
    path.join(srcDir, 'AGENTS.md'),
    path.join(destDir, 'AGENTS.md'),
    false, // 覆盖
  );

  // 2. .rocky/agents/{role}.md → .rocky/agents/{role}-{memberId}.md
  const srcAgentsDir = path.join(srcDir, '.rocky', 'agents');
  if (existsSync(srcAgentsDir)) {
    const destAgentsDir = path.join(destDir, '.rocky', 'agents');
    mkdirSync(destAgentsDir, { recursive: true });
    for (const file of readdirSync(srcAgentsDir)) {
      if (!file.endsWith('.md')) continue;
      const role = file.replace(/\.md$/, '');
      const memberId = nameToId.get(role);
      const destName = memberId ? `${role}-${memberId}.md` : file;
      copyIfExists(
        path.join(srcAgentsDir, file),
        path.join(destAgentsDir, destName),
        false,
      );
    }
  }

  // 3. .rocky/{skills,memory,templates,commands} → merge 不覆盖
  for (const sub of ['skills', 'memory', 'templates', 'commands']) {
    const srcSub = path.join(srcDir, '.rocky', sub);
    if (!existsSync(srcSub)) continue;
    const destSub = path.join(destDir, '.rocky', sub);
    mkdirSync(destSub, { recursive: true });
    mergeDir(srcSub, destSub);
  }

  // 4. .rocky/settings.json → 仅目标不存在才复制
  copyIfExists(
    path.join(srcDir, '.rocky', 'settings.json'),
    path.join(destDir, '.rocky', 'settings.json'),
    true, // 不覆盖
  );
}

/** 递归 merge 目录：文件级不覆盖（已存在则 skip） */
function mergeDir(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        mergeDir(srcPath, destPath);
      } else if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      }
    } catch (e) {
      console.warn(`[squad-template] merge copy failed: ${srcPath} → ${destPath}`, e);
    }
  }
}

/** 安全复制单文件（best-effort，失败 console.warn） */
function copyIfExists(src: string, dest: string, skipIfExists: boolean): void {
  if (!existsSync(src)) return;
  if (skipIfExists && existsSync(dest)) return;
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  } catch (e) {
    console.warn(`[squad-template] copy failed: ${src} → ${dest}`, e);
  }
}

/**
 * Skill Governance Service —— UI 改 evolvable（v0.0.55）
 * 参考: specs/api/overall/06a-skill-governance.md §2（端点契约）+ §2.4（service 层强制逻辑）
 *       specs/tech/agent/skills/[P0]skill_definition.md §6（单维度 evolvable）+ §8（UI 改 evolvable 路径）
 *
 * 职责：UI 改 SKILL.md frontmatter `evolvable` 字段（true↔false），无 lock 约束
 * （v0.0.55 删 mutableLocked 维度——UI 一定能改 evolvable，用户对自己 dataDir 资产完全控制权）。
 * 与 agent 路径正交分离（spec §3）——本端点不经过 skill_manage 工具。
 *
 * 强制逻辑（spec §2.4，service 层而非 handler 层）：
 *   1. resolveSkillByName(name, scope, workspace?) → not found 404
 *   2. read frontmatter（gray-matter 解析）
 *   3. write evolvable=body.evolvable（外科式替换，保留其他字段字节不变）+ per-file lock 串行化
 *   4. return updated SkillEntry
 *
 * 并发安全：per-file lock 用现有 withFileLock（同 path FIFO 串行，与 task-tool/board-shared 同构），
 * 避免与 skill_manage 工具并发写撕裂 SKILL.md。读不持锁。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import matter from 'gray-matter';
import type { AppConfigService } from '../config/app-config-service';
import { atomicWriteSync } from '../persistence/fs-io';
import { withFileLock } from '../persistence/file-lock';
import { SkillEnabledStore } from './enabled-store';
import { appSkillRoot, parseSkillDir, workspaceSkillRoot } from './resolver';
import type { SkillEntry } from './types';

/** governance body 强制形状（spec §2.1 + §4 scope 显式） */
interface GovernanceBody {
  scope: 'app' | 'workspace';
  evolvable: boolean;
  workspace?: string;
}

/** governance 错误（HTTP adapter 映射 status + body） */
export class GovernanceError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GovernanceError';
  }
}

/** 构造 JSON Response（HTTP adapter 用） */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析 + 校验 body（spec §2.1 + §4：scope 显式 / workspace 安全 / evolvable 类型）。
 * scope=builtin 不允许（governance 不能改内置固化 skill）；workspace 校验同 06-skill §10。
 * @throws GovernanceError(400 | 404)
 */
function parseBody(raw: unknown): GovernanceBody {
  if (typeof raw !== 'object' || raw === null) {
    throw new GovernanceError(400, 'invalid json body');
  }
  const b = raw as Record<string, unknown>;
  const scope = b.scope;
  // scope 必需且仅 app|workspace（builtin 不可改，spec §2.1 不含 builtin）
  if (scope !== 'app' && scope !== 'workspace') {
    throw new GovernanceError(400, "body requires scope: 'app' | 'workspace'");
  }
  if (typeof b.evolvable !== 'boolean') {
    throw new GovernanceError(400, 'body requires evolvable: boolean');
  }
  const workspace = typeof b.workspace === 'string' ? b.workspace : undefined;
  if (scope === 'workspace') {
    if (!workspace || workspace.length === 0) {
      throw new GovernanceError(400, 'scope=workspace requires workspace param');
    }
    // workspace 路径安全（spec §4，同 06-skill §10）：绝对路径 + 存在 + 目录
    if (!isAbsolute(workspace) || !isDir(workspace)) {
      throw new GovernanceError(400, 'workspace path invalid or not found');
    }
  }
  return { scope, evolvable: b.evolvable, workspace };
}

/**
 * 外科式设置 frontmatter 单字段（保留其他字段字节序不变，spec §4 一致性约束）。
 * 仅替换 frontmatter 块内首个 `<key>: ...` 行；字段缺失则在 frontmatter 首行后插入。
 * key 为内部常量（evolvable/updated），不来自用户输入，无需转义。
 */
function setFrontmatterField(raw: string, key: string, value: string): string {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) throw new GovernanceError(500, 'invalid SKILL.md: frontmatter missing');
  const fm = fmMatch[1]!;
  let newFm: string;
  const existRe = new RegExp(`^${key}:[ \\t]*.*$`, 'm');
  if (existRe.test(fm)) {
    newFm = fm.replace(existRe, `${key}: ${value}`);
  } else {
    // 字段缺失：在 frontmatter 首行后插入（保守默认）
    newFm = fm.replace(/^([^\r\n]*)/m, `$1\n${key}: ${value}`);
  }
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${newFm}\n---`);
}

/**
 * Governance service —— UI 改 evolvable 的强制逻辑（spec §2.4）。
 *
 * @param dataDir app 数据根
 * @param name skill name（path param）
 * @param bodyRaw request body（待校验）
 * @param appConfig enabled 状态源（用于回填响应 enabled 字段）
 * @returns 更新后的 SkillEntry（evolvable=body.evolvable）
 * @throws GovernanceError(400 body / 404 not found / 500 internal)
 */
export async function governSkillEvolvable(
  dataDir: string,
  name: string,
  bodyRaw: unknown,
  appConfig: AppConfigService,
): Promise<SkillEntry> {
  const body = parseBody(bodyRaw);
  const root = body.scope === 'workspace' ? workspaceSkillRoot(body.workspace!) : appSkillRoot(dataDir);
  const skillDir = join(root, name);
  // step1: resolve（spec §2.4 step1 → 404）
  if (!isDir(skillDir)) throw new GovernanceError(404, 'Not Found');
  const skillMdPath = join(skillDir, 'SKILL.md');

  // per-file lock 内 read-modify-write（spec §2.4 step2-4 + per-file 串行化）
  return withFileLock(skillMdPath, async () => {
    if (!existsSync(skillMdPath)) throw new GovernanceError(404, 'Not Found');
    let raw: string;
    try {
      raw = readFileSync(skillMdPath, 'utf8');
    } catch {
      throw new GovernanceError(404, 'Not Found');
    }
    // step2: read frontmatter 校验格式（v0.0.55 删 step3 mutableLocked 检查——单维度 evolvable，
    // 不再读 frontmatter 字段；仅用 matter() 验证 SKILL.md 是合法 YAML frontmatter）
    try {
      matter(raw);
    } catch {
      throw new GovernanceError(500, 'invalid SKILL.md frontmatter');
    }
    // step3: 外科式写 evolvable（保留其他字段）+ 刷新 updated=now（v0.0.149 注入分组排序用）+ 原子落盘
    const now = new Date().toISOString();
    let newContent = setFrontmatterField(raw, 'evolvable', String(body.evolvable));
    newContent = setFrontmatterField(newContent, 'updated', now);
    atomicWriteSync(skillMdPath, newContent);
    // step4: 回读返更新后 entry（enabled 来自 store）
    const entry = parseSkillDir(skillDir, body.scope);
    if (!entry) throw new GovernanceError(500, 'failed to re-parse skill after governance');
    const enabled = new SkillEnabledStore(appConfig).isEnabled(name);
    return { ...entry, enabled };
  });
}

/**
 * HTTP adapter for `PATCH /skill/:name/governance`（spec §2）。
 * body 校验 + service 调用 + 错误映射。不经 skill_manage 工具（spec §3）。
 */
export async function handleSkillGovernance(
  req: Request,
  name: string,
  appConfig: AppConfigService,
  dataDir: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  try {
    const skill = await governSkillEvolvable(dataDir, name, body, appConfig);
    return json(200, { skill });
  } catch (e) {
    if (e instanceof GovernanceError) {
      return json(e.status, { error: e.message, ...e.body });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: msg });
  }
}

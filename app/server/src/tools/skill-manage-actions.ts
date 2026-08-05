/**
 * skill_manage 工具的 6 个内建 action 实现 + skill scope 词汇（v0.0.166 从 skill-manage.ts 拆出）
 * 参考: specs/tech/agent/skills/[P0]skill_manage_tool.md §2 §3 §4 §7.2
 *       specs/tech/agent/skills/[P0]skill_definition.md §6（单维度 evolvable 治理）
 *
 * 核心原则（§1, §4）：不审批（agent 自主 create/patch/disable）；evolvable 强制（false 拒写）；
 *   不可 delete（用 disable）；evolvable 不可被 agent 改；写操作 per-file lock 串行化（§7.2）。
 * v0.0.238：scope 三值（+group）+ description ≤50 字符硬限（PRD §14.2.4）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';
import { atomicWriteSync } from '../persistence/fs-io';
import {
  SkillResolver, appSkillRoot, workspaceSkillRoot, builtinSkillRoot, groupSkillRoot,
} from '../skills/resolver';
import { SkillEnabledStore } from '../skills/enabled-store';
import { AppConfigService } from '../config/app-config-service';
import { withFileLock } from '../persistence/file-lock';
import type { SkillEntry, SkillScope } from '../skills/types';
import { SkillQuotaExceededError } from '../skills/policy';
import { resolveSkillStoreQuotas, checkSkillStoreQuota } from '../skills/store-quota';

/** 对外统一 skill scope 词汇（skill_manage_tool §2 + v0.0.238 暴露 group） */
export type SkillScopeExternal = 'global' | 'session' | 'group';

/** skill description 硬字符上限（v0.0.238 PRD §14.2.4，trim 后 str.length） */
const SKILL_DESC_CHAR_LIMIT = 50;

/** 对外 scope → 内部 SkillScope（不变量#1）：global→app / session→workspace / group→group；写侧必填由 run() 保证，else 作 read 缺省防御 fallback */
export function toInternalSkillScope(s: string | undefined): 'app' | 'workspace' | 'group' {
  if (s === 'session') return 'workspace';
  if (s === 'group') return 'group';
  return 'app';
}

/** 内部 SkillScope → 对外 scope（输出回显，不变量#1）：workspace→session / group→group / app|builtin→global */
export function toExternalSkillScope(s: SkillScope): SkillScopeExternal {
  if (s === 'workspace') return 'session';
  if (s === 'group') return 'group';
  return 'global';
}

/** list scope 过滤：对外 global/session/group/all → 内部 app/workspace/group/all（缺省 all） */
function toInternalListScope(s: unknown): 'app' | 'workspace' | 'group' | 'all' {
  if (s === 'session') return 'workspace';
  if (s === 'global') return 'app';
  if (s === 'group') return 'group';
  return 'all';
}

/** list 元数据形态（spec §2，单维度 evolvable；scope 回显 external） */
export interface SkillManageMeta {
  name: string;
  description: string;
  evolvable: boolean;
  enabled: boolean;
  scope: SkillScopeExternal;
}

/** create 自动注入的 3 个治理字段（§3 + skill_definition §6.3） */
const CREATE_GOVERNANCE = {
  source: 'agent',
  production_method: 'consolidation',
  evolvable: true,
} as const;

/** kebab-case + ≤64 校验（与 resolver.isValidSkillName 同语义） */
function isValidName(name: string): boolean {
  return typeof name === 'string'
    && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
    && name.length <= 64;
}

/** scope → skill 根目录；group 缺 groupWsDir 由 run() 先拦（[invalid_input] not_in_group）；此处防御 join 安全空串 */
function scopeRootDir(
  scope: 'app' | 'workspace' | 'group',
  dataDir: string,
  workspaceDir: string | undefined,
  groupWsDir: string | undefined,
): string {
  if (scope === 'workspace') return workspaceSkillRoot(workspaceDir ?? '');
  if (scope === 'group') return groupSkillRoot(groupWsDir ?? '');
  return appSkillRoot(dataDir);
}

/** description ≤50 字符硬校验：超限 → invalid_input；缺省由 caller 必填校验先行 */
function checkDescLimit(desc: string): ToolRunResult | null {
  const trimmed = desc.trim();
  if (trimmed.length > SKILL_DESC_CHAR_LIMIT) {
    return errorResult(
      `[${ToolErrorCode.INVALID_INPUT}] skill description exceeds ${SKILL_DESC_CHAR_LIMIT} chars (current: ${trimmed.length})`,
    );
  }
  return null;
}

/** 读 SKILL.md → { data, body }；不存在 / 解析失败 → undefined */
function readSkillFile(skillMdPath: string): { data: Record<string, unknown>; body: string } | undefined {
  if (!existsSync(skillMdPath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(skillMdPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = matter(raw);
    return { data: parsed.data as Record<string, unknown>, body: parsed.content };
  } catch {
    return undefined;
  }
}

/** 取 frontmatter bool 字段（缺省 fallback） */
function getBool(data: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = data[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** SkillEntry → SkillManageMeta（单维度 evolvable；scope 回显 external，不变量#1） */
function toMeta(e: SkillEntry): SkillManageMeta {
  return {
    name: e.name,
    description: e.description,
    evolvable: typeof e.evolvable === 'boolean' ? e.evolvable : false,
    enabled: e.enabled,
    scope: toExternalSkillScope(e.scope),
  };
}

/** 基于 dataDir 构造 SkillEnabledStore（app_config/skill_state 的便捷包装） */
function makeEnabledStore(dataDir: string): SkillEnabledStore {
  return new SkillEnabledStore(new AppConfigService({ root: dataDir }));
}

/** 校验 name + 解析 scope（必填 + biz 校验由 run() 先行；此处纯三值透传 + workspace/group 依赖校验） */
function parseNameScope(input: ToolInput, workspaceDir: string | undefined, groupWsDir: string | undefined,
): { name: string; scope: 'app' | 'workspace' | 'group' } | ToolRunResult {
  const name = String(input.name ?? '').trim();
  if (!name) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] name is required`);
  if (!isValidName(name)) {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] invalid skill name (kebab-case, ≤64 chars)`);
  }
  const scope = toInternalSkillScope(typeof input.scope === 'string' ? input.scope : undefined);
  if (scope === 'workspace' && !workspaceDir) {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] workspace scope requires workspace (ctx.workdir)`);
  }
  if (scope === 'group' && !groupWsDir) {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] not_in_group`);
  }
  return { name, scope };
}

/**
 * executeCreate：写 SKILL.md，自动注入 governance frontmatter（§3, §6.4）+ description ≤50 硬校验。
 *
 * v0.0.247：加存储配额拦截（仅 create 路径）—— appConfig 非空时，count+check+write 在 dir 级锁
 * （虚拟路径 `<scopeRoot>/.quota.lock`）内原子执行，防并发 TOCTOU race。超限抛 SkillQuotaExceededError
 * → catch 转 [INVALID_INPUT]（含 evolvable=false 提示，skill 走工具路径不抛 HTTP）。appConfig=null
 * （UT 直调 / 向后兼容）→ 不查配额，原 write 行为。详见 skills/store-quota.ts 核心不变量。
 *
 * @param appConfig app_config 服务（读 maxSkillInject* 配额 + 间接同源 skill_state）；null = 不查配额
 */
export async function executeCreate(
  input: ToolInput, dataDir: string, workspaceDir: string | undefined, groupWsDir: string | undefined,
  appConfig: AppConfigService | null = null,
): Promise<ToolRunResult> {
  const parsed = parseNameScope(input, workspaceDir, groupWsDir);
  if ('isError' in parsed) return parsed;
  const { name, scope } = parsed;
  const description = String(input.description ?? '').trim();
  if (!description) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] description is required`);
  const descErr = checkDescLimit(description);
  if (descErr) return descErr;
  const body = typeof input.body === 'string' ? input.body : '';
  const allowedTools = Array.isArray(input.allowedTools)
    ? input.allowedTools.filter((x) => typeof x === 'string') as string[]
    : undefined;
  const skillDir = join(scopeRootDir(scope, dataDir, workspaceDir, groupWsDir), name);
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (existsSync(skillMdPath)) {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] skill "${name}" already exists in scope ${scope}`);
  }
  // frontmatter：治理字段强制 3 项 + updated 盖戳 + per-file lock 写
  const fm: Record<string, unknown> = { name, description, ...CREATE_GOVERNANCE, updated: new Date().toISOString() };
  if (allowedTools && allowedTools.length > 0) fm['allowed-tools'] = allowedTools.join(', ');
  const content = matter.stringify(body, fm);
  try {
    await withFileLock(skillMdPath, async () => {
      if (existsSync(skillMdPath)) throw new Error(`skill "${name}" already exists (concurrent create)`); // 防 TOCTOU
      if (appConfig) {
        // v0.0.247: 存储配额 — 嵌套 dir 级锁（虚拟路径作 file-lock Map key），count+check+write
        // 全在 dir 锁内原子（防并发 create 不同 name 的 TOCTOU race）。entry 锁外 / dir 锁内顺序固定。
        const scopeRoot = scopeRootDir(scope, dataDir, workspaceDir, groupWsDir);
        const quotaLockPath = join(scopeRoot, '.quota.lock');
        const quotas = resolveSkillStoreQuotas(appConfig);
        const enabledStore = makeEnabledStore(dataDir);
        await withFileLock(quotaLockPath, async () => {
          checkSkillStoreQuota(scope, dataDir, workspaceDir, groupWsDir, enabledStore, quotas);
          mkdirSync(skillDir, { recursive: true });
          atomicWriteSync(skillMdPath, content); // write 在 dir 锁内（防 count 后被抢先写超限）
        });
      } else {
        // 无 appConfig（UT 直调 / 向后兼容）：不查配额，原 write 逻辑
        mkdirSync(skillDir, { recursive: true });
        atomicWriteSync(skillMdPath, content);
      }
    });
  } catch (e) {
    if (e instanceof SkillQuotaExceededError) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] ${e.message}`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] failed to write SKILL.md: ${msg}`);
  }
  return textResult(JSON.stringify({ ok: true, name, scope: toExternalSkillScope(scope), skillDir, evolvable: true }));
}

/** executePatch：全文替换 body + 选择性 frontmatter（payload 不含 evolvable，§4）+ description ≤50 硬校验（带则查） */
export async function executePatch(
  input: ToolInput, dataDir: string, workspaceDir: string | undefined, groupWsDir: string | undefined,
): Promise<ToolRunResult> {
  const parsed = parseNameScope(input, workspaceDir, groupWsDir);
  if ('isError' in parsed) return parsed;
  const { name, scope } = parsed;
  const skillMdPath = join(scopeRootDir(scope, dataDir, workspaceDir, groupWsDir), name, 'SKILL.md');
  try {
    return await withFileLock(skillMdPath, async () => { // per-file lock 串行化读-改-写（§7.2）
      const file = readSkillFile(skillMdPath);
      if (!file) return errorResult(`[${ToolErrorCode.NOT_FOUND}] skill "${name}" not found in scope ${scope}`);
      if (!getBool(file.data, 'evolvable', false)) { // evolvable 强制（§4）：false 拒绝
        return errorResult(`[${ToolErrorCode.INVALID_INPUT}] skill "${name}" is non-evolvable (evolvable=false); patch rejected (spec skill_manage_tool §4)`);
      }
      const fm: Record<string, unknown> = { ...file.data }; // 原值兜底 + 选择性覆盖（evolvable 保留原值）
      const newDesc = input.description;
      fm['updated'] = new Date().toISOString(); // patch 刷新 updated
      const newDescTrimmed = typeof newDesc === 'string' ? newDesc.trim() : '';
      if (newDescTrimmed) {
        const descErr = checkDescLimit(newDescTrimmed);
        if (descErr) return descErr;
        fm['description'] = newDescTrimmed;
      }
      if (Array.isArray(input.allowedTools)) {
        fm['allowed-tools'] = input.allowedTools.length > 0
          ? (input.allowedTools.filter((x) => typeof x === 'string') as string[]).join(', ')
          : undefined;
      }
      const bodyStr = typeof input.body === 'string' ? input.body : file.body;
      atomicWriteSync(skillMdPath, matter.stringify(bodyStr, fm));
      return textResult(JSON.stringify({ ok: true, name, scope: toExternalSkillScope(scope), skillDir: join(scopeRootDir(scope, dataDir, workspaceDir, groupWsDir), name) }));
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] patch failed: ${msg}`);
  }
}

/** executeSetEnabled：disable/enable 复用 SkillEnabledStore（§3 disable/enable） */
export async function executeSetEnabled(
  input: ToolInput, dataDir: string, workspaceDir: string | undefined, groupWsDir: string | undefined, target: boolean,
): Promise<ToolRunResult> {
  const parsed = parseNameScope(input, workspaceDir, groupWsDir);
  if ('isError' in parsed) return parsed;
  const { name, scope } = parsed;
  const skillMdPath = join(scopeRootDir(scope, dataDir, workspaceDir, groupWsDir), name, 'SKILL.md');
  try { // per-file lock 与 patch 共享同 path key → 跨 op 互斥，防并发撕裂
    return await withFileLock(skillMdPath, async () => {
      const file = readSkillFile(skillMdPath);
      if (!file) return errorResult(`[${ToolErrorCode.NOT_FOUND}] skill "${name}" not found in scope ${scope}`);
      if (!getBool(file.data, 'evolvable', false)) {
        return errorResult(`[${ToolErrorCode.INVALID_INPUT}] skill "${name}" is non-evolvable (evolvable=false); ${target ? 'enable' : 'disable'} rejected (spec skill_manage_tool §4)`);
      }
      makeEnabledStore(dataDir).setEnabled(name, target);
      return textResult(JSON.stringify({ ok: true, name, scope: toExternalSkillScope(scope), enabled: target }));
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] ${target ? 'enable' : 'disable'} failed: ${msg}`);
  }
}

/** executeList：返全部 skill 元数据（含 disabled + builtin + group，§5） */
export function executeList(
  input: ToolInput, dataDir: string, workspaceDir: string | undefined, groupWsDir: string | undefined,
): ToolRunResult {
  const scopeFilter = toInternalListScope(input.scope);
  const catalog = SkillResolver.resolveAll(
    dataDir, workspaceDir, makeEnabledStore(dataDir), builtinSkillRoot(), groupWsDir,
  );
  const metas: SkillManageMeta[] = [];
  for (const e of catalog.entries) {
    if (scopeFilter !== 'all' && e.scope !== scopeFilter) continue;
    metas.push(toMeta(e));
  }
  return textResult(JSON.stringify({ items: metas }));
}

/** executeRead：读 SKILL.md 全文（含 disabled，§3 read） */
export function executeRead(
  input: ToolInput, dataDir: string, workspaceDir: string | undefined, groupWsDir: string | undefined,
): ToolRunResult {
  const name = String(input.name ?? '').trim();
  if (!name) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] name is required`);
  // scope 显式 → 直定位；缺省 → 合并层 fallback（workspace → group → app → builtin）
  const explicitScope = input.scope === 'session' || input.scope === 'global' || input.scope === 'group'
    ? toInternalSkillScope(input.scope) : undefined;
  let skillMdPath: string | undefined;
  let scope: SkillScope | undefined;
  if (explicitScope) {
    scope = explicitScope;
    skillMdPath = join(scopeRootDir(explicitScope, dataDir, workspaceDir, groupWsDir), name, 'SKILL.md');
  } else {
    const c = SkillResolver.lookup(dataDir, workspaceDir, name, builtinSkillRoot(), groupWsDir);
    if (c) { skillMdPath = join(c.skillDir, 'SKILL.md'); scope = c.scope; }
  }
  if (!skillMdPath || !existsSync(skillMdPath)) {
    return errorResult(`[${ToolErrorCode.NOT_FOUND}] skill "${name}" not found`);
  }
  const file = readSkillFile(skillMdPath);
  if (!file) return errorResult(`[${ToolErrorCode.NOT_FOUND}] skill "${name}" SKILL.md unreadable`);
  return textResult(JSON.stringify({
    name, scope: toExternalSkillScope(scope ?? 'app'), skillMdPath,
    body: file.body,
    raw: matter.stringify(file.body, file.data),
  }));
}

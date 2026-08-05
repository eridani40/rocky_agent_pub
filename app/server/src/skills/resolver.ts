/**
 * SkillResolver —— 无状态四层扫描 + frontmatter 解析 + 合并
 * （v0.0.21 双层 / v0.0.33.3 加 builtin 层 / v0.0.164 加 squad 层 / v0.0.205 squad 层改名 group 层）
 * 参考: specs/tech/agent/skills/[P0]skill_definition.md §4 §4.1
 *       specs/tech/agent/skills/[P0]skill_architecture.md §4
 *       specs/tech/agent/skills/[P0]skill_tool.md §3
 *
 * 职责（arch §4.1）：
 *   - resolve(dataDir, workspaceDir?, enabledStore, builtinDir?, groupDir?)
 *       → SkillCatalog（四层扫 + 解析 + 高层覆盖低层合并 + 注入 enabled）。
 *   - lookup(dataDir, workspaceDir?, name, builtinDir?, groupDir?)
 *       → SkillContent | undefined（按 name 寻址，group 优先 → workspace → app → builtin，
 *         返回 L1 全文 + skillDir + scope）。
 *
 * 四层（v0.0.205 group 改名）：
 *   - builtin（最低）：随 app 发版的内置 skill（app/plugins/builtins/skills/），只读。
 *     通过 builtinDir 参数显式传入（caller 调 builtinSkillRoot() 取默认路径）。
 *     不在 resolver 内隐式扫描——保持 resolve() 纯函数可测，避免测试环境误扫真 builtins。
 *   - app（中低）：<dataDir>/skills/，用户/agent 全局安装层。
 *   - workspace（中高）：<workspace>/.rocky/skills/，项目级覆盖。
 *   - group（最高）：<groupWs>/.rocky/skills/，squad 团队共享层。
 *     groupWs 由 caller 经 resolveGroupWsDir 唯一解析（squads/<squadId>/）；
 *     playground / subagent session 不传 groupDir
 *     → 与既有三层行为等价（向后兼容）。
 *   合并语义：同名时高层胜出（group > workspace > app > builtin）。
 *
 * 设计原则（arch §10.1）：无状态、不缓存、每次全量扫（skill 数量小，新鲜度 > 性能）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import type {
  SkillCatalog,
  SkillContent,
  SkillEntry,
  SkillScope,
} from './types';
import type { SkillEnabledStore } from './enabled-store';

/** app 级 skill 根（<dataDir>/skills/） */
export function appSkillRoot(dataDir: string): string {
  return join(dataDir, 'skills');
}

/** workspace 级 skill 根（<workspace>/.rocky/skills/） */
export function workspaceSkillRoot(workspaceDir: string): string {
  return join(workspaceDir, '.rocky', 'skills');
}

/**
 * group 级 skill 根（`<groupWsDir>/.rocky/skills/`）。
 *
 * groupWsDir 由 caller 经 `agent/group-dir.ts resolveGroupWsDir` 唯一解析
 * （`<dataDir>/squads/<squadId>/`）；
 * 本 helper 只负责 ws 根 → skills 子目录的拼接（与 workspaceSkillRoot 同构）。
 *
 * 导出便于 tests + skill_manage 潜在扩展；resolver 内部路径派生走 groupDir 直接 join
 * （见 resolve 实现），本 helper 是「按 group ws 根直接算路径」的便利入口，不参与 resolver 主流程。
 */
export function groupSkillRoot(groupWsDir: string): string {
  return join(groupWsDir, '.rocky', 'skills');
}

/**
 * builtin 级 skill 根（随 app 发版的内置 skill 目录，v0.0.33.3）。
 * 定位：相对本文件（app/server/src/skills/resolver.ts）向上 3 级到 app/，
 * 再进 plugins/builtins/skills。bun 直跑 .ts 与编译后 .js 同目录，路径稳定。
 *
 * 仅作「路径计算便利」导出——resolve/lookup 不隐式调它（保持纯函数可测）。
 * 生产 caller（session-config / skill handler）显式传入；测试 omit 第 4 参 → 不扫 builtins。
 */
export function builtinSkillRoot(): string {
  return resolve(__dirname, '../../../plugins/builtins/skills');
}

/** kebab-case + ≤64 字符校验（skill_definition §2 name 字段） */
export function isValidSkillName(name: string): boolean {
  return typeof name === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64;
}

/**
 * 解析单个 skill 目录的 SKILL.md frontmatter → SkillEntry（不含 enabled）。
 * 无 SKILL.md / frontmatter 缺 name / name 非法 → 返回 null（arch §13：跳过不报错）。
 */
export function parseSkillDir(skillDir: string, scope: SkillScope): SkillEntry | null {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(skillMdPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }
  const name = String(parsed.data.name ?? '').trim();
  const description = String(parsed.data.description ?? '').trim();
  if (!isValidSkillName(name)) return null;
  return {
    name,
    description,
    scope,
    skillDir,
    enabled: true, // 占位，resolve 时用 enabledStore 覆盖
    source: parsed.data.source === 'agent' ? 'agent' : 'user',
    productionMethod: normalizeMethod(parsed.data.production_method),
    // v0.0.55: frontmatter 未写 evolvable 时按 §6.3 默认值表取 false（保守：immutable by default，
    // 仅 agent create 产出的 skill 才 evolvable=true）。L0 catalog 据此标 [evolvable] 让 LLM 知晓可改性。
    evolvable: typeof parsed.data.evolvable === 'boolean' ? parsed.data.evolvable : false,
    // v0.0.149: 读 updated/updatedAt frontmatter（容忍缺失：legacy/builtin 无戳 → undefined）。
    // 优先 updatedAt（语义化），回退 updated（短形）；两者皆非 string → undefined。
    updatedAt: readUpdatedAt(parsed.data),
    // v0.0.167: 市场来源锚点（缺失=本地来源，不报错）；仅接受非空 string 标量，否则 undefined。
    marketRef: readStringField(parsed.data.market_ref),
    marketSource: readStringField(parsed.data.market_source),
    installedHash: readStringField(parsed.data.installed_hash),
  };
}

/** 读 frontmatter 标量 string 字段（v0.0.167）：非空 string → 原值；其余 → undefined（容忍缺失/类型不符） */
function readStringField(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function normalizeMethod(v: unknown): SkillEntry['productionMethod'] {
  if (v === 'handwritten' || v === 'consolidation' || v === 'download') return v;
  return undefined;
}

/**
 * 读 frontmatter 更新时间（v0.0.149）：优先 `updatedAt`（语义化），回退 `updated`（短形）。
 * 容忍字段缺失（legacy/builtin 无戳）→ undefined。
 * 容忍 YAML 类型胁迫：js-yaml 默认把未引号 ISO 串解析为 Date 对象 → 统一转回 ISO string。
 */
function readUpdatedAt(data: Record<string, unknown>): string | undefined {
  const toIso = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
    return undefined;
  };
  return toIso(data.updatedAt) ?? toIso(data.updated);
}

/** 扫单层 skill 根目录下所有合法 skill 子目录（arch §4.4）。无目录/出错返空数组。 */
function scanLayer(rootDir: string, scope: SkillScope): SkillEntry[] {
  if (!existsSync(rootDir)) return [];
  let names: string[];
  try {
    names = readdirSync(rootDir);
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const n of names) {
    const dir = join(rootDir, n);
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const entry = parseSkillDir(dir, scope);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * SkillResolver —— 无状态纯函数集合（不缓存）。
 */
export const SkillResolver = {
  /**
   * 扫四层 + 合并 + 注入 enabled → SkillCatalog。
   * 合并语义（skill_definition §4.1 + v0.0.33.3 + v0.0.164）：高层覆盖低层（按 name 去重，
   * group > workspace > app > builtin）。
   *
   * @param dataDir app 数据根
   * @param workspaceDir 可选 workspace 绝对路径（缺省不扫 workspace 层）
   * @param enabledStore enabled 状态源（null → 全 enabled）
   * @param builtinDir 可选 builtin skill 根（随 app 发版；缺省不扫 builtin 层。
   *                  生产 caller 传 builtinSkillRoot()，测试 omit 保持双层语义）
   * @param groupDir 可选 group ws 根目录（squad 共享 ws 根，v0.0.205）。
   *                  由 caller（session-config / skill handler）经 resolveGroupWsDir 派生；
   *                  内部 join(groupDir, '.rocky', 'skills') 派生 group skill 根。
   *                  omit → 不扫 group 层，与既有三层行为等价（向后兼容 playground/subagent）。
   */
  resolve(
    dataDir: string,
    workspaceDir: string | undefined,
    enabledStore: SkillEnabledStore | null,
    builtinDir?: string,
    groupDir?: string,
  ): SkillCatalog {
    // 四层扫描：builtin（最低）→ app → workspace → group（最高）
    const builtinEntries = builtinDir ? scanLayer(builtinDir, 'builtin') : [];
    const appEntries = scanLayer(appSkillRoot(dataDir), 'app');
    const wsEntries = workspaceDir
      ? scanLayer(workspaceSkillRoot(workspaceDir), 'workspace')
      : [];
    // group 层路径由 groupDir 直接派生（不重造 helper——resolver 只关心目录）
    const groupEntries = groupDir
      ? scanLayer(join(groupDir, '.rocky', 'skills'), 'group')
      : [];
    // 合并：按 name 去重，后写入者（高层）胜出 → builtin 先写、app 覆盖、workspace、group 终覆盖
    const byName = new Map<string, SkillEntry>();
    for (const e of builtinEntries) byName.set(e.name, e);
    for (const e of appEntries) byName.set(e.name, e);
    for (const e of wsEntries) byName.set(e.name, e);
    for (const e of groupEntries) byName.set(e.name, e);
    const entries: SkillEntry[] = [];
    for (const e of byName.values()) {
      const enabled = enabledStore ? enabledStore.isEnabled(e.name) : true;
      entries.push({ ...e, enabled });
    }
    return { entries };
  },

  /**
   * resolveAll —— 显式命名表「返回全部 skill（含 disabled）」语义（v0.0.51 skill_manage_tool §5/§9）。
   *
   * 与 `resolve` 行为一致：返回四层扫描 + 合并后的全量 entries（enabled 字段反映实际状态，
   * **不**按 enabled 过滤）。`resolve` 在 session-config 层被 caller `.filter(e=>e.enabled)`
   * 收窄为 L0 catalog；`resolveAll` 提供语义清晰的 API 给 `skill_manage.list` 用——list 必须
   * 看见 disabled skill（防 agent create 撞车，§5）。
   *
   * 注：现 `resolve` 已含 disabled entry（不 filter），resolveAll 是显式 alias；后续如需分离
   * 语义（resolve 收窄、resolveAll 全量），可在此调整而不影响 list caller。
   */
  resolveAll(
    dataDir: string,
    workspaceDir: string | undefined,
    enabledStore: SkillEnabledStore | null,
    builtinDir?: string,
    groupDir?: string,
  ): SkillCatalog {
    return SkillResolver.resolve(dataDir, workspaceDir, enabledStore, builtinDir, groupDir);
  },

  /**
   * 按 name 寻址（group → workspace → app → builtin 逐层 fallback）→ SkillContent | undefined（arch §9.2）。
   * 命中 → 读 SKILL.md 全文（L1）；未命中 → undefined（caller 决定抛 SkillNotFoundError）。
   * group 优先段顺序与 resolve 合并优先级一致（group 最高）。
   */
  lookup(
    dataDir: string,
    workspaceDir: string | undefined,
    name: string,
    builtinDir?: string,
    groupDir?: string,
  ): SkillContent | undefined {
    // group 优先：squad 团队层 skill 覆盖其他所有层
    if (groupDir) {
      const gDir = join(groupDir, '.rocky', 'skills', name);
      const c = readContent(gDir, 'group');
      if (c) return c;
    }
    // workspace 优先
    if (workspaceDir) {
      const wsDir = join(workspaceSkillRoot(workspaceDir), name);
      const c = readContent(wsDir, 'workspace');
      if (c) return c;
    }
    const appDir = join(appSkillRoot(dataDir), name);
    const appHit = readContent(appDir, 'app');
    if (appHit) return appHit;
    // builtin 兜底（v0.0.33.3）：app/workspace 都没命中再查 builtin
    if (builtinDir) {
      const builtinDirEntry = join(builtinDir, name);
      return readContent(builtinDirEntry, 'builtin');
    }
    return undefined;
  },
};

/** 读 skillDir/SKILL.md 全文 → SkillContent；失败返 undefined */
function readContent(skillDir: string, scope: SkillScope): SkillContent | undefined {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return undefined;
  let body: string;
  try {
    body = readFileSync(skillMdPath, 'utf8');
  } catch {
    return undefined;
  }
  // 从 frontmatter 取 name（与目录名应一致；不一致以 frontmatter 为准回显）
  let name = '';
  try {
    name = String(matter(body).data.name ?? '');
  } catch {
    /* ignore */
  }
  return { name, skillDir, body, scope };
}

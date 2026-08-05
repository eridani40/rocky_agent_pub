/**
 * SessionTypeProfileLoader — 读 app/plugins/session-types/*.yaml → id 索引 + 继承合并
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §3/§4/§6
 *
 * 职责：
 *   - 启动期（bootstrap）扫 root 下所有 *.yaml → RawProfile 字典（id 索引）
 *   - extends 链解析 + 逐字段深合并 → ResolvedSessionProfile 缓存
 *   - 链内自检：基座必在 / 父存在 / 无环
 *
 * 语义校验（toolBound 引用已注册工具等）在 SessionTypeProfileValidator（拆分自本文件）。
 *
 * 文件名约定 = profile id 中 `:` → `.`（如 playground-rocky.parent.main.yaml）。
 * 单文件单 profile；id 在 yaml 内明示，文件名仅约定（loader 不强校验一致，以 yaml 内 id 为准）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── 枚举类型（与 loop-ports RunSpec 字段对齐） ─────────

export type ProfileDrainMode = 'eager' | 'none' | 'lazy';
export type ProfileUsagePartition = 'current' | 'sub' | 'summary' | 'consolidate';
export type ProfileToolDefinitionsSource = 'own' | 'host-snapshot';
export type ProfileSkillSource = 'global-enabled' | 'member-overlay' | 'none';
export type ProfileAbortFinalize = 'four-step' | 'none';
export type ProfilePreloadContext = 'none' | 'studio';

export interface ProfileRunShape {
  drainMode: ProfileDrainMode;
  backgroundPath: boolean;
  maxIterDefault: number;
  touchesStateMachine: boolean;
  persistsRun: boolean;
  usagePartition: ProfileUsagePartition;
}
export interface ProfileLifecycleHooks {
  abortFinalize: ProfileAbortFinalize;
  cascadeChildren: boolean;
}
export interface ProfileEventChannel {
  emitDefault: boolean;
}
export interface ProfileModelHints {
  readsSquadDefault: boolean;
}

/**
 * ResolvedSessionProfile — 继承合并后的 profile（纯数据，无逻辑）。
 * SessionTypePolicy.profile(kind) 直接返回缓存值；resolveToolSet/toolBound/eosStop 等字段读此。
 */
export interface ResolvedSessionProfile {
  id: string;
  extends?: string;
  enabled: boolean;
  toolBound: readonly string[];
  toolDefinitionsSource: ProfileToolDefinitionsSource;
  runShape: ProfileRunShape;
  lifecycleHooks: ProfileLifecycleHooks;
  eventChannel: ProfileEventChannel;
  modelHints: ProfileModelHints;
  skillSource: ProfileSkillSource;
  eosStop: readonly string[];
  autoNaming: boolean;
  preloadContext: ProfilePreloadContext;
}

/** YAML 原始结构（部分字段可选；extends 链合并时由父补全） */
interface RawProfile {
  id: string;
  extends?: string;
  enabled?: boolean;
  toolBound?: string[];
  toolDefinitionsSource?: ProfileToolDefinitionsSource;
  runShape?: Partial<ProfileRunShape>;
  lifecycleHooks?: Partial<ProfileLifecycleHooks>;
  eventChannel?: Partial<ProfileEventChannel>;
  modelHints?: Partial<ProfileModelHints>;
  skillSource?: ProfileSkillSource;
  eosStop?: string[];
  autoNaming?: boolean;
  preloadContext?: ProfilePreloadContext;
}

/** Loader 构造参数 */
export interface SessionTypeProfileLoaderOptions {
  /** session-types 根目录（默认 app/plugins/session-types，可注入便于测试） */
  root: string;
}

/** 已注册工具名表（validateAll 用：toolBound 引用必须存在于此；ghost 名硬失败） */
export interface RegisteredToolsIndex {
  names: ReadonlySet<string>;
}

/** 基座文件必须存在的 id 列表（loader 启动期检查） */
const REQUIRED_BASES = ['default', 'summary', 'consolidate', 'subagent'];

const DEFAULT_BASE: Omit<ResolvedSessionProfile, 'id' | 'extends'> = {
  enabled: true,
  toolBound: [],
  toolDefinitionsSource: 'own',
  runShape: {
    drainMode: 'eager',
    backgroundPath: false,
    maxIterDefault: 25,
    touchesStateMachine: true,
    persistsRun: true,
    usagePartition: 'current',
  },
  lifecycleHooks: { abortFinalize: 'four-step', cascadeChildren: true },
  eventChannel: { emitDefault: true },
  modelHints: { readsSquadDefault: false },
  skillSource: 'global-enabled',
  eosStop: [],
  autoNaming: false,
  preloadContext: 'none',
};

/**
 * Loader：扫 root 下所有 *.yaml → ResolvedSessionProfile[]（带 extends 合并 + 缓存）。
 * 启动入口：bootstrap 调 loadAll() → SessionTypeProfileValidator.validateAll() → SessionTypePolicy 构造。
 */
export class SessionTypeProfileLoader {
  private readonly root: string;
  private readonly rawById = new Map<string, RawProfile>();
  private readonly resolvedCache = new Map<string, ResolvedSessionProfile>();
  private loaded = false;

  constructor(optsOrRoot: SessionTypeProfileLoaderOptions | string) {
    this.root = typeof optsOrRoot === 'string' ? optsOrRoot : optsOrRoot.root;
  }

  /** 扫 root 下所有 *.yaml → RawProfile 字典（id 索引）；重复 id 后者覆盖前者并 warn。 */
  loadAll(): RawProfile[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      throw new Error(
        `SessionTypeProfileLoader.loadAll: 根目录不存在或不可读: ${this.root}`,
      );
    }
    const configs: RawProfile[] = [];
    const seen = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
      const fp = path.join(this.root, entry.name);
      const raw = this.loadOne(fp);
      const prev = seen.get(raw.id);
      if (prev) {
        console.warn(
          `SessionTypeProfileLoader: profile id "${raw.id}" 在 ${prev} 已声明，被 ${entry.name} 覆盖`,
        );
      }
      seen.set(raw.id, entry.name);
      this.rawById.set(raw.id, raw);
      configs.push(raw);
    }
    // 基座存在性校验（default / summary / consolidate / subagent 必在）
    for (const baseId of REQUIRED_BASES) {
      if (!this.rawById.has(baseId)) {
        throw new Error(
          `SessionTypeProfileLoader: 基座 profile "${baseId}" 缺失（root=${this.root}）`,
        );
      }
    }
    this.loaded = true;
    return configs;
  }

  /** 取继承合并后的 ResolvedSessionProfile（缓存命中直返）。@throws id 未登记时抛错。 */
  profile(id: string): ResolvedSessionProfile {
    const cached = this.resolvedCache.get(id);
    if (cached) return cached;
    const raw = this.rawById.get(id);
    if (!raw) {
      throw new Error(`SessionTypeProfileLoader: profile "${id}" 未登记`);
    }
    const resolved = this.resolveChain(raw, new Set());
    this.resolvedCache.set(id, resolved);
    return resolved;
  }

  /** 是否登记某 id（loadAll 后调用） */
  has(id: string): boolean {
    return this.rawById.has(id);
  }

  /** 所有已登记 id */
  listIds(): string[] {
    return Array.from(this.rawById.keys());
  }

  /** loadAll 已调用过 */
  isLoaded(): boolean {
    return this.loaded;
  }

  // —— 私有 ——

  private loadOne(filePath: string): RawProfile {
    const rawText = fs.readFileSync(filePath, 'utf8');
    let obj: unknown;
    try {
      obj = parseYaml(rawText);
    } catch (e) {
      throw new Error(
        `SessionTypeProfileLoader: ${filePath} YAML 解析失败: ${(e as Error).message}`,
      );
    }
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(`SessionTypeProfileLoader: ${filePath} 顶层必须是对象`);
    }
    const o = obj as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) {
      throw new Error(`SessionTypeProfileLoader: ${filePath} id 缺失或非非空字符串`);
    }
    return o as unknown as RawProfile;
  }

  /** 沿 extends 链合并（递归），同时做环检测 + 父存在校验 */
  private resolveChain(raw: RawProfile, chain: Set<string>): ResolvedSessionProfile {
    if (chain.has(raw.id)) {
      throw new Error(
        `SessionTypeProfileLoader: extends 链成环（${Array.from(chain).join(' → ')} → ${raw.id}）`,
      );
    }
    chain.add(raw.id);
    let parentResolved: ResolvedSessionProfile | undefined;
    if (raw.extends) {
      const parentRaw = this.rawById.get(raw.extends);
      if (!parentRaw) {
        throw new Error(
          `SessionTypeProfileLoader: profile "${raw.id}" extends 未知父 "${raw.extends}"`,
        );
      }
      parentResolved = this.resolveChain(parentRaw, chain);
    }
    const base = parentResolved ?? { ...DEFAULT_BASE, id: '' };
    return {
      id: raw.id,
      extends: raw.extends,
      enabled: raw.enabled ?? base.enabled,
      toolBound: raw.toolBound ?? base.toolBound,
      toolDefinitionsSource: raw.toolDefinitionsSource ?? base.toolDefinitionsSource,
      runShape: mergeRunShape(raw.runShape, base.runShape),
      lifecycleHooks: mergeLifecycle(raw.lifecycleHooks, base.lifecycleHooks),
      eventChannel: mergeEventChannel(raw.eventChannel, base.eventChannel),
      modelHints: mergeModelHints(raw.modelHints, base.modelHints),
      skillSource: raw.skillSource ?? base.skillSource,
      eosStop: raw.eosStop ?? base.eosStop,
      autoNaming: raw.autoNaming ?? base.autoNaming,
      preloadContext: raw.preloadContext ?? base.preloadContext,
    };
  }
}

// ── 深合并 helper（子字段覆盖父） ─────────

function mergeRunShape(c: Partial<ProfileRunShape> | undefined, p: ProfileRunShape): ProfileRunShape {
  if (!c) return p;
  return {
    drainMode: c.drainMode ?? p.drainMode,
    backgroundPath: c.backgroundPath ?? p.backgroundPath,
    maxIterDefault: c.maxIterDefault ?? p.maxIterDefault,
    touchesStateMachine: c.touchesStateMachine ?? p.touchesStateMachine,
    persistsRun: c.persistsRun ?? p.persistsRun,
    usagePartition: c.usagePartition ?? p.usagePartition,
  };
}

function mergeLifecycle(c: Partial<ProfileLifecycleHooks> | undefined, p: ProfileLifecycleHooks): ProfileLifecycleHooks {
  if (!c) return p;
  return { abortFinalize: c.abortFinalize ?? p.abortFinalize, cascadeChildren: c.cascadeChildren ?? p.cascadeChildren };
}

function mergeEventChannel(c: Partial<ProfileEventChannel> | undefined, p: ProfileEventChannel): ProfileEventChannel {
  if (!c) return p;
  return { emitDefault: c.emitDefault ?? p.emitDefault };
}

function mergeModelHints(c: Partial<ProfileModelHints> | undefined, p: ProfileModelHints): ProfileModelHints {
  if (!c) return p;
  return { readsSquadDefault: c.readsSquadDefault ?? p.readsSquadDefault };
}

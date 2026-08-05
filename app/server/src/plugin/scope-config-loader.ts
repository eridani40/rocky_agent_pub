/**
 * ScopeConfigLoader — 读 app/plugins/scopes/*.yaml → ScopeConfig 对象
 * 参考: specs/tech/plugin_system/[P1]scopes_config_decl.md（YAML schema + 校验不变量）
 *       specs/tech/plugin_system/[P0]overview.md（Registry/Manager/Config 三件套分层）
 *
 * v0.0.179 模型简化（impl 列表模型，废除 selected/enabled/delta）：
 *   - 配置 = impl 列表；EP 节点不出现 = 继承 default 全量；出现 = 用自己声明的完整列表（全量替换）
 *   - YAML 不再有 selected / enabled 字段（loader 不读、不 throw、不 warn）
 *   - 数组序即 order；在列表 = active，不在 = inactive（membership 即启用）
 *
 * 转换规则（v0.0.179）：
 *   - groups[].points[] 节点存在 = 该 EP 在本 scope 激活 → activatedPoints
 *   - point.impls[] 元素形态（一律视作 active，写入 impls 字典）：
 *     * 纯字符串 "implId"        → impls[id] = { order: 数组序+1 }
 *     * {implId, configValues}   → impls[id] = { order: 数组序+1, configValues }
 *   - 数组顺序 = order（→ impls[implId].order）
 *
 * 职责（不变）：
 *   - 启动期（bootstrap）调 loadAll：扫 root 下所有 *.yaml（每个 = 一个 scope 声明）
 *   - 形状校验：scopeId/name/groups 必填 + 类型对，错则 throw
 *   - 不读落盘 policy（D2：代码声明 = 唯一源）
 *   - 不校验 exclusive 唯一性 / impl 在 manifest 注册（那是 ScopeConfigValidator 的事）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Scope 下一条 impl 配置。
 * v0.0.179：删除 `enabled` 字段——key 在 ScopeConfig.impls 字典中即表示 active（membership）。
 *   - order: YAML 数组序（1-based）；loader 解析时填充；list 类型 EP 不用但统一保留
 *   - configValues: per-impl 配置覆盖 manifest 默认值；secret 不放这（D1）
 */
export interface ScopeImplConfig {
  order?: number;
  configValues?: Record<string, unknown>;
}

/**
 * 单个 scope 的代码化配置。
 * v0.0.179：删除 `exclusivePicks` 字段——exclusive EP 的选中 = impls 字典中恰好 1 个 active
 * （validator 保证恰好 1）。
 *   - activatedPoints: 该 scope 激活的 EP id 列表（未激活 EP 的 impl 不参与该 scope 解析）
 *   - impls: implId → 配置；**key 存在 = active impl（全量列表，无 delta merge）**
 *   - parentScopeId: v0.0.204 T2-B3 extends 链父 scope id（yaml `extends:` 字段；缺省 = 'default'）
 */
export interface ScopeConfig {
  /** scope 业务 id（snake_case，default 常驻；forked/subagent 非默认） */
  scopeId: string;
  /** 显示名 */
  name: string;
  /** 说明（可选，缺省视为空串） */
  description?: string;
  /** v0.0.204 T2-B3 extends 链父 scope id（yaml `extends:` 字段；缺省 = 'default'） */
  parentScopeId?: string;
  /** 激活的 EP id 列表（subset of registry.listPoints()） */
  activatedPoints: string[];
  /**
   * implId → impl 配置；**key 存在 = active impl**（membership）。
   * 一个 EP 在某 scope 出现 = 用本 scope 自己声明的完整列表（全量替换，零 delta）。
   */
  impls: Record<string, ScopeImplConfig>;
}

/** Loader 构造参数 */
export interface ScopeConfigLoaderOptions {
  /** scopes 根目录（默认 app/plugins/scopes，可注入便于测试） */
  root: string;
}

/** YAML impl 数组元素形态（联合类型：纯字符串 | 对象，v0.0.179 删 enabled 字段） */
type YamlImplEntry =
  | string
  | {
      implId: string;
      configValues?: Record<string, unknown>;
    };

/** YAML point 节点（v0.0.179 删 selected 字段） */
interface YamlPoint {
  pointId: string;
  impls?: YamlImplEntry[];
}

/** YAML group 节点 */
interface YamlGroup {
  id: string;
  points: YamlPoint[];
}

/** YAML 顶层 scope 文件结构 */
interface YamlScope {
  scopeId: string;
  name: string;
  description?: string;
  /** v0.0.204 T2-B3 extends 链父 scope id（缺省 = 'default'，向后兼容） */
  extends?: string;
  groups: YamlGroup[];
}

/**
 * 加载器：扫 root 下所有 *.yaml 文件 → ScopeConfig[]（每个文件 = 一个 scope）。
 *
 * 单文件单 scope，文件名约定 = scopeId.yaml（default.yaml / summary.yaml）。loader 不强校验
 * 文件名与 scopeId 一致——以 yaml 内 scopeId 为准（避免双重 source of truth）。
 */
export class ScopeConfigLoader {
  private readonly root: string;

  constructor(optsOrRoot: ScopeConfigLoaderOptions | string) {
    this.root =
      typeof optsOrRoot === 'string' ? optsOrRoot : optsOrRoot.root;
  }

  /**
   * 扫 root 下所有 *.yaml 文件，解析 + 形状校验 → ScopeConfig[]。
   * 文件读取顺序按字母序（readdirSync 自然顺序），同 scopeId 后者覆盖前者并打 warning。
   *
   * @throws 文件 YAML 解析失败 / 形状校验失败（带文件名 + 字段名）
   */
  loadAll(): ScopeConfig[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      // root 不存在或为空 → throw（scopes 目录必须存在，design §2.3 硬失败）
      throw new Error(
        `ScopeConfigLoader.loadAll: scopes 根目录不存在或不可读: ${this.root}`,
      );
    }
    const configs: ScopeConfig[] = [];
    const seen = new Map<string, string>(); // scopeId → 文件名（覆盖检测）
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
      const fp = path.join(this.root, entry.name);
      const cfg = this.loadOne(fp);
      const prev = seen.get(cfg.scopeId);
      if (prev) {
        console.warn(
          `ScopeConfigLoader: scopeId "${cfg.scopeId}" 在 ${prev} 已声明，被 ${entry.name} 覆盖`,
        );
      }
      seen.set(cfg.scopeId, entry.name);
      configs.push(cfg);
    }
    return configs;
  }

  /**
   * 读取单个 yaml 文件 → ScopeConfig（含 YAML 解析 + 形状校验 + 三层 → 扁平转换）。
   */
  private loadOne(filePath: string): ScopeConfig {
    const raw = fs.readFileSync(filePath, 'utf8');
    let obj: unknown;
    try {
      obj = parseYaml(raw);
    } catch (e) {
      throw new Error(
        `ScopeConfigLoader: ${filePath} YAML 解析失败: ${(e as Error).message}`,
      );
    }
    return validateAndConvertYamlScope(obj, filePath);
  }
}

/**
 * 形状校验 + 三层 → 扁平转换：把 YAML 三层（groups[].points[].impls[]）转成 ScopeConfig
 * （activatedPoints / impls 字典）。下游消费扁平 ScopeConfig，不动。
 *
 * v0.0.179 转换规则（impl 列表模型）：
 *   - point 节点存在 → activatedPoints 加 pointId
 *   - point.impls[] 元素（一律视作 active，写入 impls 字典）：
 *     * 纯字符串 → impls[id] = { order: idx+1 }
 *     * {implId, configValues} → impls[id] = { order: idx+1, configValues }
 *   - 数组顺序 = order
 *   - 不读 selected / enabled 字段（YAML 已删，loader 不报错也不 warn）
 *
 * @throws 形状不合法时抛错（消息含字段名 + 文件名便于定位）
 */
export function validateAndConvertYamlScope(
  obj: unknown,
  filePath: string,
): ScopeConfig {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`ScopeConfigLoader: ${filePath} 顶层必须是对象`);
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.scopeId !== 'string' || o.scopeId.length === 0) {
    throw new Error(`ScopeConfigLoader: ${filePath} scopeId 缺失或非非空字符串`);
  }
  if (typeof o.name !== 'string' || o.name.length === 0) {
    throw new Error(
      `ScopeConfigLoader: ${filePath} name 缺失或非非空字符串（scope=${o.scopeId}）`,
    );
  }
  if (!Array.isArray(o.groups) && o.groups !== undefined) {
    throw new Error(
      `ScopeConfigLoader: ${filePath} groups 必须是数组（scope=${o.scopeId}）`,
    );
  }
  // v0.0.204 T2-B3：groups 缺省 = 空数组（继承型 scope 文件可不写 groups，全靠 extends 链回退）
  const groupsArr = Array.isArray(o.groups) ? (o.groups as unknown[]) : [];

  const activatedPoints: string[] = [];
  const impls: Record<string, ScopeImplConfig> = {};

  // 重复 implId 检测（同一 scope 内同 implId 在多个 EP 重复列出 → warning，后者覆盖）
  const seenImplsInFile = new Map<string, string>();

  for (let gi = 0; gi < groupsArr.length; gi++) {
    const g = groupsArr[gi];
    if (g == null || typeof g !== 'object' || Array.isArray(g)) {
      throw new Error(
        `ScopeConfigLoader: ${filePath} groups[${gi}] 必须是对象（scope=${o.scopeId}）`,
      );
    }
    const gobj = g as Record<string, unknown>;
    if (typeof gobj.id !== 'string' || gobj.id.length === 0) {
      throw new Error(
        `ScopeConfigLoader: ${filePath} groups[${gi}].id 缺失或非非空字符串（scope=${o.scopeId}）`,
      );
    }
    if (!Array.isArray(gobj.points)) {
      throw new Error(
        `ScopeConfigLoader: ${filePath} groups[${gi}].points 必须是数组（scope=${o.scopeId}）`,
      );
    }
    const points = gobj.points as unknown[];
    for (let pi = 0; pi < points.length; pi++) {
      const p = points[pi];
      if (p == null || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error(
          `ScopeConfigLoader: ${filePath} groups[${gi}].points[${pi}] 必须是对象（scope=${o.scopeId}）`,
        );
      }
      const pobj = p as Record<string, unknown>;
      if (typeof pobj.pointId !== 'string' || pobj.pointId.length === 0) {
        throw new Error(
          `ScopeConfigLoader: ${filePath} groups[${gi}].points[${pi}].pointId 缺失或非非空字符串（scope=${o.scopeId}）`,
        );
      }
      const pointId = pobj.pointId;

      // point 节点存在 = 激活
      activatedPoints.push(pointId);

      // impls[] 数组：转成 impls 字典（v0.0.179：所有列出项一律 active）
      const implsArr = pobj.impls;
      if (implsArr === undefined) {
        // 无 impls 字段 = 该 EP 激活但无 impl（合法，但等价空列表；一般用空数组占位说明「该 EP 0 active」）
        continue;
      }
      if (!Array.isArray(implsArr)) {
        throw new Error(
          `ScopeConfigLoader: ${filePath} point "${pointId}".impls 必须是数组（scope=${o.scopeId}）`,
        );
      }
      for (let ii = 0; ii < implsArr.length; ii++) {
        const entry = implsArr[ii];
        let implId: string;
        let configValues: Record<string, unknown> | undefined;
        if (typeof entry === 'string') {
          implId = entry;
        } else if (
          entry != null && typeof entry === 'object' && !Array.isArray(entry)
        ) {
          const eobj = entry as Record<string, unknown>;
          if (typeof eobj.implId !== 'string' || eobj.implId.length === 0) {
            throw new Error(
              `ScopeConfigLoader: ${filePath} point "${pointId}".impls[${ii}].implId 缺失或非非空字符串（scope=${o.scopeId}）`,
            );
          }
          implId = eobj.implId;
          if (eobj.configValues !== undefined) {
            if (
              eobj.configValues == null || typeof eobj.configValues !== 'object'
            ) {
              throw new Error(
                `ScopeConfigLoader: ${filePath} impls["${implId}"].configValues 必须对象（scope=${o.scopeId}）`,
              );
            }
            configValues = eobj.configValues as Record<string, unknown>;
          }
        } else {
          throw new Error(
            `ScopeConfigLoader: ${filePath} point "${pointId}".impls[${ii}] 必须是字符串或对象（scope=${o.scopeId}）`,
          );
        }

        // 重复 implId 检测
        const prev = seenImplsInFile.get(implId);
        if (prev) {
          console.warn(
            `ScopeConfigLoader: implId "${implId}" 在 ${filePath} 中重复（先于 ${prev}，后覆盖）`,
          );
        }
        seenImplsInFile.set(implId, pointId);

        // 三层 → 扁平转换（v0.0.179）：所有列出项一律 active，order = 数组序（1-based）
        impls[implId] = {
          order: ii + 1,
          ...(configValues ? { configValues } : {}),
        };
      }
    }
  }

  return {
    scopeId: o.scopeId,
    name: o.name,
    description: typeof o.description === 'string' ? o.description : undefined,
    parentScopeId: typeof o.extends === 'string' ? o.extends : undefined,
    activatedPoints,
    impls,
  };
}

/**
 * GroupMetaLoader — v0.0.71 group 元数据加载：读 app/plugins/groups.json → GroupMetaFile
 * 参考: specs/tech/plugin_system/[P1]groups_meta_decl.md §3.1（加载链路）
 *       specs/tech/plugin_system/[P1]scopes_config_decl.md §3.1（同型 Loader 范式）
 *       specs/tech/version_logs/v0.0.71/change_plan.md 模块 1
 *
 * 职责（[P1]groups_meta_decl.md §3.1）：
 *   - 读 groups.json 单文件（不扫目录，groups 是元数据全集，§5.2）
 *   - JSON.parse + 形状校验：groups 必填数组 + 每项 id/label/description/extPoints 必填
 *     + extPoints 项非空字符串
 *   - 文件不存在或不可读 → throw（D6 硬失败，与 scopes 一致）
 *
 * 不做（边界，归 ScopeConfigValidator.validateGroups / Provider 构建期）：
 *   - 不校验 EP 在 registry 注册（Validator.validateGroups 第 1 条）
 *   - 不校验 pointId 唯一（LoadedGroupMetaProvider 构建期 + Validator.validateGroups）
 *   - 不校验 group id 唯一（同上）
 *
 * 与 builtin-loader / scope-config-loader 平行：同属「代码树」源，启动期一次性加载。
 */
import * as fs from 'node:fs';

/**
 * 单个 group 的元数据（groups.json 单条结构，[P1]groups_meta_decl.md §2）。
 */
export interface GroupMeta {
  /** group 业务 id（kebab-case，如 "context-ingest" / "provider" / "web"） */
  id: string;
  /**
   * 显示名（必填，i18n 占位符 `__MSG_group.<snake_id>.label__`，前端 resolveI18nField 翻译）。
   * snake_id = id 的 `-` 转 `_`（如 context-ingest → context_ingest）。
   */
  label: string;
  /** 说明（必填，i18n 占位符 `__MSG_group.<snake_id>.description__`，UI group sidebar 副文本） */
  description: string;
  /** 该 group 包含的 EP id 列表（subset of registry.listPoints()） */
  extPoints: string[];
}

/**
 * groups.json 顶层结构（[P1]groups_meta_decl.md §2）。
 * 单文件单根（不分片，无 _meta）。
 */
export interface GroupMetaFile {
  /** group 元数据列表（按声明序 = UI 显示序，[P1]groups_meta_decl.md §5.3） */
  groups: GroupMeta[];
}

/** Loader 构造参数 */
export interface GroupMetaLoaderOptions {
  /** groups.json 文件路径（默认 app/plugins/groups.json，可注入便于测试） */
  path: string;
}

/**
 * 加载器：读 groups.json 单文件 → GroupMetaFile（含 JSON 解析 + 形状校验）。
 *
 * 仿 ScopeConfigLoader 范式（[P1]scopes_config_decl.md §3.1），但本 Loader 是单文件读
 * （groups 是元数据全集，无 per-scope 切片需求，[P1]groups_meta_decl.md §5.2）。
 */
export class GroupMetaLoader {
  private readonly filePath: string;

  constructor(optsOrPath: GroupMetaLoaderOptions | string) {
    this.filePath = typeof optsOrPath === 'string' ? optsOrPath : optsOrPath.path;
  }

  /**
   * 读 groups.json 单文件 → GroupMetaFile。
   *
   * @throws 文件不存在 / JSON 解析失败 / 形状校验失败（消息含字段名 + 文件名便于定位）
   */
  load(): GroupMetaFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // 文件不存在或不可读 → throw（D6 硬失败，与 scopes 一致）
      throw new Error(
        `GroupMetaLoader.load: groups.json 不存在或不可读: ${this.filePath}`,
      );
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `GroupMetaLoader: ${this.filePath} JSON 解析失败: ${(e as Error).message}`,
      );
    }
    return validateGroupMetaShape(obj, this.filePath);
  }
}

/**
 * 形状校验：groups 必填数组 + 每项 id/label/description/extPoints 必填 + extPoints 项非空字符串。
 * 不校验语义（EP 在 registry 注册 / pointId 唯一 / group id 唯一）——
 * 那是 LoadedGroupMetaProvider 构建期 + ScopeConfigValidator.validateGroups 的职责。
 *
 * @throws 形状不合法时抛错（消息含字段名 + 文件名便于定位）
 */
export function validateGroupMetaShape(obj: unknown, filePath: string): GroupMetaFile {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`GroupMetaLoader: ${filePath} 顶层必须是对象`);
  }
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.groups)) {
    throw new Error(`GroupMetaLoader: ${filePath} groups 必须是数组`);
  }
  const groups: GroupMeta[] = [];
  for (let i = 0; i < o.groups.length; i++) {
    groups.push(validateGroupMeta(o.groups[i], i, filePath));
  }
  return { groups };
}

/** 单条 GroupMeta 形状校验：id/label/description/extPoints 必填 + extPoints 项非空字符串 */
function validateGroupMeta(g: unknown, index: number, filePath: string): GroupMeta {
  if (g == null || typeof g !== 'object' || Array.isArray(g)) {
    throw new Error(`GroupMetaLoader: ${filePath} groups[${index}] 必须是对象`);
  }
  const r = g as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) {
    throw new Error(
      `GroupMetaLoader: ${filePath} groups[${index}].id 缺失或非非空字符串`,
    );
  }
  if (typeof r.label !== 'string' || r.label.length === 0) {
    throw new Error(
      `GroupMetaLoader: ${filePath} groups[${index}].label 缺失或非非空字符串（group=${r.id}）`,
    );
  }
  if (typeof r.description !== 'string' || r.description.length === 0) {
    throw new Error(
      `GroupMetaLoader: ${filePath} groups[${index}].description 缺失或非非空字符串（group=${r.id}）`,
    );
  }
  if (!Array.isArray(r.extPoints)) {
    throw new Error(
      `GroupMetaLoader: ${filePath} groups[${index}].extPoints 必须是数组（group=${r.id}）`,
    );
  }
  for (const p of r.extPoints) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error(
        `GroupMetaLoader: ${filePath} groups[${index}].extPoints[] 项必须非空字符串（group=${r.id}）`,
      );
    }
  }
  return {
    id: r.id,
    label: r.label,
    description: r.description,
    extPoints: r.extPoints as string[],
  };
}

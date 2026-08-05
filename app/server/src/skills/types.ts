/**
 * skill 子系统核心类型（v0.0.21）
 * 参考: specs/tech/agent/skills/[P0]skill_definition.md §2-§4
 *       specs/tech/agent/skills/[P0]skill_architecture.md §4.3 §5
 *       specs/api/overall/06-skill.md §8
 *
 * 本文件是 skill 子系统对外类型契约的唯一权威源：SkillCatalog / SkillEntry /
 * SkillFileNode / SkillContent。handler / resolver / installer / tree / tool 共享引用。
 *
 * scope 四层（skill_definition §4 + v0.0.33.3 builtin 层 + v0.0.164 squad 层 + v0.0.205 改名 group 层）：
 *   - builtin 级 = app/plugins/builtins/skills/<name>/（随 app 发版，只读最低层）
 *   - app 级    = <dataDir>/skills/<name>/（用户/agent 安装层，跨 workspace 共享）
 *   - workspace 级 = <workspace>/.rocky/skills/<name>/（项目级，可随 git 共享）
 *   - group 级  = <groupWs>/.rocky/skills/<name>/（squad 团队共享，v0.0.205 改名；
 *     groupWs 由 resolveGroupWsDir 唯一解析：`<dataDir>/squads/<squadId>/`）
 *   - 同名合并时高层覆盖低层：group > workspace > app > builtin（resolver 负责）。
 *
 * 对外 skill_manage/skill 工具 scope enum 不变（工具入参仍是 'global'/'session'）。
 * group skill 目录由 studio session 通过 resolveGroupWsDir 派生 groupDir 注入 resolver，
 * UI 侧不暴露 scope='group' 选项。
 */

/** skill 命中层（同名冲突时高层胜出：group > workspace > app > builtin） */
export type SkillScope = 'builtin' | 'app' | 'workspace' | 'group';

/**
 * SkillEntry —— skill 列表/安装/toggle 响应共用形态（api §8 / arch §4.3）。
 * 治理字段（source/productionMethod/evolvable）：evolvable 自 v0.0.55 起消费（L0 catalog 标 [evolvable]
 * 让 LLM 知晓哪些 skill 可改；skill_manage 工具强制 immutable 拒绝写，见 skill_definition §6）。
 * v0.0.55 删 mutableLocked 维度（UI 一定能改 evolvable，agent 不碰治理元字段——无需 lock）。
 */
export interface SkillEntry {
  /** kebab-case，= 目录名 = frontmatter name（全局唯一 id） */
  name: string;
  /** frontmatter description（≤1024，触发器语义） */
  description: string;
  /** 命中层（同名时 workspace 胜出） */
  scope: SkillScope;
  /** 绝对路径 */
  skillDir: string;
  /** enabled 状态（app_config.skill_state 持久化，fallback true） */
  enabled: boolean;
  // —— 治理字段（v0.0.55 单维度 evolvable；governance 端点读写 frontmatter evolvable）——
  source?: 'user' | 'agent';
  productionMethod?: 'handwritten' | 'consolidation' | 'download';
  /** 是否允许 agent 自进化（v0.0.55 改名 mutable→evolvable；缺省视为 false） */
  evolvable?: boolean;
  /**
   * 更新时间（ISO 8601，源自 frontmatter `updated`/`updatedAt`）。
   * 缺省 undefined（legacy/builtin 未写戳）→ 注入分组排序时按 epoch0 处理（组内最末）。
   * 写侧（skill_manage create/patch + governance）刷新为 now；builtin 随发版带固定值。
   */
  updatedAt?: string;
  // —— 市场来源锚点（v0.0.167；仅市场安装写，resolver 从 frontmatter market_ref/market_source/installed_hash 读入）——
  /**
   * 安装用的 provider ref（如 github/awesome-copilot/git-commit）。
   * 缺省 undefined = 本地/手写/builtin 来源（非市场安装）。UI 据有无显示「市场/本地」badge；
   * 市场 tab 据 `item.ref === marketRef` 精确匹配判「同源已安装」。
   */
  marketRef?: string;
  /** 安装来源 provider id（如 skills_sh）；来源展示用。缺省=本地来源 */
  marketSource?: string;
  /** 安装时内容哈希（可更新惰性比对锚点：市场详情 detail.hash 与之不同 → 可更新）。缺省=无法比对 */
  installedHash?: string;
}

/** SkillCatalog —— resolver 产出（entries 已去重，name 唯一） */
export interface SkillCatalog {
  entries: SkillEntry[];
}

/**
 * SkillFileNode —— 预览文件树节点（api §6.2）。
 * path 相对 skillDir（不含 skill 名前缀，防泄漏绝对路径）。
 */
export interface SkillFileNode {
  /** 文件/目录名（基名） */
  name: string;
  /** 相对 skillDir 的路径（如 SKILL.md、docs/guide.md） */
  path: string;
  type: 'file' | 'dir';
  /** file 字节数（dir 无） */
  size?: number;
}

/**
 * SkillContent —— skill 读工具返回（skill_tool §2.2）。
 * L1 全文 + skillDir（供 L2 钻取用 Read 工具读 references/*）。
 */
export interface SkillContent {
  name: string;
  skillDir: string;
  body: string;
  scope: SkillScope;
}

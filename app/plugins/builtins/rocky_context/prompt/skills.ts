/**
 * builtin rocky_context plugin — system_prompt_mapper: skills
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.4
 *       specs/tech/agent/context/[P0]system_prompt.md §4（skills / stable tier）
 *       specs/tech/agent/skills/[P0]skill_definition.md §2 §6（L0 带 evolvable 标记；治理字段）
 *       specs/tech/agent/skills/[P0]skill_manage_tool.md §5（L0 = 仅 enabled 的 name+description+evolvable）
 *       specs/tech/agent/skills/[P0]skill_architecture.md §8
 *       specs/tech/agent/context/[P0]prompt_content_files.md §4（委托 SkillsHandler）
 *
 * 职责：贡献 skill L0 片段（stable tier）。v0.0.22 起 mapper 拼 skills_list 从 ctx.config.skills.entries
 * 读 enabled skill 元数据 → 传 SkillsHandler.build({vars:{skills_list}}) 替换模板 {{skills_list}}。
 * entries 为空（无 skill 或全 disabled）→ handler 返空 → mapper 不贡献。
 *
 * L0 = name + description + evolvable 标记（progressive disclosure §3 + skill_definition §2 末段）：
 *   catalog 廉价常驻 system prompt，agent 据此判断何时用某 skill，再调 `skill` 工具取 L1 全文；
 *   v0.0.55（mutable→evolvable 改名）起每条 entry 标 [evolvable=true|false]，让 LLM 知晓哪些 skill 可被 skill_manage 改（§6.1）。
 *
 * disabled 不进 L0：session-config.ts 在填 ctx.config.skills.entries 时已 .filter(e=>e.enabled)，
 *   mapper 无需重复过滤（skill_manage_tool §5：disabled 仅出现在 skill_manage.list，不进 system prompt）。
 *
 * 分层配额（覆盖旧「跨组共享统一 maxSkillInject」）：
 *   物理层 → 注入层映射（近者优先，修「system→user→agent 方向反」）：
 *     workspace → session 层（≤20）/ group → group 层（≤30）/ app → global 层（≤50）；
 *     **builtin 平台资产不计配额，恒全量殿后注入**（裁掉破坏基础能力）。
 *   catalog 拼接序 = workspace → group → app → builtin；层内 user→agent + updatedAt 倒序 + name 升序。
 *   app_config session group 三 key 覆盖（maxSkillInject→global / maxSkillInjectGroup→group
 *   / maxSkillInjectSession→session），缺失回退 20/30/50。
 *   不新增 reducer / 不新增 PromptCtx 字段；截断在 mapper 内闭环（决策 C）。
 *
 * EP: system_prompt_mapper，priority 500，tier=stable。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { SkillsHandler } from '../../../../server/src/prompts/handlers/skills-handler';
import type { AppConfigService } from '../../../../server/src/config/app-config-service';

/** 分层注入配额缺失时的默认值（app_config.md §3.14 可选覆盖调参组；分层 20/30/50） */
const DEFAULT_SKILL_QUOTAS: SkillInjectQuotas = { global: 50, group: 30, session: 20 };

/** 各 scope 独立注入配额（缺失由 caller 兜底 20/30/50） */
export interface SkillInjectQuotas {
  global: number;
  group: number;
  session: number;
}

/** 物理层 → 注入层键（resolver 4 层优先级语义不变；归组只在配额函数内） */
type InjectLayerKey = 'session' | 'group' | 'global' | 'builtin';

/** readSkillEntries 产出的扁平行（含分组/排序所需字段） */
interface SkillRow {
  name: string;
  description: string;
  evolvable: boolean;
  /** 来源层（resolver 盖章的 SkillScope 原值：builtin/app/workspace/group）—L0 [scope=] 标注用 */
  scope: string;
  /** 来源组：'user'（UI 写/download）/ 'agent'（agent 写/consolidation 产出）；builtin 恒殿后 */
  origin: 'user' | 'agent';
  updatedAt?: string;
}

/**
 * skills mapper：按配额分组截断后拼 skills_list（每条 `- name [evolvable=true|false]: description`）
 * 传 handler → 包 PromptFragment。entries 为空 → handler 返空 → 不贡献。
 */
export default class SkillsMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const rows = readSkillEntries(ctx);
    if (rows.length === 0) return [];
    const quotas = resolveSkillQuotas(ctx);
    // 物理层 → 注入层（workspace→session / group→group / app→global / builtin 殿后不计配额）
    const selected = selectSkillsByQuota(rows, quotas);
    if (selected.length === 0) return [];
    // v0.0.55: 每条 L0 entry 带 [evolvable=true|false] 标记（skill_definition §2 末段）
    // v0.0.232: 加 [scope=...] 来源层标注（PRD §13.2.4；resolver 4 层优先级语义不变）
    const lines = selected.map(
      (e) => `- ${e.name} [evolvable=${e.evolvable ? 'true' : 'false'}] [scope=${e.scope}]: ${e.description}`,
    );
    const skillsList = lines.join('\n');
    const content = new SkillsHandler().build({ vars: { skills_list: skillsList } }).content;
    return [
      {
        id: 'skills',
        tier: 'stable',
        content,
        priority: 500,
      },
    ];
  }
}

/**
 * 物理层 → 注入层映射（O3：workspace→session / group→group / app→global / builtin 殿后）。
 * resolver 4 层优先级语义不变（builtin>app>workspace>group 在 resolver.lookup）；
 * 本处只决定配额截断时该行归到哪一层。未知 scope → 'app'（global 层）保守防御，实际 resolver 必盖 scope。
 */
function injectLayerOf(scope: string): InjectLayerKey {
  if (scope === 'workspace') return 'session';
  if (scope === 'group') return 'group';
  if (scope === 'builtin') return 'builtin';
  return 'global'; // app / 缺省 / 未知
}

/**
 * 注入配额选择纯函数（分层）：物理层归组映射 + 各层独立截断（workspace/group/app
 * 三层；builtin 不计配额恒全量殿后）。catalog 拼接序 workspace → group → app → builtin
 * （近者优先，修「system→user→agent 方向反」）；层内 user→agent + updatedAt 倒序 + name 升序。
 *
 * 纯函数无副作用，单独 UT 覆盖。三层配额均 0 → 仅 builtin（若 rows 无 builtin 则 []）。
 *
 * @param rows 已派生 origin 的扁平行
 * @param quotas 三层独立配额（caller 经 app_config 解析，缺失兜底 20/30/50）
 */
export function selectSkillsByQuota(rows: SkillRow[], quotas: SkillInjectQuotas): SkillRow[] {
  const layers: Record<InjectLayerKey, SkillRow[]> = {
    session: [], // workspace 层
    group: [], // group 层
    global: [], // app 层
    builtin: [], // builtin 层（不计配额）
  };
  for (const r of rows) layers[injectLayerOf(r.scope)].push(r);

  const sortFn = (a: SkillRow, b: SkillRow): number => {
    const ta = a.updatedAt ?? '';
    const tb = b.updatedAt ?? '';
    if (ta !== tb) return tb.localeCompare(ta); // updatedAt 倒序：大者在前
    return a.name.localeCompare(b.name); // tiebreak：name 升序
  };
  // 层内 user→agent：origin 'user' 居前，'agent' 居后；各组内 sortFn
  const pickLayer = (key: Exclude<InjectLayerKey, 'builtin'>, quota: number): SkillRow[] => {
    if (quota <= 0) return [];
    const user = layers[key].filter((r) => r.origin === 'user').sort(sortFn);
    const agent = layers[key].filter((r) => r.origin === 'agent').sort(sortFn);
    return [...user, ...agent].slice(0, quota);
  };

  // catalog 序：workspace(session 层) → group → app(global 层) → builtin（殿后全量，layer 内按 sortFn）
  return [
    ...pickLayer('session', quotas.session),
    ...pickLayer('group', quotas.group),
    ...pickLayer('global', quotas.global),
    ...layers.builtin.sort(sortFn),
  ];
}

/**
 * 从 ctx.config 读 skill 分层注入配额（app_config session group，分层 20/30/50）。
 * key 语义：maxSkillInject → global 层（旧「跨组总量」key 语义转为 global 层）；
 *   maxSkillInjectGroup → group 层；maxSkillInjectSession → session 层。
 * 缺失（无 appConfig / 无 session record / 字段非 number）→ 各层独立回退 20/30/50。
 */
function resolveSkillQuotas(ctx: PromptCtx): SkillInjectQuotas {
  const appConfig = resolveAppConfig(ctx);
  if (!appConfig) return { ...DEFAULT_SKILL_QUOTAS };
  const session = appConfig.get('session', 'default');
  if (!session || typeof session !== 'object') return { ...DEFAULT_SKILL_QUOTAS };
  const rec = session as {
    maxSkillInject?: unknown;
    maxSkillInjectGroup?: unknown;
    maxSkillInjectSession?: unknown;
  };
  return {
    global:
      typeof rec.maxSkillInject === 'number' && Number.isFinite(rec.maxSkillInject)
        ? rec.maxSkillInject
        : DEFAULT_SKILL_QUOTAS.global,
    group:
      typeof rec.maxSkillInjectGroup === 'number' && Number.isFinite(rec.maxSkillInjectGroup)
        ? rec.maxSkillInjectGroup
        : DEFAULT_SKILL_QUOTAS.group,
    session:
      typeof rec.maxSkillInjectSession === 'number' && Number.isFinite(rec.maxSkillInjectSession)
        ? rec.maxSkillInjectSession
        : DEFAULT_SKILL_QUOTAS.session,
  };
}

/**
 * 从 ctx.config 取 AppConfigService（读 app_config 配额用；缺省 → null）。
 * 与 memory.ts resolveAppConfig 同模式（duck-typed，避免 context 层反向依赖 config 模块类型）。
 */
function resolveAppConfig(ctx: PromptCtx): AppConfigService | null {
  const ac = (ctx.config as { appConfig?: unknown }).appConfig;
  if (
    ac &&
    typeof ac === 'object' &&
    typeof (ac as { get?: unknown }).get === 'function' &&
    typeof (ac as { set?: unknown }).set === 'function'
  ) {
    return ac as AppConfigService;
  }
  return null;
}

/**
 * duck-typed 读 ctx.config.skills.entries（避免 context 层反向依赖 skills 模块类型）。
 * 返回 entries 已被 session-config 层过滤为仅 enabled（disabled 不进 L0 catalog）。
 * evolvable 字段缺省视为 false（skill_definition §6.3 默认值表：保守 immutable by default）。
 * v0.0.149：额外读 scope/source（origin 派生）+ updatedAt（层内排序）。
 * origin = source（'user'/'agent'；builtin 不再单独成组，恒殿后注入）。
 */
function readSkillEntries(ctx: PromptCtx): SkillRow[] {
  const skills = (ctx.config as { skills?: { entries?: unknown } }).skills;
  const entries = skills?.entries;
  if (!Array.isArray(entries)) return [];
  const out: SkillRow[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const name = (e as { name?: unknown }).name;
    const description = (e as { description?: unknown }).description;
    const evolvableRaw = (e as { evolvable?: unknown }).evolvable;
    if (typeof name !== 'string' || typeof description !== 'string') continue;
    const evolvable = typeof evolvableRaw === 'boolean' ? evolvableRaw : false;
    const scope = (e as { scope?: unknown }).scope;
    const source = (e as { source?: unknown }).source;
    const updatedAtRaw = (e as { updatedAt?: unknown }).updatedAt;
    out.push({
      name,
      description,
      evolvable,
      // scope 恒由 resolver 盖章（parseSkillDir 必传 scope 参数）；缺省 'app' 纯防御、实际不可达
      scope: typeof scope === 'string' ? scope : 'app',
      origin: source === 'agent' ? 'agent' : 'user',
      updatedAt: typeof updatedAtRaw === 'string' ? updatedAtRaw : undefined,
    });
  }
  return out;
}

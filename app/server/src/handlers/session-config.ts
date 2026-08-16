/**
 * session-config —— SessionConfig 共享构造 helper
 * 参考: specs/api/overall/04-agent-session.md §3.2 §7（messages POST / compact POST 契约）
 *       specs/tech/agent/session/[P0]session_workspace.md §1（workdir = session.workspaceDir 接线）
 *       specs/tech/agent/tools/[P0]tool_policy.md §4.1（config 层 tools 解析接线）
 *
 * 唯一入口 = agentManager.resolveConfigBySid(sid)（bootstrap 闭包内自 resolve）。
 *
 * 调用方：
 *   - bootstrap.setResolveConfig 闭包（chat/compact 同链）
 *   - session-debug（GET /session/:id/debug/system-prompt，test gate）
 *
 * workdir 接线：SessionConfig.workdir 从 session.workspaceDir 取（spec §1）。
 *   - workspaceDir 入参非空 → workdir = workspaceDir（loop 启动即用 session 真相源）
 *   - workspaceDir 入参空/缺省 → 回退 <DATA_DIR>/workspace（向后兼容旧 session）
 *
 * SessionKind 统一 session 身份维度：kind 必传，role 由 kind.role 派生。
 * tools 解析：全部走 SessionTypePolicy.resolveToolSet（profile yaml 单源）——
 *   deps.sessionTypePolicy 必填，未注入 fail-fast（生产由 bootstrap 装配注入，测试显式注入）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildLlmClient } from '../llm-client-factory';
import type { SessionHandlerDeps } from './session';
// llm_request config 装配接线：加载生效 config + 全部启用 provider 落 SessionConfig，
// 供 stage-llm 透传 invoke（见 [P0]llm_caller.md §3）。
import { LlmRequestConfigService } from '../config/llm_request_config';
import { listEnabledProviders } from './session-deps';
import type { LlmProviderConfig } from '../llm/provider-types';
// resolveModel：统一 fallback 链 + ModelNotConfiguredError。
//   参考: services/model-resolver.ts + PRD 03 §2.1 表 + §5.1 错误体
//   session-config 全部走 resolveModel（PRD §2.1 6 行 fallback 表）；resolveProviderModel
//   仅作 session-provider-utils.ts 的 @internal 机械解析兜底。
//   [v0.0.349] 分支 2 全 dangling 降级复用 ModelNotConfiguredError（与分支 1 跑空同构，
//   消费链 instanceof 识别 → HTTP 400 MODEL_NOT_CONFIGURED；api 21 §2.7-1）。
import { resolveModel, ModelNotConfiguredError } from '../services/model-resolver';
// [v0.0.347] 模型路由 resolve 双分支（D11/D12）：挂载查询 + 方案实体读取 + 候选链合成。
//   store 层（T1 已实现）：getPlan / getPlaygroundPlanId；validation 层：fillCircuitDefaults（默认熔断参数）。
import { getPlan, getPlaygroundPlanId } from '../services/model-routing-store';
import {
  fillCircuitDefaults,
  isItemEnabled,
  isItemTimeConditioned,
  type RoutingItem,
} from '../services/model-routing-validation';
import { isReservedModelId } from '../services/model-validation';
import type { AppConfigService } from '../config/app-config-service';
import type { SessionConfig, StudioContext } from '../agent/context-types';
// tool policy 单源：全部走 SessionTypePolicy.resolveToolSet（profile yaml 单源）。
// 参考: specs/tech/agent/tools/[P0]tool_policy.md §4.1（config 层接线）
import type { SessionTypePolicy } from '../agent/session-type-policy';
// maxIter 单一来源（顶层/studio/squad 默认）：agent-loop-lifecycle.ts 的 export 常量。
import { DEFAULT_MAX_ITERATIONS } from '../agent/agent-loop-lifecycle';
// SessionKind 统一 session 身份维度
import type { SessionKind, SessionContext } from '@app/shared';
// [v0.0.347] academy 边界：academy 集成 = 非目标（tech spec L20/L266 本期仅 studio/playground）。
//    academy 会话不得走 playground 挂载方案（绕过 classroom 三档模型链）。
import { isAcademySessionKind } from '../academy/academy-context';
// skill catalog 注入（arch §7.2）
import { SkillResolver, builtinSkillRoot } from '../skills/resolver';
import { SkillEnabledStore } from '../skills/enabled-store';
import type { SkillEntry } from '../skills/types';
import { resolveGroupWsDir } from '../agent/group-dir';
import type { MemberSkillConfig } from '../agent/schema_defs/squad/member';

/**
 * studio member skill overlay 判定（session_config_studio §3.2）。
 * 决定某 catalog skill 是否对该 studio member session（及其 subagent）可见：
 *   - scope==='workspace' || 'group' → true（R2：team 级约定，workspace/group 层恒生效，不受 switch/快照影响）
 *   - builtin/app 层（"全局 skill"）：
 *       mode==='custom'   → overrides 有该 name 用快照值；无记录跟全局 entry.enabled（R1/R3）
 *       mode==='inherit'  → entry.enabled（纯继承全局 enabled）
 * skillConfig 缺失/形态非法（旧数据无 skillConfig 字段）→ 退化为 inherit（跟全局 enabled）。
 *
 * @param entry  catalog 中一项 skill（含 scope/enabled/name）
 * @param cfg    member.skillConfig（json 字段，运行时按 MemberSkillConfig 断言；可能 undefined）
 */
function keepStudioSkill(entry: SkillEntry, cfg: unknown): boolean {
  // R2：workspace/group 层恒生效（即便全局 disabled；group 层=团队共享约定同 R2）
  if (entry.scope === 'workspace' || entry.scope === 'group') return true;
  const sc = cfg as MemberSkillConfig | undefined;
  // custom：查局部快照 overrides；有记录用快照，无记录跟全局 enabled（R1/R3）
  if (sc && sc.mode === 'custom') {
    const ov = sc.overrides;
    if (ov && Object.prototype.hasOwnProperty.call(ov, entry.name)) {
      return ov[entry.name] === true;
    }
    return entry.enabled;
  }
  // inherit（含缺失/非法快照兜底）：纯继承全局 enabled
  return entry.enabled;
}

/**
 * studio 分支入参（与 subAgentConfig 分支并列；[P1]session_config_studio.md §3）。
 * bootstrap setResolveConfig 闭包对 studio session（bizType==='studio' && type!=='subagent'）组装此参数。
 * - role/squadId/memberId：从 session record 镜像（透传到 config 同名字段）。role 值: 'squad'|'leader'|'mate'。
 * - member/squad：从 MemberStore/SquadStore 取的 entity（systemPrompt/tools/skills/model 取法用）。
 */
export interface StudioSessionContext {
  role: 'squad' | 'leader' | 'mate';
  squadId: string;
  memberId?: string;
  member?: StudioContext['member'];
  squad?: StudioContext['squad'];
  /**
   * squad 全队 member entity 批量。
   * bootstrap setResolveConfig 闭包按 session.squadId 调 memberStore.listMembers 一次性拉齐注入。
   * team_roster/reachable_agents mapper 据此派生花名册 + 路由对端（squadChatSessionId 在 squad entity 上）。
   */
  members?: StudioContext['members'];
}

/**
 * [v0.0.279] effort 覆盖链纯函数（squad 团队默认推理强度）。
 * 覆盖链（老板口径）：成员显式档（low/high/max）→ 用之；否则读团队 effortDefault（low/high/max）→ 用之；否则 undefined（厂商默认，encode 不注入）。
 * - sessionEffort ∈ {low,high,max} → 用之（成员显式档优先；'default' 与 undefined 同语义=不覆盖）
 * - squadEffortDefault ∈ {low,high,max} → 用之（团队默认；'default'/undefined=不覆盖）
 * - 否则 undefined（encode 层 guard 走厂商默认，不加 output_config）
 * MUST NOT 读 app_config / member 级 effort；返回 'low'|'high'|'max' | undefined。
 * 参考: specs/tech/version_logs/v0.0.279/change_plan.md（PRD D1）+ llm_protocol_interface §3.8
 */
export function resolveEffort(
  sessionEffort: 'default' | 'low' | 'high' | 'max' | undefined,
  squadEffortDefault: 'default' | 'low' | 'high' | 'max' | undefined,
): 'low' | 'high' | 'max' | undefined {
  if (sessionEffort === 'low' || sessionEffort === 'high' || sessionEffort === 'max') return sessionEffort;
  if (squadEffortDefault === 'low' || squadEffortDefault === 'high' || squadEffortDefault === 'max') return squadEffortDefault;
  return undefined;
}

/**
 * [v0.0.347] 模型路由 resolve 双分支（D11/D12）——挂载查询 + 候选链合成（纯函数，无副作用）。
 * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §4
 *
 * - 挂载源：studio = squad.modelRoutingPlanId；playground = model_routing.default.playgroundPlanId
 * - 有挂载且方案存在 → 合成候选链：
 *     session 显式 modelId（非保留字）→ [session 模型(priority 0)] + 方案 items（临时合成，
 *     不写回方案实体；熔断键 = planId + session 模型，享受方案熔断控制）
 *     default/none/undefined（保留字）→ 方案 items 原序（priority 升序）
 * - 无挂载 / 方案不存在（挂载悬空）→ undefined（走分支 1 现有 resolveModel 原链，零改动）
 *
 * @returns SessionConfig.modelRoutingPlan | undefined（undefined = 分支 1）
 */
export function resolveModelRoutingPlan(
  deps: SessionHandlerDeps,
  sessionPersist: { providerId?: string; modelId?: string },
  isStudio: boolean,
  studioContext: StudioSessionContext | undefined,
  isAcademy = false,
): SessionConfig['modelRoutingPlan'] | undefined {
  // ① academy 边界：academy 集成 = 非目标（tech spec L20/L266 本期仅 studio/playground）。
  //    academy 会话（isStudio=false）若走 playground 挂载会绕过 classroom 三档模型链 → 直接分支 1。
  if (isAcademy) return undefined;
  // ② 查挂载（每次 run 现拉无 cache）
  const planId = isStudio
    ? (studioContext!.squad as unknown as { modelRoutingPlanId?: string } | undefined)?.modelRoutingPlanId
    : getPlaygroundPlanId(deps.appConfig);
  if (!planId) return undefined;
  // ③ 读方案实体（挂载悬空 = 方案已被删但引用未清 → 分支 1 兜底，不抛）
  const plan = getPlan(deps.appConfig, planId);
  if (!plan) return undefined;
  // ④ 合成候选链
  const explicit = isReservedModelId(sessionPersist.modelId) ? undefined : sessionPersist.modelId;
  let items: RoutingItem[];
  if (explicit !== undefined) {
    // session 显式模型 → providerId 用持久 hint（有则直接用）；否则跨启用 provider 反查。
    // 反查不到（模型不存在/禁用）→ 该显式模型不可用，退化为方案 items 原序（不合成，routing 也会跳过）。
    const providerId = sessionPersist.providerId ?? findProviderIdForModel(deps.appConfig, explicit);
    items = providerId
      ? [synthesizeExplicitItem(providerId, explicit, plan.items), ...plan.items]
      : [...plan.items];
  } else {
    items = [...plan.items];
  }
  // ⑤ 生效熔断参数（默认值填充后；方案 circuit 覆盖缺省用默认）
  // [v0.0.353 T5 D8] 返回带 planName（方案实体已有；logical gen metadata 记录方案名）
  return { planId, planName: plan.name, items, circuit: fillCircuitDefaults(plan.circuit) };
}

/**
 * [v0.0.353 T1 D3] 合成 session 显式模型条目（priority 0 无条件插入候选链首位）。
 * timeCondition 继承：方案内同 providerId+modelId 的启用条目中第一个带时间条件者
 * （显式指定模型 ≠ 绕过该模型的调度时间窗）；无匹配 → 全天（不带 timeCondition）。
 * 参考: specs/tech/version_logs/v0.0.353/model-routing-trace-correctness/change_plan.md D3
 */
function synthesizeExplicitItem(providerId: string, modelId: string, planItems: RoutingItem[]): RoutingItem {
  const inheritFrom = planItems.find(
    (it) =>
      it.providerId === providerId &&
      it.modelId === modelId &&
      isItemEnabled(it) &&
      isItemTimeConditioned(it),
  );
  return {
    providerId,
    modelId,
    priority: 0,
    enabled: true,
    ...(inheritFrom?.timeCondition ? { timeCondition: inheritFrom.timeCondition } : {}),
  };
}

/**
 * [v0.0.347] 跨启用 provider 反查 modelId 所属 providerId（合成 priority 0 用）。
 * @returns providerId | undefined（未命中任何启用 provider 的启用 model）
 */
function findProviderIdForModel(svc: AppConfigService, modelId: string): string | undefined {
  for (const p of listEnabledProviders(svc)) {
    if (Array.isArray(p.models) && p.models.some((m) => m && m.modelId === modelId && m.enabled !== false)) {
      return p.id;
    }
  }
  return undefined;
}

/**
 * [v0.0.347] 分支 2 client 构造：按候选链依次 buildLlmClient，取第一个能成功组装的候选。
 * 方案校验（T1）保证 items 指向 enabled provider 的 enabled model，正常首候选即成功；
 * 循环防御运行时 provider 被删/模型被禁（此时该候选在 routing 也会被跳过）。
 * @returns 首可用候选的 providerId/modelId/client（三者同源对齐；SessionConfig.modelId 显示用）
 */
function buildClientFromCandidates(
  deps: SessionHandlerDeps,
  items: RoutingItem[],
): { providerId: string; modelId: string; client: ReturnType<typeof buildLlmClient> } {
  let lastErr: unknown;
  for (const item of items) {
    try {
      const client = buildLlmClient(item.providerId, item.modelId, deps.appConfig, deps.pluginManager);
      return { providerId: item.providerId, modelId: item.modelId, client };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('model routing plan: no usable candidate to build client');
}

/**
 * 从 deps + session 持久值构造 SessionConfig（共享段，纯函数无副作用）。
 *
 * 组装顺序：
 *   1. providerId/modelId：session 持久 > app_config 默认（chat 单链）
 *   2. client：buildLlmClient(providerId, modelId, appConfig, pluginManager)
 *   3. workdir：session.workspaceDir 优先；缺省回退 <DATA_DIR>/workspace（幂等 mkdir -p）
 *   4. maxIterations：subagent = spawn maxIter；顶层/studio/squad = DEFAULT_MAX_ITERATIONS（agent-loop-lifecycle.ts）
 *   5. tools：SessionTypePolicy.resolveToolSet（profile toolBound ∩ subAgentConfig.tools）
 *
 * @param deps        SessionHandlerDeps（appConfig/pluginManager/dataDir/sessionTypePolicy）
 * @param sessionId   session id
 * @param sessionPersist session 持久化的 providerId/modelId/effort/approvalMode
 * @returns SessionConfig（含 client/workdir/tools/maxIterations）
 * @throws ProviderNotFoundError / ModelNotFoundError / ModelNotConfiguredError（caller 决定 400/500）
 */
export function buildSessionConfigFromDeps(
  deps: SessionHandlerDeps,
  sessionId: string,
  sessionPersist: {
    /**
     * session 持久 providerId（与 modelId 配对作复合 ModelRef）。
     *   作 resolveModel 的 sessionModelId 候选 hint（INV-B1 复合精确匹配）；
     *   缺省（旧 session 无值）→ resolver fallback 跨 provider 反查（back-compat）。
     */
    providerId?: string;
    modelId?: string;
    /**
     * session 持久 effort（canonical 语义键）。
     * 与 providerId/modelId 同类持久字段，由 caller 从 session.effort 透传。
     */
    effort?: 'default' | 'low' | 'high' | 'max';
    /**
     * session 持久 approvalMode（绿灯）。
     * 由 caller 从 session.approvalMode 透传；engine.execute ask 分支直读。
     */
    approvalMode?: 'normal' | 'greenlight';
  },
  /**
   * Session 身份维度统一对象。
   * 由 caller（bootstrap/session-debug）从 getSessionKind(sid) 或
   * 直接 new SessionKind(...) 构造传入。必填。
   * 参数位置前置（必填不能跟在可选后）。
   */
  kind: SessionKind,
  /** session 持久化的 workspaceDir（loop 启动 → SessionConfig.workdir）；缺省回退 <DATA_DIR>/workspace */
  workspaceDir?: string,
  /**
   * session scope（工具可见集维度）。
   * 参考: specs/tech/agent/tools/[P1]agent_tools.md §2.2/§2.3
   * - 缺省/`'session'` → 全集（顶层 standalone / parent session）
   * - `'subagent'` → 排除 agent 工具（subagent 不可再派生）
   * 由 caller 按 session.scope 传入（subagent session 的 messages POST 被 403 拦，但 a2a
   * deliverTo 内部激活也会经此构造 config → scope='subagent' 让 agent-loop 过滤 allowedTools）。
   */
  scope?: 'session' | 'subagent',
  /**
   * subagent 派生配置（spawn 时 eff 持久化；仅 type=subagent 有）。
   * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4
   *
   * 非 undefined 时覆盖默认 systemPrompt/tools/maxIter：
   * - systemPrompt → subAgentConfig.systemPrompt（explorer 人设，非空）
   * - tools → defaultTools(workdir) 按 subAgentConfig.tools 白名单过滤（child 工具集）
   *   [v0.0.222] tools 三态：undefined=继承 subagent profile toolBound（默认）/ []=显式空 / 非空=与 bound 交集
   * - maxIter → subAgentConfig.maxIter（spawn 入参，非 appConfig 默认）
   *
   * 缺省（顶层 session）→ 走空字符串 + defaultTools + appConfig.maxIter。
   *   systemPrompt 空字符串由 system-prompt-builder 在 assemble 覆盖。
   */
  subAgentConfig?: {
    systemPrompt: string; tools?: string[]; skills?: string[]; maxIter: number;
  },
  /**
   * studio 分支配置（[P1]session_config_studio.md §3）。
   * 非 undefined 时按 studio 取法表构造 systemPrompt/tools/skills/modelId/workdir（与 subAgentConfig 互斥）：
   * - systemPrompt = ''（leader/mate，由 builder 覆盖）；squad 用硬编码路由器 prompt
   * - tools = defaultTools(workdir) ∩ member.tools（白名单交集；squad 仅 send_message）
   * - skills = catalog overlay member.skillConfig（见下方 §overlay resolve）
   * - modelId 由 resolveModel 统一 fallback 链解析（PRD 03 §2.1；studio 不读 app_config 默认，见 model-resolver.ts）
   * - workdir 沿用入参 workspaceDir（studio session.workspaceDir 已落 member workspace 路径）
   * 缺省（顶层/subagent）→ 走空字符串 + defaultTools + appConfig.maxIter。
   *   systemPrompt 由 builder 覆盖。
   */
  studioContext?: StudioSessionContext,
  /**
   * SessionContext（实例 ID；与 kind 同构造点产出）。
   * 缺省 undefined = caller 未透传。
   */
  sessionContext?: SessionContext,
  /**
   * [v0.0.210] academyContext（academy system_prompt_mapper 数据源）。
   * 由 caller（bootstrap setResolveConfig 闭包）经 buildAcademyContext 按 role 裁剪装配；
   * 形状对齐 plugin 侧 AcademyContextLike（academy-shared.ts 鸭子类型）。
   * 非 academy session / 缺省 → 不注入（mapper graceful degrade 返空）。
   */
  academyContext?: unknown,
  /**
   * academy classroom 级默认 model（resolver academy 三档链第二档）。
   * 由 caller（bootstrap setResolveConfig 闭包）从 academyContext.classroom.defaultModel
   * 透传（复用已拉实体，零新增 IO）；缺省 undefined → academy 链退化 session → app 默认
   * （session-debug 等次要 caller 可不传）。非 academy session 忽略。
   */
  academyClassroomModel?: { providerId?: string; modelId: string },
): SessionConfig {
  const isStudio = !!studioContext;
  // [v0.0.347] 模型路由 resolve 双分支（D11/D12）：
  //   分支 2（有挂载方案）→ 合成候选链产出 modelRoutingPlan，**不 resolveModel**（不隐式兜底 D4）；
  //   client 用候选链第一个能组装的（routing 运行时按候选换模型，首候选仅作 SessionConfig.client 占位）。
  //   分支 1（无挂载）→ 现有 resolveModel 原链（零改动）。
  const modelRoutingPlan = resolveModelRoutingPlan(
    deps, sessionPersist, isStudio, studioContext, isAcademySessionKind(kind),
  );
  // 1. provider/model 解析（chat/compact 同链）
  //    sessionType 从 kind.biz 派生；studio squad 复合字段（modelDefaultProviderId）作 default 步 hint。
  //    **INV-A1**: resolver 不读 member.model（session 是 model 唯一运行配置读源）。
  //    **INV-A5 收窄**: studio 只读 squad.modelDefault，不再读 squad.summaryModelDefault（已整删）。
  //    @throws ModelNotConfiguredError fallback 链跑完仍无可用 modelId（caller 转 400 错误体）
  const resolved = modelRoutingPlan
    ? null // 分支 2：不 resolveModel（方案优先，不隐式兜底 D4）
    : resolveModel({
        appConfigService: deps.appConfig,
        sessionType:
          kind.biz === 'studio' ? 'studio'
          : kind.biz === 'academy' ? 'academy'
          : 'playground',
        sessionModelId: sessionPersist.modelId,
        sessionProviderId: sessionPersist.providerId, // 复合 hint（INV-B1）
        ...(isStudio && studioContext!.squad !== undefined
          ? {
              squad: studioContext!.squad as {
                modelDefault?: string;
                modelDefaultProviderId?: string;
              },
            }
          : {}),
        // academy 三档链第二档（classroom.defaultModel）；缺省 → 退化 session → app 默认
        ...(kind.biz === 'academy' && academyClassroomModel !== undefined
          ? { classroom: { defaultModel: academyClassroomModel } }
          : {}),
      });
  // 2. 组装 LlmClient（分支 2 用候选链第一个能组装的；分支 1 用 resolveModel 结果）
  // [v0.0.353 T4 根治版] 分支 2 时 SessionConfig.modelId/providerId 取 session 持久口径，
  // 不再取首候选（禁止 run 启动前预选污染 wire body）。builtClient 仅用于取 client 占位
  // + 检测「全候选不可用」，其 modelId 不再作为 SessionConfig.modelId 来源。
  // [v0.0.349] 决策④：全候选 dangling → 降级 throw ModelNotConfiguredError。
  const builtClient = modelRoutingPlan
    ? (() => {
        try {
          return buildClientFromCandidates(deps, modelRoutingPlan.items);
        } catch {
          throw new ModelNotConfiguredError(
            kind.biz === 'studio' ? 'studio' : kind.biz === 'academy' ? 'academy' : 'playground',
            '方案内所有模型不可用（provider 已删除或模型已禁用），请编辑组合方案或检查 provider 配置',
          );
        }
      })()
    : {
        providerId: resolved!.providerId,
        modelId: resolved!.modelId,
        client: buildLlmClient(resolved!.providerId, resolved!.modelId, deps.appConfig, deps.pluginManager),
      };
  const client = builtClient.client;
  // [v0.0.353 T4 根治版] 分支 2 取消启动前预选污染：providerId/modelId 取 session 持久口径；
  // 分支 1 仍使用 resolveModel 结果（resolved.providerId/modelId）。
  const providerId = modelRoutingPlan ? (sessionPersist.providerId ?? '') : resolved!.providerId;
  const modelId = modelRoutingPlan ? (sessionPersist.modelId ?? '') : resolved!.modelId;

  // [v0.0.279] effort 覆盖链解析（与 resolveModel 同处同时机——每次 run 现拉无 cache）：
  //   成员显式档（low/high/max）→ 用之；否则读团队 effortDefault（low/high/max）→ 用之；否则 undefined（厂商默认）。
  //   squad.effortDefault 由 schema（string, required:false）+ PATCH 校验保证合法值，cast 到联合可接受。
  //   参考: PRD D1/D3 + llm_protocol_interface §3.8（'default' 不注入 output_config，encode guard 兜底）
  const resolvedEffort = resolveEffort(
    sessionPersist.effort,
    isStudio && studioContext!.squad !== undefined
      ? (studioContext!.squad.effortDefault as 'default' | 'low' | 'high' | 'max' | undefined)
      : undefined,
  );

  // 3. workdir 接线：优先 session.workspaceDir（spec §1）；缺省/空回退 <DATA_DIR>/workspace
  //    幂等 mkdir（已存在不报错；防外部删后 loop 启动失败）
  const workdir = workspaceDir && workspaceDir.length > 0
    ? workspaceDir
    : join(deps.dataDir, 'workspace');
  try {
    mkdirSync(workdir, { recursive: true });
  } catch {
    // 忽略：已存在或权限等运行时再报
  }

  // 4. maxIterations：subagent = spawn 入参 maxIter；顶层/studio/squad = DEFAULT_MAX_ITERATIONS（agent-loop-lifecycle.ts，无 dev config 覆盖项）
  const maxIterations = subAgentConfig
    ? subAgentConfig.maxIter
    : DEFAULT_MAX_ITERATIONS;

  // 5. resolve skill catalog（四层扫 + 合并；studio overlay / 顶层 enabled 过滤）
  //    arch §7.2：一次 resolve，skills mapper 拼 L0 + skill 工具 lookup 共用。
  //    用 workdir 作 workspace 层（= session.workspaceDir），与 arch §6.3 一致。
  //    传 builtinSkillRoot() → catalog 含随 app 发版的内置 skill
  //    （okf-skill 等），经 studio overlay / 顶层 enabled 过滤启用。
  //  groupDir 第 5 参：group ws 根（squad 共享 ws），经 resolveGroupWsDir 唯一派生
  //    （studio session 的 squadId），resolver 内部派生 `.rocky/skills/`；
  //    playground / subagent 无 group 依赖传 undefined。
  //    合并优先级 group > workspace > app > builtin。
  const enabledStore = new SkillEnabledStore(deps.appConfig);
  const groupDir = resolveGroupWsDir(deps.dataDir, {
    squadId: studioContext?.squadId,
  });
  const catalog = SkillResolver.resolve(deps.dataDir, workdir, enabledStore, builtinSkillRoot(), groupDir);
  // studio 分支 overlay resolve（session_config_studio §3.2）：
  //    读 member.skillConfig（{mode, overrides}）叠加全局 catalog。keep(e)：
  //      ① scope==='workspace'          → 恒保留（R2：team 级约定，不受 switch/快照影响）
  //      ② builtin/app 层：
  //         mode==='custom'  → overrides[e.name] 有记录用快照值；无记录跟全局 e.enabled（R1/R3）
  //         mode==='inherit' → e.enabled（纯继承全局 enabled）
  //    不另扫盘绕过 SkillResolver 已产 catalog；overlay 容忍 overrides 含未知 name（不命中即无 e 可判）。
  //    squad 哑路由器无 member（studioContext.member undefined）→ 无 skills（仅 send_message 路由，与旧 D4 一致）。
  //    顶层/subagent 仅 filter enabled（subagent.skills 不在本层过滤，由 skill enabled policy 管）。
  const skills = isStudio
    ? {
        entries: studioContext!.member
          ? catalog.entries.filter((e) => keepStudioSkill(e, studioContext!.member!.skillConfig))
          : [],
      }
    : { entries: catalog.entries.filter((e) => e.enabled) };

  // 6. tools 解析：全部走 SessionTypePolicy.resolveToolSet（profile yaml 单源驱动）。
  //    参考: specs/tech/agent/tools/[P0]tool_policy.md §4.1（config 层接线）+ §3（resolveToolSet 流程）。
  //    deps.sessionTypePolicy 必填（fail-fast）：生产由 bootstrap 装配注入，测试显式注入 mock/real policy。
  const policy = deps.sessionTypePolicy as SessionTypePolicy | undefined;
  if (!policy) {
    throw new Error(
      'buildSessionConfigFromDeps: deps.sessionTypePolicy 未注入（必填，fail-fast）——生产由 bootstrap 装配注入，测试用 buildRealSessionTypePolicy 或 mock',
    );
  }
  const tools = policy.resolveToolSet(kind, { tools: subAgentConfig?.tools }).tools;

  // 7. systemPrompt 解析（studio / 顶层-subagent 两分支互斥）：
  //    所有分支赋空字符串 ''，由 system-prompt-builder 在 assemble pipeline 跑 mapper 链
  //      产出完整 system prompt（rocky_context builtin 必加载）。
  //    squad router 的 systemPrompt 同 leader/mate 走 '' 占位，由 builder 经 squad_role mapper
  //      注入 squad_chat.md（与 leader.md/mate.md 同链路，对齐架构原则「单一 system prompt 构建链」）。
  //      参考: specs/tech/squad/[P1]prompt_sections.md §3.1（squad_role mapper 含 squad 分支）。
  const systemPrompt = subAgentConfig?.systemPrompt ?? '';

  // llm_request config 装配（llm_caller §3）：
  //   - llmRequestConfig：生效的 retry/timeout/degradation/length/fallbackChain
  //     （record 不存在时 service.get() 返回 DEFAULT_LLM_REQUEST_CONFIG，恒非空）。
  //   - allProviders：全部启用的 provider 实例，供 fallback_chain 非空时 invoke.resolveTarget 查找。
  //     ProviderInstance（响应/落盘形状）与 LlmProviderConfig（invoke 消费形状）字段不完全一致
  //     （前者缺 pluginId + model 侧 modalities/paramConstraints/providerId），故用 `as unknown as`
  //     宽转——空 chain（默认）时 allProviders 不被消费，非空 chain 时 resolveTarget 按 id/credentials/models
  //     取用运行时真值（持久 data 携带完整字段）。
  const llmRequestConfig = new LlmRequestConfigService(deps.appConfig).get();
  const allProviders = listEnabledProviders(deps.appConfig) as unknown as LlmProviderConfig[];

  // 8. 组装 SessionConfig
  return {
    providerId,
    sessionId,
    systemPrompt,
    client,
    modelId,
    tools,
    workdir,
    maxIterations,
    skills,
    // [v0.0.347] 模型路由方案注入（分支 2 才有；分支 1 = undefined → invoke 走现有路径）。
    //   stage-llm 透传 CallLLMInput.routingPlan → InvokeContext.routingPlan → routingAttemptLoop。
    ...(modelRoutingPlan !== undefined ? { modelRoutingPlan } : {}),
    // 生效的 llm_request config + 全部 provider（stage-llm 透传 invoke）。
    llmRequestConfig,
    allProviders,
    // effort 注入（[v0.0.279] resolve 覆盖链后的值：成员显式档 → 团队 effortDefault → undefined 厂商默认；
    //   源头不再直读 session record——encode 层零改动，config.effort 已是 low/high/max/undefined）
    ...(resolvedEffort !== undefined ? { effort: resolvedEffort } : {}),
    // approvalMode 注入（源头唯一 = session record；undefined → engine 走 normal 分支）
    ...(sessionPersist.approvalMode !== undefined ? { approvalMode: sessionPersist.approvalMode } : {}),
    // 注入 pluginManager，供 web_search 等工具读 exclusive EP provider
    pluginManager: deps.pluginManager,
    // web_fetch 读 ctx.config.appConfig 取 web group（jina 配置）。
    // appConfig 字段下方统一注入（web_fetch + memory mapper 配额等多消费方共用同一服务）。
    // 注入 connectorManager（v0.0.266 起 attach 走 InstanceManager；保留注入供 config/UI 消费方兼容）
    connectorManager: deps.connectorManager,
    // 注入 computerNativePort，供 screenshot tool 走主进程截图（去连接器语义）
    computerNativePort: deps.computerNativePort,
    // 注入 browserDriverRegistry（含 PlaywrightDriver），供 web_fetch headless 兜底
    // + browser tool mode=headless/managed-profile 启 driver
    browserDriverRegistry: deps.browserDriverRegistry,
    // [v0.0.264] 注入 browserInstanceManager（headless/managed-profile 常驻实例管理器），
    // browser tool 非 attach 前置校验读（缺省 undefined → 报「未注册」isError）
    browserInstanceManager: deps.browserInstanceManager,
    // scope param 保留为向后兼容，运行时被忽略——
    // subagent agent 工具不可见由 profile playground-rocky:subagent:main toolBound 不含 'agent' 保证）
    // logWriter 注入（dev-logs §3.1/§3.2 hook）：llm 经 stage-llm/forked-agent
    // 透传到 InvokeContext，tool 经 engine.executeOne 取用。缺省 undefined → 不写。
    ...(deps.logWriter !== undefined ? { logWriter: deps.logWriter } : {}),
    dataDir: deps.dataDir, // skill_manage 经 ctx.config.dataDir 读 app 数据根
    // appConfig 注入：web_fetch 读 web group；memory mapper 经 ctx.config.appConfig
    //   读 maxMemoryInject 配额（app_config session 组）。
    appConfig: deps.appConfig,
    // cron 工具运行时依赖（cronStore + engine + sessionStore/squadStore）。
    //   cron 工具（action: create/list/update/disable/enable/delete）经 ctx.config.cronToolDeps 读；
    //   缺省 undefined → cron 工具报 RUNTIME_ERROR（spec [P1]cron_subsystem.md §6）。
    //   由 bootstrap 从 bootScheduler 产出透传到 SessionHandlerDeps.cronToolDeps。
    ...(deps.cronToolDeps !== undefined ? { cronToolDeps: deps.cronToolDeps } : {}),
    // history_search / history_get_context 工具运行时依赖（searchEngine + sessionStore ref）。
    //   两工具经 ctx.config.historyToolDeps 读；缺省 undefined → 两工具报 RUNTIME_ERROR。
    //   由 bootstrap 装配 SearchEngine（driver + titleResolver）后透传到 SessionHandlerDeps.historyToolDeps。
    ...(deps.historyToolDeps !== undefined ? { historyToolDeps: deps.historyToolDeps } : {}),
    // SessionKind：caller 传入的 kind 必填，统一注入。
    kind,
    // SessionContext（实例 ID）
    ...(sessionContext !== undefined ? { sessionContext } : {}),
    // [v0.0.210] academyContext（academy mapper 数据源；与上方 studio 块同模式条件注入）
    ...(academyContext !== undefined ? { academyContext } : {}),
    // studio 5 字段（[P1]session_config_studio.md §2）。
    //    bizType 保留（handler 层 GET /sessions 用）。
    ...(isStudio
      ? {
          bizType: 'studio' as const,
          squadId: studioContext!.squadId,
          ...(studioContext!.memberId !== undefined ? { memberId: studioContext!.memberId } : {}),
          studioContext: {
            squad: studioContext!.squad,
            member: studioContext!.member,
            ...(studioContext!.members !== undefined ? { members: studioContext!.members } : {}),
          },
        }
      : {}),
  };
}

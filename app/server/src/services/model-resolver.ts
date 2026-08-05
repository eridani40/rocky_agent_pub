/**
 * model-resolver — 统一 model resolve 入口
 *
 * 参考:
 *   - specs/tech/agent/providers_and_models/[P0]model_resolve.md §3（chat 单链 fallback 表）+ §4（ModelRef 复合）+ §5（错误）
 *   - specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md 段 A（resolve 简化 + INV-A5 收窄）
 *
 * 设计要点（v0.0.158 简化后）：
 *   - ModelRef = `{providerId?, modelId}` 复合：providerId optional（back-compat 救存量无 providerId 的数据）；
 *     新数据 session/squad 都可携带 providerId 作 hint，resolver 命中时精确匹配。
 *   - chat/compact 同链：resolver 内部只有一条 chat fallback 链，不再区分 summary 子链。
 *     compact/自动 compact/T1 记忆整理全部走同一入口 `agentManager.resolveConfigBySid(sid)`。
 *   - 按 sessionType 分发：playground → app_config.default_models.chat；studio → squad.modelDefault；
 *     academy → 两档链 session → classroom.defaultModel → throw（v0.0.230 收窄：去 app 默认档，群体级无应用层默认概念）。
 *   - 保留字 `default` / `none` / undefined / 空串 = 视为「未手动选，继续 fallback」。
 *   - 具体 modelId 不命中（disabled / not found）= 视为该步未命中继续 fallback。
 *   - 全部 fallback 跑完仍无具体可用 modelId → 抛 ModelNotConfiguredError（HTTP 400 给客户端）。
 *   - default 来源单点出口：`resolveDefaultModel(input)`，按 sessionType 分发（INV-A5 收窄）：
 *       playground → app_config.default_models.chat（仅 chat；summary 字段整删）
 *       studio     → squad.modelDefault（MUST NOT 读 squad.summaryModelDefault，已整删；MUST NOT 读 app_config）
 *   - **INV-A1**: 链中任何分支不再读 `member.model`（v0.0.155 硬删；member 退管理概念，model 跟 session/squad）。
 *   - **INV-A2**: session 是 model 唯一运行配置读源（与 effort/approvalMode 同款）。
 *   - **INV-A5 收窄**: studio 只读 `squad.modelDefault`；MUST NOT 读 app_config；chat/compact 同链。
 *   - **INV-B1/B2**: ModelRef 复合 + providerIdHint 精确；hint 空 fallback 跨 provider（救存量）。
 */
import type { AppConfigService } from '../config/app-config-service';
// 保留字判定复用 model-validation.ts 单一权威（避免双源漂移）。
import { isReservedModelId } from './model-validation';

/** providers 组名（与 handlers/session-deps.ts / model-validation.ts 一致，固定） */
const PROVIDERS_GROUP = 'providers';
/** playground 默认模型 record 所在 group/key（data 形态 {chat?}，纯 modelId string；v0.0.158 删 summary 字段） */
const DEFAULT_MODELS_GROUP = 'default_models';
const DEFAULT_MODELS_KEY = 'default';

/**
 * studio squad 最小结构子集（v0.0.158：删除 summary* 字段族；chat/compact 同链）。
 * providerId optional（back-compat：旧 squad 无此字段，resolver fallback 跨 provider 反查）。
 */
interface SquadLike {
  /** squad 级默认 chat modelId（required in schema，但 here 宽松允许 undefined 测试场景） */
  modelDefault?: string;
  /** modelDefault 的配对 providerId（v0.0.155 复合 ModelRef；optional） */
  modelDefaultProviderId?: string;
}

/** 候选 ModelRef：复合（hint optional）。buildFallbackChain 产出此类型，resolveModel 遍历消费。 */
interface ModelCandidate {
  modelId: string;
  /** 已知则精确匹配该 provider；未知/空 → 跨 provider 反查（back-compat） */
  providerIdHint?: string;
}

/** resolveModel 入参（v0.0.158：删 task 参数 + bodyOverride* 参数；v0.0.204：删 role 死参） */
export interface ResolveModelInput {
  appConfigService: AppConfigService;
  /**
   * session 类型：playground 走 app_config.default_models；studio 仅读 squad；
   * academy 走两档链 session → classroom.defaultModel → throw（v0.0.230 去 app 默认档）。
   */
  sessionType: 'playground' | 'studio' | 'academy';
  /** session.modelId（可能为 'default'/'none'/undefined/具体 modelId） */
  sessionModelId?: string;
  /** session 持久 providerId（v0.0.155：作 sessionModelId 的精确 hint，INV-B1 复合） */
  sessionProviderId?: string;
  /** studio: squad 配置（modelDefault 必填，其余 optional） */
  squad?: SquadLike;
  /**
   * academy: 教室配置（defaultModel = 两档链第二档；复合 ModelRef，providerId 作精确 hint）。
   * 缺省/无 defaultModel → academy 链跑空 → resolveModel 抛 ModelNotConfiguredError
   * （v0.0.230 去 app 默认兜底：群体级无应用层默认概念，与创建链 academy-session-model.ts 语义等价）。
   */
  classroom?: { defaultModel?: { providerId?: string; modelId: string } };
}

/** resolve 输出：含 providerId（hint 命中则 = 输入 hint；hint 空 = 跨 provider 反查命中的首个） */
export interface ResolvedModel {
  providerId: string;
  modelId: string;
}

/**
 * ModelNotConfiguredError — resolve 链跑完仍无可用具体 modelId 时抛。
 *
 * HTTP 映射：400（POST /session/:id/chat / /messages / /run / /compact）。
 * 错误体：`{ code: "MODEL_NOT_CONFIGURED", message, detail: { sessionType } }`
 * （v0.0.158：detail 去 task 字段，chat/compact 同链后不再区分）。
 * UI 据此 toast「请配置模型后再发起会话」+ 跳「应用设置 → 模型」（playground）/「squad 编辑页」（studio）。
 */
export class ModelNotConfiguredError extends Error {
  readonly code = 'MODEL_NOT_CONFIGURED' as const;
  readonly detail: { sessionType: 'playground' | 'studio' | 'academy' };
  constructor(
    sessionType: 'playground' | 'studio' | 'academy',
    message?: string,
  ) {
    super(message ?? '请配置模型后再发起会话');
    this.name = 'ModelNotConfiguredError';
    this.detail = { sessionType };
  }
}

/** 校验用 provider 结构子集（与 model-validation.ts 同形态，避免反向依赖） */
interface ValidationProvider {
  id: string;
  enabled?: boolean;
  models?: { modelId: string; enabled?: boolean }[];
  _deleted?: boolean;
}

/**
 * 取全部启用 provider（过滤 _deleted tombstone + enabled!==false）。
 * 与 model-validation.ts listEnabledProvidersForValidation 同口径，本处保持自包含
 * （避免 service 层反向依赖另一 service helper）。
 */
function listEnabledProviders(svc: AppConfigService): ValidationProvider[] {
  return svc
    .listGroup(PROVIDERS_GROUP)
    .map((r) => r.data as unknown as ValidationProvider)
    .filter(
      (p) =>
        p &&
        !(p as { _deleted?: boolean })._deleted &&
        p.enabled !== false,
    );
}

/** 保留字或空判定：undefined / 空串 / 'default' / 'none' → true（继续 fallback）。
 *  复用 model-validation.ts 单一权威 isReservedModelId，避免双源漂移。 */
const isReservedOrEmpty = isReservedModelId;

/**
 * 跨 enabled providers 查找托管该 modelId 的 provider（INV-B2 双路）。
 *
 * - `providerIdHint` 非空：精确匹配该 provider 的 models（命中 = hint + modelId + model.enabled!==false）；
 *   provider 不存在 / 不含该 modelId / model disabled → 返 null（caller 继续下一候选）。
 * - `providerIdHint` 空：跨 enabled providers 反查首个命中（back-compat：救存量无 providerId 的 session/squad）。
 *
 * 命中 → 返 `{providerId, modelId}`；不命中 → 返 null。
 */
function findProviderForModel(
  svc: AppConfigService,
  modelId: string,
  providerIdHint?: string,
): ResolvedModel | null {
  const enabledProviders = listEnabledProviders(svc);
  // hint 非空 → 精确匹配该 provider（INV-B2）
  if (providerIdHint) {
    const hinted = enabledProviders.find((p) => p.id === providerIdHint);
    if (!hinted) return null;
    const models = Array.isArray(hinted.models) ? hinted.models : [];
    const hit = models.find((m) => m && m.modelId === modelId && m.enabled !== false);
    return hit ? { providerId: hinted.id, modelId: hit.modelId } : null;
  }
  // hint 空 → 跨 provider 反查（back-compat）
  for (const p of enabledProviders) {
    const models = Array.isArray(p.models) ? p.models : [];
    const hit = models.find((m) => m && m.modelId === modelId && m.enabled !== false);
    if (hit) return { providerId: p.id, modelId: hit.modelId };
  }
  return null;
}

/**
 * 读 app_config.default_models.chat（playground 专属；studio MUST NOT 读 — INV-A5）。
 *
 * v0.0.158 简化：只读 chat（summary 字段整删；chat/compact 同链无需再区分 key）。
 */
function readPlaygroundDefault(svc: AppConfigService): string | undefined {
  const dm = svc.get(DEFAULT_MODELS_GROUP, DEFAULT_MODELS_KEY) as
    | { chat?: string }
    | undefined;
  return dm?.chat;
}

/**
 * 统一 default 来源决策（INV-A5 单点出口，v0.0.158 简化）。
 *
 * 按 sessionType 分发：
 *   - playground → 读 `app_config.default_models.chat`（仅此一个来源，MUST NOT 读 squad）
 *   - studio     → 读 `squad.modelDefault`（MUST NOT 读 squad.summaryModelDefault，已整删；
 *                 MUST NOT 读 app_config；MUST NOT 加 app_config fallback）
 *   - academy 不经本函数（default 只有 classroom 一档来源，由 buildFallbackChain 内联 push）
 *
 * 返 ModelCandidate（含 providerIdHint 若 squad 携带复合 providerId）；无可用 default → undefined（caller 决定是否 throw）。
 */
function resolveDefaultModel(input: ResolveModelInput): ModelCandidate | undefined {
  if (input.sessionType === 'playground') {
    const mid = readPlaygroundDefault(input.appConfigService);
    return mid !== undefined ? { modelId: mid } : undefined;
  }
  // studio（squad 配置；不读 app_config — INV-A5）
  const chatMid = input.squad?.modelDefault;
  if (!chatMid) return undefined;
  return {
    modelId: chatMid,
    providerIdHint: input.squad?.modelDefaultProviderId,
  };
}

/**
 * 按 PRD §3 表构建 fallback 候选链（v0.0.158 简化：chat 单链，删 summary 分支）。
 *
 * 链顺序（首个有效命中即用）：
 *   1. playground（chat/compact 同链）: session → resolveDefaultModel(playground=chat)
 *   2. studio（chat/compact 同链；squad/leader/mate 同链）: session → resolveDefaultModel(studio=squad.modelDefault)
 *   3. academy（v0.0.230 收窄）: session → classroom.defaultModel → throw
 *      （两档，任一保留字/不可用继续下探；跑空由 resolveModel 抛 ModelNotConfiguredError。
 *       MUST NOT 下探 app_config.default_models.chat——群体级无应用层默认概念，用户确认；
 *       与创建链 academy-session-model 语义等价）
 *
 * studio 分支完全无 default_models.* 读取（INV-A5）；候选带复合 {modelId, providerIdHint?}（INV-B1）。
 */
function buildFallbackChain(input: ResolveModelInput): ModelCandidate[] {
  const { sessionModelId, sessionProviderId } = input;
  const chain: ModelCandidate[] = [];

  // session 候选（复合：modelId + 持久 providerId hint）
  const sessionCandidate: ModelCandidate | undefined = sessionModelId
    ? { modelId: sessionModelId, ...(sessionProviderId ? { providerIdHint: sessionProviderId } : {}) }
    : undefined;

  if (sessionCandidate) chain.push(sessionCandidate);

  // academy 两档链（不经 resolveDefaultModel：该函数是 playground/studio 二分发，
  //   academy 的 default 只有 classroom 一档来源，直接在此 push；
  //   v0.0.230 收窄：删 app 默认第三档——群体级无应用层默认概念，跑空由 resolveModel 抛错）
  if (input.sessionType === 'academy') {
    const cd = input.classroom?.defaultModel;
    if (cd?.modelId) {
      chain.push({
        modelId: cd.modelId,
        ...(cd.providerId ? { providerIdHint: cd.providerId } : {}),
      });
    }
    return chain;
  }

  const d = resolveDefaultModel(input);
  if (d) chain.push(d);
  return chain;
}

/**
 * 统一 model resolve：按 PRD §3 表 fallback 链分支解析。
 *
 * 行为：
 *   - 遍历 buildFallbackChain 产出的候选 ModelRef 列表
 *   - 跳过保留字 / undefined / 空串
 *   - 对具体 modelId 调 findProviderForModel(svc, modelId, hint?)：命中即返；不命中继续
 *   - 全部候选均未命中 → throw ModelNotConfiguredError
 *
 * @throws ModelNotConfiguredError fallback 链跑完仍无可用 modelId
 */
export function resolveModel(input: ResolveModelInput): ResolvedModel {
  const chain = buildFallbackChain(input);
  for (const candidate of chain) {
    if (isReservedOrEmpty(candidate.modelId)) continue;
    const found = findProviderForModel(
      input.appConfigService,
      candidate.modelId,
      candidate.providerIdHint,
    );
    if (found) return found;
    // 具体 modelId 不命中（hint 精确失败 / 跨 provider 反查失败）→ 继续下一候选
  }
  throw new ModelNotConfiguredError(
    input.sessionType,
    input.sessionType === 'academy'
      ? '教室未配置默认模型，请先在教室设置中选择一个具体模型'
      : undefined,
  );
}

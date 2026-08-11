/**
 * squad handlers — /squad CRUD（POST/GET/GET:id/PATCH/DELETE）。
 * DELETE /squad/:id = team 硬删除（解散）：teardown 停调度 → 删各会话 → 删 record → 删办公室目录
 * （v0.0.111 块②，编排见 squad-dissolve.ts；不留任何潜伏调度/历史）。
 * 参考: specs/api/overall/11a-squad-endpoints.md §1（payload + 响应 + 错误码）
 *       specs/tech/squad/[P1]data_model.md §4（createSquadService 事务）
 * 依赖：SquadHandlerDeps 注入 SessionStore + dataDir + squadRuntime + appConfig（modelDefault 校验）。
 */
import { SquadStore, MemberStore } from '../stores/squad-store';
import type { SquadEntity, MemberEntity } from '../stores/squad-store';
// [v0.0.305] squad 聚合服务（GET /squad 批量聚合）+ 广播器（写路径 broadcast）
import { computeSquadAggregates } from '../squad/squad-aggregate-service';
import type { SquadMetaBroadcaster } from '../squad/squad-meta-broadcaster';
import { createSquadService, type CreateSquadInput } from '../services/squad-service';
import { applyTemplate, TemplateNotFoundError, type MemberSpec } from '../services/squad-template-service';
import { dissolveSquad } from '../squad/squad-dissolve';
import type { SessionStore } from '../agent/session-store';
import type { BudgetUsage } from '../squad/budget/budget-aggregator';
// token 用量聚合查询结果类型（handler port 用）
import type { TokenUsageQueryResult } from '../squad/token-usage/token-usage-aggregator';
// squadTimezone 复用 budget-aggregator 的实现（避免 DEFAULT_TIMEZONE 双写漂移）
import { squadTimezone } from '../squad/budget/budget-aggregator';
// modelDefault/model 写入校验（fail-fast；v0.0.156 A2 拆出到 squad-model-helpers）
import type { AppConfigService } from '../config/app-config-service';
import { checkModel, json } from './squad-model-helpers';

/** SquadRuntime 结构端口（reloadSquad + getScheduler + disposeSquad；UT 可注入 mock） */
export interface SquadRuntimePort {
  reloadSquad(squadId: string): Promise<void>;
  getScheduler(squadId: string): {
    getHistory(limit?: number, roleId?: string): unknown[];
  } | undefined;
  /** [v0.0.111] per-squad 运行时 teardown（team 硬删前置停调度） */
  disposeSquad(squadId: string): Promise<void>;
}

/** BudgetAggregator 结构端口（仅 displayUsage） */
export interface BudgetAggregatorPort {
  displayUsage(squadId: string, now: Date): Promise<BudgetUsage>;
}

/** TokenUsageAggregator 结构端口（query + queryDistinctModels） */
export interface TokenUsageAggregatorPort {
  query(
    squadId: string,
    opts: {
      from?: string;
      to?: string;
      scope?: string;
      granularity?: 'day' | 'hour';
      providerId?: string;
      modelId?: string;
    },
    timezone: string,
  ): TokenUsageQueryResult;

  /** distinct model 列表（前端 model 下拉数据源） */
  queryDistinctModels(
    squadId: string,
    range?: { from?: string; to?: string },
  ): Array<{ providerId: string; modelId: string; label: string }>;
}

/** squad handler 依赖注入集合（router 从 bootstrap 取实例构造） */
export interface SquadHandlerDeps {
  sessionStore: SessionStore;
  dataDir: string;
  squadRuntime?: SquadRuntimePort;
  budgetAggregator?: BudgetAggregatorPort;
  /** token 用量聚合查询（sqlite 未就绪时 undefined → handler 返 503） */
  tokenUsageAggregator?: TokenUsageAggregatorPort;
  /** appConfig：modelDefault 写入校验（v0.0.158 起 summaryModelDefault 已删）。省略时跳过（旧测试不回归） */
  appConfig?: AppConfigService;
  /**
   * [v0.0.305] squad 聚合 meta 广播器（写路径落盘后 broadcast squad_meta_update）。
   * 可选——UT/旧装配无 broadcaster 时 no-op（写路径不受影响）。
   */
  squadMetaBroadcaster?: SquadMetaBroadcaster;
  /**
   * [v0.0.305] MemberStore（squad 聚合计算 listMembers 用）。可选——缺省时内部 new
   * （makeStores 兜底，与既有 handler 自包含惯例一致）。
   */
  memberStore?: MemberStore;
}

/** POST /squad 请求体（11a §1.1 CreateSquadBody；v0.0.155 加 ModelRef 复合 providerId 字段） */
interface CreateSquadBody {
  name?: string;
  description?: string;
  modelDefault?: string;
  /** [v0.0.155] modelDefault 的配对 providerId（复合 ModelRef；optional back-compat） */
  modelDefaultProviderId?: string;
  leader?: { name?: string };
  /** 模板 slug；有值时按模板批量 hire mate + 复制配置文件（§⑤） */
  templateSlug?: string;
  charter?: {
    goals?: string;
    workingStyle?: string;
    collaboration?: string;
    escalation?: string;
  };
}

/** squad 级心跳时间窗口（HH:mm 格式，start<end，不跨 0 点） */
interface HeartbeatWindow {
  start: string;
  end: string;
}

/** squad 级心跳配置（11a §1.4 + specs/tech/squad/[P1]data_model.md §1.1a） */
interface SquadHeartbeatConfig {
  interval: 5 | 15 | 30 | 60;
  activeWindows: HeartbeatWindow[];
  scope: { mode: 'all' | 'whitelist'; memberIds: string[] };
}

/** PATCH /squad/:id 请求体（11a §1.4 PatchSquadBody；v0.0.155 加 ModelRef 复合 providerId 字段） */
interface PatchSquadBody {
  name?: string;
  description?: string;
  modelDefault?: string;
  /** [v0.0.155] modelDefault 配对 providerId；undefined=不修改；""=清空 */
  modelDefaultProviderId?: string;
  /**
   * [v0.0.279] 团队默认推理强度（canonical 语义键 4 档）。
   * undefined=不修改（对齐 modelDefaultProviderId L107 模式）；显式 'default' 也落盘（不清空）。
   */
  effortDefault?: 'default' | 'low' | 'high' | 'max';
  budget?: unknown;
  enableHeartBeat?: boolean;
  /** [v0.0.270] 群聊可见性开关（true/false；undefined=不修改）；缺省=开（存量 squad 无字段读取 ?? true） */
  enableGroupChat?: boolean;
  timezone?: string;
  /** [v0.0.116] squad 级心跳配置；null=清空回默认；undefined=不修改 */
  heartbeatConfig?: SquadHeartbeatConfig | null;
}

/** [v0.0.279] effortDefault 合法值校验（canonical 语义键 4 档） */
function isValidEffortDefault(v: unknown): v is 'default' | 'low' | 'high' | 'max' {
  return v === 'default' || v === 'low' || v === 'high' || v === 'max';
}

/** SquadSummary（11a §1.2 GET /squad 响应项） */
export interface SquadSummary {
  id: string;
  name: string;
  description: string;
  modelDefault: string;
  leaderId: string;
  memberCount: number;
  squadChatSessionId: string;
  enableHeartBeat: boolean;
  /** [v0.0.270] 群聊可见性开关（回显；存量无字段 ?? true=开） */
  enableGroupChat: boolean;
  createdAt: string;
  updatedAt: string;
  /** [v0.0.305] 在线成员数 = member.state==='deployed' 数（与 seats onlineCount 同口径；optional 向后兼容） */
  onlineCount?: number;
  /** [v0.0.305] 工作中 session 数 = squadChat + members 直连 session state∈{running,interrupting,suspended} 数（与 seats 同口径） */
  inProgressCount?: number;
  /** [v0.0.305] 成员最后会话时间 = max(直连 session.updatedAt)；无 session 时 fallback squad.updatedAt（恒有值可排序） */
  lastActiveAt?: string;
}

/** SquadDetail（11a §1.3 GET /squad/:id 响应；v0.0.155 加 ModelRef 复合 providerId 字段回显） */
export interface SquadDetail {
  id: string;
  name: string;
  description: string;
  modelDefault: string;
  /** [v0.0.155] modelDefault 配对 providerId（复合 ModelRef；optional back-compat） */
  modelDefaultProviderId?: string;
  /** [v0.0.279] 团队默认推理强度（回显；存量无字段 ?? 'default'——UI 下拉恒有值） */
  effortDefault: 'default' | 'low' | 'high' | 'max';
  leaderId: string;
  memberIds: string[];
  members: MemberEntity[];
  squadChatSessionId: string;
  budget: unknown;
  enableHeartBeat: boolean;
  /** [v0.0.270] 群聊可见性开关（回显；存量无字段 ?? true=开） */
  enableGroupChat: boolean;
  timezone: string;
  /** [v0.0.116] squad 级心跳配置（null=未配=默认 interval15/全天/all） */
  heartbeatConfig: SquadHeartbeatConfig | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 把 SquadEntity 序列化成 SquadSummary */
function toSummary(s: SquadEntity): SquadSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    modelDefault: s.modelDefault,
    leaderId: s.leaderId,
    memberCount: Array.isArray(s.memberIds) ? s.memberIds.length : 0,
    squadChatSessionId: s.squadChatSessionId,
    enableHeartBeat: s.enableHeartBeat,
    enableGroupChat: s.enableGroupChat ?? true, // [v0.0.270] 存量无字段兜底=开
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** IANA tz 合法性校验（用 Intl 构造检测，非法抛 RangeError） */
function isValidIanaTimezone(tz: string): boolean {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

/** HH:mm 格式正则（零填充，字典序=时间序，便于 start<end 比较） */
const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 合法 interval 枚举 */
const VALID_INTERVALS = new Set([5, 15, 30, 60]);

/**
 * 校验 heartbeatConfig（非 null 时）。
 * 返 null 表合法；返错误字符串则应回 400。
 * 校验矩阵：
 *   - interval ∉ {5,15,30,60} → 400
 *   - activeWindows 每段 start/end 格式错（非 HH:mm）→ 400
 *   - 单段 start >= end → 400（不跨 0 点）
 *   - 段间排序后相邻两两不重叠（prev.end > cur.start 即重叠）→ 400
 *   - scope.mode ∉ {all, whitelist} → 400
 *   - whitelist 时 memberIds 必须为 string[]（不校验存在性）
 */
function validateHeartbeatConfig(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== 'object') return 'heartbeatConfig must be an object';
  const c = cfg as Record<string, unknown>;

  // interval 枚举校验
  if (!VALID_INTERVALS.has(c.interval as number)) {
    return 'heartbeatConfig.interval must be one of 5, 15, 30, 60';
  }

  // activeWindows：格式 + 单段 start<end + 段间不重叠
  if (!Array.isArray(c.activeWindows)) return 'heartbeatConfig.activeWindows must be an array';
  const wins = c.activeWindows as HeartbeatWindow[];
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i]!;
    if (typeof w.start !== 'string' || typeof w.end !== 'string') {
      return `heartbeatConfig.activeWindows[${i}] must have start and end strings`;
    }
    if (!HH_MM_RE.test(w.start) || !HH_MM_RE.test(w.end)) {
      return `heartbeatConfig.activeWindows[${i}] start/end must be HH:mm format`;
    }
    if (w.start >= w.end) {
      return `heartbeatConfig.activeWindows[${i}] start must be before end (no cross-midnight)`;
    }
  }
  // 段间不重叠：排序后相邻检查（prev.end > cur.start = 重叠）
  if (wins.length > 1) {
    const sorted = [...wins].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.end > cur.start) {
        return `heartbeatConfig.activeWindows overlap: [${prev.start}-${prev.end}] and [${cur.start}-${cur.end}]`;
      }
    }
  }

  // scope 校验
  if (!c.scope || typeof c.scope !== 'object') return 'heartbeatConfig.scope required';
  const scope = c.scope as Record<string, unknown>;
  if (scope.mode !== 'all' && scope.mode !== 'whitelist') {
    return 'heartbeatConfig.scope.mode must be "all" or "whitelist"';
  }
  if (!Array.isArray(scope.memberIds)) return 'heartbeatConfig.scope.memberIds must be an array';
  if (scope.mode === 'whitelist') {
    const ids = scope.memberIds as unknown[];
    if (ids.some((id) => typeof id !== 'string')) {
      return 'heartbeatConfig.scope.memberIds must be string[]';
    }
  }

  return null;
}

/** 把 SquadEntity + members 序列化成 SquadDetail（timezone/heartbeatConfig/复合 providerId 必含回显） */
function toDetail(s: SquadEntity, members: MemberEntity[]): SquadDetail {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    modelDefault: s.modelDefault,
    modelDefaultProviderId: s.modelDefaultProviderId,
    effortDefault: (s.effortDefault as 'default' | 'low' | 'high' | 'max' | undefined) ?? 'default', // [v0.0.279] 存量无字段兜底 'default'
    leaderId: s.leaderId,
    memberIds: Array.isArray(s.memberIds) ? s.memberIds : [],
    members,
    squadChatSessionId: s.squadChatSessionId,
    budget: s.budget ?? null,
    enableHeartBeat: s.enableHeartBeat,
    enableGroupChat: s.enableGroupChat ?? true, // [v0.0.270] 存量无字段兜底=开
    timezone: squadTimezone(s),
    heartbeatConfig: (s.heartbeatConfig as SquadHeartbeatConfig | null | undefined) ?? null,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** 内部构造 squad/member store（handler 自包含；[v0.0.305] memberStore 优先用注入实例——聚合计算共用句柄） */
function makeStores(deps: SquadHandlerDeps): { squadStore: SquadStore; memberStore: MemberStore } {
  return {
    squadStore: new SquadStore({ root: deps.dataDir }),
    memberStore: deps.memberStore ?? new MemberStore({ root: deps.dataDir }),
  };
}

/** /squad 路由分发（POST/GET/GET:id/PATCH/DELETE；DELETE=team 硬删除，v0.0.111 块②）。 */
export async function handleSquadRoute(
  req: Request,
  method: string,
  path: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  // /squad（无 id）
  if (path === '/squad') {
    if (method === 'POST') return handleCreateSquad(req, deps);
    if (method === 'GET') return handleListSquads(deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET,POST');
  }
  // /squad/:id（GET/PATCH/DELETE）
  const itemMatch = path.match(/^\/squad\/([^/]+)$/);
  if (itemMatch) {
    const id = itemMatch[1]!;
    if (method === 'GET') return handleGetSquad(id, deps);
    if (method === 'PATCH') return handlePatchSquad(req, id, deps);
    if (method === 'DELETE') return handleDeleteSquad(id, deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET,PATCH,DELETE');
  }
  // 其他 squad 子路径（/squad/:id/member、/squad/:id/charter）由各自 handler 处理，本 handler 不匹配
  return json(404, { error: 'Not Found' });
}

/** POST /squad — 建 squad（事务 8 步 + 补偿回滚，11a §1.1） */
async function handleCreateSquad(req: Request, deps: SquadHandlerDeps): Promise<Response> {
  let body: CreateSquadBody;
  try {
    body = (await req.json()) as CreateSquadBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  // 入参校验（11a §1.1 400）
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid body' });
  if (!body.name || body.name.length === 0) return json(400, { error: 'name required' });
  if (!body.modelDefault || body.modelDefault.length === 0) return json(400, { error: 'modelDefault required' });
  if (!body.leader?.name || body.leader.name.length === 0) return json(400, { error: 'leader.name required' });
  // [v0.0.155] 复合 ModelRef 校验：providerId 非空但对应 modelId 空 → 400
  if (body.modelDefaultProviderId !== undefined && body.modelDefaultProviderId !== '' && !body.modelDefault) {
    return json(400, { error: 'modelDefaultProviderId without modelDefault' });
  }
  // modelDefault 写入校验（fail-fast；v0.0.155 复合：带 providerId hint 精确；v0.0.158 起 summary 单路已删）
  const bad = checkModel(deps.appConfig, body.modelDefault, body.modelDefaultProviderId);
  if (bad) return bad;

  const { squadStore, memberStore } = makeStores(deps);
  try {
    const created = await createSquadService(
      { sessionStore: deps.sessionStore, squadStore, memberStore, dataDir: deps.dataDir, appConfig: deps.appConfig },
      body as CreateSquadInput,
    );
    // 从模板创建：建 squad 成功后批量 hire mate + 复制配置（§⑤）
    // [v0.0.319-fix] 传 leaderMember.id → applyTemplate 补 nameToId['leader'] 映射，
    //   leader.md 才能改名 leader-{memberId}.md（对齐注入扫描约定）
    if (body.templateSlug) {
      try {
        await applyTemplate(deps.dataDir, created.squad.id, body.templateSlug, {
          sessionStore: deps.sessionStore,
          squadStore,
          memberStore,
          dataDir: deps.dataDir,
          ...(deps.appConfig ? { appConfig: deps.appConfig } : {}),
        }, created.leaderMember.id, body.leader.name);
      } catch (e) {
        if (e instanceof TemplateNotFoundError) {
          return json(400, { error: 'template_not_found' });
        }
        // manifest 格式错误或其他 → 400 invalid_template（squad 已建好，不回滚）
        console.warn('[handleCreateSquad] applyTemplate failed (best-effort):', e);
        return json(400, { error: 'invalid_template' });
      }
    }
    // 201 + SquadDetail（11a §1.1；fetch members 给 detail，含模板 hire 的 mate）
    const members = await memberStore.listMembers(created.squad.id);
    // [v0.0.305] 落盘成功后 broadcast 新 squad 聚合（PRD §4.4.2；await 落盘后再调，v0.0.163 race 教训）
    deps.squadMetaBroadcaster?.broadcast(created.squad.id);
    return json(201, toDetail(created.squad, members));
  } catch (e) {
    // 事务失败（已补偿回滚，11a §1.1 500）
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: 'create squad failed', detail: msg });
  }
}

/** GET /squad — 列表（按 updatedAt desc，11a §1.2；[v0.0.305] 合并聚合 3 字段） */
async function handleListSquads(deps: SquadHandlerDeps): Promise<Response> {
  const { squadStore, memberStore } = makeStores(deps);
  const list = await squadStore.listSquads();
  // listSquads 返回 createdAt desc；spec 要求 updatedAt desc，再排一次
  const sorted = list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // [v0.0.305] 批量聚合（一次 listSessions 全量，避免 N+1；单个 squad 失败降级跳过不 500）
  let aggregates: Map<string, { onlineCount: number; inProgressCount: number; lastActiveAt: string }> | null = null;
  try {
    aggregates = await computeSquadAggregates(
      { sessionStore: deps.sessionStore, squadStore, memberStore },
      sorted.map((s) => s.id),
    );
  } catch {
    // 聚合服务异常降级：列表返回无 3 字段（旧行为），不 500
  }
  return json(200, {
    items: sorted.map((s) => {
      const summary = toSummary(s);
      const agg = aggregates?.get(s.id);
      if (agg) {
        summary.onlineCount = agg.onlineCount;
        summary.inProgressCount = agg.inProgressCount;
        summary.lastActiveAt = agg.lastActiveAt;
      }
      return summary;
    }),
  });
}

/** GET /squad/:id — 详情（含 members + charter，11a §1.3） */
async function handleGetSquad(id: string, deps: SquadHandlerDeps): Promise<Response> {
  const { squadStore, memberStore } = makeStores(deps);
  const squad = await squadStore.getSquad(id);
  if (!squad) return json(404, { error: 'squad not found' });
  const members = await memberStore.listMembers(id);
  return json(200, toDetail(squad, members));
}

/** PATCH /squad/:id — 改字段（11a §1.4）。写后 reloadSquad 刷 scheduler；400 字段级优先于 404。 */
async function handlePatchSquad(req: Request, id: string, deps: SquadHandlerDeps): Promise<Response> {
  let body: PatchSquadBody;
  try { body = (await req.json()) as PatchSquadBody; } catch { return json(400, { error: 'invalid json body' }); }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid body' });

  // 字段级校验（400 优先于 404，先于查 squad）
  if (body.budget !== undefined && body.budget !== null) {
    const b = body.budget as { limit?: unknown; window?: unknown; scope?: unknown };
    if (!b || typeof b !== 'object' ||
      typeof b.limit !== 'number' || typeof b.window !== 'string' || typeof b.scope !== 'string') {
      return json(400, { error: 'invalid budget shape' });
    }
    if ((b as { limit: number }).limit < 0) return json(400, { error: 'budget.limit must be >= 0' });
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || body.timezone.length === 0) return json(400, { error: 'timezone must be a non-empty string' });
    if (!isValidIanaTimezone(body.timezone)) return json(400, { error: 'invalid IANA timezone' });
  }
  // [v0.0.116] heartbeatConfig 校验（400 优先于 404）
  if (body.heartbeatConfig !== undefined && body.heartbeatConfig !== null) {
    const hbErr = validateHeartbeatConfig(body.heartbeatConfig);
    if (hbErr) return json(400, { error: hbErr });
  }
  // [v0.0.279] effortDefault 校验（字段级，400 优先于 404，先于查 squad）
  if (body.effortDefault !== undefined && !isValidEffortDefault(body.effortDefault)) {
    return json(400, { error: 'effortDefault must be one of default, low, high, max' });
  }
  // [v0.0.155] 复合 ModelRef 字段级校验（v0.0.158 起 summary 单路已删）：
  //   - 若 PATCH 把 modelDefault 置空但留下 modelDefaultProviderId → 400（不能有 providerId 而无 modelId）
  //   注意：PATCH 单改 providerId（不动 modelDefault）允许——给已配 modelDefault 的 squad 补 providerId
  if (body.modelDefault === '' && body.modelDefaultProviderId !== undefined && body.modelDefaultProviderId !== '') {
    return json(400, { error: 'modelDefaultProviderId without modelDefault' });
  }
  // modelDefault 校验（字段级，400 优先于 404；v0.0.155 复合：带 hint 精确）
  if (body.modelDefault !== undefined) {
    const bad = checkModel(deps.appConfig, body.modelDefault, body.modelDefaultProviderId);
    if (bad) return bad;
  }

  const { squadStore, memberStore } = makeStores(deps);
  const existing = await squadStore.getSquad(id);
  if (!existing) return json(404, { error: 'squad not found' });

  // 剥信封字段（put 不允许 record 自带 createdAt/updatedAt/version）
  const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = existing as unknown as Record<string, unknown>;
  void _ca; void _ua; void _v;
  const patch: Record<string, unknown> = { ...rest };
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.modelDefault !== undefined) patch.modelDefault = body.modelDefault;
  // [v0.0.155] modelDefaultProviderId：undefined=不修改；""=清空；具体值=写入
  if (body.modelDefaultProviderId !== undefined) {
    patch.modelDefaultProviderId = body.modelDefaultProviderId === '' ? undefined : body.modelDefaultProviderId;
  }
  if (body.budget !== undefined) patch.budget = body.budget;
  if (body.enableHeartBeat !== undefined) patch.enableHeartBeat = body.enableHeartBeat;
  if (body.enableGroupChat !== undefined) patch.enableGroupChat = body.enableGroupChat; // [v0.0.270] undefined=不修改
  // [v0.0.279] effortDefault：undefined=不修改；显式 'default' 也落盘（不清空，与 enableGroupChat 模式对称）
  if (body.effortDefault !== undefined) patch.effortDefault = body.effortDefault;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  // [v0.0.116] heartbeatConfig：undefined=不修改；null=清空；合法 object=写入
  if (body.heartbeatConfig !== undefined) patch.heartbeatConfig = body.heartbeatConfig ?? null;

  const updated = await squadStore.putSquad(patch as Parameters<typeof squadStore.putSquad>[0]);
  // 写后刷 scheduler（best-effort，失败不影响持久化）
  if (deps.squadRuntime) {
    try { await deps.squadRuntime.reloadSquad(id); } catch { /* ignore */ }
  }
  const members = await memberStore.listMembers(id);
  return json(200, toDetail(updated, members));
}

/**
 * DELETE /squad/:id — team 硬删除（解散，11a §1.5，v0.0.111 块②）。
 * 校验 squad 存在（不存在 404）→ dissolveSquad 编排（teardown → 删各会话 → 删 record → 删办公室目录）→ 200。
 * 硬删不可逆：member session + 历史消息 + 调度全部物理清除，不留潜伏调度/历史入口。
 */
async function handleDeleteSquad(id: string, deps: SquadHandlerDeps): Promise<Response> {
  const { squadStore } = makeStores(deps);
  const squad = await squadStore.getSquad(id);
  if (!squad) return json(404, { error: 'squad not found' });
  // squadRuntime 生产必注入（router.ts）；缺失时兜底 no-op teardown（不阻断删数据）
  const squadRuntime = deps.squadRuntime ?? { disposeSquad: async () => {} };
  await dissolveSquad({
    squadId: id,
    squadRuntime,
    sessionStore: deps.sessionStore,
    squadStore,
    dataDir: deps.dataDir,
  });
  return json(200, { deleted: true });
}

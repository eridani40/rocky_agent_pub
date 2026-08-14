/**
 * createSquadService — 建 squad 事务（步骤 + 补偿回滚）
 * 参考: states/v0.0.33.1/design.md §4（建 squad 流程）+ §1.5（双向关联）
 *       specs/tech/squad/[P1]data_model.md §2（双向关联）+ §4（createSquadService）
 *       specs/api/overall/11a-squad-endpoints.md §1.1（POST /squad 行为 + 响应）
 *
 * 事务顺序（data_model.md §4）：
 *   1. 生成 squadId + 建 squad record（memberIds=[], enableHeartBeat=false）
 *   2. 建 leader member（role=leader, state=deployed, squadId）
 *   3. 建 leader session（type=leader, bizType=studio, squadId, memberId, parentSessionId=null）
 *   4. 回填 member.sessionId + squad.leaderId
 *   5. 建 squadChat session（type=squad, bizType=studio, squadId, parentSessionId=null）
 *   6. 回填 squad.squadChatSessionId + append squad.memberIds=[leaderId]
 *   7. 建目录骨架（squads/{squadId}/{members,outputs,reports,.rocky/{state,agents}}）
 *   8. 任一步失败 → 补偿删除已建 record + 目录（反向顺序，best-effort）
 *
 * 实现调整（vs design §4 字面顺序）：leaderId/squadChatSessionId/memberIds 在 schema 是 required，
 *   故先把 member/session 全部建好（拿到所有 id），最后一次性建 squad record（含完整关联字段）。
 *   补偿回滚反向：squad → squadChat session → leader session → leader member → 目录。
 *   事务语义与 design §4 一致（任一步失败反向清理），外部观察等价。
 */
import { ulid } from '../config/ulid';
import type { SessionStore } from '../agent/session-store';
import {
  SquadStore, MemberStore,
  ensureSquadDirSkeleton, squadRootDir,
} from '../stores/squad-store';
import type { SquadEntity, MemberEntity } from '../stores/squad-store';
// [v0.0.36] modelDefault 写入校验（fail-fast，救活存量前先挡新增非法）
import type { AppConfigService } from '../config/app-config-service';
import { validateModelId } from './model-validation';

/**
 * 系统本地 IANA 时区（spec [P1]scheduler.md §13：squad timezone 默认 user local）。
 * createSquad 时落库为默认值，避免 scheduler 按 UTC 判 activeWindow 而用户用本地时区生成窗口导致错位不 fire。
 * 取值失败兜底 UTC（防御旧环境 / SSR 无 Intl）。
 */
function systemLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * leader 建队默认 intro（Team Roster 花名册一句话介绍）。
 * 建队时 squad 只有名字，无个性化信息，故用固定职能文案；后续职能变化可通过 PATCH member intro 编辑。
 */
function defaultLeaderIntro(): string {
  return '团队 leader，负责分配任务、与用户（老板）沟通定义目标和路径、评估工作是否完成等';
}

/** createSquadService 入参（11a §1.1 CreateSquadBody + service 用；v0.0.155 加复合 providerId 字段） */
export interface CreateSquadInput {
  name: string;
  description?: string;
  modelDefault: string;
  /** modelDefault 配对 providerId（复合 ModelRef；optional） */
  modelDefaultProviderId?: string;
  // [v0.0.33.3 step3] leader.systemPrompt 移除（身份正文迁 squad_role mapper content fragment）
  leader: { name: string };
}

/** createSquadService 出参（11a §1.1 + data_model §4 返回） */
export interface CreatedSquad {
  squad: SquadEntity;
  leaderMember: MemberEntity;
  leaderSessionId: string;
  squadChatSessionId: string;
}

/**
 * createSquadService 的依赖集合（bootstrap 装配，handler 注入）。
 * dataDir 用于建 workspace 目录 + session.workspaceDir 持久化。
 */
export interface SquadServiceDeps {
  sessionStore: SessionStore;
  squadStore: SquadStore;
  memberStore: MemberStore;
  /** data_dir 绝对路径（建 workspace + 目录骨架用） */
  dataDir: string;
  /**
   * [v0.0.36] AppConfigService——modelDefault/model 写入校验用。
   * 可选：handler 在 prod 始终注入（router 透传 bs.appConfig）；
   *   旧测试/直接调 service 可省略（退化为仅非空校验，向后兼容不回归）。
   */
  appConfig?: AppConfigService;
}

/**
 * 建 squad 事务（步骤 + 补偿回滚，data_model.md §4）。
 *
 * 顺序（实现调整版，见文件头注释）：
 *   a. 生成全部 id（squadId/leaderMemberId/leaderSessionId/squadChatSessionId）
 *   b. 建 leader member（sessionId 暂用占位——为绕过 required，先建 session 拿 id 再 put member）
 *   c. 建 leader session → 回填 member.sessionId
 *   d. 建 squadChat session
 *   e. 建 squad record（leaderId/memberIds/squadChatSessionId 全部就绪）
 *   f. 建目录骨架
 *   失败 → 反向补偿删除已建 record + 目录
 *
 * @throws Error 事务任一步失败（已补偿回滚后抛出原始错误，11a §1.1 500）
 */
export async function createSquadService(
  deps: SquadServiceDeps,
  input: CreateSquadInput,
): Promise<CreatedSquad> {
  const { sessionStore, squadStore, memberStore, dataDir } = deps;

  // ── 0. 入参校验（11a §1.1 400 错误，handler 层也校验，service 兜底）──
  //   [v0.0.33.3 step3] leader.systemPrompt 校验移除（身份正文迁 squad_role mapper）
  if (!input.name || input.name.length === 0) throw new Error('squad name required');
  if (!input.modelDefault || input.modelDefault.length === 0) throw new Error('modelDefault required');
  if (!input.leader?.name || input.leader.name.length === 0) throw new Error('leader.name required');
  // [v0.0.36] modelDefault 合法性校验（fail-fast）：必须是某 enabled provider 的 enabled modelId。
  //   修前仅非空 → UI 自由填名 'claude-sonnet' 等非法值存库 → 激活时 ModelNotFoundError 全崩。
  //   appConfig 注入时才校验（handler prod 必传；旧测试省略退化为非空校验，不回归）。
  //   [v0.0.155] 复合 ModelRef：providerIdHint 非空时精确匹配该 provider（INV-B2/C1）。
  if (deps.appConfig) {
    const v = validateModelId(deps.appConfig, input.modelDefault, input.modelDefaultProviderId);
    if (!v.ok) throw new Error(v.error);
  }

  // ── 1. 生成全部 id（避免 required 字段空值，先算好再建 record）──
  const squadId = ulid();
  const leaderMemberId = ulid();
  const leaderSessionId = ulid();
  const squadChatSessionId = ulid();
  // leader workspace = 团队根（团队 workspace 简化：leader/mate/群聊 session.workspaceDir 统一 squads/{sid}/）
  const leaderWorkspaceDir = squadRootDir(dataDir, squadId);

  // 补偿栈：记录已建的 record/目录，失败时反向清理
  const created: {
    leaderMember?: boolean;
    leaderSession?: boolean;
    squadChatSession?: boolean;
    squad?: boolean;
  } = {};

  try {
    // ── 2. 建 leader session（role=leader, biz=studio, squadId, memberId）──
    //    先建 session 拿 sessionId（member.sessionId required）
    //    [v0.0.33.2 round-3 BUG-3 修] title=leader member name——enrichForInbox 用 session.title
    //    派生 sender.agent.ref.name；修前 studio session 无 title → name 退化 'parent' → 收方按
    //    'parent' 回复（parent 别名对 mate 自解析为 self）→ a2a 自环（mate_peer/leader_mate_collab 断）。
    await sessionStore.createSession({
      id: leaderSessionId,
      role: 'leader',
      biz: 'studio',
      derivation: 'parent',
      squadId,
      memberId: leaderMemberId,
      parentSessionId: undefined, // leader 顶层
      workspaceDir: leaderWorkspaceDir,
      title: input.leader.name,
    });
    created.leaderSession = true;

    // ── 3. 建 squadChat session（role=squad, biz=studio, squadId，无 memberId）──
    //    squadChat 不直接跑 agent（T6 占位），workspaceDir 用 squad 根目录占位
    //    title=squad 名（enrichForInbox 派生 sender name 用，避免退化 'parent'）
    await sessionStore.createSession({
      id: squadChatSessionId,
      role: 'squad',
      biz: 'studio',
      derivation: 'parent',
      squadId,
      memberId: undefined,
      parentSessionId: undefined,
      workspaceDir: squadRootDir(dataDir, squadId),
      title: input.name,
    });
    created.squadChatSession = true;

    // ── 4. 建 leader member（role=leader, state=deployed, sessionId 已就绪）──
    //   [v0.0.33.3 step3] systemPrompt 字段已移除（身份正文迁 squad_role mapper content fragment）
    //   [v0.0.113] leader 默认 skillConfig=inherit（纯继承全局 enabled skill，overlay 无局部覆盖）。
    //     overlay 下 leader 仍可见全局 enabled 的 builtin；角色区分改由
    //     squad_role mapper + tool-policy 保证，不再靠 member skill 白名单（session_config_studio §3.2）。
    const leaderMember = await memberStore.putMember({
      id: leaderMemberId,
      squadId,
      sessionId: leaderSessionId,
      name: input.leader.name,
      // [v0.0.114] leader 默认 intro = 固定职能文案（无用户输入，渲染进 Team Roster）；
      //   后续职能变化可通过 PATCH member intro 编辑。
      intro: defaultLeaderIntro(),
      role: 'leader',
      // [v0.0.48] leader 工具集改 static-by-type 查 tool-policy.ts（resolveTools 不读 member.tools）；
      //   member.tools 现为 dead 字段（schema required，写 [] 占位；session-config/engine/schema 三层均不消费）。
      //   历史：v0.0.33.3 BUG 修曾在此装载 LEADER_DEFAULT_TOOL_NAMES 作「双保险」，T2 接线 resolveTools 后该写入已无功能作用。
      tools: [],
      skillConfig: { mode: 'inherit', overrides: {} },
      state: 'deployed',
    });
    created.leaderMember = true;

    // ── 5. 建 squad record（leaderId/memberIds/squadChatSessionId 全部就绪，design §4 step1 + step4/6 合并）──
    const squad = await squadStore.putSquad({
      id: squadId,
      name: input.name,
      description: input.description ?? '',
      modelDefault: input.modelDefault,
      // [v0.0.155] 复合 ModelRef：modelDefaultProviderId 透传（optional；未传=undefined 走旧 back-compat）
      ...(input.modelDefaultProviderId !== undefined && input.modelDefaultProviderId !== ''
        ? { modelDefaultProviderId: input.modelDefaultProviderId }
        : {}),
      leaderId: leaderMemberId,
      memberIds: [leaderMemberId], // leader 也在 memberIds 内（design §4 step6）
      squadChatSessionId,
      budget: null, // 占位 v4
      enableHeartBeat: false, // 占位 v4（默认 false）
      enableGroupChat: false, // [v0.0.340] 新团队默认关群聊（squad schema required:false；建队显式写 false；存量兜底 handlers/squad.ts ?? true 不受影响）
      // [v0.0.33.4 BUG-001 修] 默认 user local timezone（spec §13）。
      //   修前：entity 无 timezone → scheduler projectSquadSnapshot fallback 'UTC' →
      //   activeWindow（用户本地时区生成）按 UTC 判窗口错位 → multi-squad heartbeat 不 fire（单队因显式 PATCH tz 而漏检）。
      timezone: systemLocalTimezone(),
    });
    created.squad = true;

    // ── 6. 建目录骨架（design §4 step7 + data_model §3）──
    //    幂等 mkdirSync recursive；含 members（store lazy 建，显式预建保骨架完整）
    //    + .rocky/agents 占位（个人差异 AGENTS 文件引导）；不再建 workspaces/{memberId} 个人工位
    ensureSquadDirSkeleton(dataDir, squadId);

    // ── 7. 返回（双向关联已全部就绪；leaderMember 复用 step4 的 put 返回值，免重复读盘）──
    return {
      squad,
      leaderMember,
      leaderSessionId,
      squadChatSessionId,
    };
  } catch (err) {
    // ── 8. 补偿回滚（反向顺序，best-effort；data_model §4 step8）──
    await compensateCreateSquad(
      { squadStore, memberStore, sessionStore },
      { squadId, leaderMemberId, leaderSessionId, squadChatSessionId, created },
    );
    throw err; // 抛原始错误（handler 层返 500）
  }
}

/**
 * 补偿回滚（反向删除已建 record）。
 * 目录骨架不删（mkdirSync 幂等建，残留目录无害；best-effort 策略）。
 * 不抛错（补偿失败仅 console.warn，避免掩盖原始错误）。
 */
async function compensateCreateSquad(
  stores: { squadStore: SquadStore; memberStore: MemberStore; sessionStore: SessionStore },
  ctx: {
    squadId: string;
    leaderMemberId: string;
    leaderSessionId: string;
    squadChatSessionId: string;
    created: { leaderMember?: boolean; leaderSession?: boolean; squadChatSession?: boolean; squad?: boolean };
  },
): Promise<void> {
  const { squadStore, memberStore, sessionStore } = stores;
  // 反向：squad → squadChat session → leader session → leader member
  try {
    if (ctx.created.squad) await squadStore.deleteSquad(ctx.squadId);
  } catch (e) { console.warn('compensate: deleteSquad failed', e); }
  try {
    if (ctx.created.squadChatSession) await sessionStore.deleteSession(ctx.squadChatSessionId);
  } catch (e) { console.warn('compensate: delete squadChat session failed', e); }
  try {
    if (ctx.created.leaderSession) await sessionStore.deleteSession(ctx.leaderSessionId);
  } catch (e) { console.warn('compensate: delete leader session failed', e); }
  try {
    if (ctx.created.leaderMember) await memberStore.deleteMember(ctx.squadId, ctx.leaderMemberId);
  } catch (e) { console.warn('compensate: delete leader member failed', e); }
}

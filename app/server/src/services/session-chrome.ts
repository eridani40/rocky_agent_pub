/**
 * session-chrome — GET /session/:id/chrome 的装饰数据组装（同构 shape + capabilities 静态表）
 * 参考: specs/api/overall/04a-session-chrome.md（权威契约：§2 shape / §3 数据源映射 / §4 capabilities）
 *       specs/tech/app/frontend/[P0]chat_session_assembly.md（前端消费契约）
 *
 * 核心契约（同构承诺）：
 *   - 所有 kind 返回同一响应 shape（字段集恒定）；kind 间差异只体现在字段值，前端零 kind 分支。
 *   - 数据源缺失（squad/classroom 不存在、default 未配）→ 字段降级 null/[]，绝不 throw（装饰语义）。
 *   - 不调 resolveModel：chrome 返原始配置值，不做可用性解析（写路径仍 PUT /session/:id）。
 */
import type { BizType, Role, Derivation } from '@app/shared';
// 保留字判定单一权威（'default'/'none'/空 → sessionModel null）
import { isReservedModelId } from './model-validation';

/** chrome kind 闭合枚举（api 04a §2；派生规则 §3.1） */
export type ChromeKind =
  | 'playground' | 'studio_member' | 'studio_group'
  | 'academy_head' | 'academy_coach' | 'academy_student';

/** 能力开关集（后端唯一权威，前端只消费；api 04a §4） */
export interface SessionCapabilities {
  /** run 态订阅 + 停止按钮（前端据此给 useRunState/useSummary 过 enabled 门） */
  runState: boolean;
  /** 提问卡 + 审批卡透传 */
  hitl: boolean;
  /** 排队区 */
  enqueue: boolean;
  effortPicker: boolean;
  approvalPicker: boolean;
  /** usage 三件套 */
  usage: boolean;
  /** CompactBtn */
  compact: boolean;
  /** ClearBtn + 清空 modal */
  clear: boolean;
  /** 历史 query minimap */
  minimap: boolean;
  /** 右上悬浮菜单 */
  floatMenu: boolean;
  /** 悬浮菜单内定时任务项（false = hideCron） */
  cron: boolean;
  /** 群聊渲染策略（白名单 filter + a2a actor + 窄输入区） */
  groupRender: boolean;
}

/** GET /session/:id/chrome 响应体（api 04a §2；各 kind 同构，字段集恒定） */
export interface SessionChromeView {
  sessionId: string;
  kind: ChromeKind;
  /** derivation==='subagent' → true（只读观察；覆盖层，与 kind 正交） */
  readOnly: boolean;
  /** session.title（titled=false 时仍返原值，前端按 titled 语义显 defaultTitle） */
  title: string;
  titled: boolean;
  /** 身份 tag：studio="squad.name · role|群聊"；academy/playground='' */
  tag: string;
  /** session 持久 model；modelId 空/保留字 → null（picker 显默认态） */
  sessionModel: { providerId: string; modelId: string } | null;
  /** 该 kind 的默认模型（picker「默认模型」项数据源）；未配置 → null */
  defaultModel: { providerId?: string; modelId: string } | null;
  effort: 'default' | 'low' | 'high' | 'max' | null;
  approvalMode: 'normal' | 'greenlight' | null;
  /** studio: squad 全体成员投影（群聊 actor 解析用）；其他 kind 恒 []（同构：字段恒在） */
  members: { id: string; name: string; role: string }[];
  /** studio_member: 对端 member id；其他 kind 无对端 → null */
  memberId: string | null;
  capabilities: SessionCapabilities;
}

/** 全开基线（groupRender=false）；studio_group 在 CAPABILITIES 差异化 */
const ALL_OPEN: SessionCapabilities = {
  runState: true, hitl: true, enqueue: true, effortPicker: true, approvalPicker: true,
  usage: true, compact: true, clear: true, minimap: true, floatMenu: true, cron: true,
  groupRender: false,
};

/**
 * capabilities 静态表（api 04a §4）。
 * - studio_group：关 runState/enqueue/effortPicker/approvalPicker/cron + groupRender=true
 *   （v0.0.152 裁决保持：群聊不放两 picker、无 stop）。
 * - 其余 kind 全开（academy 全开 = 用户拍板 2026-07-29）。
 * - subagent 不单列：readOnly 是覆盖层（前端 readOnly=true 时整体隐藏输入侧）。
 */
export const CAPABILITIES: Record<ChromeKind, SessionCapabilities> = {
  playground: { ...ALL_OPEN },
  studio_member: { ...ALL_OPEN },
  studio_group: {
    ...ALL_OPEN,
    runState: false, enqueue: false, effortPicker: false, approvalPicker: false, cron: false,
    groupRender: true,
  },
  academy_head: { ...ALL_OPEN },
  academy_coach: { ...ALL_OPEN },
  academy_student: { ...ALL_OPEN },
};

/** buildSessionChrome 所需的 session 字段子集（Session 结构子集，UT 可直构 literal） */
export interface ChromeSessionSource {
  id: string;
  title?: string;
  titled?: boolean;
  biz?: BizType;
  role?: Role;
  derivation?: Derivation;
  providerId?: string;
  modelId?: string;
  effort?: 'default' | 'low' | 'high' | 'max';
  approvalMode?: 'normal' | 'greenlight';
  squadId?: string;
  memberId?: string;
  academyClassroomId?: string;
}

/**
 * 数据源依赖（结构子集，与真实 store 结构兼容；classroom.defaultModel 为 json 字段故 unknown）。
 * 独立接口：不复用 SessionHandlerDeps（chrome 专用，防依赖膨胀）。
 */
export interface SessionChromeSources {
  /** app_config 读取（playground defaultModel 数据源） */
  appConfig: { get(group: string, key: string): unknown };
  /** squad 实体读取（studio defaultModel + tag 数据源） */
  squadStore: {
    getSquad(squadId: string): Promise<
      { name?: string; modelDefault?: string; modelDefaultProviderId?: string } | undefined
    >;
  };
  /** squad 成员列表（studio members 投影 + 对端 role 数据源） */
  memberStore: {
    listMembers(squadId: string): Promise<{ id: string; name: string; role: string }[]>;
  };
  /** academy 教室读取（academy defaultModel 数据源） */
  academyStore: {
    getClassroom(classroomId: string): Promise<{ defaultModel?: unknown } | undefined>;
  };
}

/**
 * biz/role → ChromeKind（api 04a §3.1 判定序）。
 * 纯函数：studio 按 role==='squad' 分 group/member；academy 按三 role；其余（含 biz 缺省、
 * academy 非法 role 组合）缺省 playground。readOnly 与 kind 正交（subagent 保留宿主 kind）。
 */
export function deriveChromeKind(session: { biz?: BizType; role?: Role }): ChromeKind {
  if (session.biz === 'studio') {
    return session.role === 'squad' ? 'studio_group' : 'studio_member';
  }
  if (session.biz === 'academy') {
    if (session.role === 'head_teacher') return 'academy_head';
    if (session.role === 'coach') return 'academy_coach';
    if (session.role === 'student') return 'academy_student';
  }
  return 'playground';
}

/** IO 降级包装：数据源读取异常一律视为「缺数据」（chrome 装饰语义，绝不向上 throw） */
async function safeRead<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * 组装 SessionChromeView（api 04a §3.2 数据源映射表）。
 *
 * defaultModel 按 kind 数据源（返原始配置值，不调 resolveModel）：
 *   - playground → app_config.default_models.default.chat（modelId only）
 *   - studio     → squad.modelDefault + modelDefaultProviderId
 *   - academy    → classroom.defaultModel {providerId?, modelId}
 * 数据源缺失 → null/[] 降级；studio 另投影 members + tag。
 */
export async function buildSessionChrome(
  session: ChromeSessionSource,
  deps: SessionChromeSources,
): Promise<SessionChromeView> {
  const kind = deriveChromeKind(session);

  // sessionModel：保留字（'default'/'none'）/空 → null（picker 显默认态）
  const sessionModel = isReservedModelId(session.modelId)
    ? null
    // providerId 缺失（存量数据）降级空串——shape 恒 string，前端跨 provider 反查兜底
    : { providerId: session.providerId ?? '', modelId: session.modelId! };

  let defaultModel: SessionChromeView['defaultModel'] = null;
  let tag = '';
  let members: SessionChromeView['members'] = [];

  if (kind === 'studio_member' || kind === 'studio_group') {
    const squad = session.squadId
      ? await safeRead(() => deps.squadStore.getSquad(session.squadId!))
      : undefined;
    const list = session.squadId
      ? (await safeRead(() => deps.memberStore.listMembers(session.squadId!))) ?? []
      : [];
    members = list.map((m) => ({ id: m.id, name: m.name, role: m.role }));
    if (squad?.modelDefault) {
      defaultModel = {
        modelId: squad.modelDefault,
        ...(squad.modelDefaultProviderId ? { providerId: squad.modelDefaultProviderId } : {}),
      };
    }
    if (squad?.name) {
      if (kind === 'studio_group') {
        tag = `${squad.name} · 群聊`;
      } else {
        // 对端 member 的 role；member 缺失（数据不一致）降级只显 squad 名
        const peer = session.memberId ? list.find((m) => m.id === session.memberId) : undefined;
        tag = peer ? `${squad.name} · ${peer.role}` : squad.name;
      }
    }
  } else if (kind.startsWith('academy_')) {
    const classroom = session.academyClassroomId
      ? await safeRead(() => deps.academyStore.getClassroom(session.academyClassroomId!))
      : undefined;
    const dm = classroom?.defaultModel as { providerId?: string; modelId: string } | undefined;
    if (dm?.modelId) {
      defaultModel = { modelId: dm.modelId, ...(dm.providerId ? { providerId: dm.providerId } : {}) };
    }
  } else {
    // playground：app_config.default_models.default.chat（modelId only）
    const dm = deps.appConfig.get('default_models', 'default') as { chat?: string } | undefined;
    if (dm?.chat) defaultModel = { modelId: dm.chat };
  }

  return {
    sessionId: session.id,
    kind,
    readOnly: session.derivation === 'subagent',
    title: session.title ?? '',
    titled: session.titled === true,
    tag,
    sessionModel,
    defaultModel,
    effort: session.effort ?? null,
    approvalMode: session.approvalMode ?? null,
    members,
    memberId: kind === 'studio_member' ? session.memberId ?? null : null,
    // 浅拷贝防调用方误改静态表
    capabilities: { ...CAPABILITIES[kind] },
  };
}

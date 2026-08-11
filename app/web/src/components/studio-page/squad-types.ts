/**
 * studio-page 共享类型 —— squad / member 实体 + 请求体
 * 参考: specs/api/overall/11a-squad-endpoints.md（§1 Squad / §2 Member 契约）
 *       specs/ui/overall/06-studio.md（Studio view 契约）
 *       specs/ui/components/studio-page/heartbeat-config.md（squad 级配置）
 *
 * UI 不发明实体，直接消费 11a 端点契约的响应 shape。member.role 用 B 方案命名
 * （leader|mate）。本文件只放类型，无运行逻辑。
 */

/**
 * squad 级心跳配置（squad 统一调度，非 per-member）
 * 对齐后端 data_model §1.1a + API 11a §1.4 heartbeatConfig 字段
 */
export interface SquadHeartbeatConfig {
  /** 心跳间隔（分钟，枚举值 5/15/30/60） */
  interval: number;
  /** 工作时间段列表（空=全天可调度） */
  activeWindows: Array<{ start: string; end: string }>; // "HH:mm" 24h
  /** 成员覆盖范围 */
  scope: {
    mode: 'all' | 'whitelist';
    memberIds: string[];
  };
}

/** GET /squad/:id/budget/usage 响应（budget=null 时 limit=-1/remaining=-1） */
export interface BudgetUsage {
  squadId: string;
  limit: number; // -1 = 未配 budget
  window: 'daily';
  consumed: number;
  remaining: number; // <0 表示超限
  windowStart: string;
  windowEnd: string;
  perSession: Array<{ sessionId: string; role: 'leader' | 'mate' | 'squad'; consumed: number }>;
  timezone: string;
}

/** scheduler 历史一条（心跳唤醒历史） */
export interface SchedulerHistoryEntry {
  id: string; // ulid
  squadId: string;
  roleId: string; // member.id
  roleName: string; // member.name（UI 显示）
  at: string; // ISO
  reason: 'heartbeat';
  result: 'fired' | 'skipped_busy' | 'skipped_budget' | 'skipped_window' | 'skipped_killswitch';
  actionSummary?: string;
}

/**
 * 成员 skill 叠加快照配置（形态与后端 MemberSchema.skillConfig 一致）。
 * - mode='inherit'：纯继承全局 skill 配置，无任何局部覆盖（默认新成员）。
 * - mode='custom'：以全局 enabled 为底，overrides 有记录的 skill 用记录值覆盖；
 *     overrides 无记录的 skill（如全局后续新增）跟全局配置（R3）。
 * - overrides：skill name → 是否启用 的局部开关快照（仅治理 builtin/app 层；workspace 层恒生效）。
 */
export interface MemberSkillConfig {
  mode: 'inherit' | 'custom';
  overrides: Record<string, boolean>;
}

/** member 实体（11a §1.3 Member） */
export interface Member {
  id: string;
  squadId: string;
  sessionId: string;
  name: string;
  /** [v0.0.114] 一句话介绍（渲染进 Team Roster；旧 member 可能缺省） */
  intro?: string;
  /** [v0.0.142] 工作方式（仅注入自己个人 session prompt，不进 Team Roster；旧 member 缺省） */
  workStyle?: string;
  /** B 方案命名：leader（不可下岗）| mate（可 deploy/bench） */
  role: 'leader' | 'mate';
  tools: string[];
  /** [v0.0.113] skill 叠加快照（替代旧 skills:string[] 白名单，见 MemberSkillConfig） */
  skillConfig: MemberSkillConfig;
  /**
   * [v0.0.155] member.model 字段已硬删（A4 决策：member 退管理概念）。
   * 运行配置（model/effort/approval）跟 session 走，picker 走 updateSession；member 不持 model。
   * 类型层移除字段；存量后端响应忽略此字段（lazy，无 migration）。
   */
  state: 'deployed' | 'benched';
  benchReason?: string;
  benchedAt?: string;
  /** [v0.0.116] presence 工具写入的当前任务标记（只读回显，来自 presence tool） */
  currentWork?: { text: string; updatedAt: string } | null;
  deriveFrom?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** squad 列表项（11a §1.2 GET /squad → items[]） */
export interface SquadSummary {
  id: string;
  name: string;
  description: string;
  modelDefault: string;
  leaderId: string;
  memberCount: number;
  squadChatSessionId: string;
  enableHeartBeat: boolean;
  /** [v0.0.270] 群聊可见性开关（默认 true=开；false=注入 + UI 入口隐藏） */
  enableGroupChat: boolean;
  createdAt: string;
  updatedAt: string;
  /** [v0.0.305] 在线成员数 = member.state==='deployed' 数（与 seats 同口径；optional 旧后端无字段） */
  onlineCount?: number;
  /** [v0.0.305] 工作中数 = busy session 数（running/interrupting/suspended；optional 旧后端无字段） */
  inProgressCount?: number;
  /** [v0.0.305] 成员最后会话时间 = max(session.updatedAt) ?? squad.updatedAt（optional 旧后端无字段） */
  lastActiveAt?: string;
}

/** squad 详情（11a §1.3 GET /squad/:id → SquadDetail，含 members） */
export interface SquadDetail {
  id: string;
  name: string;
  description: string;
  modelDefault: string;
  /**
   * modelDefault 的配对 providerId（复合 ModelRef）。
   * 后端 response mapper 透传；optional（旧 squad 无此字段 → undefined，picker 读侧 fallback 跨 provider 反查）。
   */
  modelDefaultProviderId?: string;
  /**
   * [v0.0.279] 团队默认推理强度（squad 级 effort default）。
   * 后端 toDetail 回显 ?? 'default' → 恒有值（UI 下拉初始态可直用）。
   */
  effortDefault: 'default' | 'low' | 'high' | 'max';
  leaderId: string;
  memberIds: string[];
  members: Member[];
  squadChatSessionId: string;
  budget?: { limit: number; window: 'daily'; scope: 'team' } | null;
  enableHeartBeat: boolean;
  /** [v0.0.270] 群聊可见性开关（默认 true=开；false=注入 + UI 入口隐藏；server toDetail ?? true 回显） */
  enableGroupChat: boolean;
  /** squad 级心跳配置（null=未配置/使用默认） */
  heartbeatConfig?: SquadHeartbeatConfig | null;
  timezone: string; // IANA，activeWindow + daily 回血都跟它
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /squad 请求体（11a §1.1 CreateSquadBody） */
export interface CreateSquadBody {
  name: string;
  description?: string;
  modelDefault: string;
  /** modelDefault 配对 providerId（复合 ModelRef；optional，back-compat 旧 client 不传） */
  modelDefaultProviderId?: string;
  leader: { name: string };
  /** [v0.0.298] 模板 slug；有值时后端批量 hire mate + 复制配置文件（optional back-compat） */
  templateSlug?: string;
}

/** [v0.0.298] GET /squad-templates → items[] 摘要（11b §1） */
export interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  builtin: boolean;
  memberCount: number;
  /** 预填 leader 名（UI 预填用，来自 manifest.leaderName） */
  leaderName: string;
}

/** PATCH /squad/:id 请求体（11a §1.4） */
export interface PatchSquadBody {
  name?: string;
  description?: string;
  modelDefault?: string;
  /** [v0.0.155] modelDefault 配对 providerId（复合 ModelRef；optional） */
  modelDefaultProviderId?: string;
  budget?: { limit: number; window: 'daily'; scope: 'team' } | null;
  enableHeartBeat?: boolean;
  /** [v0.0.270] 群聊可见性开关（undefined=不改；false=注入 + UI 入口隐藏） */
  enableGroupChat?: boolean;
  /** [v0.0.279] 团队默认推理强度（undefined=不改；显式 'default' 也落盘） */
  effortDefault?: 'default' | 'low' | 'high' | 'max';
  timezone?: string;
  /** [v0.0.116] squad 级心跳配置（undefined=不改/null=清空回默认） */
  heartbeatConfig?: SquadHeartbeatConfig | null;
}

/** POST /squad/:id/member 请求体（11a §2.1，fresh / derive / derive_academy 三选一） */
//   无 tools 字段：leader/mate 工具集 static-by-type 查 tool-policy.ts；
//     旧 client 传 tools 后端 accept-and-ignore + warn（11a §2.1）
//   [v0.0.155] member.model 硬删：不再接受 model 字段（A4）；旧 client 传 model 后端忽略 + warn
//   [v0.0.169] workStyle?：fresh 直传（trim 回写/空串=空串无 400）；derive 默认复制父 workStyle，
//     overrides.workStyle 覆盖（空串=清空）——对齐 §2.2 PATCH 的 v0.0.142 语义
//   [v0.0.210] derive_academy：academySource 三字段必填（classroomId/studentId/versionId，
//     仅 formal+active 版本可派生）+ name 必填；intro/workStyle 可选直传（18-academy.md §5.1）
//   [v0.0.233] derive_academy 加 resolution?（同名裁决：默认全 skip 同名 + 不同名 merge）；
//     resolution 由前端预览面板同名项 toggle 产出（POST /squad/:id/member/derive-academy/preview 拉清单）
/** 同名裁决单项（11a §2.1 + §2.5） */
export interface ResolutionItem {
  name: string;
  action: 'skip' | 'overwrite';
}
/** derive_academy 同名裁决结果（per-item 清单；undefined = 默认全 skip 同名 + 不同名 merge） */
export interface DeriveResolution {
  skills?: ResolutionItem[];
  memory?: ResolutionItem[];
}
export type HireMemberBody =
  | { mode: 'fresh'; name: string; intro: string; workStyle?: string; skillConfig?: MemberSkillConfig }
  | {
      mode: 'derive';
      deriveFrom: string;
      overrides?: { name?: string; intro?: string; workStyle?: string; skillConfig?: MemberSkillConfig };
    }
  | {
      mode: 'derive_academy';
      name: string;
      intro?: string;
      workStyle?: string;
      academySource: { classroomId: string; studentId: string; versionId: string };
      /** [v0.0.233] 同名裁决（undefined = 默认全 skip 同名 + 不同名 merge，向后兼容） */
      resolution?: DeriveResolution;
    };

/** PATCH /squad/:id/member/:mid 请求体（11a §2.2，不可改 role/state/squadId/sessionId） */
//   无 tools 字段（后端 accept-and-ignore + warn，11a §2.2）；
//   intro（一句话介绍）可编辑：提供但 trim 后为空 → 后端 400 intro required
//   [v0.0.113] skills:string[] → skillConfig 整体快照替换
//   [v0.0.155] member.model 硬删：不再接受 model 字段；运行配置跟 session（picker 走 updateSession）
export interface PatchMemberBody {
  name?: string;
  /** [v0.0.114] 一句话介绍（渲染进 Team Roster；提供空串后端 400） */
  intro?: string;
  /** 工作方式（可空，空串=清空回写，无 400——区别于 intro） */
  workStyle?: string;
  skillConfig?: MemberSkillConfig;
}

/**
 * [v0.0.317] SaveBarController —— tab 级 dirty/saving/save/cancel 上推接口
 * ManageTab/AutoworkTab 通过 onSaveBarChange 回调上推给 SeatsPanel，
 * SeatsPanel 据此驱动面板级统一 SaveBar。
 */
export interface SaveBarController {
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
  cancel: () => void;
}

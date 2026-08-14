/**
 * Mention 子系统核心类型
 * 参考: specs/tech/mention/provider-interface.md §1-§3
 *
 * 定义 MentionProvider 接口契约、搜索上下文 SearchCtx、搜索结果 MentionItem，
 * 以及 listView / display 子结构。provider 不感知 session 语义，只看 SearchCtx。
 */
import type { BizType, Role } from '../../../shared/src/types/session-types';
import type { Derivation } from '../../../shared/src/types/session-kind';

/**
 * mention provider 统一契约。
 * 每个 provider 实现一个搜索源（文件 / skill / 未来可扩展）。
 * provider 不感知 session 语义——只接收 SearchCtx（workspaceDir + query + limit/cursor）。
 */
export interface MentionProvider {
  /** provider 唯一标识（如 'file'、'skill'）；前端 tab 切换时传此值 */
  readonly name: string;
  /** provider 显示标签（如 'Files'、'Skills'）；前端 tab 标题 */
  readonly label: string;
  /**
   * 执行搜索。
   * @param ctx 搜索上下文（handler 层从 sessionId 解析）
   * @returns 搜索结果列表（最多 ctx.limit 条）+ 可选分页游标
   */
  search(ctx: SearchCtx): Promise<SearchResult>;
}

/** 搜索结果（含分页游标） */
export interface SearchResult {
  items: MentionItem[];
  /** 分页游标（undefined = 无更多结果） */
  nextCursor?: string;
  /** 是否达搜索上限早停（v0.0.346；handler 响应仅 true 时输出，缺省省略向后兼容） */
  truncated?: boolean;
}

/**
 * 搜索上下文——handler 层从 sessionId 解析后传给 provider。
 * provider 只看 ctx.workspaceDir / ctx.query / ctx.limit / ctx.cursor。
 * biz/role/derivation/memberId/squadId 是审计/过滤用，provider 可选消费。
 */
export interface SearchCtx {
  /** 用户输入的搜索关键词（@ 后文本） */
  query: string;
  /** 分页大小（默认 20，最大 100） */
  limit: number;
  /** 分页游标（首次搜索 undefined） */
  cursor?: string;
  /** 以下由 handler 从 sessionId 解析 */
  /** 业务分区（playground | studio） */
  bizType: BizType;
  /** 会话角色（'rocky'|'leader'|'mate'|'squad'；subagent 存 parent.role bloodline） */
  role: Role;
  /** 派生层级（'main'=顶层；'subagent'=子 agent） */
  derivation: Derivation;
  /** 业务分区（与 bizType 同值，字段名对齐 SessionKind） */
  biz: BizType;
  sessionId: string;
  workspaceDir: string;
  memberId?: string;
  squadId?: string;
  parentSessionId?: string;
}

/**
 * 搜索结果单元。核心 = address（稳定句柄）+ display（呈现快照）双关注点分离。
 * 参考: specs/tech/mention/message-content.md（mention tag 格式 + 持久化自洽 INV-1）
 *       specs/tech/mention/provider-interface.md §3
 */
export interface MentionItem {
  /** 类型标识（'file' | 'skill' | 'workitem' | 'member'，开放枚举） */
  type: string;
  /** 是否为目录条目（file provider 目录命中 true；缺省 = 文件，向后兼容；member/skill/workitem 不设） */
  isDir?: boolean;

  // ─── Address（语义/地址；按 type 不同字段不同） ───
  /**
   * file/skill: 工作路径（file=workspaceDir 下相对路径，POSIX 风格；
   * skill=skill 绝对目录路径）。
   * workitem/member: **不使用此字段**（address 走 `kind`+`id` / `id`）。
   */
  path?: string;
  /** workitem 专属：kind ∈ {goal, kr, requirement, task} */
  kind?: string;
  /** workitem/member 专属：workitem=store 工作项 ID（G-0001/T-0001）；member=memberId ULID */
  id?: string;

  // ─── Display（呈现；前端 pill 唯一渲染依据，序列化进 message tag 持久化） ───
  /**
   * 全类型统一闭集合 `{ icon, label, badge? }`。
   * provider search 时构建——前端零推导、零补全、零二次查询（INV-1）。
   */
  display: MentionItemDisplay;

  /** 列表渲染视图（MentionPopover 结果列表用；与 display 并存，不持久化进 tag） */
  listView: MentionItemListView;
}

/**
 * Display 字段类型。闭集合，不任意扩字段。
 * badge 仅 member role==='leader' 时 'leader'，其余省略。
 */
export interface MentionItemDisplay {
  /** glyph key（前端 Glyph registry 注册的 SVG key） */
  icon: string;
  /** 主文本（不含 @ 前缀；file=basename / skill=name / workitem=title / member=name） */
  label: string;
  /** 徽标（可空；member role==='leader' 时 'leader'，其余省略不传 undefined） */
  badge?: string;
}

/** 列表渲染视图（MentionPopover 结果列表用） */
export interface MentionItemListView {
  /** 主标题（文件名 / skill name / 工作项 title / 成员 name） */
  title: string;
  /** 副标题（文件路径 / skill description / kind · status / role；可选） */
  subtitle?: string;
  /** icon 标识（'file' | 'skill' | 'workitem' kind | 'member'；前端据此渲染对应 icon） */
  icon?: string;
}

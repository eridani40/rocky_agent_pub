/**
 * builtin rocky_context plugin — system_prompt_mapper: agent_profile
 * 参考: specs/tech/agent/context/[P1]agent_profile.md（概念权威：统一 mapper 铁律 + 5 kind a/b/c/d 路径表）
 *       specs/prd/overall/14-prompt-quality-governance.md §14.2.1（d) 自律治理段）
 *
 * 贡献「定义你的 agent」section（stable/480，永不被 budget_truncate 裁）。告诉 agent 四件事：
 *   a) AGENTS.md（团队/个人/课程）在哪、叠加关系、配置状态；
 *   b) memory 用什么工具管、可用 scope（按 biz 渲染）；
 *   c) skills 有哪几层、路径；
 *   d) 自律治理（质量标准）+ 按 biz 渲染的 scope 规则段。
 *
 * 铁律：代码层只有这 1 个 mapper，按 ctx.config.kind 分支计算路径并渲染（禁止拆 kind 模板文件）。
 * 未覆盖 kind（subagent/coach/head_teacher/summary/consolidate）→ 返 []；依赖缺失/异常 → 降级返 []。
 *
 * EP: system_prompt_mapper，priority 480，tier=stable。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { findPersonalAgentsFile } from './context_files';
import {
  AVAILABLE_SCOPES_BY_BIZ,
  renderScopeTableForPrompt,
  resolveBizScopeKind,
} from '../../../../server/src/agent/biz-scope-rules';

/** a) 条单路径行（label + 路径 + 配置状态 + 行尾说明） */
interface AgentsLine {
  label: string;
  filePath: string;
  /** existsSync / 后缀扫描命中 */
  configured: boolean;
  /** true → 未配置标「未配置·可选」；false → 标「未配置」（academy 课程行） */
  optional: boolean;
  note: string;
}

/** c) 条单 skills 层（layerPath=null → builtin 层不渲染绝对路径，只标说明文字） */
interface SkillLayer {
  label: string;
  /** builtin 层 = null（app 安装目录/asar 内，用户不可操作） */
  layerPath: string | null;
}

/** renderAgentProfile 入参（kind 差异已全部算成数据） */
interface AgentProfileInput {
  agentsLines: AgentsLine[];
  /** a) 条尾注（正文注入引导；squad 双份带「团队在前、个人在后」） */
  agentsFooter: string;
  /** b) 条可用 memory scope 列表（按 biz 从 biz-scope-rules 单源派生） */
  memoryScopes: string[];
  /** c) 条 skills 层（高→低，已按 kind 去重合并） */
  skillLayers: SkillLayer[];
  /** d) 段按 biz 渲染的 scope 规则段（biz-scope-rules.renderScopeTableForPrompt 产出） */
  scopeTable: string;
}

/**
 * agent_profile mapper：按 session kind 渲染「定义你的 agent」section。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class AgentProfileMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    try {
      const input = resolveAgentProfileInput(ctx);
      if (!input) return [];
      return [
        {
          id: 'agent_profile',
          tier: 'stable',
          priority: 480,
          content: renderAgentProfile(input),
        },
      ];
    } catch {
      // 单 mapper 失败降级原则（system_prompt §9.4）：任何异常不阻塞 prompt 组装
      return [];
    }
  }
}

/** duck-typed kind 形状（生产 = SessionKind 实例，UT = 纯对象） */
interface KindLike {
  biz?: unknown;
  role?: unknown;
  derivation?: unknown;
  runKind?: unknown;
}

/**
 * 从 ctx.config 算 kind 分支 + 各路径 + 存在性（纯函数；不可覆盖 kind / 缺关键依赖 → null）。
 * 个人文件名 = `{member.name}-{memberId}.md`（缺失回退 `*-{memberId}.md` 后缀锚——member 改名不断链）。
 */
export function resolveAgentProfileInput(ctx: PromptCtx): AgentProfileInput | null {
  const c = ctx.config as {
    kind?: KindLike;
    sessionContext?: { memberId?: unknown };
    memberId?: unknown;
    studioContext?: { member?: { name?: unknown } };
    workdir?: unknown;
    dataDir?: unknown;
  };
  const kind = c.kind;
  if (!kind) return null;
  // 未覆盖 runKind/derivation（subagent/summary/consolidate 保持 prompt 精简）→ 不渲染
  if (kind.derivation !== undefined && kind.derivation !== 'parent') return null;
  if (kind.runKind !== undefined && kind.runKind !== 'main') return null;

  const workdir = typeof c.workdir === 'string' && c.workdir ? c.workdir : null;
  if (!workdir) return null; // 全 kind 渲染都依赖 workdir 路径
  const dataDir = typeof c.dataDir === 'string' && c.dataDir ? c.dataDir : null;

  // skills 层尾部两层（app 层无 dataDir = 层不生效，省略；builtin 不渲染绝对路径）
  const tailLayers: SkillLayer[] = [
    ...(dataDir ? [{ label: 'app', layerPath: path.join(dataDir, 'skills') }] : []),
    { label: 'builtin', layerPath: null },
  ];

  // biz 单源（biz-scope-rules）：memoryScopes + scopeTable 都从同一可用表派生，不在本文件复制
  const biz = resolveBizScopeKind(ctx.config);
  const scopeTable = renderScopeTableForPrompt(biz);
  // studio 场景给 group 加「团队级，全队共享」语义标注；数据来自单源 AVAILABLE_SCOPES_BY_BIZ
  const memoryScopes = AVAILABLE_SCOPES_BY_BIZ[biz].map((s) =>
    biz === 'studio' && s === 'group' ? 'group（团队级，全队共享）' : s,
  );

  if (kind.biz === 'studio' && (kind.role === 'leader' || kind.role === 'mate' || kind.role === 'squad')) {
    // squad 三角色：workdir 已指向团队根 squads/{sid}/（v0.0.232 删个人 ws）
    const agentsLines: AgentsLine[] = [
      {
        label: '团队',
        filePath: path.join(workdir, 'AGENTS.md'),
        configured: fileExists(path.join(workdir, 'AGENTS.md')),
        optional: true,
        note: '全队共享的角色与规则，对全员注入',
      },
    ];
    if (kind.role !== 'squad') {
      // leader/mate 有个人差异行；memberId 缺失（防御）→ 降级同 squad 群聊仅团队行
      const memberId = resolveMemberId(c);
      if (memberId) {
        agentsLines.push(resolvePersonalLine(workdir, memberId, c));
      }
    }
    return {
      agentsLines,
      agentsFooter:
        '正文注入见本 prompt 的「Project Context」片段（团队在前、个人在后，叠加生效）。',
      memoryScopes,
      // workspace 层与 group 层同址（删个人 ws 后都是 {workdir}/.rocky/skills/）→ 合并「团队」一行
      skillLayers: [
        { label: '团队', layerPath: path.join(workdir, '.rocky', 'skills') },
        ...tailLayers,
      ],
      scopeTable,
    };
  }

  if (kind.biz === 'academy' && kind.role === 'student') {
    // academy 学员：仅课程行（workdir = versions/{label}/ws）
    return {
      agentsLines: [
        {
          label: '课程',
          filePath: path.join(workdir, 'AGENTS.md'),
          configured: fileExists(path.join(workdir, 'AGENTS.md')),
          optional: false,
          note: '本课程版本的角色与规则定义',
        },
      ],
      agentsFooter: '正文注入见本 prompt 的「Project Context」片段。',
      memoryScopes,
      skillLayers: [
        { label: 'workspace', layerPath: path.join(workdir, '.rocky', 'skills') },
        ...tailLayers,
      ],
      scopeTable,
    };
  }

  if (kind.biz === 'playground' && kind.role === 'rocky') {
    // playground 个人：仅个人行（无团队行；无 group 层）
    return {
      agentsLines: [
        {
          label: '个人',
          filePath: path.join(workdir, 'AGENTS.md'),
          configured: fileExists(path.join(workdir, 'AGENTS.md')),
          optional: true,
          note: '你的个人角色与规则定义',
        },
      ],
      agentsFooter: '正文注入见本 prompt 的「Project Context」片段。',
      memoryScopes,
      skillLayers: [
        { label: 'workspace', layerPath: path.join(workdir, '.rocky', 'skills') },
        ...tailLayers,
      ],
      scopeTable,
    };
  }

  // 未覆盖 kind（academy coach/head_teacher 等）→ 不渲染
  return null;
}

/** d) 段 4 条质量标准（固定文案，spec §3；scope 规则段由 caller 按 biz 渲染传入） */
const AGENT_PROFILE_D_STANDARDS = [
  '## d) 自律治理（质量标准）',
  '写 AGENTS.md / memory / skill 时遵守：',
  '1. 分层归位：AGENTS.md 只写角色定位与规则；业务流水、过程记录、临时状态下沉 memory 或 outputs 文件，不进角色层。',
  '2. 个人只写差异：个人 AGENTS.md 只写与团队定义不同的部分；团队已有的规则不重复抄写。',
  '3. 描述即路由：skill description / memory intro 是路由语言——写「什么时候该用它」，一句话（≤50 字）；写不好路由就失效。',
  '4. 会删比会写重要：定期清理——过时 memory 归档、失效 skill 禁用、AGENTS.md 保持精简；各 scope 有配额上限（session ≤20 / group ≤30 / global ≤50），写满前先把旧的清掉。',
].join('\n');

/**
 * 渲染「定义你的 agent」section（统一骨架；kind 差异只是数据）。
 * a) 条路径行恒渲染并标状态：已配置｜未配置·可选（温和中性状态，非错误提示）。
 * d) 段 = 4 条质量标准（固定文案）+ 按 biz 渲染的 scope 规则段（biz-scope-rules 单源产出）。
 */
export function renderAgentProfile(input: AgentProfileInput): string {
  const aLines = input.agentsLines.map((l) => {
    const status = l.configured ? '已配置' : l.optional ? '未配置·可选' : '未配置';
    return `- ${l.label} AGENTS.md：${l.filePath}（${status}）——${l.note}`;
  });
  const cLines = input.skillLayers.map(
    (l) => `- ${l.label}：${l.layerPath ?? '内置（随 app 发版，只读）'}`,
  );
  return [
    '# 定义你的 agent',
    '',
    '你可以通过以下方式定义和进化自己：',
    '',
    '## a) System Prompt（AGENTS.md）',
    ...aLines,
    input.agentsFooter,
    '',
    '## b) Memories（长期记忆）',
    `用 memory / memory_manage 工具管理（search/read + 增改归档）。可用 scope：${input.memoryScopes.join(' / ')}。`,
    '已注入条目见「Memories」片段（name+intro，正文按需 memory.read）。',
    '',
    '## c) Skills（技能）',
    `你的 skills 来自 ${input.skillLayers.length} 个位置（高层覆盖低层同名）：`,
    ...cLines,
    '已注入清单见「Skills」片段（每条带 [scope=...] 来源层标注；正文按需 skill.read）。',
    '',
    AGENT_PROFILE_D_STANDARDS,
    '',
    'scope 规则（按本 session 的 biz 渲染可用层）：',
    input.scopeTable,
  ].join('\n');
}

/** memberId：sessionContext（v0.0.204 实例 ID 投影）优先，顶层 legacy 字段兜底 */
function resolveMemberId(c: {
  sessionContext?: { memberId?: unknown };
  memberId?: unknown;
}): string | null {
  const fromCtx = c.sessionContext?.memberId;
  if (typeof fromCtx === 'string' && fromCtx) return fromCtx;
  const legacy = c.memberId;
  return typeof legacy === 'string' && legacy ? legacy : null;
}

/** squad leader/mate 个人差异行：命中后缀扫描 → 已配置+实际路径；否则未配置·可选+引导路径 */
function resolvePersonalLine(
  workdir: string,
  memberId: string,
  c: { studioContext?: { member?: { name?: unknown } } },
): AgentsLine {
  const hit = findPersonalAgentsFile(workdir, memberId);
  const memberName = c.studioContext?.member?.name;
  const guideName =
    typeof memberName === 'string' && memberName
      ? `${memberName}-${memberId}.md`
      : `*-${memberId}.md`;
  return {
    label: '个人',
    filePath: hit ?? path.join(workdir, '.rocky', 'agents', guideName),
    configured: hit !== null,
    optional: true,
    note: '你的差异化定义，叠加在团队定义之上',
  };
}

/** existsSync 包装（读异常视为不存在，不抛） */
function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

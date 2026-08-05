/**
 * team 工具 —— squad 团队成员管理收敛工具（6 action：list/query/hire/deploy/bench/edit）
 * 参考: specs/tech/squad/[P1]squad_tools.md §2（team 工具 action 全表）
 *
 * 设计（squad_tools §1 收敛原则）：同概念合并为单工具 + action 分派，少占 LLM tool slot。
 * 6 action：只读 2（list/query）+ 写 4（hire/deploy/bench/edit）。
 *
 * 权限（squad_tools §2 表）：
 * - 只读 2 action：leader/mate 可调（mate 不能写但能读团队信息）
 * - 写 4 action：leader/user only（mate/subagent → forbidden；standalone=undefined 当 user 允许）
 * - squad session（SquadChat 路由器）/ standalone 无 team 工具（schema 层裁剪 + selfType 校验
 *   defense-in-depth 双重门）
 *
 * 写 action 实现 + 完整 inputSchema 已抽出到 ./team-write-actions.ts：
 * - TEAM_INPUT_SCHEMA = 6 action enum + flat 顶层 properties（LLM 参数契约，§0）
 * - runHire / runDeploy / runBench / runEdit 4 个写 action 函数
 * 本文件只保留 definition + 权限门 + dispatch + 2 只读 action 实现。单文件 ≤300 行。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import { readRuntimeContext } from './runtime-context';
import type { AgentToolRuntimeContext } from './runtime-context';
import { TEAM_INPUT_SCHEMA, runHire, runDeploy, runBench, runEdit } from './team-write-actions';

/** 6 action 集（只读 2 + 写 4；squad_tools §2 全表） */
const TEAM_ACTIONS = ['list', 'query', 'hire', 'deploy', 'bench', 'edit'] as const;
type TeamAction = (typeof TEAM_ACTIONS)[number];
/** 写 action（leader/user only；mate/subagent/squad → forbidden） */
const WRITE_ACTIONS: readonly TeamAction[] = ['hire', 'deploy', 'bench', 'edit'];

/**
 * team 工具（单例导出，registry defaultTools 引用）。
 * 工具 run 时从 ctx.config.agentToolContext 读 runtime context（selfSquadId + store 句柄）。
 */
export const teamTool: Tool = {
  definition: {
    name: 'team',
    description:
      'Team management. action="list" lists squad members (id/name/role/state); ' +
      'action="query" gets single member detail by ref (id or name); ' +
      'action="hire" (mode fresh: name/intro/skillConfig; or derive: deriveFrom/overrides) creates member — leader/user only; ' +
      'action="deploy" (roleId) deploys a benched member — leader/user only; ' +
      'action="bench" (roleId, reason) benches a member — leader/user only; ' +
      'action="edit" (roleId, patch with skillConfig/intro/name) patches member — leader/user only. ' +
      'Read actions available to leader/mate; write actions leader/user only; squad session has no team tool.',
    intro: 'Manage squad team members.',
    inputSchema: TEAM_INPUT_SCHEMA,
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const action = String(input.action ?? '').trim();
    if (!isTeamAction(action)) {
      return errorResult(
        `team: invalid action "${action}" (allows list|query|hire|deploy|bench|edit)`,
      );
    }

    let rtc: AgentToolRuntimeContext;
    try {
      rtc = readRuntimeContext(ctx.config);
    } catch (e) {
      return errorResult(`team: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 权限校验：squad session（SquadChat 路由器）/ standalone 无 team 工具
    // （schema 层裁剪 + 工具层 defense-in-depth 双重门；架构 §2.H + §2.C 改动1）
    if (rtc.selfType === 'squad') {
      return errorResult('team: squad (SquadChat) session cannot use team tool (leader/mate only)');
    }
    if (WRITE_ACTIONS.includes(action as TeamAction)) {
      // 写 action：leader/user only（mate/subagent forbidden；standalone=undefined 当 user 允许）
      const t = rtc.selfType;
      if (t === 'mate' || t === 'subagent') {
        return errorResult(`team.${action}: forbidden (caller selfType=${t}, leader/user only)`);
      }
    } else if (rtc.selfType !== 'leader' && rtc.selfType !== 'mate') {
      // 只读 action：leader/mate 可调
      return errorResult(
        `team: only leader/mate can use team tool (caller selfType=${rtc.selfType ?? 'undefined'})`,
      );
    }

    // squad 上下文完整性：selfSquadId + store 句柄缺一不可
    if (!rtc.selfSquadId || !rtc.squadStore || !rtc.memberStore) {
      return errorResult(
        'team: missing squad context (selfSquadId/squadStore/memberStore not injected)',
      );
    }

    try {
      if (action === 'list') return await runList(rtc);
      if (action === 'query') return await runQuery(input, rtc);
      if (action === 'hire') return await runHire(input, rtc);
      if (action === 'deploy') return await runDeploy(input, rtc);
      if (action === 'bench') return await runBench(input, rtc);
      if (action === 'edit') return await runEdit(input, rtc);
      return errorResult(`team: unhandled action "${action}"`);
    } catch (e) {
      return errorResult(`team.${action}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/** 类型守卫：action 字串是否 ∈ team action 集 */
function isTeamAction(action: string): action is TeamAction {
  return (TEAM_ACTIONS as readonly string[]).includes(action);
}

/** list action：列 caller squad 内全部 member（squad_tools §2 list） */
async function runList(rtc: AgentToolRuntimeContext): Promise<ToolRunResult> {
  const members = await rtc.memberStore!.listMembers(rtc.selfSquadId!);
  const summary = members.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    state: m.state,
  }));
  return textResult(JSON.stringify(summary));
}

/** query action：单 member 详情 by ref（memberId 或 member.name；squad_tools §2 query） */
async function runQuery(input: ToolInput, rtc: AgentToolRuntimeContext): Promise<ToolRunResult> {
  const ref = (input.query as { ref?: unknown } | undefined)?.ref;
  if (typeof ref !== 'string' || ref.length === 0) {
    return errorResult('team.query: ref (memberId or member.name) is required');
  }
  const members = await rtc.memberStore!.listMembers(rtc.selfSquadId!);
  const found = members.filter((m) => m.id === ref || m.name === ref);
  if (found.length === 0) {
    return errorResult(`team.query: no member matches ref "${ref}" in squad`);
  }
  // name 唯一性：a2a §9 待定 #1 强约束（squad 内 name 唯一）；id 自然唯一。
  // 多匹配仅理论可能（id 撞 name 字串）——取首个并附 warning。
  const m = found[0]!;
  // 只读 detail：含 intro（只读身份），不含 tools（dead field，squad_tools §2.2）
  const detail = {
    id: m.id,
    name: m.name,
    role: m.role,
    state: m.state,
    intro: m.intro,
    // member.skills（白名单）已推翻为 skillConfig overlay 快照（{mode, overrides}）
    skillConfig: m.skillConfig,
    sessionId: m.sessionId,
  };
  return textResult(JSON.stringify(detail));
}

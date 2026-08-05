/**
 * skill_manage 工具 — agent 自演化 + skill 市场（create/patch/disable/enable/list/read/search/install）
 * 参考: specs/tech/agent/skills/[P0]skill_manage_tool.md §2 §3 §4 §7.2
 *       specs/tech/agent/skills/[P1]skill_market.md §5/§6（search/install action）
 *
 * 本文件 = tool 定义 + action dispatch + scope 词汇对外 re-export（≤150 行，v0.0.166 拆分）：
 *   - 6 个自演化 action（create/patch/disable/enable/list/read）实现在 skill-manage-actions.ts；
 *   - search / install 两个市场 action 委派到 tools/skill-market/actions.ts（走 exclusive 市场源）。
 *
 * 核心原则（§1, §4）：不审批；evolvable=false 拒 patch/disable/enable；不可 delete（用 disable）；
 *   evolvable 不可被 agent 改（payload 不含 evolvable）；写操作 per-file lock 串行化（§7.2）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, ToolErrorCode } from './types';
import { ROUTING_DECISION_PROMPT } from '../prompts/routing-decision';
import {
  AVAILABLE_SCOPES_BY_BIZ,
  resolveBizScopeKind,
  scopeRequiredErrorText,
  scopeUnavailableErrorText,
} from '../agent/biz-scope-rules';
import { resolveGroupWsDir } from '../agent/group-dir';
import {
  executeCreate, executePatch, executeSetEnabled, executeList, executeRead,
} from './skill-manage-actions';
import { executeMarketSearch, executeMarketInstall } from './skill-market/actions';
import type { AppConfigService } from '../config/app-config-service';

/** 写侧 action 集合（create/patch/disable/enable）：scope 必填 + 按 biz 校验 + groupWsDir 解析 */
const WRITE_ACTIONS = new Set(['create', 'patch', 'disable', 'enable']);

// scope 词汇对外 re-export（保持既有 import 路径不变：skill.ts / 测试从 './skill-manage' 取）
export { toInternalSkillScope, toExternalSkillScope } from './skill-manage-actions';
export type { SkillScopeExternal, SkillManageMeta } from './skill-manage-actions';

/**
 * 写侧 scope 校验：必填 + 按 biz 校验（v0.0.238）。
 * - 缺失 → invalid(scopeRequiredErrorText)
 * - 非法值（非 global/session/group）→ invalid_input
 * - 合法但 biz 不可用 → invalid(scopeUnavailableErrorText)
 */
function checkWriteScope(input: ToolInput, ctx: ToolCtx): true | ToolRunResult {
  const raw = input.scope;
  if (raw === undefined || raw === null || raw === '') {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] ${scopeRequiredErrorText(resolveBizScopeKind(ctx.config))}`);
  }
  if (raw !== 'global' && raw !== 'session' && raw !== 'group') {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] invalid scope "${String(raw)}" (expected global|session|group)`);
  }
  const biz = resolveBizScopeKind(ctx.config);
  if (!AVAILABLE_SCOPES_BY_BIZ[biz].includes(raw)) {
    return errorResult(`[${ToolErrorCode.INVALID_INPUT}] ${scopeUnavailableErrorText(biz, raw)}`);
  }
  return true;
}

/** SkillManage 单例工具（registry.defaultTools 引用） */
export const skillManageTool: Tool = {
  definition: {
    name: 'skill_manage',
    description:
      'Manage skills (self-evolution + marketplace): create / patch / disable / enable / list / read / search / install. ' +
      'Only evolvable=true skills can be patched/disabled/enabled. ' +
      'Cannot delete (use disable instead). list returns all skills including disabled. ' +
      'search finds skills in the configured skill marketplace; install downloads a marketplace skill (by ref) into global scope.\n\n' +
      ROUTING_DECISION_PROMPT + '\n\n' +
      'scope is REQUIRED for create/patch/disable/enable (no default — omitted scope or a scope not available for your biz is rejected with the available list). ' +
      'For skills, "session" means PROJECT-LEVEL (workspace) storage shared across this project\'s ' +
      'sessions and committable to git — it is NOT a single private session. ' +
      '(memory\'s "session" is the truly per-session one.) ' +
      'description (for create/patch) is hard-limited to ≤50 chars; over-limit is rejected.',
    intro: 'Manage skills (create/patch/disable/enable/list) + marketplace search/install.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'patch', 'disable', 'enable', 'list', 'read', 'search', 'install'] },
        name: { type: 'string', description: 'kebab-case skill name (required except for list/search/install)' },
        scope: {
          type: 'string', enum: ['global', 'session', 'group', 'all'],
          description: 'target scope. REQUIRED for create/patch/disable/enable (no default — invalid scope or omitted scope is rejected with the available list). ' +
            'global=shared across all projects; session=this project (workspace, NOT a single session). ' +
            'group=this squad\'s shared skills (auto-resolved from squadId; error [invalid_input] not_in_group if caller not in a group). ' +
            'list also accepts "all".',
        },
        description: { type: 'string', description: '[create/patch] skill description (≤50 chars, hard limit)' },
        body: { type: 'string', description: '[create/patch] SKILL.md body (markdown, no frontmatter). patch = full-text replace.' },
        allowedTools: { type: 'array', items: { type: 'string' }, description: '[create/patch] optional allowed-tools frontmatter' },
        query: { type: 'string', description: '[search] marketplace search query' },
        owner: { type: 'string', description: '[search] optional filter by repository owner' },
        limit: { type: 'number', description: '[search] optional max results' },
        ref: { type: 'string', description: '[install] marketplace skill ref (owner/repo/slug)' },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const action = String(input.action ?? '').trim();
    if (!action) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] action is required`);
    const dataDir = (ctx.config as { dataDir?: string }).dataDir;
    if (!dataDir) return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] ctx.config.dataDir missing (skill_manage requires app data root)`);
    const w = ctx.workdir;
    // 写侧 scope 必填 + 按 biz 校验（O4）；read/list 不收窄
    if (WRITE_ACTIONS.has(action)) {
      const ok = checkWriteScope(input, ctx);
      if (ok !== true) return ok;
    }
    // group ws 解析（squadId → <dataDir>/squads/<squadId>/；无 → undefined，group 寻址由下层 not_in_group 拦）
    const squadId = (ctx.config as { squadId?: unknown }).squadId;
    const groupWsDir = resolveGroupWsDir(dataDir, {
      ...(typeof squadId === 'string' && squadId.trim() ? { squadId } : {}),
    });
    switch (action) {
      // v0.0.247: create 透传 ctx.config.appConfig（读 maxSkillInject* 配额）；
      // 其他 action 不动（executeCreate 仅 create 路径查配额，不变量#1）
      case 'create': return executeCreate(input, dataDir, w, groupWsDir, (ctx.config.appConfig ?? null) as AppConfigService | null);
      case 'patch': return executePatch(input, dataDir, w, groupWsDir);
      case 'disable': return executeSetEnabled(input, dataDir, w, groupWsDir, false);
      case 'enable': return executeSetEnabled(input, dataDir, w, groupWsDir, true);
      case 'list': return executeList(input, dataDir, w, groupWsDir);
      case 'read': return executeRead(input, dataDir, w, groupWsDir);
      case 'search': return executeMarketSearch(input, ctx);
      case 'install': return executeMarketInstall(input, ctx, dataDir, w);
      default: return errorResult(`[${ToolErrorCode.INVALID_INPUT}] unknown action: ${action}`);
    }
  },
};

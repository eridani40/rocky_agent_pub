/**
 * cron agent 工具（单工具，6 action）— 当前 session 自治 cron 管理。
 * 参考: specs/api/overall/16-cron.md §3（inputSchema + 出参 + 错误共通契约）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §6（6 操作表 + sessionId 自动取 ctx.session.id）
 *
 * 设计（仿 browser 工具范式：单工具 + action enum + 平铺参数）：
 *   - 单工具 `cron`，6 个 action：create / list / update / disable / enable / delete
 *   - inputSchema.required: ['action']；其余参数平铺，description 注明适用哪个 action
 *   - run() 解析 input.action → 前置校验 → 调 dispatch(input, ctx, action)
 *   - 与 UI HTTP 完全正交（spec §3.3）：sessionId 自动取 ctx.config.sessionId，tz 自动取
 *     session.timezone → squad.timezone → 进程本地（agent 不传 sessionId/tz）
 *   - 错误统一 isError=true + TextBlock `[cron:<op>] <reason>`（spec §3.1）
 *   - 共享 CronPersistenceAdapter + SchedulerEngine（与 UI HTTP 同底层，互不感知）
 *
 * 文件拆分：run* 实现 + CronToolDeps + helper 在 ./cron-tool-shared.ts（不改，acceptance §1
 *   单文件 ≤300 行约束；本文件仅 Tool 定义 + dispatch + 单例导出）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult } from '../types';
import {
  resolveDeps,
  resolveSessionId,
  runCreate,
  runList,
  runUpdate,
  runToggle,
  runDelete,
} from './cron-tool-shared';

/** cron 工具支持的 6 个 action（与 dispatch op + spec §3 共通契约 1:1）。 */
type CronAction = 'create' | 'list' | 'update' | 'disable' | 'enable' | 'delete';

/** 合法 action 集合（run() 前置校验用）。 */
const VALID_ACTIONS: readonly CronAction[] = [
  'create', 'list', 'update', 'disable', 'enable', 'delete',
];

// ============================================================
// dispatch：取 deps + sessionId → 分流到具体 run*
// ============================================================

/**
 * 公共 dispatch：解析 action → resolveDeps / resolveSessionId 集中错误处理 → 分流到 run*。
 * 错误统一格式 `[cron:<op>] <reason>`（spec §3.1），isError=true。
 *
 * run* 只读各自需要的字段，多余字段（含 action 本身）会被忽略，安全。
 */
async function dispatch(
  input: ToolInput,
  ctx: ToolCtx,
  op: CronAction,
): Promise<ToolRunResult> {
  const deps = resolveDeps(ctx);
  if (!deps) {
    return errorResult(`[cron:${op}] runtime error: cronToolDeps not injected`);
  }
  const sessionId = resolveSessionId(ctx);
  if (!sessionId) {
    return errorResult(`[cron:${op}] runtime error: sessionId missing from ctx.config`);
  }
  switch (op) {
    case 'create': return runCreate(input, deps, sessionId);
    case 'list': return runList(deps, sessionId);
    case 'update': return runUpdate(input, deps, sessionId);
    case 'disable': return runToggle(input, deps, sessionId, false, 'disable');
    case 'enable': return runToggle(input, deps, sessionId, true, 'enable');
    case 'delete': return runDelete(input, deps, sessionId);
  }
}

// ============================================================
// cron 单工具导出（registry 注册 / tool-policy bound 引用名 'cron'）
// ============================================================

/**
 * cron 单工具（仿 browser 范式：单工具 + action enum + 平铺参数）。
 *
 * 6 个 action 与原 6 个独立工具（cron_create/list/update/disable/enable/delete）1:1 等价；
 * run() 解析 input.action → 校验合法 → dispatch 分流。
 */
export const cronTool: Tool = {
  definition: {
    name: 'cron',
    description:
      '当前 session 自治 cron 管理（6 action）。到点以 prompt 作提示词唤醒本 session。' +
      'tz 自动取 session.timezone（agent 不传）。与 UI HTTP 正交（共享底层 persistence/engine）。',
    intro: 'Manage this session\'s scheduled cron jobs.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'update', 'disable', 'enable', 'delete'],
          description:
            'create=新建 cron job / list=列出本 session 全部 jobs / update=改 cron expr·prompt·name ' +
            '（不改 enabled，用 disable/enable）/ disable=禁用 / enable=启用 / delete=永久删',
        },
        cron: {
          type: 'string',
          description: 'action=create/update：5 字段 cron expr（minute-hour-dom-month-dow，不支持 L/W/?/name 别名），如 "*/30 * * * *"（每 30 分钟）/ "0 9 * * 1-5"（工作日 9 点）',
        },
        prompt: {
          type: 'string',
          description: 'action=create/update：到点投递的提示词（任务描述），agent 醒来后据此自主决定做不做',
        },
        name: {
          type: 'string',
          description: 'action=create/update：可选，任务名（缺省 = prompt 前 30 字）',
        },
        enabled: {
          type: 'boolean',
          description: 'action=create：可选，缺省 true',
        },
        jobId: {
          type: 'string',
          description: 'action=update/disable/enable/delete：cron job id（cron list 返回的 id）',
        },
      },
    },
  },
  async run(input, ctx) {
    const action = typeof input.action === 'string' ? input.action : '';
    if (!action) {
      return errorResult('cron: action 必填 (create|list|update|disable|enable|delete)');
    }
    if (!VALID_ACTIONS.includes(action as CronAction)) {
      return errorResult(
        `cron: action 非法 (${action})；合法值 create|list|update|disable|enable|delete`,
      );
    }
    return dispatch(input, ctx, action as CronAction);
  },
};

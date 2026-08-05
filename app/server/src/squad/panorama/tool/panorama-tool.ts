/**
 * panorama 工具 —— 业务全景看板读写收敛工具（action-based，对齐 squad_tools §0）
 * 参考: specs/tech/squad/[P1]panorama_tools.md §1（工具定义）/ §2（action 表）/ §3（权限矩阵）
 *       specs/tech/version_logs/v0.0.189.dsl_board/change_plan.md 模块 5
 *
 * 设计（panorama_tools §0 收敛原则）：单工具 + action 分派，占 1 tool slot。
 * 8 action：只读 3（get_schema/query/events）+ schema 面 1（define）+ 数据面 4（create/update/transition/delete）。
 *
 * 权限（panorama_tools §3 权限矩阵）：
 * - define（schema 面）：仅 leader/user（mate → forbidden）
 * - 数据面（create/update/transition/delete/query/events）+ get_schema：全员
 * - squad session（SquadChat 哑路由）/ standalone 无 squad 语境 → 工具层报缺上下文
 *
 * inputSchema.properties = flat 顶层字段（LLM 参数契约 §0）：handler 读啥 schema 声明啥。
 * 仅 action required；action 专属参数均 optional（必填由 handler 按 action 运行时校验）。
 * 写操作记 lastWriteMessageId（= rtc.currentMessageId，caller 不直传）。
 *
 * 单文件 ≤300 行：definition + run dispatch + 权限门在此；schema 面在 panorama-tool-actions.ts，数据面在 panorama-tool-data-actions.ts。
 */
import type { Tool, ToolInput, ToolRunResult } from '../../../tools/types';
import type { ToolDefinition } from '../../../tools/types';
import { errorResult, textResult } from '../../../tools/types';
import { readRuntimeContext } from '../../../agent/tools/runtime-context';
import type { AgentToolRuntimeContext } from '../../../agent/tools/runtime-context';
import {
  PANORAMA_ACTIONS,
  isPanoramaAction,
  isSchemaAction,
  runDefine, runGetSchema, runEvents,
} from './panorama-tool-actions';
import {
  runCreate, runUpdate, runTransition, runDelete, runQuery,
} from './panorama-tool-data-actions';

/**
 * panorama 工具定义（单工具，占 1 tool slot）。
 * inputSchema flat 顶层 properties = LLM 参数契约（panorama_tools §1）。
 */
export const PANORAMA_TOOL_DEFINITION: ToolDefinition = {
  name: 'panorama',
  description:
    'Business panorama board (DSL-defined kanban/table/chart). ' +
    'action="define" (dsl full YAML, dryRun?, migration?, approved?) — leader/user only; ' +
    'action="get_schema" reads current board.yaml; ' +
    'action="create" (entity, fields{}) / "update" (entity, id, patch{}) / "transition" (entity, id, to); ' +
    'action="delete" (entity, id) removes one instance; ' +
    'action="query" (entity, filter?, sort?, limit?) lists instances; ' +
    'action="events" (since?, limit?) reads event stream. ' +
    'State field changes go through "transition" (update patch on the state field is state-machine validated). ' +
    'Evolution loop: breaking schema changes (delete entity/field, narrow enum, change type) pass directly when no existing data; ' +
    'with existing data define is blocked by a data_safety error — resubmit per the error suggestion: ' +
    'approved:true lets the engine auto-migrate (archive deleted data, clip values, move state values), ' +
    'or attach an explicit migration for full control (narrow_enum requires a value mapping).',
  intro: 'Read/write the squad business panorama board (DSL-defined kanban/table/chart).',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: PANORAMA_ACTIONS.slice(), description: 'panorama action' },
      dsl: { type: 'string', description: 'DSL 全文（YAML），action=define 时必填' },
      dryRun: { type: 'boolean', description: 'action=define 时 true=只校验（含 data_safety 预警）不落盘' },
      migration: { type: 'object', description: '破坏性变更的显式迁移方案 {operations:MigrationOperation[]}；缺省且 approved:true 时引擎自动生成默认操作（archive/clip）；narrow_enum 必须带 mapping' },
      approved: { type: 'boolean', description: '重大变更用户确认标记（true）；data_safety 报错后按 suggestion 重提时带上' },
      entity: { type: 'string', description: '实体名（create/update/transition/delete/query 用）' },
      id: { type: 'string', description: '实例 id（update/transition/delete 用）' },
      fields: { type: 'object', description: '实例字段值（create 用）' },
      patch: { type: 'object', description: '字段补丁（update 用）' },
      to: { type: 'string', description: '目标状态（transition 用）' },
      filter: { type: 'object', description: '查询过滤条件（字段值精确匹配）' },
      sort: { type: 'object', description: '排序条件 {field, order}' },
      limit: { type: 'number', description: '返回上限' },
      since: { type: 'number', description: '事件流起始 seq（不含）' },
    },
  },
};


/**
 * panorama 工具（单例导出，registry defaultTools 引用）。
 * run 时从 ctx.config 读 dataDir + agentToolContext（selfSquadId + currentMessageId + panoramaBus）。
 */
export const panoramaTool: Tool = {
  definition: PANORAMA_TOOL_DEFINITION,

  async run(input: ToolInput, ctx): Promise<ToolRunResult> {
    const action = String(input.action ?? '').trim();
    if (!isPanoramaAction(action)) {
      return errorResult(
        `panorama: invalid action "${action}" (allows ${PANORAMA_ACTIONS.join('|')})`,
      );
    }

    // 从 ctx.config.dataDir 取数据根（skill_manage 等工具同款读法，types.ts ToolSessionConfigLike.dataDir）
    const dataDir = (ctx.config as { dataDir?: string }).dataDir;
    if (!dataDir) {
      return errorResult('panorama: dataDir not injected (session-config 未注入 ctx.config.dataDir)');
    }

    let rtc: AgentToolRuntimeContext;
    try {
      rtc = readRuntimeContext(ctx.config);
    } catch (e) {
      return errorResult(`panorama: ${e instanceof Error ? e.message : String(e)}`);
    }

    // squad 上下文完整性：panorama 仅在有 squad 语境（leader/mate）时可用。
    // squad session（SquadChat 哑路由）/ standalone（无 selfSquadId）→ 报缺上下文。
    if (!rtc.selfSquadId) {
      return errorResult('panorama: missing squad context (selfSquadId not injected — squad session only)');
    }

    // 权限校验（panorama_tools §3）：
    //   define（schema 面）仅 leader/user（mate → forbidden）；standalone=undefined 当 user 允许
    const t = rtc.selfType;
    if (isSchemaAction(action) && t === 'mate') {
      return errorResult(`panorama.${action}: forbidden (caller selfType=mate, schema 面仅 leader/user)`);
    }

    try {
      switch (action) {
        case 'define': return await runDefine(input, rtc, dataDir);
        case 'get_schema': return await runGetSchema(rtc, dataDir);
        case 'create': return await runCreate(input, rtc, dataDir);
        case 'update': return await runUpdate(input, rtc, dataDir);
        case 'transition': return await runTransition(input, rtc, dataDir);
        case 'delete': return await runDelete(input, rtc, dataDir);
        case 'query': return await runQuery(input, rtc, dataDir);
        case 'events': return await runEvents(input, rtc, dataDir);
        default: return errorResult(`panorama: unhandled action "${action}"`);
      }
    } catch (e) {
      return errorResult(`panorama.${action}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

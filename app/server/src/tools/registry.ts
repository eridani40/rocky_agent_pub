/**
 * 工具清单组装（默认工具集）
 * 参考: specs/tech/version_logs/v0.0.8/change_log.md §2.1 §11
 *
 * 职责：把各工具组装成默认 Tool[]，并暴露 ToolDefinition[]（供 assemble → snapshot.tools）。
 *
 * SessionConfig.tools 持有 defaultTools(workdir) 的返回（单一源）。
 */
import type { ToolDefinition } from './types';
import { fileReadTool } from './file-read';
import { fileWriteTool } from './file-write';
import { fileEditTool } from './file-edit';
import { fileGlobTool } from './file-glob';
import { fileGrepTool } from './file-grep';
import { bashTool } from './bash';
// skill 读工具（纯读，progressive disclosure L1）
import { skillTool } from './skill';
// memory 读工具（纯读，progressive disclosure L1：read 单条正文 / search 关键词定位）
// 参考: specs/tech/agent/memory/[P0]memory_tool.md §2 §7
import { memoryTool } from './memory';
// skill_manage 工具（self-evolution：create/patch/disable/enable/list/read）
// 参考: specs/tech/agent/skills/[P0]skill_manage_tool.md §2 §3
import { skillManageTool } from './skill-manage';
// memory_manage 工具（self-evolution：write/archive/list/read 长期记忆）
// 参考: specs/tech/agent/memory/[P0]memory_manage_tool.md §2
import { memoryManageTool } from './memory-manage';
// web_search 工具（query→结构化结果；list EP + app_config 路由）
import { webSearchTool } from './web-search/tool';
// see_image 工具（本地图片路径+文字→视觉理解文字；list EP + app_config 路由，与 web_search 同构）
// 参考: specs/tech/agent/tools/[P1]see_image_tool.md §4
import { seeImageTool } from './see-image/tool';
// browser 工具（chrome 自动化三模式；attach 经 ConnectorManager）
import { browserTool } from './browser/tool';
// web_fetch 工具（抓单 URL → race jina∥本地静态 + headless 兜底，SSRF-guarded）
import { webFetchTool } from './web-fetch/tool';
// agent 工具（spawn/query/abort 单工具 3 action）+ send_message a2a 投递
import { agentTool } from '../agent/tools/agent-tool';
import { sendMessageTool } from '../agent/tools/send-message-tool';
// team 工具（squad 团队成员管理收敛工具：list/query/hire/deploy/bench/edit）
// 参考: specs/tech/squad/[P1]squad_tools.md §2 + 架构 §2.H
import { teamTool } from '../agent/tools/team-tool';
// [v0.0.223] todo 工具（session 级双层待办：主 item + 步骤，状态 free-form）
// 参考: specs/tech/agent/tools/[P1]todo_tools.md §3
import { todoTool } from '../agent/tools/todo-tool';
// cron 工具（单工具 + 6 action：create/list/update/disable/enable/delete）
// 参考: specs/api/overall/16-cron.md §3 + specs/tech/scheduling/[P1]cron_subsystem.md §6
import { cronTool } from './cron/cron-tool';
// ask-question 工具（首个悬挂型 tool，HITL 蓝图首消费者）
// 参考: reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §9/§12/§13
import { askQuestionTool } from './ask-question';
// history_search + history_get_context（read-only，FTS5 历史召回 + 回 transcript 取上下文窗）
// 参考: specs/tech/agent/tools/[P1]history_search_tool.md + [P1]history_get_context_tool.md
import { historySearchTool } from './history-search-tool';
import { historyGetContextTool } from './history-get-context-tool';
// presence 工具（[v0.0.116] 成员当前工作标记，set/clear，leader/mate 可用）
// 参考: specs/tech/squad/[P1]squad_tools.md §6a
import { presenceTool } from '../agent/tools/presence-tool';
// computer use 工具（单 computer tool，action=screenshot/read_ax_tree/click/type/scroll/key，走 ComputerNativePort）
// 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.8
import { COMPUTER_USE_TOOLS } from './computer-use';
// [v0.0.189] panorama 工具（业务全景看板读写，action-based；tool-policy bound studio-leader/studio-mate）
// 参考: specs/tech/squad/[P1]panorama_tools.md §1
import { panoramaTool } from '../squad/panorama/tool/panorama-tool';
// [v0.0.221] manage-task + manage-classroom 工具（academy 板块；manage-student 并入 manage-classroom）
// 参考: specs/tech/academy/[P0]train_student_tool.md §6（注册到 defaultTools）
import { manageTaskTool } from '../agent/tools/train-student-tool';
import { manageClassroomTool } from '../agent/tools/manage-classroom-tool';
import type { Tool } from './types';

/**
 * 组装默认工具集（file×5 + bash + skill + skill_manage + memory（纯读）+ memory_manage +
 * web_search/browser/web_fetch/see_image + agent/send_message + team + cron 单工具 +
 * ask-question + computer）。
 * 注：see_image（本地图片路径+文字→视觉理解文字）注册到默认集，与 web_search 完全
 *     同构（list EP + app_config 路由 + 未配置报错三分支）；可见性由 profile toolBound 收束。
 *     squad 业务工具（team）注册到默认集，可见性由 profile toolBound
 *     + 工具层 selfType 校验双重门控：squad session 仅 send_message；
 *     leader 看 send_message/team；mate 全集（action 级权限在工具层兜底）。
 *     skill_manage + memory_manage 注册到默认集，可见性由 profile toolBound 绑定。
 *     cron 单工具注册到默认集；profile toolBound 仅 playground/leader/mate 绑定（squad/subagent 不绑，
 *     cron_subsystem §11）。
 *     ask-question 注册到默认集（悬挂型 tool，任何 session 可调）；
 *     LLM 决定何时调（schema description 引导「需澄清时用」）。
 * @param _workdir 工作目录（各工具从 ctx.workdir 取，此参数保留以兼容未来按 workdir 配置）
 * @returns 默认 Tool[]
 */
export function defaultTools(_workdir?: string): Tool[] {
  return [
    fileReadTool, fileWriteTool, fileEditTool, fileGlobTool, fileGrepTool, bashTool,
    skillTool, skillManageTool, memoryTool, memoryManageTool,
    webSearchTool, browserTool, webFetchTool,
    // [v0.0.141] see_image（本地图片视觉理解；tool-policy bound 4 角色，注册序紧邻 web_fetch 后）
    seeImageTool,
    agentTool, sendMessageTool,
    teamTool,
    todoTool,
    cronTool,
    askQuestionTool,
    // [v0.0.126] history_search + history_get_context（read-only，tool-policy bound 4 角色）
    historySearchTool, historyGetContextTool,
    // [v0.0.116] presence 工具；tool-policy 仅 bound studio-leader/studio-mate
    presenceTool,
    // [v0.0.105] computer use（单 computer tool）；tool-policy 仅 bound playground-rocky
    ...COMPUTER_USE_TOOLS,
    // [v0.0.189] panorama 工具；tool-policy 仅 bound studio-leader/studio-mate
    panoramaTool,
    // [v0.0.221] manage-task + manage-classroom 工具（academy 板块）
    // - manage-task：coach 专属 task 推进工具（原 train-student 重命名）
    // - manage-classroom：head 教室层工具（20 action，含原 manage-student 9 action 并入）
    // 注册到默认集后，可见性由 profile.toolBound 收束（与 skill_manage 等同模式）。
    manageTaskTool,
    manageClassroomTool,
  ];
}

/**
 * 组装默认工具声明集（config.tools.map(t => t.definition) 的快捷方式）。
 * 供 ContextEngine assemble → snapshot.tools 使用。
 * @param _workdir 工作目录（保留参数）
 * @returns 默认 ToolDefinition[]（与 defaultTools 同长度）
 */
export function defaultToolDefinitions(_workdir?: string): ToolDefinition[] {
  return defaultTools(_workdir).map((t) => t.definition);
}

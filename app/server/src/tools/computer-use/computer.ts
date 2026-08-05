/**
 * computer tool —— 单一 `computer` tool + `action` 参数（11 action，对齐 open-codex 能力集）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.1 A + §B2.8 A（单 tool 收敛设计）
 *
 * 架构：computer use 能力暴露为**单一 1 个 `computer` tool + action 参数**（11 action 是同一 tool 的
 *   不同 action），**非** 多独立 tool。port 层保持分方法粒度不变；tool 层 run() 按 input.action
 *   dispatch 到对应 port method。
 *
 * 11 action（open-codex 9 + 2 省 token 补充）：
 *   读类：get_app_state（图+树，主）/ list_apps / screenshot（纯图）/ read_ax_tree（纯树）
 *   动作类：click / perform_secondary_action / scroll / drag / type_text / press_key / set_value
 *
 * fail-closed 分层（run() 前置统一做，handler 只留「调 port + 包装结果」）：
 *   ① action 非 string / 不在 11 值集 → errorResult（未知 action 引导）
 *   ② ctx.config.computerNativePort undefined → errorResult「仅桌面 App 可用」
 *   ③ ACTION_PERMS[action] 权限门禁（screenshot→screenRecording；get_app_state→双；其余→accessibility）missing → errorResult
 *   ④ switch dispatch 到 action handler → 调 port.<method> → 统一包装
 *
 * 约束：
 *   - **MUST** 走 port 不绕过；**MUST NOT** import electron / native / spawn。
 *   - 单 tool（非多 tool）；仅 bound playground-rocky（tool-policy，控 OS 风险）。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult } from '../types';
import type { ComputerNativePort } from '../../platform/computer/native-port';
import { checkPermissionGate, formatPermissionMissing, type PermissionRequirement } from './permissions';
import { COMPUTER_INPUT_SCHEMA } from './schema';
import { handleScreenshot } from './actions/screenshot';
import { handleGetAppState } from './actions/get-app-state';
import { handleReadAxTree } from './actions/read-ax-tree';
import { handleListApps } from './actions/list-apps';
import { handleClick } from './actions/click';
import { handlePerformSecondaryAction } from './actions/perform-secondary-action';
import { handleScroll } from './actions/scroll';
import { handleDrag } from './actions/drag';
import { handleTypeText } from './actions/type-text';
import { handlePressKey } from './actions/press-key';
import { handleSetValue } from './actions/set-value';

/** 本版本支持的 11 个 action（run() 首步据此校验 action 合法性；对齐 open-codex 原名） */
export const COMPUTER_ACTIONS = [
  'get_app_state',
  'list_apps',
  'screenshot',
  'read_ax_tree',
  'click',
  'perform_secondary_action',
  'scroll',
  'drag',
  'type_text',
  'press_key',
  'set_value',
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/**
 * 各 action 的权限要求（run() 门禁映射）：
 *   - screenshot → 仅屏幕录制（纯像素快照）
 *   - get_app_state → 屏幕录制 + 辅助功能（截图 + AX 树合一，双门禁）
 *   - 其余（list_apps/read_ax_tree/click/perform_secondary_action/scroll/drag/type_text/press_key/set_value）→ 辅助功能
 * 门禁集中在 computer.ts 一处，handler 保持纯（不各自查权限）。
 */
const ACTION_PERMS: Record<ComputerAction, PermissionRequirement> = {
  screenshot: { screenRecording: true },
  get_app_state: { screenRecording: true, accessibility: true },
  list_apps: { accessibility: true },
  read_ax_tree: { accessibility: true },
  click: { accessibility: true },
  perform_secondary_action: { accessibility: true },
  scroll: { accessibility: true },
  drag: { accessibility: true },
  type_text: { accessibility: true },
  press_key: { accessibility: true },
  set_value: { accessibility: true },
};

/** action 合法性 type guard（窄化到 ComputerAction，供 switch 穷尽） */
function isComputerAction(v: unknown): v is ComputerAction {
  return typeof v === 'string' && (COMPUTER_ACTIONS as readonly string[]).includes(v);
}

/**
 * 单 `computer` tool（走 registry defaultTools spread + tool-policy bound 机制，与既有 tool 同范式）。
 */
export const computerTool: Tool = {
  definition: {
    name: 'computer',
    description:
      'Control this Mac desktop: read an app via get_app_state (screenshot + accessibility tree in one ' +
      'call) or the lighter screenshot / read_ax_tree, list running apps, then click / type / scroll / ' +
      'drag / press keys / set values / run secondary AX actions. Choose the operation via the "action" ' +
      'parameter and optionally scope it to an app via "app". Read the screen (get_app_state) before ' +
      'acting, and ask the user before destructive actions. Requires macOS Screen Recording (screenshot / ' +
      'get_app_state) or Accessibility (everything else) permission for Rocky. (computer use)',
    intro: 'Control this Mac desktop (screenshot, click, type, etc.).',
    inputSchema: COMPUTER_INPUT_SCHEMA,
  },

  /**
   * dispatch：校验 action → 读 port → 按 action 权限门禁 → switch 到 handler。
   * @param input 含 action（必填）+ action-specific 参数
   * @param ctx   ToolCtx（读 config.computerNativePort + sessionId）
   */
  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const action = input.action;
    if (!isComputerAction(action)) {
      return errorResult(
        `computer: 未知 action ${JSON.stringify(action)}；有效 action：${COMPUTER_ACTIONS.join(' / ')}。`,
      );
    }
    const port = ctx.config.computerNativePort as ComputerNativePort | undefined;
    if (!port) {
      return errorResult(
        'computer 仅在 Rocky 桌面 App 中可用（当前环境未注入 computer 原生能力）。' +
          'dev 模式需在 dev.env 配置 ROCKY_DEV_COMPUTER_LOOPBACK_PORT 开启原生通道。',
      );
    }
    // 按 action 权限门禁（缺 → 引导文案，不抛）
    const perms = await port.checkPermissions();
    const missing = checkPermissionGate(ACTION_PERMS[action], perms);
    if (missing) {
      return errorResult(formatPermissionMissing(missing));
    }
    switch (action) {
      case 'get_app_state':
        return handleGetAppState(input, port, ctx);
      case 'list_apps':
        return handleListApps(port);
      case 'screenshot':
        return handleScreenshot(input, port, ctx);
      case 'read_ax_tree':
        return handleReadAxTree(input, port);
      case 'click':
        return handleClick(input, port, ctx);
      case 'perform_secondary_action':
        return handlePerformSecondaryAction(input, port);
      case 'scroll':
        return handleScroll(input, port, ctx);
      case 'drag':
        return handleDrag(input, port, ctx);
      case 'type_text':
        return handleTypeText(input, port);
      case 'press_key':
        return handlePressKey(input, port);
      case 'set_value':
        return handleSetValue(input, port);
    }
  },
};

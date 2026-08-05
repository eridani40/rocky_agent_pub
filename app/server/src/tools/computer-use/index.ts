/**
 * computer-use 工具集桶导出（registry defaultTools spread）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.8 A/B
 *
 * 单一 `computer` tool（11 action 收敛为其 action：get_app_state / list_apps / screenshot /
 *   read_ax_tree / click / perform_secondary_action / scroll / drag / type_text / press_key / set_value）。
 * 底层 port 分方法粒度不变（tool→action→port method 见 computer.ts）。
 */
import type { Tool } from '../types';
import { computerTool } from './computer';

/** computer use 工具集（单 tool = [computer]） */
export const COMPUTER_USE_TOOLS: Tool[] = [computerTool];

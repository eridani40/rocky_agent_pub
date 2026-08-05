/**
 * COMPUTER_INPUT_SCHEMA —— 单 `computer` tool 的扁平 action-discriminated inputSchema
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §B2.8 A
 *
 * 设计（扁平，非 JSON Schema oneOf/if-then）：`action` 必填 enum（11 action）+ 各 action 专属可选参数，
 *   additionalProperties:false。契合项目 loose JSONSchemaLike + engine「必填 + primitive」轻校验——
 *   engine 仅验 action 存在且是 string；**action-specific 必需参数**（type_text 的 text / scroll 的
 *   direction / press_key 的 key / drag 的 from_x..to_y / set_value 的 element_index+value）由
 *   tool run()/handler 校验（缺 → errorResult，不静默）。
 *   坐标用扁平 x/y 整数（沿 batch2 resolveTarget 既定），非 Anthropic coordinate:[x,y] 数组。
 */
import type { JSONSchemaLike } from '../types';

/** action 参数说明串（逐 action 列语义 + 必需参数 + 引导「get_app_state 每轮先调」「破坏性操作先问」） */
const ACTION_DESCRIPTION = [
  'Which computer-use operation to perform. One of:',
  '- "get_app_state": capture a screenshot AND read the accessibility tree of an app in one call;',
  '  returns an image plus text where each line starts with an element_index. This is the PRIMARY',
  '  action — call it FIRST each turn to see the app and obtain element_index. Optional: app,',
  '  text_limit, max_tree_nodes, max_tree_depth.',
  '- "list_apps": list running apps (name / bundleId / pid) to find an app hint (no other params).',
  '- "screenshot": capture only a screenshot of an app window (no AX tree; saves tokens). Optional: app.',
  '- "read_ax_tree": read only the accessibility tree (no screenshot; saves tokens). Optional: app,',
  '  text_limit, max_tree_nodes, max_tree_depth.',
  '- "click": click a target. Prefer element_index (from get_app_state/read_ax_tree); fall back to x,y',
  '  pixel coordinates (from a prior get_app_state/screenshot). Optional: click_count (1|2|3), mouse_button, app.',
  '- "perform_secondary_action": run an element\'s secondary AX action shown in the tree.',
  '  Requires element_index and secondary_action. The action name accepts both the pretty label',
  '  shown in the tree (e.g. "Press", "Show Menu", "Raise") and the raw AX identifier (e.g. "AXPress",',
  '  "AXShowMenu", "AXRaise"); matching is case-insensitive. Optional: app.',
  '- "scroll": scroll at a target. Requires direction (up|down|left|right); target via element_index',
  '  or x,y; optional pages, app.',
  '- "drag": drag from (from_x,from_y) to (to_x,to_y) pixel coordinates. Requires all four. Optional: app.',
  '- "type_text": type Unicode text into the focused element. Requires text. Optional: app.',
  '- "press_key": press a key or key combo in xdotool syntax (e.g. "cmd+s", "enter"). Requires key. Optional: app.',
  '- "set_value": set an editable element\'s value directly via AX. Requires element_index and value. Optional: app.',
  'Always get_app_state (or screenshot / read_ax_tree) first to see the screen; ask the user before destructive actions.',
].join('\n');

/**
 * 单 `computer` tool 的 inputSchema（扁平 action-discriminated）。
 * required:['action'] + additionalProperties:false；enum 仅 LLM 读，engine 不强校，
 * run() 首步显式校验 action ∈ 11 值集（未知 action → errorResult）；action-specific 必需参数由 handler 校验。
 */
export const COMPUTER_INPUT_SCHEMA: JSONSchemaLike = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
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
      ],
      description: ACTION_DESCRIPTION,
    },
    app: { type: 'string', description: 'App hint (bundleId or name) to target; default frontmost. Optional for all actions.' },
    element_index: {
      type: 'integer',
      description: 'Target element index from a prior get_app_state/read_ax_tree (primary targeting; required for perform_secondary_action/set_value).',
    },
    x: { type: 'integer', description: 'Screenshot pixel X (fallback targeting for click/scroll).' },
    y: { type: 'integer', description: 'Screenshot pixel Y (fallback targeting for click/scroll).' },
    from_x: { type: 'integer', description: 'Drag start pixel X (action=drag, required).' },
    from_y: { type: 'integer', description: 'Drag start pixel Y (action=drag, required).' },
    to_x: { type: 'integer', description: 'Drag end pixel X (action=drag, required).' },
    to_y: { type: 'integer', description: 'Drag end pixel Y (action=drag, required).' },
    text: { type: 'string', description: 'Text to type (action=type_text).' },
    key: { type: 'string', description: 'Key or combo in xdotool syntax, e.g. "cmd+s" (action=press_key).' },
    value: { type: 'string', description: 'Value to set on the element (action=set_value).' },
    secondary_action: {
      type: 'string',
      description:
        'AX secondary action name to perform (action=perform_secondary_action). Accepts either the pretty ' +
        'label shown in the AX tree (e.g. "Press", "Show Menu", "Raise") or the raw AX identifier ' +
        '(e.g. "AXPress", "AXShowMenu", "AXRaise"); matching is case-insensitive.',
    },
    direction: {
      type: 'string',
      enum: ['up', 'down', 'left', 'right'],
      description: 'Scroll direction (action=scroll, required).',
    },
    pages: { type: 'integer', description: 'Number of pages to scroll (action=scroll).' },
    click_count: { type: 'integer', enum: [1, 2, 3], description: 'Click count: 1=single,2=double,3=triple.' },
    mouse_button: {
      type: 'string',
      enum: ['left', 'right', 'middle'],
      description: 'Mouse button for click (default left).',
    },
    text_limit: {
      // v0.0.160：支持整数或字面量 "max"（对齐 Swift SnapshotTextLimit）；LLM 由 oneOf + description 双提示
      oneOf: [
        { type: 'integer' },
        { type: 'string', enum: ['max'] },
      ],
      description:
        'Max chars of AX render text (get_app_state/read_ax_tree). Pass an integer for a hard cap, ' +
        'or the string "max" to disable the cap entirely.',
    },
    max_tree_nodes: { type: 'integer', description: 'Max AX nodes to collect (get_app_state/read_ax_tree).' },
    max_tree_depth: { type: 'integer', description: 'Max AX tree depth (get_app_state/read_ax_tree).' },
  },
  required: ['action'],
  additionalProperties: false,
};

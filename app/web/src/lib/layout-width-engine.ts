/**
 * layout-width-engine —— 三栏响应式布局宽度换算纯函数引擎（零 React，UT 主战场）
 * 参考: specs/prd/version_logs/v0.0.182/change_log.md §2（统一宽度模型 + 双场景语义 + 相位表）
 *       specs/tech/version_logs/v0.0.182/change_plan.md §1.1/§3（引擎签名 + method 级契约）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.13（三栏响应式布局引擎设计原则）
 *
 * 核心不变式（PRD §2.2）：每个侧栏 渲染宽 = clamp(静态min, min(设定宽, 动态上限), 静态max)。
 * 动态上限的防守基准按场景区分：
 *   场景 A（拖拽中 dragging≠null）：基准 = 中部底线 480；对侧栏 hold 上一帧渲染宽不动。
 *   场景 B（窗口缩窄 dragging=null）：基准 = C_defend = clamp(480, 中部当前宽, 舒适宽 932)。
 * 解析顺序先 R 后 L（= 降级顺序 右⇒左，PRD §2.3）；相位边界 P0~P4 零硬编码、全由公式涌现。
 * 中部保底：middle < 480 → 定 480 + scrollX（横滚兜底，绝不突破 480）。
 */

// ──────────────────────────── 宽度常量组（唯一权威源，PRD §2.1 槽位表） ────────────────────────────

/** 右栏 ws-panel 静态下限（ws-header tab + 3 action 按钮完整放下的最小宽） */
export const WS_WIDTH_MIN = 232;
/** 右栏 ws-panel 静态上限（[v0.0.320] 560→1600 近全屏语义，PRD §2.1） */
export const WS_WIDTH_MAX = 1600;
/** 右栏 ws-panel 默认展开宽 */
export const WS_WIDTH_DEFAULT = 272;
/** 右栏收起态窄栏宽（ws-rail） */
export const WS_RAIL_WIDTH = 36;
/** 左栏 conv-panel 静态下限（用户决策值） */
export const CONV_WIDTH_MIN = 180;
/** 左栏 conv-panel 静态上限（用户决策值） */
export const CONV_WIDTH_MAX = 400;
/** 左栏 conv-panel 默认宽（用户决策值） */
export const CONV_WIDTH_DEFAULT = 220;
/** 中部保底宽（MANDATORY，任何场景不突破；4 槽场景由 CHAT_WIDTH_MIN 取代） */
export const MIDDLE_MIN = 480;
/** 中部舒适宽 = 内容列 820 + 左 padding 32 + 右 overlay reserve 80（派生自 _overview §4.5） */
export const MIDDLE_COMFORT = 932;
// ── [v0.0.320] 预览区（preview 槽）常量组（PRD §2.1 槽位表） ──
/** chat 中部保底下限（4 槽场景，PRD §2.1；旧 3 槽仍用 MIDDLE_MIN=480） */
export const CHAT_WIDTH_MIN = 320;
/** 预览区展开下限 */
export const PV_WIDTH_MIN = 240;
/** 预览区静态上限（= 近全屏语义，动态由引擎钳制） */
export const PV_WIDTH_MAX = 1600;
/** 预览区默认展开宽 */
export const PV_WIDTH_DEFAULT = 360;

// ──────────────────────────── 类型组（引擎输入/输出契约） ────────────────────────────

/** 拖拽侧；null = 非拖拽（场景 B） */
export type DragSide = 'left' | 'preview' | 'right' | null;

/** 侧栏槽位输入：设定宽 = 用户拖拽意图值（localStorage 记忆），窗口压缩不改写 */
export interface SidebarSlotInput {
  setting: number;
}

/** 右栏槽位输入：收起态按 WS_RAIL_WIDTH 计入换算、不参与拖拽（PRD §3.4） */
export interface RightSlotInput extends SidebarSlotInput {
  collapsed: boolean;
}

/** [v0.0.320] 预览区槽位输入：同 RightSlotInput（collapsed → previewWidth=0 完全隐藏，两侧回收） */
export interface PreviewSlotInput extends SidebarSlotInput {
  collapsed: boolean;
}

export interface ThreeColLayoutInput {
  /** 页容器 clientWidth（已不含 nav-rail；studio 场景也不含 224 sidebar——它是容器外兄弟） */
  available: number;
  /** chat: conv-panel；studio: null（中+右两槽） */
  left: SidebarSlotInput | null;
  /** chat 无 active session 时 null */
  right: RightSlotInput | null;
  /** [v0.0.320] 预览区槽（缺省 null = 旧 3 槽路径一字不动） */
  preview?: PreviewSlotInput | null;
  /** [v0.0.329 门模型] chat 槽被门遮（door=left → preview 占满门框、chat 宽 0）。缺省 false = 旧路径逐字段相等 */
  chatCollapsed?: boolean;
  /** 上一帧中部渲染宽（C_defend 数据源；初值 MIDDLE_COMFORT） */
  middleCurrent: number;
  /** 上一帧左栏渲染宽（场景 A 拖拽 hold 用） */
  leftCurrent: number;
  /** 上一帧右栏渲染宽（场景 A 拖拽 hold 用） */
  rightCurrent: number;
  /** [v0.0.320] 上一帧预览区渲染宽（场景 A 拖 preview 时 hold 用；preview=null 缺省 0） */
  previewCurrent?: number;
  /** 非 null = 场景 A（拖拽）；null = 场景 B（缩窄） */
  dragging: DragSide;
}

export interface ThreeColLayoutResult {
  leftWidth: number;
  rightWidth: number;
  middleWidth: number;
  /** [v0.0.320] 预览区渲染宽（preview=null 时 0，旧调用方零影响） */
  previewWidth: number;
  /** 内行 min-width = leftWidth + 中部底线 + previewWidth + rightWidth（最小内容总宽，横滚触发基准） */
  minRowWidth: number;
  /** available < minRowWidth → 页容器横向滚动（PRD §2.4） */
  scrollX: boolean;
  /** 本帧防守宽（UT 断言锚点） */
  cDefend: number;
}

// ──────────────────────────── 纯函数组 ────────────────────────────

/** 场景 B 中部防守宽：clamp(480, middleCurrent, 932)（PRD §2.2） */
export function clampMiddleDefend(middleCurrent: number): number {
  return Math.max(MIDDLE_MIN, Math.min(MIDDLE_COMFORT, middleCurrent));
}

/**
 * 侧栏渲染宽统一 clamp：max(静态min, min(静态max, min(setting, dynMax)))。
 * 静态 min 永远赢过 dynMax——宁挤中部/走横滚，不破侧栏下限（下限之上才守中部，PRD §2.2/UC-8）。
 * [v0.0.320] side 加 'preview'（min=PV_WIDTH_MIN / max=PV_WIDTH_MAX）。
 */
export function clampSidebar(setting: number, dynMax: number, side: 'left' | 'right' | 'preview'): number {
  const min = side === 'left' ? CONV_WIDTH_MIN : side === 'preview' ? PV_WIDTH_MIN : WS_WIDTH_MIN;
  const max = side === 'left' ? CONV_WIDTH_MAX : side === 'preview' ? PV_WIDTH_MAX : WS_WIDTH_MAX;
  return Math.max(min, Math.min(max, Math.min(setting, dynMax)));
}

/**
 * 场景 A 动态上限唯一公式：available − 对侧宽 − 480（拖侧栏 = 中部让路，中部触 480 即达上限）。
 * 引擎内部与拖拽手柄 props 必须同源调用本函数，禁第二份公式（change_plan §3）。
 */
export function dragDynMax(available: number, otherWidth: number): number {
  return available - otherWidth - MIDDLE_MIN;
}

/**
 * [v0.0.320] 4 槽场景动态上限唯一公式：available − 其余侧栏宽和 − CHAT_WIDTH_MIN。
 * 与 dragDynMax（3 槽）并存不互斥：4 槽统一走本函数，禁第二份公式（change_plan D1）。
 */
export function dragDynMax4(available: number, others: number[], minChat: number = CHAT_WIDTH_MIN): number {
  return available - others.reduce((a, b) => a + b, 0) - minChat;
}

/**
 * 三栏布局主解析（纯函数，无状态——同输入同输出，拉宽自恢复无滞后残留）。
 * 先 R 后 L；场景 A 对侧 hold *Current；场景 B dynR 用左栏静态 clamp 设定宽、dynL 用 R 渲染宽。
 *
 * [v0.0.320] preview 可选槽：
 *   - preview=null/undefined → 旧 3 槽路径一字不动（回归保护，旧 UT 全绿）
 *   - preview 非 null → 4 槽解析（槽序 left|chat|preview|right；chat 无设定宽=剩余）
 *     保底链 right→preview→left→chat（CHAT_WIDTH_MIN=320 兜底，全触底仍不足 → scrollX 横滚）
 */
export function computeThreeColLayout(input: ThreeColLayoutInput): ThreeColLayoutResult {
  const { available, left, right, middleCurrent, leftCurrent, rightCurrent, dragging } = input;
  const preview = input.preview ?? null;
  const previewCurrent = input.previewCurrent ?? 0;
  const cDefend = dragging !== null ? MIDDLE_MIN : clampMiddleDefend(middleCurrent);

  let leftWidth: number;
  let rightWidth: number;
  let previewWidth: number;

  if (preview === null) {
    // ═══ 旧 3 槽路径（一字不动，回归保护） ═══
    previewWidth = 0;
    if (dragging === 'right') {
      // 场景 A 拖右栏：左栏 hold 上一帧不动，右栏受动态上限约束（PRD §3.2）
      leftWidth = leftCurrent;
      rightWidth = clampSidebar(right?.setting ?? WS_WIDTH_DEFAULT, dragDynMax(available, leftWidth), 'right');
    } else if (dragging === 'left') {
      // 场景 A 拖左栏：右栏 hold 上一帧不动（collapsed 时为 36，左栏因此获得更大 dynL，PRD §3.4）
      rightWidth = rightCurrent;
      leftWidth = clampSidebar(left?.setting ?? CONV_WIDTH_DEFAULT, dragDynMax(available, rightWidth), 'left');
    } else {
      // 场景 B：解析先 R 后 L（= 降级 右⇒左）；dynR 用左栏静态 clamp 设定宽防循环依赖
      if (right === null) {
        rightWidth = 0;
      } else if (right.collapsed) {
        rightWidth = WS_RAIL_WIDTH;
      } else {
        const leftStatic = left === null ? 0 : clampSidebar(left.setting, Number.POSITIVE_INFINITY, 'left');
        rightWidth = clampSidebar(right.setting, available - leftStatic - cDefend, 'right');
      }
      leftWidth = left === null ? 0 : clampSidebar(left.setting, available - rightWidth - cDefend, 'left');
    }

    let middleWidth = available - leftWidth - rightWidth;
    let scrollX = false;
    if (middleWidth < MIDDLE_MIN) {
      // 中部保底 480：绝不突破，溢出走横滚兜底（PRD §2.4）
      middleWidth = MIDDLE_MIN;
      scrollX = true;
    }
    const minRowWidth = leftWidth + MIDDLE_MIN + rightWidth;
    return { leftWidth, rightWidth, middleWidth, previewWidth, minRowWidth, scrollX, cDefend };
  }

  // ═══ [v0.0.320] 4 槽路径 ═══
  // preview.collapsed=true → previewWidth=0（完全隐藏，两侧自动扩展回收）
  const pvSetting = preview.collapsed ? 0 : preview.setting;

  if (dragging === 'preview') {
    // 场景 A 拖预览区：left/right hold 上一帧，preview 受 dragDynMax4 上限约束
    leftWidth = leftCurrent;
    rightWidth = rightCurrent;
    previewWidth = clampSidebar(pvSetting, dragDynMax4(available, [leftWidth, rightWidth]), 'preview');
  } else if (dragging === 'right') {
    // 场景 A 拖右栏：left/preview hold 上一帧，right 受 dragDynMax4 上限约束
    leftWidth = leftCurrent;
    previewWidth = previewCurrent;
    rightWidth = clampSidebar(right?.setting ?? WS_WIDTH_DEFAULT, dragDynMax4(available, [leftWidth, previewWidth]), 'right');
  } else if (dragging === 'left') {
    // 场景 A 拖左栏：preview/right hold 上一帧，left 受 dragDynMax4 上限约束
    previewWidth = previewCurrent;
    rightWidth = rightCurrent;
    leftWidth = clampSidebar(left?.setting ?? CONV_WIDTH_DEFAULT, dragDynMax4(available, [previewWidth, rightWidth]), 'left');
  } else if (input.chatCollapsed === true) {
    // ═══ [v0.0.329 门模型] 场景 B + door=left：chat 被门遮（宽 0），preview 吞并整个门框 ═══
    // 先走 4 槽场景 B 完整换算（R→preview→L，防守逻辑与缺省路径一字不差——左右槽位置/门框总宽不动，PRD §4 三个不变②）；
    // 最后重分配：chat(middle) 置 0、preview 吞并门框剩余全部（不被 CHAT_WIDTH_MIN 钳；无 scrollX——显式门态非宽度不足）。
    if (right === null) {
      rightWidth = 0;
    } else if (right.collapsed) {
      rightWidth = WS_RAIL_WIDTH;
    } else {
      const leftStatic = left === null ? 0 : clampSidebar(left.setting, Number.POSITIVE_INFINITY, 'left');
      const pvStatic = preview.collapsed ? 0 : clampSidebar(pvSetting, Number.POSITIVE_INFINITY, 'preview');
      rightWidth = clampSidebar(right.setting, available - leftStatic - pvStatic - CHAT_WIDTH_MIN, 'right');
    }
    if (preview.collapsed) {
      previewWidth = 0;
    } else {
      const leftStatic = left === null ? 0 : clampSidebar(left.setting, Number.POSITIVE_INFINITY, 'left');
      previewWidth = clampSidebar(pvSetting, available - leftStatic - rightWidth - CHAT_WIDTH_MIN, 'preview');
    }
    leftWidth = left === null ? 0 : clampSidebar(left.setting, available - rightWidth - previewWidth - CHAT_WIDTH_MIN, 'left');
    // 门态重分配：chat 槽 0、preview 吞并（总宽守恒 available = left + right + preview + 0）
    previewWidth = Math.max(0, available - leftWidth - rightWidth);
    const minRowWidth = leftWidth + 0 + previewWidth + rightWidth;
    return { leftWidth, rightWidth, middleWidth: 0, previewWidth, minRowWidth, scrollX: false, cDefend };
  } else {
    // 场景 B：解析先 R → preview → L（= 降级 右⇒预览⇒左）；chat = available − 三者（无设定宽）
    // 保底链 right→preview→left→chat；每步 dynMax 用「已定槽静态/渲染宽 + 剩余槽最小和」防循环依赖
    if (right === null) {
      rightWidth = 0;
    } else if (right.collapsed) {
      rightWidth = WS_RAIL_WIDTH;
    } else {
      const leftStatic = left === null ? 0 : clampSidebar(left.setting, Number.POSITIVE_INFINITY, 'left');
      const pvStatic = preview.collapsed ? 0 : clampSidebar(pvSetting, Number.POSITIVE_INFINITY, 'preview');
      rightWidth = clampSidebar(right.setting, available - leftStatic - pvStatic - CHAT_WIDTH_MIN, 'right');
    }
    if (preview.collapsed) {
      previewWidth = 0;
    } else {
      const leftStatic = left === null ? 0 : clampSidebar(left.setting, Number.POSITIVE_INFINITY, 'left');
      previewWidth = clampSidebar(pvSetting, available - leftStatic - rightWidth - CHAT_WIDTH_MIN, 'preview');
    }
    leftWidth = left === null ? 0 : clampSidebar(left.setting, available - rightWidth - previewWidth - CHAT_WIDTH_MIN, 'left');
  }

  let middleWidth = available - leftWidth - previewWidth - rightWidth;
  let scrollX = false;
  if (middleWidth < CHAT_WIDTH_MIN) {
    // chat 保底 320：绝不突破，溢出走横滚兜底（PRD §2.4 / D1 保底链最后一步）
    middleWidth = CHAT_WIDTH_MIN;
    scrollX = true;
  }
  const minRowWidth = leftWidth + CHAT_WIDTH_MIN + previewWidth + rightWidth;
  return { leftWidth, rightWidth, middleWidth, previewWidth, minRowWidth, scrollX, cDefend };
}

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
/** 右栏 ws-panel 静态上限 */
export const WS_WIDTH_MAX = 560;
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
/** 中部保底宽（MANDATORY，任何场景不突破） */
export const MIDDLE_MIN = 480;
/** 中部舒适宽 = 内容列 820 + 左 padding 32 + 右 overlay reserve 80（派生自 _overview §4.5） */
export const MIDDLE_COMFORT = 932;

// ──────────────────────────── 类型组（引擎输入/输出契约） ────────────────────────────

/** 拖拽侧；null = 非拖拽（场景 B） */
export type DragSide = 'left' | 'right' | null;

/** 侧栏槽位输入：设定宽 = 用户拖拽意图值（localStorage 记忆），窗口压缩不改写 */
export interface SidebarSlotInput {
  setting: number;
}

/** 右栏槽位输入：收起态按 WS_RAIL_WIDTH 计入换算、不参与拖拽（PRD §3.4） */
export interface RightSlotInput extends SidebarSlotInput {
  collapsed: boolean;
}

export interface ThreeColLayoutInput {
  /** 页容器 clientWidth（已不含 nav-rail；studio 场景也不含 224 sidebar——它是容器外兄弟） */
  available: number;
  /** chat: conv-panel；studio: null（中+右两槽） */
  left: SidebarSlotInput | null;
  /** chat 无 active session 时 null */
  right: RightSlotInput | null;
  /** 上一帧中部渲染宽（C_defend 数据源；初值 MIDDLE_COMFORT） */
  middleCurrent: number;
  /** 上一帧左栏渲染宽（场景 A 拖拽 hold 用） */
  leftCurrent: number;
  /** 上一帧右栏渲染宽（场景 A 拖拽 hold 用） */
  rightCurrent: number;
  /** 非 null = 场景 A（拖拽）；null = 场景 B（缩窄） */
  dragging: DragSide;
}

export interface ThreeColLayoutResult {
  leftWidth: number;
  rightWidth: number;
  middleWidth: number;
  /** 内行 min-width = leftWidth + 480 + rightWidth（最小内容总宽，横滚触发基准） */
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
 */
export function clampSidebar(setting: number, dynMax: number, side: 'left' | 'right'): number {
  const min = side === 'left' ? CONV_WIDTH_MIN : WS_WIDTH_MIN;
  const max = side === 'left' ? CONV_WIDTH_MAX : WS_WIDTH_MAX;
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
 * 三栏布局主解析（纯函数，无状态——同输入同输出，拉宽自恢复无滞后残留）。
 * 先 R 后 L；场景 A 对侧 hold *Current；场景 B dynR 用左栏静态 clamp 设定宽、dynL 用 R 渲染宽。
 */
export function computeThreeColLayout(input: ThreeColLayoutInput): ThreeColLayoutResult {
  const { available, left, right, middleCurrent, leftCurrent, rightCurrent, dragging } = input;
  const cDefend = dragging !== null ? MIDDLE_MIN : clampMiddleDefend(middleCurrent);

  let leftWidth: number;
  let rightWidth: number;

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
  return { leftWidth, rightWidth, middleWidth, minRowWidth, scrollX, cDefend };
}

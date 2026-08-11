/**
 * use-three-col-layout —— 三栏响应式布局 React 接线 hook（page-chat / StudioChatRouter 共用）
 * 参考: specs/prd/version_logs/v0.0.182/change_log.md §2（统一宽度模型）+ §3（拖拽契约）
 *       specs/tech/version_logs/v0.0.182/change_plan.md §3（layout-hook 模块契约）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.13（设计原则）
 *
 * 职责：
 *   - available（页容器 clientWidth）：useLayoutEffect 首测 + ResizeObserver 续测 + window resize fallback
 *   - convWidth state（左栏 conv-panel 设定宽，全局 localStorage key `conv-panel-width` 默认 220）
 *   - rightReport state（ws-panel 上报 {settingWidth, collapsed}）
 *   - dragging state（null=场景 B 缩窄 / 'left'|'right'=场景 A 拖拽）
 *   - 三 ref（leftCurrent/rightCurrent/middleCurrent）每帧 effect 回填上一帧渲染宽
 *   - derive computeThreeColLayout（引擎纯函数，无状态）
 *
 * 不变量（change_plan §3 layout-hook 行约束）：
 *   - MUST 守卫 `typeof ResizeObserver !== 'undefined'`（jsdom 无 RO，fallback window resize）
 *   - MUST dragMax 用 dragDynMax 同源（禁第二份公式）
 *   - MUST NOT 节流外的额外 state；mid-drag 不重捕获 startRef（无死区，详见 ComponentColResizeHandle）
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readColWidth, writeColWidth } from '../common/use-persistent-width';
import {
  CONV_WIDTH_DEFAULT,
  CONV_WIDTH_MAX,
  CONV_WIDTH_MIN,
  MIDDLE_COMFORT,
  PV_WIDTH_DEFAULT,
  WS_WIDTH_DEFAULT,
  computeThreeColLayout,
  dragDynMax,
  dragDynMax4,
  type DragSide,
  type PreviewSlotInput,
  type RightSlotInput,
  type SidebarSlotInput,
} from '../../lib/layout-width-engine';

// ──────────────────────────── conv-panel 宽度 localStorage 辅助（全局 key，裁决 P2） ────────────────────────────

/** 左栏 conv-panel 全局宽度 localStorage key（非 per-session，与右栏 ws-* 区分） */
export const CONV_WIDTH_LS_KEY = 'conv-panel-width';

/**
 * 读取左栏宽度：clamp[180,400]，缺省 220，坏值兜底。
 * 读写/clamp 委托 common/use-persistent-width 纯函数（单一实现源）；key/默认/上下限不变。
 */
export function readConvWidth(): number {
  return readColWidth(CONV_WIDTH_LS_KEY, CONV_WIDTH_DEFAULT, CONV_WIDTH_MIN, CONV_WIDTH_MAX);
}

/**
 * 写入左栏宽度到 localStorage（全局 key）。异常吞掉（隐私模式 / 配额满）委托 common。
 */
export function writeConvWidth(v: number): void {
  writeColWidth(CONV_WIDTH_LS_KEY, v);
}

// ──────────────────────────── useThreeColLayout 主 hook ────────────────────────────

interface UseThreeColLayoutOpts {
  /** 是否有左栏：chat=true（conv-panel）/ studio=false（中+右两槽） */
  hasLeft: boolean;
  /** 是否有右栏：chat=!!activeSessionId / studio=true */
  rightPresent: boolean;
  /** [v0.0.320] 是否有预览区（4 槽场景 true；缺省 false = 旧 3 槽路径零影响） */
  previewPresent?: boolean;
  /** [v0.0.329 门模型] chat 槽被门遮（door=left → chat 宽 0、preview 占满门框）。缺省 false */
  chatCollapsed?: boolean;
}

/**
 * 三栏响应式布局 hook。返回 12 字段（change_plan §3 契约）。
 *
 * @returns containerRef   挂到外层 scroll 容器（measure clientWidth = available）
 * @returns rowMinWidth    内行 minWidth（clamp 到 1px 防 available=0 首帧塌陷）
 * @returns layout         引擎输出（leftWidth/rightWidth/middleWidth/minRowWidth/scrollX/cDefend）
 * @returns convWidth      左栏设定宽（受控值，传给 ConvPanel renderWidth）
 * @returns handleConvResize 拖动回调（挂 ConvPanel onConvResize，dragging 期间更新 convWidth）
 * @returns handleConvResizeEnd 拖动结束回调（挂 ConvPanel onConvResizeEnd，persist localStorage）
 * @returns convDragMaxWidth 左栏动态上限（dragDynMax(available, rightCurrent)）
 * @returns reportRightPanel ws-panel 上报 setter（挂 WorkspacePanel onLayoutChange）
 * @returns rightRenderWidth 右栏渲染宽（传 WorkspacePanel renderWidth）
 * @returns rightDragMaxWidth 右栏动态上限（dragDynMax(available, leftCurrent)）
 * @returns setDragging    拖拽模式 setter（挂 ConvPanel onConvDragStart('left') / WorkspacePanel onDragStart('right')）
 */
export function useThreeColLayout(opts: UseThreeColLayoutOpts) {
  const { hasLeft, rightPresent, previewPresent = false, chatCollapsed = false } = opts;

  // ── available：页容器 clientWidth（已不含 nav-rail；studio 也不含 224 sidebar——容器外兄弟） ──
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);

  // useLayoutEffect 首测 + ResizeObserver 续测 + window resize fallback（jsdom 无 RO）
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // 首测：同帧设置 available（paint 前），避免首帧 available=0 引发的相位塌陷
    setAvailable(el.clientWidth);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width;
        if (typeof w === 'number') setAvailable(w);
      });
      ro.observe(el);
      return () => ro.disconnect();
    }
    // jsdom fallback：window resize 监听（RO 不存在时唯一兜底）
    const onResize = () => setAvailable(el.clientWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── convWidth：左栏设定宽（localStorage 全局 key，初始 readConvWidth） ──
  const [convWidth, setConvWidth] = useState<number>(() => readConvWidth());

  // ── rightReport：ws-panel 上报 {settingWidth, collapsed}（null=未上报，首帧用默认 272） ──
  const [rightReport, setRightReport] = useState<{ settingWidth: number; collapsed: boolean } | null>(null);

  // ── [v0.0.320] previewReport：预览区上报 {settingWidth, collapsed}（null=未上报，首帧用默认 360） ──
  const [previewReport, setPreviewReport] = useState<{ settingWidth: number; collapsed: boolean } | null>(null);

  // ── dragging：null=场景 B / 'left'|'preview'|'right'=场景 A ──
  const [dragging, setDragging] = useState<DragSide>(null);

  // ── 四 ref：上一帧渲染宽（场景 A hold *Current；场景 B cDefend 数据源） ──
  // 初值 = 引擎默认（CONV_WIDTH_DEFAULT / WS_WIDTH_DEFAULT / PV_WIDTH_DEFAULT / MIDDLE_COMFORT）
  const leftCurrentRef = useRef(CONV_WIDTH_DEFAULT);
  const rightCurrentRef = useRef(WS_WIDTH_DEFAULT);
  const previewCurrentRef = useRef(PV_WIDTH_DEFAULT);
  const middleCurrentRef = useRef(MIDDLE_COMFORT);

  // ── 构造引擎输入（先 R 后 L 由引擎内部处理） ──
  const left: SidebarSlotInput | null = hasLeft ? { setting: convWidth } : null;
  const right: RightSlotInput | null = !rightPresent
    ? null
    : rightReport === null
      ? { setting: WS_WIDTH_DEFAULT, collapsed: false } // 首帧未上报用默认 272
      : { setting: rightReport.settingWidth, collapsed: rightReport.collapsed };
  const preview: PreviewSlotInput | null = !previewPresent
    ? null
    : previewReport === null
      ? { setting: PV_WIDTH_DEFAULT, collapsed: false } // 首帧未上报用默认 360
      : { setting: previewReport.settingWidth, collapsed: previewReport.collapsed };

  // ── derive 引擎输出（纯函数，无状态——拉宽自恢复无滞后残留） ──
  const layout = computeThreeColLayout({
    available,
    left,
    right,
    preview,
    chatCollapsed,
    middleCurrent: middleCurrentRef.current,
    leftCurrent: leftCurrentRef.current,
    rightCurrent: rightCurrentRef.current,
    previewCurrent: previewCurrentRef.current,
    dragging,
  });

  // 每帧回填四 ref：本帧 layout 输出 → 下一帧的「上一帧」输入
  useEffect(() => {
    leftCurrentRef.current = layout.leftWidth;
    rightCurrentRef.current = layout.rightWidth;
    previewCurrentRef.current = layout.previewWidth;
    middleCurrentRef.current = layout.middleWidth;
  }, [layout.leftWidth, layout.rightWidth, layout.previewWidth, layout.middleWidth]);

  // ── 动态上限（同源 dragDynMax / dragDynMax4，禁第二份公式） ──
  const convDragMaxWidth = dragDynMax(available, rightCurrentRef.current);
  const rightDragMaxWidth = dragDynMax(available, leftCurrentRef.current);
  // [v0.0.320] 4 槽场景预览区动态上限（dragDynMax4：available − left − right − CHAT_WIDTH_MIN）
  const previewDragMaxWidth = previewPresent
    ? dragDynMax4(available, [leftCurrentRef.current, rightCurrentRef.current])
    : 0;

  // ── 回调组（useCallback 稳定引用，避免子组件无必要 re-render） ──
  const handleConvResize = useCallback((w: number) => {
    setConvWidth(w);
  }, []);

  const handleConvResizeEnd = useCallback(() => {
    // 拖动结束：persist 当前 convWidth 到 localStorage（全局 key）
    writeConvWidth(convWidth);
  }, [convWidth]);

  const reportRightPanel = useCallback((r: { settingWidth: number; collapsed: boolean }) => {
    setRightReport(r);
  }, []);

  // [v0.0.320] 预览区上报 setter（挂 SectionPreviewArea onLayoutChange）
  const reportPreviewPanel = useCallback((r: { settingWidth: number; collapsed: boolean }) => {
    setPreviewReport(r);
  }, []);

  return {
    containerRef,
    // 首帧 available=0 → rowMinWidth=0 会让 flex 容器塌陷，clamp 到 1px 防 0 宽
    rowMinWidth: Math.max(1, layout.minRowWidth),
    layout,
    convWidth,
    handleConvResize,
    handleConvResizeEnd,
    convDragMaxWidth,
    reportRightPanel,
    rightRenderWidth: layout.rightWidth,
    rightDragMaxWidth,
    // [v0.0.329 门模型] chat 槽渲染宽（= layout.middleWidth；door=left 时 0，供 chat 槽隐藏判断）
    chatRenderWidth: layout.middleWidth,
    // [v0.0.320] 预览区 4 新字段（复刻 ws-panel 模式）
    reportPreviewPanel,
    previewRenderWidth: layout.previewWidth,
    previewDragMaxWidth,
    setPreviewDragging: (d: boolean) => setDragging(d ? 'preview' : null),
    setDragging,
  };
}

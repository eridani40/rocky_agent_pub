// @vitest-environment node
/**
 * layout-width-engine 单测
 * 参考: specs/tech/version_logs/v0.0.182/change_plan.md §4（UT 覆盖计划 #1~#14；
 *       #15 readConvWidth 由 hook 同级 UT 覆盖）
 *       specs/prd/version_logs/v0.0.182/change_log.md §2.2/§2.3（双场景语义 + 相位表 P0~P4）
 *
 * 覆盖矩阵：
 *   - 相位边界（场景 B 缩窄）：avail 1424/1400/1384/1364/1344/1000/892/891
 *   - 场景 A 拖拽：对侧 hold 上一帧（含 collapsed 36）、dynMax = avail − 对侧 − 480
 *   - C_defend = clamp(480, middleCurrent, 932)；拖拽压过 932 后缩窄守当前宽
 *   - 拉宽自恢复（无状态公式，无滞后残留）
 *   - 槽位组合：studio left=null / chat right=null（含 collapsed）
 *   - clampSidebar 静态界：静态 min 永远赢 dynMax
 */
import { describe, it, expect } from 'vitest';
import {
  WS_WIDTH_MIN,
  WS_WIDTH_MAX,
  WS_WIDTH_DEFAULT,
  WS_RAIL_WIDTH,
  CONV_WIDTH_MIN,
  CONV_WIDTH_MAX,
  CONV_WIDTH_DEFAULT,
  MIDDLE_MIN,
  MIDDLE_COMFORT,
  CHAT_WIDTH_MIN,
  PV_WIDTH_MIN,
  PV_WIDTH_MAX,
  PV_WIDTH_DEFAULT,
  clampMiddleDefend,
  clampSidebar,
  dragDynMax,
  dragDynMax4,
  computeThreeColLayout,
  type ThreeColLayoutInput,
} from '../layout-width-engine';

/** chat 三栏默认输入（设定 220/272，middleCurrent=1500 → cDefend=932 初态） */
function chatInput(available: number, over: Partial<ThreeColLayoutInput> = {}): ThreeColLayoutInput {
  return {
    available,
    left: { setting: CONV_WIDTH_DEFAULT },
    right: { setting: WS_WIDTH_DEFAULT, collapsed: false },
    middleCurrent: 1500,
    leftCurrent: CONV_WIDTH_DEFAULT,
    rightCurrent: WS_WIDTH_DEFAULT,
    dragging: null,
    ...over,
  };
}

describe('宽度常量组（PRD §2.1 槽位表唯一权威源）', () => {
  it('9 常量数值与契约一致', () => {
    // [v0.0.320] WS_WIDTH_MAX 560→1600（近全屏语义，PRD §2.1）+ PV_* 预览区常量
    expect([WS_WIDTH_MIN, WS_WIDTH_MAX, WS_WIDTH_DEFAULT, WS_RAIL_WIDTH]).toEqual([232, 1600, 272, 36]);
    expect([CONV_WIDTH_MIN, CONV_WIDTH_MAX, CONV_WIDTH_DEFAULT]).toEqual([180, 400, 220]);
    expect([MIDDLE_MIN, MIDDLE_COMFORT]).toEqual([480, 932]);
    expect([CHAT_WIDTH_MIN, PV_WIDTH_MIN, PV_WIDTH_MAX, PV_WIDTH_DEFAULT]).toEqual([320, 240, 1600, 360]);
  });
});

describe('场景 B 相位边界（窗口缩窄降级序列，PRD §2.3）', () => {
  it('#1 P0 宽裕：avail=1424 → 侧栏设定宽，middle=932，cDefend=932', () => {
    const r = computeThreeColLayout(chatInput(1424));
    expect(r).toMatchObject({
      leftWidth: 220, rightWidth: 272, middleWidth: 932,
      scrollX: false, cDefend: 932, minRowWidth: 220 + 480 + 272,
    });
  });

  it('#2 P1 右栏降级：avail=1400 → R=248（272→232 连续），L=220 不动，middle 守 932', () => {
    const r = computeThreeColLayout(chatInput(1400));
    expect(r).toMatchObject({ leftWidth: 220, rightWidth: 248, middleWidth: 932, scrollX: false });
  });

  it('#3 P1→P2 边界：avail=1384 → R=232 恰好触底，L=220 未降', () => {
    const r = computeThreeColLayout(chatInput(1384));
    expect(r).toMatchObject({ leftWidth: 220, rightWidth: 232, middleWidth: 932, scrollX: false });
  });

  it('#4 P2 左栏降级：avail=1364 → L=200；avail=1344 → L=180 恰好触底，middle 守 932', () => {
    const r1 = computeThreeColLayout(chatInput(1364));
    expect(r1).toMatchObject({ leftWidth: 200, rightWidth: 232, middleWidth: 932, scrollX: false });
    const r2 = computeThreeColLayout(chatInput(1344));
    expect(r2).toMatchObject({ leftWidth: 180, rightWidth: 232, middleWidth: 932, scrollX: false });
  });

  it('#5 P3 中部降级：avail=1000 → 侧栏双触底 180/232，middle=588', () => {
    const r = computeThreeColLayout(chatInput(1000));
    expect(r).toMatchObject({ leftWidth: 180, rightWidth: 232, middleWidth: 588, scrollX: false });
  });

  it('#6 P4 横滚边界：avail=892 恰好不 scroll；avail=891 → scrollX + minRowWidth=892 + middle=480', () => {
    const r1 = computeThreeColLayout(chatInput(892));
    expect(r1).toMatchObject({ leftWidth: 180, rightWidth: 232, middleWidth: 480, scrollX: false });
    const r2 = computeThreeColLayout(chatInput(891));
    expect(r2).toMatchObject({ middleWidth: 480, scrollX: true, minRowWidth: 892 });
  });
});

describe('场景 A 拖拽（PRD §3.2/§3.4）', () => {
  it('#7 拖右栏 hold 左栏上一帧：L=leftCurrent 不动（≠setting），R=min(setting, dragDynMax)，middle=avail−L−R', () => {
    // leftCurrent=260 ≠ setting 220 —— 钉死「hold 上一帧」而非回设定宽
    const r = computeThreeColLayout(chatInput(1200, { dragging: 'right', leftCurrent: 260, right: { setting: 400, collapsed: false } }));
    expect(dragDynMax(1200, 260)).toBe(1200 - 260 - 480); // dynMax 公式同源断言
    expect(r).toMatchObject({ leftWidth: 260, rightWidth: 400, middleWidth: 1200 - 260 - 400, cDefend: 480 });
  });

  it('#7b 拖右栏触动态上限：avail 不足时 R 被 dynMax 截断，middle 守 480', () => {
    const r = computeThreeColLayout(chatInput(1000, { dragging: 'right', right: { setting: 400, collapsed: false } }));
    expect(r).toMatchObject({ leftWidth: 220, rightWidth: 300, middleWidth: 480, scrollX: false });
  });

  it('#8 拖左栏 hold 右栏上一帧（含 collapsed=36）：R=rightCurrent 不动，dynL=avail−36−480', () => {
    const r = computeThreeColLayout(chatInput(1200, {
      dragging: 'left',
      right: { setting: WS_WIDTH_DEFAULT, collapsed: true },
      rightCurrent: WS_RAIL_WIDTH,
      left: { setting: 350 },
    }));
    expect(dragDynMax(1200, 36)).toBe(1200 - 36 - 480);
    expect(r).toMatchObject({ rightWidth: 36, leftWidth: 350, middleWidth: 1200 - 350 - 36, cDefend: 480 });
  });

  it('#9 C_defend clamp：middleCurrent=700→700；1500→932；300→480', () => {
    expect(clampMiddleDefend(700)).toBe(700);
    expect(clampMiddleDefend(1500)).toBe(932);
    expect(clampMiddleDefend(300)).toBe(480);
    expect(computeThreeColLayout(chatInput(1424, { middleCurrent: 700 })).cDefend).toBe(700);
  });

  it('#10 拖拽压过 932 后缩窄防守当前宽（cDefend=700）：侧栏先触底，middle 守 700 直到双触底', () => {
    // R 触底点 avail = 220+232+700 = 1152；L 触底点 avail = 180+232+700 = 1112
    const r1 = computeThreeColLayout(chatInput(1152, { middleCurrent: 700 }));
    expect(r1).toMatchObject({ leftWidth: 220, rightWidth: 232, middleWidth: 700, cDefend: 700 });
    const r2 = computeThreeColLayout(chatInput(1112, { middleCurrent: 700 }));
    expect(r2).toMatchObject({ leftWidth: 180, rightWidth: 232, middleWidth: 700, scrollX: false });
    const r3 = computeThreeColLayout(chatInput(1100, { middleCurrent: 700 }));
    expect(r3).toMatchObject({ leftWidth: 180, rightWidth: 232, middleWidth: 688 });
  });

  it('#11 拉宽自恢复：窄→宽同输入（除 available）输出 = 宽态输出，无滞后残留', () => {
    const narrow = computeThreeColLayout(chatInput(1000));
    expect(narrow.middleWidth).toBe(588);
    const wide = computeThreeColLayout(chatInput(1424));
    expect(wide).toMatchObject({ leftWidth: 220, rightWidth: 272, middleWidth: 932, scrollX: false });
  });
});

describe('槽位组合（PRD §5 studio / chat 无右栏）', () => {
  it('#12 studio left=null：avail=712 恰好不 scroll；711→scrollX+minRowWidth=712；collapsed→minRowWidth=516', () => {
    const base: Partial<ThreeColLayoutInput> = { left: null, leftCurrent: 0 };
    const r1 = computeThreeColLayout(chatInput(712, base));
    expect(r1).toMatchObject({ leftWidth: 0, rightWidth: 232, middleWidth: 480, scrollX: false });
    const r2 = computeThreeColLayout(chatInput(711, base));
    expect(r2).toMatchObject({ middleWidth: 480, scrollX: true, minRowWidth: 712 });
    const r3 = computeThreeColLayout(chatInput(516, { ...base, right: { setting: WS_WIDTH_DEFAULT, collapsed: true } }));
    expect(r3).toMatchObject({ rightWidth: 36, middleWidth: 480, scrollX: false, minRowWidth: 516 });
  });

  it('#13 chat 无右栏 right=null：middle=avail−L；直到 L+480 触底才 scroll（minRowWidth=L+480）', () => {
    const r1 = computeThreeColLayout(chatInput(1200, { right: null, rightCurrent: 0 }));
    expect(r1).toMatchObject({ leftWidth: 220, rightWidth: 0, middleWidth: 980, scrollX: false });
    const r2 = computeThreeColLayout(chatInput(659, { right: null, rightCurrent: 0 }));
    expect(r2).toMatchObject({ leftWidth: 180, middleWidth: 480, scrollX: true, minRowWidth: 660 });
  });
});

describe('clampSidebar 静态界（PRD §2.2 / UC-8）', () => {
  it('#14 静态 max/min：setting=999→999(right，<1600 不截断)/400(left)；setting=2000→1600；100→232/180', () => {
    expect(clampSidebar(999, Number.POSITIVE_INFINITY, 'right')).toBe(999);
    expect(clampSidebar(999, Number.POSITIVE_INFINITY, 'left')).toBe(400);
    expect(clampSidebar(2000, Number.POSITIVE_INFINITY, 'right')).toBe(1600);
    expect(clampSidebar(100, Number.POSITIVE_INFINITY, 'right')).toBe(232);
    expect(clampSidebar(100, Number.POSITIVE_INFINITY, 'left')).toBe(180);
  });

  it('#14b dynMax < 静态 min → min 永远赢（宁横滚不破侧栏下限）', () => {
    expect(clampSidebar(272, 100, 'right')).toBe(232);
    expect(clampSidebar(220, 50, 'left')).toBe(180);
  });
});

// ═══════════════ [v0.0.320] 4 槽路径（preview 可选槽） ═══════════════

/** 4 槽默认输入（left=220 / preview=360 / right=272，chat 无设定宽=剩余） */
function fourInput(available: number, over: Partial<ThreeColLayoutInput> = {}): ThreeColLayoutInput {
  return {
    available,
    left: { setting: CONV_WIDTH_DEFAULT },
    preview: { setting: PV_WIDTH_DEFAULT, collapsed: false },
    right: { setting: WS_WIDTH_DEFAULT, collapsed: false },
    middleCurrent: 1500,
    leftCurrent: CONV_WIDTH_DEFAULT,
    previewCurrent: PV_WIDTH_DEFAULT,
    rightCurrent: WS_WIDTH_DEFAULT,
    dragging: null,
    ...over,
  };
}

describe('[v0.0.320] 4 槽路径（preview 可选槽）', () => {
  it('preview=null/缺省 → 输出与旧版逐字段相等（回归保护）', () => {
    const old1 = computeThreeColLayout(chatInput(1424));
    const old2 = computeThreeColLayout(chatInput(1000));
    // preview 缺省 = 旧路径（previewWidth=0，其余字段与旧断言逐字一致）
    expect(old1).toMatchObject({ leftWidth: 220, rightWidth: 272, middleWidth: 932, previewWidth: 0, scrollX: false, cDefend: 932 });
    expect(old2).toMatchObject({ leftWidth: 180, rightWidth: 232, middleWidth: 588, previewWidth: 0, scrollX: false });
    // 显式 preview: null 等价缺省
    const explicit = computeThreeColLayout({ ...chatInput(1424), preview: null });
    expect(explicit).toEqual(old1);
  });

  it('4 槽宽裕：left|chat|preview|right 槽序，chat=剩余（无设定宽）', () => {
    const r = computeThreeColLayout(fourInput(1600));
    // 220 + chat + 360 + 272 = 1600 → chat = 748
    expect(r).toMatchObject({
      leftWidth: 220, previewWidth: 360, rightWidth: 272, middleWidth: 748,
      scrollX: false, cDefend: 932, minRowWidth: 220 + CHAT_WIDTH_MIN + 360 + 272,
    });
  });

  it('4 槽保底链：right→preview→left→chat；全触底 → chat 守 CHAT_WIDTH_MIN + scrollX', () => {
    // 宽裕 → right 先降（保底链第一步）
    const r1 = computeThreeColLayout(fourInput(1400));
    // right dynMax = 1400 - 220 - 360 - 320 = 500 → right=500? 不对：dynMax=500 但 setting=272 已低于 → right=272
    // 实际 right=272（setting 272 < dynMax 500）；preview=360；left=220；chat=548
    expect(r1).toMatchObject({ rightWidth: 272, previewWidth: 360, leftWidth: 220, middleWidth: 548, scrollX: false });

    // 缩窄：right 触底 232 → preview 降 → left 降 → chat 触底 320 横滚
    const r2 = computeThreeColLayout(fourInput(900));
    // 保底链：right=232（触底）、preview=240（PV_MIN）、left=180（CONV_MIN）
    // 三者 232+240+180=652 → chat=900-652=248 < 320 → chat=320 + scrollX
    expect(r2).toMatchObject({ leftWidth: 180, previewWidth: 240, rightWidth: 232, middleWidth: CHAT_WIDTH_MIN, scrollX: true });
    expect(r2.minRowWidth).toBe(180 + CHAT_WIDTH_MIN + 240 + 232);
  });

  it('preview.collapsed=true → previewWidth=0（两侧自动扩展回收）', () => {
    const r = computeThreeColLayout(fourInput(1600, { preview: { setting: PV_WIDTH_DEFAULT, collapsed: true } }));
    // 220 + chat + 0 + 272 = 1600 → chat = 1108（preview 空间回收）
    expect(r).toMatchObject({ leftWidth: 220, previewWidth: 0, rightWidth: 272, middleWidth: 1108, scrollX: false });
  });

  it('拖 preview：left/right hold 上一帧，preview 受 dragDynMax4 上限约束', () => {
    const r = computeThreeColLayout(fourInput(1200, {
      dragging: 'preview',
      preview: { setting: 600, collapsed: false },
      leftCurrent: 260, // hold 上一帧（≠setting 220）
      rightCurrent: 300, // hold 上一帧
    }));
    // dynMax4 = 1200 - 260 - 300 - 320 = 320 → preview=320（被截断）
    expect(dragDynMax4(1200, [260, 300])).toBe(320);
    expect(r).toMatchObject({ leftWidth: 260, rightWidth: 300, previewWidth: 320, middleWidth: 1200 - 260 - 300 - 320, cDefend: 480 });
  });

  it('拖 right（4 槽）：left/preview hold 上一帧，right 受 dragDynMax4 上限约束', () => {
    const r = computeThreeColLayout(fourInput(1200, {
      dragging: 'right',
      preview: { setting: 500, collapsed: false },
      previewCurrent: 420, // hold 上一帧
      right: { setting: 600, collapsed: false },
    }));
    // dynMax4 = 1200 - 220 - 420 - 320 = 240 → right=240（被截断，守 right 下限 232 之上）
    expect(r).toMatchObject({ leftWidth: 220, previewWidth: 420, rightWidth: 240, middleWidth: 1200 - 220 - 420 - 240, cDefend: 480 });
  });

  it('拖 left（4 槽）：preview/right hold 上一帧，left 受 dragDynMax4 上限约束', () => {
    const r = computeThreeColLayout(fourInput(1200, {
      dragging: 'left',
      previewCurrent: 360,
      rightCurrent: 272,
      left: { setting: 500 },
    }));
    // dynMax4 = 1200 - 360 - 272 - 320 = 248 → left=248
    expect(r).toMatchObject({ leftWidth: 248, previewWidth: 360, rightWidth: 272, middleWidth: 1200 - 248 - 360 - 272, cDefend: 480 });
  });

  it('dragDynMax4 纯函数：available − others和 − minChat（唯一公式）', () => {
    expect(dragDynMax4(1600, [220, 360, 272])).toBe(1600 - 220 - 360 - 272 - 320);
    expect(dragDynMax4(1200, [260, 300])).toBe(1200 - 260 - 300 - 320);
    expect(dragDynMax4(900, [180, 232], 240)).toBe(900 - 180 - 232 - 240);
  });
});

// ═══════════════ [v0.0.329 门模型] chatCollapsed 分支（door=left） ═══════════════

describe('[v0.0.329] chatCollapsed（门滑最左：chat 宽 0、preview 吞并门框）', () => {
  it('chatCollapsed=true（4 槽场景 B）→ middleWidth=0、preview 吞并门框、无 scrollX', () => {
    const r = computeThreeColLayout(fourInput(1600, { chatCollapsed: true }));
    // left=220 / right=272 / preview=1600-220-272=1108 / chat=0
    expect(r).toMatchObject({
      leftWidth: 220,
      rightWidth: 272,
      previewWidth: 1600 - 220 - 272,
      middleWidth: 0,
      scrollX: false,
    });
    expect(r.minRowWidth).toBe(220 + 0 + (1600 - 220 - 272) + 272);
  });

  it('chatCollapsed=true 缩窄场景：preview 仍吞并门框（不被 CHAT_WIDTH_MIN 钳住）', () => {
    // 窄窗 900：left=180（CONV_MIN）、right=232（WS_MIN）、preview=900-180-232=488、chat=0
    const r = computeThreeColLayout(fourInput(900, { chatCollapsed: true }));
    expect(r).toMatchObject({
      leftWidth: 180,
      rightWidth: 232,
      previewWidth: 900 - 180 - 232,
      middleWidth: 0,
      scrollX: false,
    });
  });

  it('chatCollapsed 缺省/undefined → 输出与现状逐字段相等（回归保护）', () => {
    const base = fourInput(1424);
    const withUndef = computeThreeColLayout({ ...base, chatCollapsed: undefined });
    const without = computeThreeColLayout(base);
    // 4 槽默认：left=220 / preview=360 / right=272 / chat=572
    expect(without).toMatchObject({ leftWidth: 220, previewWidth: 360, rightWidth: 272, middleWidth: 572, scrollX: false });
    expect(withUndef).toEqual(without);
  });

  it('chatCollapsed=true 时 preview.collapsed 同时为 true → 门态优先 preview 吞并（真实链路互斥：door=left 上报 preview.collapsed 必 false）', () => {
    const r = computeThreeColLayout(fourInput(1600, { chatCollapsed: true, preview: { setting: PV_WIDTH_DEFAULT, collapsed: true } }));
    // door 单值：preview.collapsed=true 只在 door=right 上报（previewHidden=door==='right'），与 door=left（chatCollapsed）互斥。
    // 门态最高优先级：chatCollapsed=true → preview 必占满门框（吞并），preview.collapsed 字段不生效。
    expect(r).toMatchObject({ leftWidth: 220, rightWidth: 272, previewWidth: 1600 - 220 - 272, middleWidth: 0, scrollX: false });
  });

  it('chatCollapsed=true 拖拽场景（场景 A）→ 走既有拖拽路径（chatCollapsed 仅场景 B 生效）', () => {
    const r = computeThreeColLayout(fourInput(1200, {
      chatCollapsed: true,
      dragging: 'preview',
      preview: { setting: 600, collapsed: false },
      leftCurrent: 260,
      rightCurrent: 300,
    }));
    // 拖拽路径不受 chatCollapsed 影响：preview 受 dragDynMax4 上限约束
    expect(r).toMatchObject({ leftWidth: 260, rightWidth: 300, previewWidth: 320 });
  });
});

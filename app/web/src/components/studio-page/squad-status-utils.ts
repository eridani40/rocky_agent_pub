/**
 * squad-status-utils —— Squad 成员状态入口的派生纯函数 + ChatNode 公共 helper（v0.0.268）
 * 参考: specs/ui/components/studio-page/component-squad-status-modal.md
 *       specs/tech/version_logs/v0.0.268/change_plan.md（决策① DRY + 决策③ badge 口径）
 *
 * 职责：
 *   - buildMemberChatNode：从 SeatsPanel 抽出的公共 ChatNode 组装 helper（面板进入对话与
 *     坐席卡同源组装，tag 规则 leader → squadTree.tagLeader / mate → squadTree.tagSingle）
 *   - deriveRunningCount：running badge 计数（deployed 成员 isRunningState 计数含 leader，
 *     suspended/benched 不计——对齐 seats isRunning 口径）
 *   - derivePanelRows：面板 running/idle 分区行派生（benched 过滤；statusTextSource 复用）
 *
 * 边界：全部纯函数无副作用（UT 覆盖）；t 由消费方注入（本模块不依赖 i18n 实例）。
 */
import type { TFunction } from 'i18next';
import type { SessionState } from '../chat-page/types';
import type { ChatNode } from './chat-node';
import type { Member, SquadDetail } from './squad-types';
import {
  derivePresence,
  deriveStatusTextSource,
  isRunningState,
  type SeatPresence,
  type SeatRow,
} from './use-seats-data';

/**
 * 单聊 ChatNode 公共组装（与 SeatsPanel 现组装逐字节一致，DRY 迁移）。
 * tag 派生规则：leader → `squadTree.tagLeader` / mate → `squadTree.tagSingle`（同 use-board-at-mention 源）。
 * @param detail squad 详情（含 members + name + id）
 * @param memberId 目标成员 id
 * @param t i18n 翻译函数（studio ns；消费方注入）
 * @returns ChatNode；member 不存在返 null
 */
export function buildMemberChatNode(
  detail: SquadDetail,
  memberId: string,
  t: TFunction,
): ChatNode | null {
  const m = detail.members.find((mm) => mm.id === memberId);
  if (!m) return null;
  return {
    sessionId: m.sessionId,
    title: m.name,
    tag:
      m.role === 'leader'
        ? t('studio:squadTree.tagLeader', { name: detail.name })
        : t('studio:squadTree.tagSingle', { name: detail.name }),
    squadId: detail.id,
  };
}

/**
 * running badge 计数：遍历 deployed 成员 sessionId，`isRunningState(stateMap[sid])`
 * （running/interrupting）计数，**含 leader**；suspended/benched 不计。
 * 口径与 seats isRunning 一致（INV-2：suspended = loop 已退出等用户回填，不算运行中）。
 * @param detail squad 详情（members 含 state/sessionId）
 * @param memberStateMap 仅成员 sessionId 子集的 stateMap（page-studio 派生下传）
 * @returns running 成员数（无成员 → 0）
 */
export function deriveRunningCount(
  detail: SquadDetail,
  memberStateMap: Record<string, SessionState>,
): number {
  let count = 0;
  for (const m of detail.members) {
    if (m.state !== 'deployed') continue; // benched 不计（active 视图口径）
    if (isRunningState(memberStateMap[m.sessionId])) count++;
  }
  return count;
}

/** 面板单行派生数据（running/idle 分区行；member 全量透传供渲染 avatar/name/presence） */
export interface PanelRow {
  member: Member;
  isLeader: boolean;
  /** presence 三态（fallback 文案键依据；与 seats derivePresence 同源） */
  presence: SeatPresence;
  /** 状态行文案来源：currentWork 优先，其次 i18n fallback（同 seats deriveStatusTextSource） */
  statusTextSource: SeatRow['statusTextSource'];
}

/** 面板分区结果（running 上 / idle 中 / benched 下；某区无成员 → 空数组，组件不渲染该区标题） */
export interface PanelRows {
  running: PanelRow[];
  idle: PanelRow[];
  /** benched 成员第三分区（v0.0.288 不再过滤；showBenched=true 时渲染） */
  benched: PanelRow[];
}

/**
 * 面板行派生：三分区——running（deployed + isRunningState）/ idle（deployed + 非 running，含 suspended）
 * / benched（state === 'benched'，不再过滤）。行 = { member, isLeader, presence, statusTextSource }
 * （presence/statusTextSource 复用 use-seats-data 同源派生）。组内顺序保持 detail.members 顺序
 * （后端已给稳定排序；本函数不改输入）。
 * @param detail squad 详情（members 含 state/sessionId/currentWork/role）
 * @param memberStateMap 仅成员 sessionId 子集的 stateMap
 * @returns { running, idle, benched } 三组行（纯函数，不 mutate 输入）
 */
export function derivePanelRows(
  detail: SquadDetail,
  memberStateMap: Record<string, SessionState>,
): PanelRows {
  const running: PanelRow[] = [];
  const idle: PanelRow[] = [];
  const benched: PanelRow[] = [];
  for (const m of detail.members) {
    const sessionState = memberStateMap[m.sessionId];
    const row: PanelRow = {
      member: m,
      isLeader: m.role === 'leader',
      presence: derivePresence(m, sessionState),
      statusTextSource: deriveStatusTextSource(m),
    };
    if (m.state === 'benched') {
      // benched 归第三分区（不再过滤；首页「全部」视图通过 showBenched=true 渲染）
      benched.push(row);
    } else if (isRunningState(sessionState)) {
      running.push(row);
    } else {
      idle.push(row);
    }
  }
  return { running, idle, benched };
}

/**
 * use-preview-collapsed —— 预览区门三态 hook（[老板第三批补充] 从 use-preview-tabs 抽离；v0.0.329 门模型扩展）
 * 参考: specs/prd/version_logs/v0.0.329-region23-door.md §3（三态）/§3.5（持久化）
 *       specs/tech/version_logs/v0.0.329/change_plan.md D1（method 级契约）
 *
 * 职责：门三态（door）状态管理 + per session localStorage 持久化 + 旧 collapsed 语义桥接。
 *   use-preview-tabs 一行接入：`const { collapsed, setCollapsed, door, setDoor } = usePreviewCollapsed(sessionId)`。
 *
 * 三态语义（v0.0.329 门模型）：
 *   - center（默认）：2/3 共存（chat flex + preview 各自宽）
 *   - right：门滑最右，preview 被遮、chat 占满门框（= 旧 collapsed=true 路径）
 *   - left：门滑最左，chat 被遮、preview 占满门框（新增 chatCollapsed 引擎分支）
 *
 * 旧 collapsed 消费方零改：collapsed 派生 = door !== 'center'；setCollapsed(v) 桥接 setDoor(v?'right':'center')。
 */
import { useCallback, useEffect, useState } from 'react';

/** 门三态（D1，供 context / 消费方复用） */
export type DoorState = 'center' | 'left' | 'right';

/** localStorage key（per session）——旧 collapsed 态（兼容保留） */
function lsKey(sid: string): string {
  return `pv-collapsed-${sid}`;
}

/** localStorage key（per session）——门三态（D1） */
function doorLsKey(sid: string): string {
  return `pv-door-${sid}`;
}

/** 读取 collapsed 态（per session localStorage）。旧 key，保留供迁移/旧消费方读取 */
export function readPvCollapsed(sid: string): boolean {
  try {
    return localStorage.getItem(lsKey(sid)) === '1';
  } catch {
    return false;
  }
}

/** 写入 collapsed 态（per session localStorage）。旧 key，保留供旧消费方兼容 */
export function writePvCollapsed(sid: string, v: boolean): void {
  try {
    localStorage.setItem(lsKey(sid), v ? '1' : '0');
  } catch { /* 隐私模式 / 配额满 → 静默 */ }
}

/**
 * 读取门三态（per session localStorage）。
 * 迁移（PRD §3.5/§10，用户无感）：pv-door 缺省时读旧 pv-collapsed，
 *   '1'（旧收起）→ 'right'（preview 被遮）；否则 → 'center'。坏值兜底 'center'。
 */
export function readPvDoor(sid: string): DoorState {
  try {
    const raw = localStorage.getItem(doorLsKey(sid));
    if (raw === 'center' || raw === 'left' || raw === 'right') return raw;
    if (raw !== null) return 'center'; // 坏值兜底
    // pv-door 缺省 → 迁移旧 pv-collapsed
    return readPvCollapsed(sid) ? 'right' : 'center';
  } catch {
    return 'center';
  }
}

/**
 * 写入门三态（per session localStorage）。
 * 同步写旧 pv-collapsed（door !== 'center' → '1'）保旧消费方兼容。异常静默（隐私模式）。
 */
export function writePvDoor(sid: string, v: DoorState): void {
  try {
    localStorage.setItem(doorLsKey(sid), v);
  } catch { /* 静默 */ }
  // 同步旧 key：door !== 'center'（任一门被遮）→ 旧 collapsed='1'，保旧消费方兼容
  writePvCollapsed(sid, v !== 'center');
}

/**
 * 预览区门三态 hook。door per session localStorage 持久化。
 * @returns door 当前门态（center/left/right）
 * @returns setDoor 设置门态（含 localStorage 持久化）
 * @returns collapsed 派生 = door !== 'center'（旧语义：preview 被遮；right 态等价旧 collapsed=true）
 * @returns setCollapsed 旧签名桥接 = setDoor(v ? 'right' : 'center')（use-preview-tabs 调用零改语义）
 */
export function usePreviewCollapsed(sessionId: string) {
  const [door, setDoorState] = useState<DoorState>(() => readPvDoor(sessionId));

  // [329 blocking 修复] sessionId 变化 → 重读对应会话的门态（root 挂载 sid='' → 点进会话 sid 变化；
  //   若不用 effect 重读，门态会固化为 root 的 center，切会话不恢复各自持久化门态）
  useEffect(() => {
    setDoorState(readPvDoor(sessionId));
  }, [sessionId]);

  const setDoor = useCallback((v: DoorState) => {
    setDoorState(v);
    writePvDoor(sessionId, v);
  }, [sessionId]);

  // 旧签名桥接：setCollapsed(true) = 门滑最右（preview 被遮）；setCollapsed(false) = 回居中
  const setCollapsed = useCallback((v: boolean) => {
    setDoor(v ? 'right' : 'center');
  }, [setDoor]);

  // collapsed 派生：任一门被遮（非 center）即旧 collapsed 语义
  const collapsed = door !== 'center';

  return { collapsed, setCollapsed, door, setDoor };
}

/**
 * use-tab-dirty-aggregator — tab 级 dirty/save 聚合 hook
 * [v0.0.316-fix] 方案 B：dirty 走声明式 state（section→reportDirty→setDirtyMap→re-render），save/reset 走 ref
 * 参考: specs/tech/version_logs/v0.0.316/fix-aggregator-dirty-report.md
 *
 * 职责：收集 tab 内多个 section 的 save/reset ref + dirty state，聚合为 tab 级 dirty/save。
 *   - register(key)：返回 ref 回调（挂到 section forwardRef），unmount 时自动传 null 清理
 *   - reportDirty(key, dirty)：section dirty 变化上报（声明式，驱动 page re-render）
 *   - isDirty()：查 dirtyMap（state 驱动），任一 section dirty → tab dirty
 *   - saveAll()：Promise.allSettled（部分失败不中断），返回 { ok, failed }
 *   - resetAll()：遍历调 reset + 清 dirtyMap（丢弃全部 draft）
 *
 * 设计（方案 B）：
 *   - dirty 判定走 useState（section 上报变化 → setState → page re-render → save bar 亮）
 *   - save/reset 走 useRef<Map>（命令式调用，不触发 re-render）
 *   - 两部分分离，各走最合适的路
 */

import { useCallback, useRef, useState } from 'react';

/**
 * section 向 tab 暴露的保存句柄（forwardRef + useImperativeHandle 契约）。
 * [v0.0.316-fix] 去掉 isDirty——dirty 改由 onDirtyChange callback 上报（声明式 state）。
 */
export interface SectionSaveHandle {
  /** 保存（提交 draft 到后端）；返回 Promise，reject 表示失败 */
  save: () => Promise<void>;
  /** 重置（draft 回 baseline，丢弃改动） */
  reset: () => void;
}

/** saveAll 返回值 */
export interface SaveAllResult {
  /** 全部成功 */
  ok: boolean;
  /** 失败的 section key 列表（allSettled rejected 的） */
  failed: string[];
}

/** tab 级 dirty/save 聚合 hook（方案 B：state dirty + ref save） */
export function useTabDirtyAggregator() {
  /** ref 仅管 save/reset（命令式，不触发 re-render） */
  const handles = useRef<Map<string, SectionSaveHandle>>(new Map());

  /** dirty 走声明式 state（section 上报变化 → setState → page re-render → save bar 亮） */
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});

  /** section dirty 变化上报（section useEffect 内调） */
  const reportDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyMap((prev) => {
      if (prev[key] === dirty) return prev; // 无变化不 setState（避免无效 re-render）
      return { ...prev, [key]: dirty };
    });
  }, []);

  /** ref 回调：挂到 section forwardRef（save/reset 用） */
  const register = useCallback((key: string) => {
    return (handle: SectionSaveHandle | null) => {
      if (handle === null) {
        handles.current.delete(key);
      } else {
        handles.current.set(key, handle);
      }
    };
  }, []);

  /** tab 级 dirty：声明式查询（读 state，不遍历 ref Map） */
  const isDirty = useCallback(() => {
    return Object.values(dirtyMap).some(Boolean);
  }, [dirtyMap]);

  /** tab 级保存：allSettled（部分失败不中断），返回 { ok, failed } */
  const saveAll = useCallback(async (): Promise<SaveAllResult> => {
    const dirtyKeys = Object.entries(dirtyMap)
      .filter(([, d]) => d)
      .map(([k]) => k);
    if (dirtyKeys.length === 0) return { ok: true, failed: [] };
    const results = await Promise.allSettled(
      dirtyKeys.map((k) => handles.current.get(k)?.save()),
    );
    const failed: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') failed.push(dirtyKeys[i]!);
    });
    return { ok: failed.length === 0, failed };
  }, [dirtyMap]);

  /** tab 级重置：遍历调 reset + 同步清 dirtyMap */
  const resetAll = useCallback(() => {
    for (const handle of handles.current.values()) {
      handle.reset();
    }
    setDirtyMap({});
  }, []);

  return { register, reportDirty, isDirty, saveAll, resetAll, dirtyMap };
}

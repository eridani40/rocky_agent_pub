/**
 * task-hooks — task 写入后的自动依赖 transition（panorama_builtin §4）.
 * 参考: specs/tech/squad/[P1]panorama_builtin.md §4（hook 设计）+ §8（不变量#3）
 *
 * 触发：task create / update（patch 含 dependencies 或 status）/ transition 后调 afterTaskWrite.
 *
 * 不变量（panorama_builtin §8 #3 — 自动 transition 不走用户路径）：
 *   - source='system' 直调 store.transitionInstance（区分 agent/drag/system）
 *   - 禁走 runTransition / validateTransition（避免 self-loop：hook→transition→hook 递归）
 *   - 同值跳过（防事件洪水 + 幂等）
 *   - 单层依赖（不递归传递闭包）→ 天然无环
 */
import type { PanoramaEntityStore } from '../store/panorama_store';
import { TASK_STATUS } from './task-schema';

/**
 * 解析 dependencies 字段值（string）→ task id 数组.
 * 容错：非 string 输入返 []；按逗号/空白分隔 + 过滤空.
 */
export function parseDeps(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 简易 task 实例形状（hook 内部用，避免 any；与 reminder-deps 的 TaskLike 不同——那只覆盖 provider 产出子集） */
interface TaskInstance {
  id: string;
  status?: unknown;
  dependencies?: unknown;
}

/**
 * task 写入后置 hook：重算所有 task 的 waiting/todo 状态.
 *
 * 规则（panorama_builtin §4）：
 *   - 依赖未满足（任一非 done）+ 当前 todo → 转 waiting
 *   - 依赖全 done + 当前 waiting → 回 todo
 *   - 其他情况（in_progress / done / 同态）跳过
 *
 * 同值跳过：已是目标态不动（防 transitionInstance 仍 append 事件造成洪水）.
 * 单层：只看直接依赖，不递归（hook 内 visits 全 task 一次，O(n²) 查找）.
 *
 * @param store 写入刚发生的 store（复用其 transitionInstance + listInstances；readBoard 直查 task entity）
 */
export function afterTaskWrite(
  store: PanoramaEntityStore,
): void {
  // 直查 board 是否含 task entity（task 是普通 entity，落盘在 board.yaml）
  const schema = store.readBoard();
  if (!schema?.entities.task) return;

  const tasks = store.listInstances('task') as unknown as TaskInstance[];
  // id → status 查表（解析依赖状态用）
  const statusOf = new Map<string, string>();
  for (const t of tasks) {
    const id = typeof t.id === 'string' ? t.id : '';
    if (id) statusOf.set(id, typeof t.status === 'string' ? t.status : '');
  }

  for (const t of tasks) {
    const id = typeof t.id === 'string' ? t.id : '';
    if (!id) continue;
    const cur = typeof t.status === 'string' ? t.status : '';
    const deps = parseDeps(t.dependencies);

    // 无依赖 → 不参与 waiting 自动维护（todo 就是 todo）
    if (deps.length === 0) continue;

    const allDone = deps.every((d) => statusOf.get(d) === TASK_STATUS.DONE);

    if (!allDone && cur === TASK_STATUS.TODO) {
      // 依赖未满足 + todo → waiting（system 自动）
      store.transitionInstance('task', id, 'status', cur, TASK_STATUS.WAITING, { source: 'system' });
    } else if (allDone && cur === TASK_STATUS.WAITING) {
      // 依赖全 done + waiting → todo（system 自动解除）
      store.transitionInstance('task', id, 'status', cur, TASK_STATUS.TODO, { source: 'system' });
    }
    // 其他情况（in_progress / done / 已是目标态）跳过 — 同值跳过防事件洪水
  }
}

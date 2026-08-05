/**
 * useMemoryCrud —— memory UI CRUD 状态 + 回调复用 hook（useLifecycle 四方法契约）
 * 参考: specs/api/overall/15-memory-ui.md §3-§6（GET/POST/PATCH/DELETE /memory/:scope）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.1（Collection 形）
 *
 * 抽出 section-memory-panel（session scope，带 sessionId）+ section-user-memory（[v0.0.112] global
 * scope，无 sessionId）共享的 CRUD 逻辑：entries/loading/error state + refetch/handleSave/handleArchive。
 * 两 panel 只负责自己的 UI（header / 列表容器 / empty 文案），逻辑统一走本 hook。
 *
 * GET-once 无 SSE：打开 tab GET 一次，写操作（POST/PATCH/DELETE）后 refetch；不实现实时推送。
 *
 * 数据流走 useLifecycle 四方法（onInit 拿 ctx + AbortSignal 守卫 + deps 变化自动 onDestroy+重 onInit）：
 *   - ctx 是 Collection<MemoryEntry>（list 三形）：onInit GET 结果包成 Collection（keyOf=按 entry.name 索引）；
 *     对外仍暴露 entries 数组（=ctx.items），调用方无感。GET-once 无 SSE 推送，故无 onEvent。
 *   - onInit 失败的 error 由 useLifecycle 内部管（initError）；mutation 失败（archive）的 error 由本地 mutError 管
 *     （useLifecycle 不暴露 setError；本 hook 用 mutError 叠加保持旧「archive 失败 UI 可见」语义）
 *   - 不变量②遵守：onInit 内仅返回 ctx（fetch + signal.aborted 校验），不调 setState
 *   - 不加 poll（PRD §2.2 OUT：GET-once 无 SSE 不轮询）；写操作后走 reload 命令式重拉
 */
import { useCallback, useState } from 'react';
import {
  archiveMemory,
  listMemory,
  patchMemory,
  writeMemory,
  type MemoryEntry,
  type MemoryScope,
  type MemoryWriteInput,
} from '../../lib/memory-api';
import { useLifecycle } from '../../lib/use-lifecycle';
import { type Collection } from '../../lib/lifecycle-shapes';
import type { MemoryEditorInitial } from './component-memory-editor-modal';

interface EditorState {
  open: boolean;
  initial?: MemoryEditorInitial; // undefined = 新建
}

export interface MemoryCrud {
  entries: MemoryEntry[];
  loading: boolean;
  error: string | null;
  editor: EditorState;
  setEditor: (s: EditorState) => void;
  refetch: () => Promise<void>;
  handleSave: (input: MemoryWriteInput) => Promise<void>;
  handleArchive: (name: string) => Promise<void>;
}

/**
 * @param scope 'global' | 'session'（[v0.0.112] 对外统一命名）
 * @param sessionId scope=session 必填（sidQuery 强校验），scope=global 留空
 */
export function useMemoryCrud(scope: MemoryScope, sessionId?: string): MemoryCrud {
  const [editor, setEditor] = useState<EditorState>({ open: false });
  // mutation 失败的 error（archive）。useLifecycle 仅管 init 失败 error，不暴露 setError，
  // 所以 archive catch 单独存 mutError，与 initError 合并对外暴露（保旧行为）
  const [mutError, setMutError] = useState<string | null>(null);

  // ctx=Collection<MemoryEntry>（keyOf 按 name 索引）；对外暴露 entries=ctx.items。
  // GET-once 无 SSE 推送 → 无 onEvent；无自建资源要清 → onDestroy 省略（timer/SSE 由 hook 自动回收，本 hook 无声明）。
  const { ctx: coll, loading, error: initError, reload } = useLifecycle<Collection<MemoryEntry>>({
    onInit: async ({ signal }) => {
      const items = await listMemory(scope, { sessionId });
      // 不变量②：fetch 后必须校验 signal.aborted 才能「生效」（杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return { items, keyOf: (e: MemoryEntry) => e.name };
    },
    deps: [scope, sessionId],
  });

  // refetch：命令式刷新（清 mutError + 调 reload 重 init），保持旧 refetch 行为（开始时清 error）
  const refetch = useCallback(async () => {
    setMutError(null);
    await reload();
  }, [reload]);

  const handleSave = useCallback(
    async (input: MemoryWriteInput) => {
      const isEdit = !!editor.initial?.name;
      if (isEdit && editor.initial?.name) {
        const { name: _omit, ...patch } = input;
        await patchMemory(scope, editor.initial.name, patch, sessionId);
      } else {
        await writeMemory(scope, input, sessionId);
      }
      await refetch();
      setEditor({ open: false });
    },
    [editor.initial, scope, sessionId, refetch],
  );

  const handleArchive = useCallback(
    async (name: string) => {
      try {
        await archiveMemory(scope, name, sessionId);
        await refetch();
      } catch (e) {
        // archive 失败：旧版 setError 显示；新版 useLifecycle 不暴露 setError，
        // 走本地 mutError（与 initError 合并对暴露，下次 refetch 清）
        setMutError(e instanceof Error ? e.message : '归档失败');
      }
    },
    [scope, sessionId, refetch],
  );

  // entries：onInit 未完成时 ctx 为 null，对外暴露空数组（保旧 entries 初值 [] 语义）；
  // ctx 是 Collection，渲染直接取 ctx.items（keyOf 不外泄给调用方）。
  // error：mutError 优先（mutation 失败更具体），其次 initError（GET 失败）
  return {
    entries: coll?.items ?? [],
    loading,
    error: mutError ?? initError?.message ?? null,
    editor,
    setEditor,
    refetch,
    handleSave,
    handleArchive,
  };
}

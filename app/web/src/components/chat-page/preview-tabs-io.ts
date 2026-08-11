/**
 * preview-tabs-io —— 预览区 tab IO/工具函数（v0.0.320 D4，独立文件控 use-preview-tabs 行数）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D4
 *
 * 从 use-preview-tabs.ts 拆出：readRockyShell / readFileContent（统一读文件：workspace → HTTP 带 version；
 * absolute → IPC version=''）+ neighborId（焦点左移）+ makeTab（tab 工厂）。
 * 纯函数/无 React 依赖，供状态机与测试引用。
 */
import { readWorkspaceFile } from '../../lib/chat-api';
import type { OpenLocalTarget } from '../../lib/open-local-path';
import type { PreviewTab } from './preview-tabs-types';

/** 取 window.rockyShell（absolute 源 IPC 读写用；jsdom/无壳环境 undefined） */
export function readRockyShell(): typeof window.rockyShell | undefined {
  return typeof window !== 'undefined' ? window.rockyShell : undefined;
}

/** 统一读文件（workspace → HTTP 带 version；absolute → IPC，version=''） */
export async function readFileContent(
  sessionId: string,
  source: 'workspace' | 'absolute',
  path: string,
): Promise<{ content: string; version: string }> {
  if (source === 'workspace') {
    const res = await readWorkspaceFile(sessionId, { path });
    return { content: res.content, version: res.version ?? '' };
  }
  const api = readRockyShell();
  if (!api) throw new Error('打开失败');
  const res = await api.readFileText(path);
  if (!res.ok || typeof res.content !== 'string') {
    throw new Error(res.reason === 'not-found' ? '文件未找到' : '打开失败');
  }
  return { content: res.content, version: '' };
}

/** 焦点左移：target 左侧有 tab → 左邻居；无 → 右邻居；无相邻 → null（空态） */
export function neighborId(tabs: PreviewTab[], currentId: string): string | null {
  const idx = tabs.findIndex((t) => t.id === currentId);
  if (idx < 0) return null;
  const left = idx > 0 ? tabs[idx - 1] : undefined;
  if (left) return left.id;
  const right = idx < tabs.length - 1 ? tabs[idx + 1] : undefined;
  if (right) return right.id;
  return null;
}

/** tab 工厂（id = `${source}:${path}`） */
export function makeTab(target: OpenLocalTarget): PreviewTab {
  return {
    id: `${target.source}:${target.path}`,
    path: target.path,
    fileName: target.fileName,
    subtitle: target.subtitle,
    source: target.source,
    format: target.format ?? 'txt',
    version: '',
    mode: 'view',
    dirty: false,
    content: '',
    draft: '',
    loadState: 'idle',
  };
}

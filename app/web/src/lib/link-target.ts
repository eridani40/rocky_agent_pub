/**
 * link-target —— markdown 链接点击分发 lib（v0.0.253）
 * 参考: specs/tech/version_logs/v0.0.253/change_plan.md 模块 E
 *       specs/prd/version_logs/v0.0.253.md §3.2（分发逻辑表）
 *
 * 三职责（全部纯函数，便于 UT）：
 *   1. isDangerousScheme(url) — 危险协议拦截（单一权威，从 primitive-markdown-view isSafeUrl 提取语义）
 *   2. classifyLinkTarget(target) — 分类为 web / local / dangerous
 *   3. openLinkTarget(target, opts) — 按分类路由到 openExternal / openPath / 内置 viewer 回调
 *
 * 路由策略：
 *   - dangerous → 不动（防 XSS）
 *   - web       → window.rockyShell.openExternal（Electron） / window.open（非 Electron 浏览器兜底）
 *   - local     → isBuiltinEditable(target) ? opts.onLocalViewer(chatLinkTarget) : window.rockyShell.openPath
 *                 非 Electron + 非 viewer 型 → noop（浏览器无法系统打开）
 *
 * workspace 相对路径仍走 HTTP readWorkspaceFile（由 viewer 内部调，不经本 lib 路由）。
 */

/** 链接分类（决定打开方式） */
export type LinkTargetKind = 'web' | 'local' | 'dangerous';

/** onLocalViewer 回调参数（viewer 据此分流内容源） */
export interface ChatLinkTarget {
  /** 原始 target（main 侧负责展开 ~ / file://；workspace 相对原样） */
  path: string;
  /** 路径来源：workspace 相对（HTTP 读）/ absolute（IPC 读） */
  source: 'workspace' | 'absolute';
  /** basename（modal fileName 用） */
  fileName: string;
}

/** openLinkTarget 的可选回调集（无 onLocalViewer 时 local-12 格式降级为系统打开） */
export interface OpenLinkTargetOpts {
  /** 12 格式本地文件回调（消费方挂内置 viewer modal） */
  onLocalViewer?: (target: ChatLinkTarget) => void;
}

/**
 * 危险协议拦截（单一权威，与原 isSafeUrl 语义逐字一致——不放宽不收紧）。
 * 拦 javascript: / vbscript: / data:（含前导空白，大小写不敏感）。
 */
export function isDangerousScheme(url: string): boolean {
  return /^\s*(javascript|vbscript|data):/i.test(url);
}

/**
 * 分类 target：先判 dangerous 再判 web scheme（顺序不变，dangerous 优先），其余为 local。
 *   - dangerous → 'dangerous'（isDangerousScheme）
 *   - file:// 走 'local'（不归 web：本地文件应 openPath / viewer，非浏览器）
 *   - web scheme `^[a-z][a-z0-9+.-]*:` 命中（http/https/mailto/ftp 等）→ 'web'
 *   - 其余（绝对路径、~、workspace 相对）→ 'local'
 */
export function classifyLinkTarget(target: string): LinkTargetKind {
  if (isDangerousScheme(target)) return 'dangerous';
  if (/^file:/i.test(target)) return 'local';
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return 'web';
  return 'local';
}

/**
 * 从 target 派生 ChatLinkTarget（onLocalViewer 回调参数）。
 *
 * source 判定：
 *   - `file://` / `/` 开头 / `~` 开头 / win 盘符 `X:\` / `X:/` → 'absolute'（main 侧展开）
 *   - 其余（workspace 相对，如 `config.yaml` / `./notes.md`）→ 'workspace'（HTTP readWorkspaceFile）
 *
 * fileName = basename（最后一段，兼容 `/` 与 `\`）。
 */
export function toChatLinkTarget(target: string): ChatLinkTarget {
  const isAbsolute =
    target.startsWith('file://') ||
    target.startsWith('/') ||
    target.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(target);
  const slash = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  const fileName = slash >= 0 ? target.slice(slash + 1) : target;
  return {
    path: target,
    source: isAbsolute ? 'absolute' : 'workspace',
    fileName: fileName || target,
  };
}

// 12 内置格式判定复用 file-format.ts 单一权威（isBuiltinEditable = getFileFormat!==null，
// 含 .env / .env.* basename 特殊匹配），避免两份格式集漂移。
import { isBuiltinEditable } from './file-format';

/** Electron 环境 guard（dev 浏览器无 window.rockyShell） */
function hasRockyShell(): boolean {
  return typeof window !== 'undefined' && !!window.rockyShell;
}

/**
 * 按分类路由打开 target。
 *
 * @param target markdown 链接 raw target
 * @param opts   消费方提供 onLocalViewer 回调（无 Provider 时不挂 viewer modal）
 */
export function openLinkTarget(target: string, opts: OpenLinkTargetOpts = {}): void {
  const kind = classifyLinkTarget(target);
  if (kind === 'dangerous') return; // 防 XSS：不动
  if (kind === 'web') {
    // Electron → 系统浏览器；非 Electron 浏览器 → window.open 兜底
    if (hasRockyShell()) {
      void window.rockyShell!.openExternal(target);
    } else if (typeof window !== 'undefined') {
      window.open(target, '_blank', 'noopener');
    }
    return;
  }
  // local：12 格式 → 内置 viewer（无 onLocalViewer 回调时降级走 openPath 系统打开）；其它 → 系统默认应用
  if (isBuiltinEditable(target)) {
    if (opts.onLocalViewer) {
      opts.onLocalViewer(toChatLinkTarget(target));
      return;
    }
    // 无 Provider（其它消费方：md-editor viewer / skill 预览 / feishu doc）→ 降级系统打开
    if (hasRockyShell()) {
      void window.rockyShell!.openPath(target);
    }
    return;
  }
  if (hasRockyShell()) {
    void window.rockyShell!.openPath(target);
  }
  // 非 Electron + 非内置格式 → noop（浏览器无法系统打开）
}

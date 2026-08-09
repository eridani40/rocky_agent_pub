/**
 * link-target —— markdown 链接点击分发 lib（v0.0.253 / v0.0.280 改调共享分发）
 * 参考: specs/tech/version_logs/v0.0.253/change_plan.md 模块 E
 *       specs/tech/version_logs/v0.0.280/change_plan.md 行 26/27
 *       specs/prd/version_logs/v0.0.253.md §3.2（分发逻辑表）
 *
 * 三职责（全部纯函数，便于 UT）：
 *   1. isDangerousScheme(url) — 危险协议拦截（单一权威，从 primitive-markdown-view isSafeUrl 提取语义）
 *   2. classifyLinkTarget(target) — 分类为 web / local / dangerous
 *   3. openLinkTarget(target, opts) — 按分类路由到 openExternal / openLocalPath（内置 viewer 回调） / openPath
 *
 * 路由策略：
 *   - dangerous → 不动（防 XSS）
 *   - web       → window.rockyShell.openExternal（Electron） / window.open（非 Electron 浏览器兜底）
 *   - local     → 有 onLocalViewer → openLocalPath 共享分发（.url/image/12 格式/系统打开，≡ 右侧文件区）
 *                 无 onLocalViewer（其它消费方）→ window.rockyShell.openPath（系统打开，行为不变）
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
  /** [v0.0.280] 当前 session（openLocalPath workspace 源 .url 嗅探 + 系统打开用；无 Provider 消费方不传） */
  sessionId?: string;
}

/**
 * 危险协议拦截（单一权威，与原 isSafeUrl 语义逐字一致——不放宽不收紧）。
 * 拦 javascript: / vbscript: / data:（含前导空白，大小写不敏感）。
 */
export function isDangerousScheme(url: string): boolean {
  return /^\s*(javascript|vbscript|data):/i.test(url);
}

/**
 * 图片专用危险协议判定（v0.0.286）。
 * 与 isDangerousScheme 共存（链接仍走原函数，行为不变）。
 * 拦 javascript:/vbscript:/非 image data:；放行 data:image/（base64 内联图片白名单）。
 */
export function isDangerousImageScheme(url: string): boolean {
  if (/^\s*(javascript|vbscript):/i.test(url)) return true;
  // data: 但非 image/ → 拦截（data:text/html 等）；data:image/ → 放行
  if (/^\s*data:/i.test(url) && !/^\s*data:image\//i.test(url)) return true;
  return false;
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

// 共享分发 openLocalPath 复用 file-format.ts 单一权威（getFileFormat/isImagePath/isRemoteLinkPath，
// 含 .env / .env.* basename 特殊匹配），避免两份格式集漂移。
import { openLocalPath } from './open-local-path';

/** Electron 环境 guard（dev 浏览器无 window.rockyShell） */
function hasRockyShell(): boolean {
  return typeof window !== 'undefined' && !!window.rockyShell;
}

/**
 * 按分类路由打开 target。
 *
 * @param target markdown 链接 raw target
 * @param opts   消费方提供 onLocalViewer 回调（无 Provider 时不挂 viewer modal）
 *
 * [v0.0.280] local 分支改调 openLocalPath 共享分发（≡ 右侧文件区五路分流：
 *   .url 嗅探 / image viewer / 12 格式 editor / 系统打开）；
 *   无 onLocalViewer（其它消费方）→ 降级 rockyShell.openPath 系统打开（行为不变）。
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
  // local：有 onLocalViewer → 共享分发（.url/image/12 格式 editor/系统打开，≡ 右侧）；无 → 降级系统打开（行为不变）
  if (opts.onLocalViewer) {
    const { source, fileName } = toChatLinkTarget(target);
    openLocalPath(target, {
      sessionId: opts.sessionId,
      source,
      onEditor: (t) => opts.onLocalViewer!({ path: t.path, source, fileName: t.fileName }),
      onImageViewer: (t) => opts.onLocalViewer!({ path: t.path, source, fileName: t.fileName }),
    });
    return;
  }
  // 无 Provider（其它消费方：md-editor viewer / skill 预览 / feishu doc）→ 降级系统打开
  if (hasRockyShell()) {
    void window.rockyShell!.openPath(target);
  }
  // 非 Electron + 非内置格式 → noop（浏览器无法系统打开）
}

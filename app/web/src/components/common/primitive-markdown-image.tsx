/**
 * primitive-markdown-image —— Markdown 图片渲染 helper（v0.0.286）
 * 参考: specs/prd/version_logs/v0.0.286.md_image/prd.md §2.2（三源分流 + 三态）
 *       specs/tech/version_logs/v0.0.286.md_image/change_plan.md 行 2-5
 *
 * 从 primitive-markdown-view.tsx 拆出（保持主文件 ≤300 行，范本 gfm-table）。
 * 导出：MarkdownImage（渲染组件）+ resolveImageUrl + joinPath（纯函数）+ PrimitiveImageLightbox
 *
 * 三源分流：
 *   - web（http/https）→ 直渲 `<img src>`
 *   - data:image/ → 直渲 `<img src>`
 *   - absolute（/~/file://）→ rockyShell.readFileBinary → base64 → data URL
 *   - relative + baseDir → joinPath resolve → workspace 或 absolute 读
 *   - relative 无 baseDir → 降级 alt 文本
 */
import { useState, useEffect, useCallback } from 'react';
import { Portal } from '../../lib/portal';
import { isDangerousImageScheme } from '../../lib/link-target';
import { readWorkspaceFileBinary } from '../../lib/chat-api/workspace-api';

// ===== 纯函数（可独立 UT）=====

/** POSIX `/` join：baseDir 去尾 `/` + relative 去前 `/`。relative 带 scheme 或盘符前缀（绝对路径原样返回）。 */
export function joinPath(baseDir: string, relative: string): string {
  // relative 已是绝对路径（scheme/~/file:///win 盘符）→ 原样返回
  if (/^(https?:\/\/|~\/|file:\/\/|[a-zA-Z]:[\\/])/.test(relative)) return relative;
  const base = baseDir.replace(/\/+$/, '');
  const rel = relative.replace(/^\/+/, '');
  if (!base) return rel; // baseDir 为空（md 在根目录）→ relative 原样
  return `${base}/${rel}`;
}

/**
 * 从文件路径提取所在目录（baseDir）。
 * - 含 `/` 路径 → lastIndexOf('/') 截取（`docs/sub/a.md` → `docs/sub`）
 * - 纯文件名（无 `/`）→ 空串（`a.md` → `''`，表示根目录）
 * - 空值 → undefined（academy 等无文件场景不传）
 */
export function deriveBaseDir(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.lastIndexOf('/');
  if (idx === -1) return '';
  return filePath.slice(0, idx);
}

/** 图片 src 分类 */
export interface ImageUrlInfo {
  type: 'web' | 'data' | 'absolute' | 'relative';
  url: string;
  resolvedPath?: string;
}

/**
 * resolve 图片 src → { type, url, resolvedPath? }
 * web=http/https 前缀；data=data:image/ 前缀；absolute=/~/file:// / win 盘符；relative=其余
 * relative + baseDir → joinPath 后再判 absolute/workspace
 */
export function resolveImageUrl(src: string, baseDir?: string): ImageUrlInfo {
  if (/^https?:\/\//i.test(src)) return { type: 'web', url: src };
  if (/^data:image\//i.test(src)) return { type: 'data', url: src };
  if (/^(\/|~\/|file:\/\/|[a-zA-Z]:[\\/])/.test(src)) return { type: 'absolute', url: src };
  // relative + baseDir（含空串=根目录）→ joinPath resolve
  if (baseDir !== undefined) {
    return { type: 'relative', url: src, resolvedPath: joinPath(baseDir, src) };
  }
  return { type: 'relative', url: src };
}

// ===== PrimitiveImageLightbox（轻量放大 modal ~55 行）=====

/** 轻量图片放大 modal（Portal+遮罩+全尺寸 `<img>`+Esc/遮罩/✕ 三路关闭） */
export function PrimitiveImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center pointer-events-auto"
        style={{ background: 'rgba(10,10,10,.8)' }}
        onClick={onClose}
      >
        <img
          src={src}
          alt={alt}
          className="max-h-[88vh] max-w-[92vw] object-contain rounded-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="关闭"
          className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl"
        >
          ✕
        </button>
      </div>
    </Portal>
  );
}

// ===== MarkdownImage（block 级图片渲染组件）=====

interface MarkdownImageProps {
  src: string;
  alt: string;
  baseDir?: string;
  sessionId?: string;
  /** [BUG-002] DI：workspace 二进制读取（默认走 readWorkspaceFileBinary HTTP；UT 可注入 mock 测成功路径） */
  readBinary?: (sessionId: string, path: string) => Promise<string>;
}

/** 加载三态 */
type ImgLoadState = 'loading' | 'loaded' | 'error' | 'too-large';

/**
 * block 级图片渲染组件（三源分流 + 加载三态 + 点击放大）。
 * web/data → 直渲；absolute → readFileBinary IPC；relative → joinPath resolve → workspace 或 IPC。
 */
export function MarkdownImage({ src, alt, baseDir, sessionId, readBinary }: MarkdownImageProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [state, setState] = useState<ImgLoadState>('loading');
  const [showLightbox, setShowLightbox] = useState(false);

  // 危险协议拦截
  const info = resolveImageUrl(src, baseDir);

  const handleOpenLightbox = useCallback(() => {
    if (imgSrc) setShowLightbox(true);
  }, [imgSrc]);

  useEffect(() => {
    // 危险协议 → 降级 alt
    if (isDangerousImageScheme(src)) {
      setState('error');
      return;
    }
    // web/data → 直渲（不异步读）
    if (info.type === 'web' || info.type === 'data') {
      setImgSrc(info.url);
      setState('loaded');
      return;
    }
    // absolute → readFileBinary IPC
    if (info.type === 'absolute') {
      setState('loading');
      const path = info.resolvedPath ?? info.url;
      window.rockyShell?.readFileBinary(path).then((res) => {
        if (res.ok && res.content) {
          setImgSrc(`data:image/unknown;base64,${res.content}`);
          setState('loaded');
        } else if (res.reason === 'too-large') {
          setState('too-large');
        } else {
          setState('error');
        }
      }).catch(() => setState('error'));
      return;
    }
    // relative + baseDir → workspace 或 absolute resolve
    if (info.type === 'relative' && info.resolvedPath) {
      setState('loading');
      if (sessionId) {
        // workspace 相对 → readWorkspaceFileBinary（HTTP）或 DI readBinary（UT）
        const readFn = readBinary ?? ((sid, path) => readWorkspaceFileBinary(sid, { path }).then((r) => r.content));
        readFn(sessionId, info.resolvedPath)
          .then((content: string) => {
            setImgSrc(`data:image/unknown;base64,${content}`);
            setState('loaded');
          })
          .catch(() => setState('error'));
      } else {
        // joinPath 后是 absolute → readFileBinary IPC
        window.rockyShell?.readFileBinary(info.resolvedPath).then((res) => {
          if (res.ok && res.content) {
            setImgSrc(`data:image/unknown;base64,${res.content}`);
            setState('loaded');
          } else if (res.reason === 'too-large') {
            setState('too-large');
          } else {
            setState('error');
          }
        }).catch(() => setState('error'));
      }
      return;
    }
    // relative 无 baseDir → 降级 alt
    setState('error');
  }, [src, info.type, info.resolvedPath, info.url, sessionId]);

  // 渲染
  if (state === 'loaded' && imgSrc) {
    return (
      <>
        <img
          src={imgSrc}
          alt={alt}
          data-testid="md-image-loaded"
          className="max-w-full rounded-lg my-1.5 cursor-zoom-in"
          onClick={handleOpenLightbox}
        />
        {showLightbox && (
          <PrimitiveImageLightbox src={imgSrc} alt={alt} onClose={() => setShowLightbox(false)} />
        )}
      </>
    );
  }

  if (state === 'loading') {
    return (
      <div data-testid="md-image-loading" className="inline-flex items-center gap-2 text-muted text-[12px] my-1.5 px-3 py-2 bg-bg-warm rounded-lg">
        🔄 {alt || '加载中...'}
      </div>
    );
  }

  if (state === 'too-large') {
    return (
      <div data-testid="md-image-too-large" className="inline-flex items-center gap-2 text-muted text-[12px] my-1.5 px-3 py-2 bg-bg-warm rounded-lg">
        ⚠️ {alt || '图片'}（超过 2MB 限制）
      </div>
    );
  }

  // error（含危险协议 / 无 baseDir / 加载失败）
  return (
    <span data-testid="md-image-error" className="text-muted text-[12px] italic">
      🖼️ {alt || src}
    </span>
  );
}

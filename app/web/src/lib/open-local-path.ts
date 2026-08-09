/**
 * open-local-path —— 本地文件打开共享分发 lib（v0.0.280）
 * 参考: specs/tech/version_logs/v0.0.280/change_plan.md 行 24/25
 *       specs/prd/version_logs/v0.0.280/prd.md D1 §2.1（老板铁律：聊天链 ≡ 右侧文件区）
 *       specs/tech/version_logs/v0.0.269/change_plan.md 行 34（右侧 handleOpen 五路分流 MUST 顺序）
 *
 * 职责：本地文件（workspace 相对 / absolute 绝对）统一分发——聊天链接与右侧文件区行为永远一致。
 * 分流顺序固定（对齐右侧 v0.0.269 MUST）：
 *   ① kind==='folder' → 系统文件管理器（workspace→openWorkspaceItem kind=folder / absolute→rockyShell.openPath）
 *   ② isRemoteLinkPath(.url) → 嗅探浏览器（workspace→openRemoteLink；absolute→readFileText+parseUrlFileContent+openWebUrl）
 *       嗅探失败降级 onEditor(format:'txt')
 *   ③ isImagePath → onImageViewer（内置只读 viewer）
 *   ④ getFileFormat!=null → onEditor(format)（内置可编辑 editor）
 *   ⑤ 其余 → 系统打开（workspace→openWorkspaceItem kind=file / absolute→rockyShell.openPath）
 *
 * 边界：不做危险协议处理（调用方 link-target 已拦）；不新开格式集/图片白名单（复用 file-format 单一权威）；
 *   kind=undefined（聊天链）跳过文件夹分支，目录路径落 openPath 行为等价。
 *   注意：本 lib **不 import link-target**（link-target local 分支 import 本 lib —— 若反向 import 形成循环依赖，
 *   vitest mock 下模块加载顺序异常导致命名绑定 undefined）。.url 嗅探命中后的 web 打开复用 remote-link 的
 *   openWebUrl（remote-link 同样不 import link-target，双向断开环）。
 */
import { openWorkspaceItem } from './chat-api';
import { openRemoteLink, openWebUrl, parseUrlFileContent } from './remote-link';
import { getFileFormat, isImagePath, isRemoteLinkPath, type FileFormat } from './file-format';

/** 共享分发回调 target（消费方据此分流读/存） */
export interface OpenLocalTarget {
  /** 原始路径（workspace 相对 / absolute 原样） */
  path: string;
  /** basename（modal fileName 用） */
  fileName: string;
  /** 副标题（原路径） */
  subtitle: string;
  /** 12 格式命中 → 对应格式；image 分支 / 未命中 → null */
  format: FileFormat | null;
  /** 路径来源（消费方据此分流读/存） */
  source: 'workspace' | 'absolute';
}

/** openLocalPath 可选回调集（唯一权威分发的消费方契约） */
export interface OpenLocalPathOpts {
  /** workspace 源 HTTP 调用（openWorkspaceItem / openRemoteLink）用；absolute 源不需要 */
  sessionId?: string;
  /** 路径来源：workspace 相对（HTTP）/ absolute（IPC） */
  source: 'workspace' | 'absolute';
  /** 节点类型（右侧文件树传 file/dir；聊天链不传 → 跳过文件夹分支） */
  kind?: 'file' | 'folder';
  /** 文本编辑回调（12 格式 / .url 降级 txt） */
  onEditor: (target: OpenLocalTarget) => void;
  /** image 6 格式只读 viewer 回调 */
  onImageViewer: (target: OpenLocalTarget) => void;
}

/** basename（兼容 / 与 \；file-format basename 私有不导出，内部 5 行实现不破坏封装） */
function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Electron 环境 guard（dev 浏览器无 window.rockyShell） */
function hasRockyShell(): boolean {
  return typeof window !== 'undefined' && !!window.rockyShell;
}

/** workspace 源系统打开（文件夹管理器 / 默认应用），失败 console.warn 不抛 */
function openSystemWorkspace(sessionId: string | undefined, path: string, kind: 'file' | 'folder') {
  if (!sessionId) return;
  void openWorkspaceItem(sessionId, { path, kind }).catch((e) => console.warn('openWorkspaceItem failed:', e));
}

/** absolute 源系统打开（文件夹管理器 / 默认应用），非 Electron noop */
function openSystemAbsolute(path: string) {
  if (!hasRockyShell()) return;
  void window.rockyShell!.openPath(path).catch((e) => console.warn('openPath failed:', e));
}

/** .url 嗅探（absolute 源 3 行内联：readFileText + parseUrlFileContent + openWebUrl；未命中/失败降级 editor txt） */
function sniffUrlFileAbsolute(path: string, onEditor: (t: OpenLocalTarget) => void) {
  const api = typeof window !== 'undefined' ? window.rockyShell : undefined;
  const fallback = () => onEditor({ path, fileName: basename(path), subtitle: path, format: 'txt', source: 'absolute' });
  if (!api) {
    fallback();
    return;
  }
  void api
    .readFileText(path)
    .then((res) => {
      if (res.ok && typeof res.content === 'string') {
        const url = parseUrlFileContent(res.content);
        if (url) {
          openWebUrl(url);
          return;
        }
      }
      fallback();
    })
    .catch(fallback);
}

/**
 * 共享本地文件分发（唯一权威，聊天链 + 右侧 handleOpen 共用）。
 * 同步入口；.url 嗅探为异步（openRemoteLink / readFileText）→ fire-and-forget + 回调。
 */
export function openLocalPath(path: string, opts: OpenLocalPathOpts): void {
  const { sessionId, source, kind, onEditor, onImageViewer } = opts;
  const mk = (format: FileFormat | null): OpenLocalTarget => ({ path, fileName: basename(path), subtitle: path, format, source });

  // ① 文件夹 → 系统文件管理器（聊天链 kind=undefined 跳过）
  if (kind === 'folder') {
    if (source === 'workspace') openSystemWorkspace(sessionId, path, 'folder');
    else openSystemAbsolute(path);
    return;
  }

  // ② .url → 嗅探浏览器（失败降级 editor txt）
  if (isRemoteLinkPath(path)) {
    if (source === 'workspace') {
      if (!sessionId) {
        onEditor(mk('txt'));
        return;
      }
      void openRemoteLink(sessionId, path)
        .then((r) => {
          if (!r.opened) onEditor(mk('txt'));
        })
        .catch(() => onEditor(mk('txt')));
    } else {
      sniffUrlFileAbsolute(path, onEditor);
    }
    return;
  }

  // ③ image 6 格式 → 内置只读 viewer
  if (isImagePath(path)) {
    onImageViewer(mk(null));
    return;
  }

  // ④ 12 格式 → 内置可编辑 editor
  const fmt = getFileFormat(path);
  if (fmt !== null) {
    onEditor(mk(fmt));
    return;
  }

  // ⑤ 其余 → 系统默认应用打开
  if (source === 'workspace') openSystemWorkspace(sessionId, path, 'file');
  else openSystemAbsolute(path);
}

export default openLocalPath;

/**
 * browser tool dispatch helpers
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §7
 *
 * 承载：
 *   - dispatchAction：把 action 名 + typed input 派发到 BrowserSession 方法（v0.0.266 T3：
 *     返回 BrowserExecuteResult + ctx 轻量化 DispatchCtx，供 AttachModeImpl.execute 使用）
 *   - formatBrowserError：把 driver.connect / dispatch 抛出的错误转结构化 {kind,message}
 *   - extractActionParams：给 driver.executeOnce 提取 action 参数（headless 走 worker 路径）
 *   - formatExecuteError：executeOnce 失败结果转文本
 */
import type { BrowserSession, BrowserActionParams, BrowserExecuteResult } from './types';
import { BrowserError } from './types';
import type { SnapshotSink } from './mode-impl';
// 截图落盘共享出口（INV-157-3 单一出口；经 SnapshotSink 抽象由 tool.ts 注入）
import { formatSnapshotText } from '../snapshot-store';

/** browser tool 输入形状（与 tool.ts 内部 BrowserInput 一致；这里 duck typing） */
export interface BrowserInputLike {
  url?: unknown;
  ref?: unknown;
  text?: unknown;
}

/** dispatchAction 轻量执行上下文（attach impl 从 ExecuteCtx 透传；不 import ToolCtx） */
export interface DispatchCtx {
  snapshot?: SnapshotSink;
}

/**
 * 把 action 派发到 BrowserSession 上的具体方法（attach 经 AttachModeImpl 调用）。
 * 返回 BrowserExecuteResult（{ok, text?, error?}）——attach impl 直接透传；
 * screenshot 落盘经 ctx.snapshot（INV-157-1 不 inline image / INV-157-3 走单一落盘出口）。
 */
export async function dispatchAction(
  session: BrowserSession,
  action: string,
  typed: BrowserInputLike,
  ctx: DispatchCtx,
): Promise<BrowserExecuteResult> {
  try {
    switch (action) {
      case 'navigate': {
        const url = typeof typed.url === 'string' ? typed.url : '';
        if (!url) return errR('bad_request', 'browser navigate: url 必填');
        await session.navigate(url);
        return okR(`navigated to ${url}`);
      }
      case 'snapshot': {
        const r = await session.snapshot({ format: 'aria' });
        return okR(JSON.stringify(r));
      }
      case 'click': {
        const ref = typeof typed.ref === 'string' ? typed.ref : '';
        if (!ref) return errR('bad_request', 'browser click: ref 必填');
        await session.click(ref);
        return okR(`clicked ${ref}`);
      }
      case 'type': {
        const ref = typeof typed.ref === 'string' ? typed.ref : '';
        const text = typeof typed.text === 'string' ? typed.text : '';
        if (!ref) return errR('bad_request', 'browser type: ref 必填');
        await session.type(ref, text);
        return okR(`typed into ${ref}`);
      }
      case 'listPages': {
        const pages = await session.listPages();
        return okR(JSON.stringify(pages));
      }
      case 'selectPage': {
        const pageId = typeof typed.ref === 'string' ? typed.ref : '';
        if (!pageId) return errR('bad_request', 'browser selectPage: ref(pageId) 必填');
        await session.selectPage(pageId);
        return okR(`selected page ${pageId}`);
      }
      case 'evaluate': {
        const script = typeof typed.text === 'string' ? typed.text : '';
        const r = await session.evaluate(script);
        return okR(JSON.stringify(r));
      }
      case 'screenshot': {
        if (!session.screenshot) return errR('unsupported', 'browser screenshot: 当前 driver 不支持');
        if (!ctx.snapshot) return errR('unsupported', 'browser screenshot: 无落盘 sink');
        const r = await session.screenshot();
        // 截图落盘（INV-157-1/3）：data 是 Buffer，直接交 SnapshotSink；
        // tool_result 仅返路径文本（formatSnapshotText source='browser' 固定无尺寸段）
        try {
          const r2 = await ctx.snapshot.save(r.data, r.mime);
          return okR(formatSnapshotText({ relPath: r2.relPath, source: 'browser' }));
        } catch (e) {
          // 落盘失败（磁盘满/权限）→ errorResult，不回退 inline image（INV-157-4）
          const msg = e instanceof Error ? e.message : String(e);
          return errR('screenshot_save_failed', `browser screenshot 落盘失败: ${msg}`);
        }
      }
      default:
        return errR('unknown_action', `browser: 未知 action "${action}"`);
    }
  } catch (e) {
    return errR(e instanceof BrowserError ? e.kind : 'unknown', e instanceof Error ? e.message : String(e));
  }
}

/** BrowserError → 友好文本；attach_failed/profile_in_use 等带 kind 前缀（保留导出兼容） */
export function formatBrowserError(e: unknown): string {
  if (e instanceof BrowserError) {
    return `browser ${e.kind}: ${e.message}`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `browser 调用失败: ${msg}`;
}

/**
 * extractActionParams：从 BrowserInput 提取 executeOnce 所需的 action 参数。
 * 字段映射与 dispatchAction 一致（url/ref/text/format），保证两路径行为对齐。
 */
export function extractActionParams(
  action: string,
  typed: BrowserInputLike,
): BrowserActionParams {
  const params: BrowserActionParams = {};
  if (typeof typed.url === 'string') params.url = typed.url;
  if (typeof typed.ref === 'string') params.ref = typed.ref;
  if (typeof typed.text === 'string') params.text = typed.text;
  // snapshot format 默认 aria；typed.format 未在 BrowserInput 显式声明，保持简单（不透传 → worker 默认 aria）
  void action;
  return params;
}

/** formatExecuteError：executeOnce 失败结果 → 友好文本（带 kind 前缀，与 formatBrowserError 对齐） */
export function formatExecuteError(r: {
  error?: { kind?: string; message: string };
}): string {
  const e = r.error;
  if (!e) return 'browser 调用失败: 未知错误';
  if (e.kind) return `browser ${e.kind}: ${e.message}`;
  return `browser 调用失败: ${e.message}`;
}

/** 成功结果（text 字段） */
function okR(text: string): BrowserExecuteResult {
  return { ok: true, text };
}

/** 失败结果（kind + message） */
function errR(kind: string, message: string): BrowserExecuteResult {
  return { ok: false, error: { kind, message } };
}

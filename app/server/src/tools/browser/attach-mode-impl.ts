/**
 * attach-mode-impl —— attach 模式专属 AttachModeImpl
 * 参考: specs/tech/version_logs/v0.0.266/change_plan.md Delta（registry 重构，老板 delta #2）
 *       specs/tech/agent/tools/[P1]browser_tool.md §4（ChromeMcpDriver connect/close 语义）
 *
 * attach 语义（相对 worker-based）：
 *   - launch：switch 门禁 → attachDriver 缺省 fail-closed → connectAttachSession（不 spawn worker）
 *   - execute：主进程 dispatchAction（session 方法）+ 失活检测（CDP 断/chrome 被关 →
 *     isAttachConnectionLost → handle.state='dead' + 引导重新 launch；manager 收尾 close）
 *   - close：disconnectAttachSession（不杀 chrome/不删目录/不释放端口/不持久化；幂等）
 * 失活自愈下沉 impl（tool.ts 不再检查 isAttachConnectionLost）。
 */
import type { BrowserActionParams, BrowserExecuteResult, BrowserLaunchOptions, BrowserSession } from './types';
import type { BrowserHandle, ExecuteCtx, LaunchResult, ModeImpl, ModeImplEnv } from './mode-impl';
import { connectAttachSession, disconnectAttachSession, isAttachConnectionLost } from './attach-instance';
import { dispatchAction, type BrowserInputLike } from './tool-dispatch';

/** AttachHandle —— attach 实例私有扩展（manager 不读这些字段） */
export interface AttachHandle extends BrowserHandle {
  /** 主进程持有的 ChromeMcpSession（dispatchAction 用） */
  session: BrowserSession;
  /** attach 连接端点（cdpUrl，disconnect 复用）；launch 缺省时由 driver 内部兜底 */
  cdpUrl?: string;
}

/** AttachModeImpl（registry 注册 'attach' 键；依赖经 ModeImplEnv 注入，构造无参） */
export class AttachModeImpl implements ModeImpl {
  async launch(key: string, opts: BrowserLaunchOptions, env: ModeImplEnv): Promise<LaunchResult> {
    if (env.isAttachEnabled && !env.isAttachEnabled()) {
      return {
        ok: false,
        error: { kind: 'not_enabled', message: 'browser attach 未启用：请在「连接器 → 浏览器」中开启开关' },
      };
    }
    if (!env.attachDriver) {
      return { ok: false, error: { kind: 'attach_failed', message: 'attach 驱动未注册（未装配 attachDriver）' } };
    }
    const r = await connectAttachSession(env.attachDriver, opts.cdpUrl);
    if (!r.ok) return { ok: false, error: r.error };
    const handle: AttachHandle = {
      key,
      mode: 'attach',
      session: r.session,
      ...(opts.cdpUrl ? { cdpUrl: opts.cdpUrl } : {}),
      state: 'ready',
      createdAt: env.now(),
      lastUsedAt: env.now(),
    };
    return { ok: true, handle, text: `launched ${opts.mode}` };
  }

  async execute(
    handle: BrowserHandle,
    action: string,
    params: BrowserActionParams,
    ctx: ExecuteCtx,
  ): Promise<BrowserExecuteResult> {
    const ah = handle as AttachHandle;
    const typed: BrowserInputLike = { url: params.url, ref: params.ref, text: params.text };
    const r = await dispatchAction(ah.session, action, typed, ctx);
    if (r.ok) return r;
    // 失活自愈下沉：CDP 断/chrome 被关 → 置 dead + 引导重新 launch（manager 见 dead → closeInstance）
    if (isAttachConnectionLost(r.error?.message ?? '')) {
      handle.state = 'dead';
      return {
        ok: false,
        error: { kind: 'attach_lost', message: 'attach 浏览器连接已断开（Chrome 可能被关闭），请重新 launch' },
      };
    }
    return r; // 非失活错误原样透传
  }

  async close(handle: BrowserHandle, env: ModeImplEnv): Promise<void> {
    const ah = handle as AttachHandle;
    await disconnectAttachSession(env.attachDriver, ah.cdpUrl); // 断 MCP 连接，幂等
    handle.state = 'dead';
  }
}

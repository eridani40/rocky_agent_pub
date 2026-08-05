/**
 * connect with retry（3 次 × 5s 上限，非指数退避）
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.3（重连策略）
 *       reqs/[done] v0.0.103.channel/design-feishu §7
 *
 * 上限：MAX_RETRIES 次，每次间隔 RETRY_INTERVAL_MS。
 *   - 成功 → connection='connected' + retryCount 清零 + rt.handle 挂新句柄
 *   - 失败 → 累计错误详情；超过上限 → connection='error'
 *   - toggle off / unregister 触发 controller.aborted=true → 立即退出（不重试、不改 state）
 *
 * v0.0.206：connect 委托 connectFn（组合器注入 `() => impl.connect(config, backend)`），
 * 每 attempt 产出 fresh ChannelHandle 挂 rt.handle。scope 门（resolveImpl throw）在 retry
 * 之外的 spawnConnect 做——确定性失败不进本函数。
 *
 * 此文件是纯函数，不持状态；ChannelManagerImpl 持状态。
 */
import type { ChannelHandle } from './types';
import type { RuntimeState } from './channel-manager';

/** 重连上限（req：3 次 × 5s） */
const MAX_RETRIES = 3;
/** 每次重连间隔（ms） */
const RETRY_INTERVAL_MS = 5000;

/** retry 的 abort 控制器（toggle off / unregister 时 aborted=true） */
export interface RetryController {
  aborted: boolean;
}

/**
 * connect with retry 的主入口（持 rt 直接 mutate connection/errorDetail/handle）。
 *
 * @param rt per-config 运行时态（mutate connection/errorDetail/lastConnectedAt/handle）
 * @param controller abort 控制器（aborted=true 时立即退出，不再重试）
 * @param connectFn 组合器注入的连接工厂（每 attempt 调一次产出 fresh handle；throw 即 errorDetail 来源）
 */
export async function connectChannelWithRetry(
  rt: RuntimeState,
  controller: RetryController,
  connectFn: () => Promise<ChannelHandle>,
): Promise<void> {
  if (controller.aborted) return;
  rt.connection = 'connecting';
  rt.errorDetail = undefined;
  let retryCount = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (controller.aborted) return;
    try {
      const handle = await connectFn();
      if (controller.aborted) {
        // connect 成功后被 toggle off：对新 handle 尝试 disconnect 补偿，不改 state
        try {
          await handle.disconnect();
        } catch {
          /* swallow */
        }
        return;
      }
      rt.handle = handle;
      rt.connection = 'connected';
      rt.lastConnectedAt = new Date().toISOString();
      rt.retryCount = 0;
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rt.errorDetail = `connect 失败（第 ${attempt + 1}/${MAX_RETRIES} 次）：${msg}`;
      retryCount = attempt + 1;
      if (attempt + 1 < MAX_RETRIES && !controller.aborted) {
        await sleep(RETRY_INTERVAL_MS);
      }
    }
  }
  if (!controller.aborted) {
    rt.connection = 'error';
    rt.retryCount = retryCount;
  }
}

/** 简易 sleep（不真中断；aborted 检查在每次 attempt 顶上做） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bun+飞书 SDK 兼容冒烟脚本（v0.0.103 T3 编码期门禁）
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §5.5
 *       reqs/[done] v0.0.103.channel/design-feishu.md §1
 *
 * 用真凭证（feishu.env）跑 minimal connect：
 *   - 能 import @larksuiteoapi/node-sdk
 *   - 能 new WSClient({appId, appSecret})
 *   - 能 EventDispatcher.register im.message.receive_v1
 *   - 能 wsClient.start()（不 hang，10-15s 内连上或失败退出）
 *
 * 用法: bun run scripts/feishu-smoke.ts
 *
 * 退出码：
 *   0 = 成功（onReady 在 15s 内触发 / 或收到任意事件即退出）
 *   1 = 凭证缺失
 *   2 = SDK import/构造失败
 *   3 = connect 超时（>15s 未 onReady）
 *   4 = onError 触发（连接被拒绝/凭证无效）
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(
  import.meta.dirname,
  '../reqs/[done] v0.0.103.channel/feishu.env',
);

if (!existsSync(ENV_PATH)) {
  console.error(`[smoke] 凭证文件不存在: ${ENV_PATH}`);
  process.exit(1);
}

const envText = readFileSync(ENV_PATH, 'utf8');
const appId = envText.match(/^app_id=(.+)$/m)?.[1]?.trim();
const appSecret = envText.match(/^app_secret=(.+)$/m)?.[1]?.trim();

if (!appId || !appSecret) {
  console.error('[smoke] feishu.env 缺少 app_id 或 app_secret');
  process.exit(1);
}

console.log(`[smoke] appId=${appId.slice(0, 6)}... appSecret=***`);

let sdk: typeof import('@larksuiteoapi/node-sdk');
try {
  sdk = await import('@larksuiteoapi/node-sdk');
  console.log('[smoke] SDK import 成功');
} catch (e) {
  console.error('[smoke] SDK import 失败:', e);
  process.exit(2);
}

const { WSClient, EventDispatcher, LoggerLevel, Domain } = sdk;

let dispatcher: InstanceType<typeof EventDispatcher>;
try {
  dispatcher = new EventDispatcher({});
  dispatcher.register({
    'im.message.receive_v1': (data) => {
      console.log('[smoke] 收到 im.message.receive_v1 事件（onInboundMessage 入口）');
      console.log(
        `[smoke] message_id=${data.message?.message_id} chat_type=${data.message?.chat_type}`,
      );
      // 收到任意事件即视为门禁通过
      gracefulExit(0);
    },
  });
  console.log('[smoke] EventDispatcher.register(im.message.receive_v1) 成功');
} catch (e) {
  console.error('[smoke] EventDispatcher 构造/register 失败:', e);
  process.exit(2);
}

let wsClient: InstanceType<typeof WSClient>;
try {
  wsClient = new WSClient({
    appId,
    appSecret,
    domain: Domain.Feishu,
    loggerLevel: LoggerLevel.info,
    onReady: () => {
      console.log('[smoke] WSClient.onReady 触发 —— 连接成功，Bun+SDK 兼容');
      gracefulExit(0);
    },
    onError: (err: Error) => {
      console.error('[smoke] WSClient.onError:', err.message);
      gracefulExit(4);
    },
    onReconnecting: () => console.log('[smoke] reconnecting...'),
    onReconnected: () => console.log('[smoke] reconnected'),
  });
  console.log('[smoke] WSClient 构造成功');
} catch (e) {
  console.error('[smoke] WSClient 构造失败:', e);
  process.exit(2);
}

// 超时兜底（15s 内未 ready/event 视为 hang）
const timer = setTimeout(() => {
  console.error('[smoke] 超时 15s 未 onReady/未收事件（可能 hang）');
  gracefulExit(3);
}, 15000);
timer.unref?.();

// 启动连接（不 await，连接由 onReady/onError 回调通知）
wsClient
  .start({ eventDispatcher: dispatcher })
  .then(() => console.log('[smoke] wsClient.start() resolved'))
  .catch((e: unknown) => {
    console.error('[smoke] wsClient.start() rejected:', e);
    gracefulExit(4);
  });

let exited = false;
function gracefulExit(code: number): void {
  if (exited) return;
  exited = true;
  clearTimeout(timer);
  try {
    wsClient?.close({ force: true });
  } catch {
    /* ignore */
  }
  // 给 close 一点时间清理 socket
  setTimeout(() => process.exit(code), 300).unref?.();
}

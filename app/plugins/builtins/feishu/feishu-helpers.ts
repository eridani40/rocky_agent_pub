/**
 * FeishuConnection 的内部 helper（独立文件，避免 feishu-connection.ts 超 300 行）
 * 参考: 设计见 feishu-connection.ts 顶部注释
 */
import type { ChannelConfig } from '../../../server/src/channel/types';
import { ulid } from '../../../server/src/config/ulid';

/** 用户消息 id 生成器（运行时注入；测试可 mock） */
export type MessageIdGenerator = () => string;

/** 读取 config.config 的 appId/appSecret（带类型 guard） */
export function readCredentials(config: ChannelConfig): {
  appId: string;
  appSecret: string;
} {
  const cfg = config.config ?? {};
  return {
    appId: typeof cfg.appId === 'string' ? cfg.appId : '',
    appSecret: typeof cfg.appSecret === 'string' ? cfg.appSecret : '',
  };
}

/** default message id 生成（ULID，满足 fs-store schema id 字段校验：26 字符 Crockford Base32） */
export function defaultMessageIdGenerator(): string {
  return ulid();
}

/**
 * Promise 超时包装（顺序队列任务超时兜底，防一个任务卡死整队列）。
 * @param promise 被包装的 Promise
 * @param timeoutMs 超时毫秒数
 * @param label 可选标签，用于区分超时来源（如 "feishu sendMessage"），不传则用通用文案
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const msg = label
      ? `${label} timeout after ${timeoutMs}ms`
      : `sequential task timeout after ${timeoutMs}ms`;
    const timer = setTimeout(() => {
      reject(new Error(msg));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

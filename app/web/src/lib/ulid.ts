/**
 * ULID 生成器（浏览器/Node 通用版）—— v0.0.88 前端 SseClient subId 用
 * 参考: specs/tech/persistence/[P0]schema_interface.md §2.1
 *       ULID 规范 https://github.com/ulid/spec
 *
 * 与 server `app/server/src/config/ulid.ts` 同构（Crockford Base32，48 位时间戳 + 80 位随机）。
 * 浏览器无 node:crypto，改用 globalThis.crypto.getRandomValues（WebCrypto API，所有现代浏览器 + Node ≥ 15 可用）。
 *
 * 字符集（Crockford Base32，剔除 I/L/O/U 易混）：0-9 + A-H + J-K + M-N + P-T + V-Z
 * 编码：48 bit 时间 = 10 字符（每字符 5 bit），80 bit 随机 = 16 字符。合计 26 字符。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 取 n 字节真随机数（WebCrypto.getRandomValues） */
function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/** 把 10 字节随机段编码为 16 字符 Crockford Base32（每字符 5 bit；80 bit / 5 = 16 整除） */
function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    // 取第 i*5 位起的 5 bit（从最高位开始）
    const bitStart = i * 5;
    const byteIdx = bitStart >> 3; // bitStart / 8
    const bitInByte = bitStart & 7; // bitStart % 8
    // 把可能涉及的 2 字节拼成 16 bit，再取高 5 bit
    const lo = bytes[byteIdx]! << 8;
    const hi = byteIdx + 1 < bytes.length ? bytes[byteIdx + 1]! : 0;
    const window = (lo | hi) << bitInByte;
    const idx = (window >>> 11) & 0x1f;
    out += ENCODING[idx]!;
  }
  return out;
}

/** 把 48 位时间戳编码为 10 字符 Crockford Base32 */
function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    out = ENCODING[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/**
 * 生成 26 字符 ULID（Crockford Base32，48 位时间戳 + 80 位随机）。
 *
 * 注：相比 server 版去掉了同毫秒单调自增（lastTime/lastRandom），仅依赖时间戳 + 真随机；
 * 碰撞概率 << 2^80，足够 SseClient subId 用（subId 仅需唯一，不需跨进程聚合排序）。
 *
 * @returns 26 字符 ULID 字符串（如 '01H8ZG3F2X7VQNQJB4RM9K5PWT'）
 */
export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom(randomBytes(10));
}

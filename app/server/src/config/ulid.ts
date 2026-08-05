/**
 * ULID 生成器 — Crockford Base32，48 位时间戳 + 80 位随机，单调递增
 * 参考: specs/tech/persistence/[P0]schema_interface.md §2.1（id 字段类型 ulid）
 *       ULID 规范 https://github.com/ulid/spec
 *
 * 用途：config service 写 KV record 时生成主键（persistence 不分配 id，由业务生成）。
 * 设计：同进程内单调（上次时间相同则随机段 +1）；跨进程依赖时间戳天然有序。
 *
 * 字符集（Crockford Base32，32 字符，剔除 I/L/O/U 易混）：0-9 + A-H + J-K + M-N + P-T + V-Z
 *
 * 编码：48 bit 时间 = 10 字符（每字符 5 bit，前 2 bit 补 0），80 bit 随机 = 16 字符。
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 上次生成的时间戳（单调性保证） */
let lastTime = 0;
/** 上次生成的随机段（同时间戳时自增，保证单调），10 字节 = 80 bit */
let lastRandom: Uint8Array | null = null;

/**
 * 把 10 字节随机段编码为 16 字符 Crockford Base32（每字符 5 bit）。
 * 80 bit / 5 = 16 字符整除，无填充。
 */
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
    const idx = (window >>> 11) & 0x1f; // 取高 5 bit
    out += ENCODING[idx]!;
  }
  return out;
}

/** 把 48 位时间戳编码为 10 字符 Crockford Base32 */
function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32;
    out = ENCODING[mod]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 同时间戳下随机段 +1（单调递增，避免同毫秒碰撞） */
function incrementRandom(bytes: Uint8Array): Uint8Array {
  const next = new Uint8Array(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 0xff) {
      next[i] = (next[i]! + 1) & 0xff;
      return next;
    }
    next[i] = 0;
  }
  // 全 0xff 溢出（极罕见）→ 重新随机
  return randomBytes(10);
}

/**
 * 生成一个单调递增的 ULID 字符串（26 字符）。
 * @returns 形如 '01KVCKMNPQRSTVWXYZ0123456789' 的 26 字符 ULID
 */
export function ulid(): string {
  const now = Date.now();
  let random: Uint8Array;
  if (now === lastTime && lastRandom) {
    // 同毫秒 → 随机段自增保证单调
    random = incrementRandom(lastRandom);
  } else {
    random = randomBytes(10);
  }
  lastTime = now;
  lastRandom = random;
  return encodeTime(now) + encodeRandom(random);
}

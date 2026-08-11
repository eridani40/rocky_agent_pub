/**
 * config-crypto — 配置同步加解密模块（纯前端 Web Crypto API）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D2
 *      specs/prd/v0.0.318-config-sync.md §2.6
 *
 * AES-256-CBC 对称加密，密钥硬编码（rocky_agent_ + md5(固定盐) → SHA-256 → 32B AES key）。
 * 非安全级加密（防肉眼读取），仅做信息整体编解码。
 */

import type { ModelInstance, ProtocolName } from './api-client';

// —— 类型定义（D2）——

/** 导出/导入的 provider 项（剥离 id，导入时后端生成新 ULID） */
export interface ProviderExportItem {
  label: string;
  name: 'anthropic_compatible';
  protocolId: ProtocolName;
  baseUrl: string;
  credentials: { key: string };
  enabled: boolean;
  models: ModelInstance[];
}

/** 加密前的完整导出数据 */
export interface ConfigExportData {
  v: 1;
  exportedAt: string; // ISO
  providers: ProviderExportItem[];
  tools: Record<string, unknown>; // tabId → data
}

/** 加密后的文件壳 */
export interface ConfigExportFile {
  v: number;
  payload: string; // base64(IV + ciphertext)
}

// ——密钥生成——

/** 固定盐值（PRD §2.6） */
const SALT = 'ra_config_sync_2026';
/** 前缀（PRD §2.6） */
const KEY_PREFIX = 'rocky_agent_';

/**
 * 生成 AES-256 密钥（32 字节）。
 * 密钥 = SHA-256(KEY_PREFIX + md5(SALT))
 * ⚠️ 实现偏离（leader 裁决接受）：crypto.subtle 不提供 MD5，
 *   用 SHA-256(SALT) 截 32 hex 替代 md5(SALT)。功能等价（固定盐→固定串→固定 key），
 *   非安全场景可接受（PRD §2.6「防肉眼读取」级）。
 */
async function deriveAesKey(): Promise<CryptoKey> {
  // 偏离实现：SHA-256(SALT) 截 32 hex 替代 md5(SALT)
  const saltHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SALT));
  const saltHex = bufToHex(saltHashBuf).slice(0, 32);
  const keyMaterial = KEY_PREFIX + saltHex;
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
}

// ——工具函数——

/** ArrayBuffer → hex 字符串 */
function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ArrayBuffer → base64 字符串 */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** base64 字符串 → Uint8Array */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ——加解密核心——

/** AES-256-CBC 加密 → base64（IV 拼在密文前） */
export async function encryptConfig(data: ConfigExportData): Promise<string> {
  const key = await deriveAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext);
  // IV + ciphertext 拼接 → base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bufToBase64(combined.buffer);
}

/** base64 → AES-256-CBC 解密 → 原始对象 */
export async function decryptConfig(payload: string): Promise<ConfigExportData> {
  const key = await deriveAesKey();
  const combined = base64ToBytes(payload);
  if (combined.length < 16) throw new Error('文件已损坏或被修改，无法导入');
  const iv = combined.slice(0, 16);
  const ciphertext = combined.slice(16);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as ConfigExportData;
}

// ——壳封装——

/** 加密 + 包 {v:1, payload} 壳 */
export async function wrapExport(data: ConfigExportData): Promise<ConfigExportFile> {
  const payload = await encryptConfig(data);
  return { v: 1, payload };
}

/** 壳校验 + 解密 → ConfigExportData */
export async function unwrapExport(file: unknown): Promise<ConfigExportData> {
  if (typeof file !== 'object' || file === null || !('v' in file) || !('payload' in file)) {
    throw new Error('文件格式不正确，无法解析为配置同步文件');
  }
  const { v, payload } = file as { v: unknown; payload: unknown };
  if (typeof v !== 'number') {
    throw new Error('文件格式不正确，无法解析为配置同步文件');
  }
  if (v !== 1) {
    throw new Error('文件版本不兼容，请升级应用后重试');
  }
  if (typeof payload !== 'string') {
    throw new Error('文件已损坏或被修改，无法导入');
  }
  try {
    return await decryptConfig(payload);
  } catch {
    throw new Error('文件已损坏或被修改，无法导入');
  }
}

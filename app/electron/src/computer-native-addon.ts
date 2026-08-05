/**
 * computer-native-addon —— 加载 @app/computer-native addon + 统一 invoke 调用/解包
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2_batch2.md §P1-C（loadComputerAddon + addon 缺失 fail-closed）
 *       app/computer-native/index.js（addon.invoke(method, jsonParams) → JSON 结果串）
 *       app/computer-native/swift/.../CBridge.swift（返 {ok, result?|error?} 信封）
 *
 * 铁律（§B2.0）：native 原生能力在 Rocky Electron 主进程内加载（com.rocky.agent = TCC 权限主体）。
 *   本文件仅在主进程运行（packaged 直注入 / dev loopback server 均在主进程）。
 *
 * fail-closed：非 darwin / 未构建 / 加载失败 → addon undefined；各 native 方法据此返 {ok:false,reason}。
 * addon.invoke 返回信封 `{ok, result?|error?}`（native 侧包装）：本文件解包为 NativeEnvelope
 *   （成功 → {ok:true,result}；失败 → {ok:false,reason}），供 port 各方法映射到 TS 结果类型。
 */

/** addon 面（@app/computer-native 导出；缺失时 undefined） */
export interface AddonLike {
  /** 同步健康探针（返 Swift 固定 JSON 串） */
  ping(): string;
  /** 异步业务入口：method + JSON params → Promise<JSON 结果串（信封 {ok,result?|error?}）> */
  invoke(method: string, paramsJson: string): Promise<string>;
}

/**
 * callNative 解包后的结果（成功携 result；失败携 reason，供 port 转 fail-closed）。
 * v0.0.160：失败态多携 `code`（native 侧 `error.code`，供上层 handler 区分 state_unavailable 等分类）。
 */
export type NativeEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; reason: string; code?: string };

/**
 * lazy 加载 native addon（仅 darwin；require 失败/形状非法 → undefined，warn 不抛）。
 * addon 缺失时 port 各 native 方法 fail-closed（返 {ok:false} / 空数组）。
 *
 * @returns addon（含 invoke）或 undefined（非 darwin / 未构建 / 加载失败）
 */
export function loadComputerAddon(): AddonLike | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const addon = require('@app/computer-native') as AddonLike | undefined;
    if (addon && typeof addon.invoke === 'function') return addon;
    // eslint-disable-next-line no-console
    console.warn('[computer-native-addon] addon loaded but invoke() missing (fail-closed → undefined)');
    return undefined;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[computer-native-addon] addon load failed (fail-closed → undefined):', errMsg(e));
    return undefined;
  }
}

/**
 * 统一调用 addon.invoke 并解包信封。
 *   - addon 缺失 → {ok:false, reason}
 *   - invoke 抛 / JSON 解析失败 → {ok:false, reason}
 *   - 信封 ok!==true → {ok:false, reason=error.message}
 *   - 成功 → {ok:true, result=信封.result}
 *
 * @param addon  已加载 addon（undefined 表示不可用）
 * @param method native 方法名（readAxTree/screenshot/click/...）
 * @param params 单 JSON 对象参数（named 字段，undefined 值 JSON.stringify 时自动剔除）
 */
export async function callNative(
  addon: AddonLike | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<NativeEnvelope> {
  if (!addon) return { ok: false, reason: `native addon unavailable for ${method}` };
  try {
    const raw = await addon.invoke(method, JSON.stringify(params));
    const env = JSON.parse(raw) as {
      ok?: boolean;
      result?: unknown;
      error?: { code?: string; message?: string };
    };
    if (env?.ok !== true) {
      const reason = env?.error?.message ?? `native ${method} failed`;
      const code = env?.error?.code;
      return code ? { ok: false, reason, code } : { ok: false, reason };
    }
    return { ok: true, result: env.result };
  } catch (e) {
    return { ok: false, reason: `native ${method} error: ${errMsg(e)}` };
  }
}

/** 从 unknown error 取消息串（fail-closed reason 用） */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

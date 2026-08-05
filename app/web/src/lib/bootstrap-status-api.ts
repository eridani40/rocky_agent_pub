/**
 * bootstrap-status-api —— GET /bootstrap/status 薄封装（v0.0.150 前端报错通道）
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §C（前端报错通道）
 *
 * 职责：
 *   - 启动期 fetch /bootstrap/status 拉取迁移错误信息
 *   - 失败兜底返空 errors 数组（不阻塞 UI——网络/server 故障时静默降级）
 *
 * 复用 api-client.ts 的 req fetcher 范式（统一拼 URL + 错误转异常）。
 * 但本端点失败时不抛错（返空 errors），与 req 默认抛错不同——故直接 fetch + try/catch。
 */
import { resolveApiBase } from './api-base';

/** GET /bootstrap/status 响应体（与后端 handleBootstrapStatus 返回 schema 对齐） */
export interface BootstrapStatusResponse {
  /** 当前 app 版本（getAppVersion 读 app-version.json） */
  appVersion: string;
  /** 上次跑完 MigrationManager 的版本（'0.0.0' = 首次启动） */
  lastAppVersion: string;
  /** 迁移错误列表（空数组表示无错；含 lock 冲突 + handler 抛错） */
  migrationErrors: Array<{ id: string; message: string; stack?: string }>;
}

/** 兜底空响应（fetch 失败时返，不阻塞 UI） */
const EMPTY_STATUS: BootstrapStatusResponse = {
  appVersion: '',
  lastAppVersion: '0.0.0',
  migrationErrors: [],
};

/**
 * GET /bootstrap/status —— 拉取迁移错误信息。
 *
 * 失败兜底语义：网络故障 / server 未起 / HTTP 非 2xx → 返空 errors 数组（不抛错），
 * 让 UI 启动流程不被迁移状态查询阻塞。仅 errors.length > 0 时 caller 渲染 modal。
 *
 * @param base 显式 API base（测试用）；undefined 走 resolveApiBase 读 VITE_API_BASE
 */
export async function fetchBootstrapStatus(base?: string): Promise<BootstrapStatusResponse> {
  try {
    const res = await fetch(`${resolveApiBase(base)}/bootstrap/status`, {
      headers: { 'content-type': 'application/json' },
    });
    if (!res.ok) return EMPTY_STATUS;
    const body = (await res.json()) as Partial<BootstrapStatusResponse>;
    return {
      appVersion: body.appVersion ?? '',
      lastAppVersion: body.lastAppVersion ?? '0.0.0',
      migrationErrors: Array.isArray(body.migrationErrors) ? body.migrationErrors : [],
    };
  } catch {
    // 网络故障 / JSON 解析失败 → 兜底空响应
    return EMPTY_STATUS;
  }
}

/**
 * team-sync-handler — 团队同步 API handler（v0.0.319）
 * 参考: specs/tech/version_logs/v0.0.319/change_plan.md D3
 *       specs/prd/v0.0.319-team-sync.md §2.2/§2.3（导出/导入流程）
 *
 * 端点：
 *   - GET  /squad/:id/export → zip 二进制下载流（application/zip + Content-Disposition）
 *   - POST /squad/import?step=preview → FormData(file) 解包校验 → { importKey, manifest }
 *   - POST /squad/import?step=execute → FormData(importKey, name) 建队 → { squadId, created, failed }
 *
 * modelDefault 继承：当前 session squad → fallback 系统第一个 enabled provider 的第一个 enabled model。
 * 路由顺序约束：MUST 在 /squad/:id CRUD 之前匹配（squad-routes.ts 保证）。
 */
import { rmSync } from 'node:fs';
import type { SessionStore } from '../agent/session-store';
import { SquadStore, squadRootDir } from '../stores/squad-store';
import type { AppConfigService } from '../config/app-config-service';
import { json } from './squad-model-helpers';
import { exportSquadToZip } from '../services/team-sync-export-service';
import {
  ImportKeyExpiredError, ImportKeyStore, InvalidZipError,
  importSquadFromTempDir, parseManifestFromDir, unpackToTemp,
} from '../services/team-sync-import-service';
import type { SquadServiceDeps } from '../services/squad-service';
import type { CreateMemberDeps } from '../services/member-service';

/** team-sync handler 依赖注入集合（router 从 bootstrap 构造） */
export interface TeamSyncHandlerDeps {
  sessionStore: SessionStore;
  squadStore: SquadStore;
  memberStore: SquadServiceDeps['memberStore'];
  dataDir: string;
  appConfig?: AppConfigService;
}

/** 模块级 ImportKeyStore 单例（preview→execute 跨请求共享；5min TTL 自动清理） */
const importKeyStore = new ImportKeyStore();

/** 导出文件名时间戳：YYYYMMDD_HHmmss（本地时区） */
function formatTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 系统 fallback：第一个 enabled provider 的第一个 enabled model */
function resolveModelDefaultFromProviders(
  deps: TeamSyncHandlerDeps,
): { modelDefault: string; modelDefaultProviderId?: string } | null {
  if (!deps.appConfig) return null;
  interface ProviderLike {
    id?: string; enabled?: boolean; _deleted?: boolean;
    models?: { modelId?: string; enabled?: boolean }[];
  }
  const providers = deps.appConfig
    .listGroup('providers')
    .map((r) => r.data as ProviderLike)
    .filter((p) => p && !p._deleted && p.enabled !== false);
  for (const p of providers) {
    const m = (p.models ?? []).find((mm) => mm.modelId && mm.enabled !== false);
    if (p.id && m?.modelId) {
      return { modelDefault: m.modelId, modelDefaultProviderId: p.id };
    }
  }
  return null;
}

/**
 * 解析导入建队的 modelDefault（PRD §5.5）：先当前 session squad 继承，再系统 fallback。
 *   1. 请求头 x-session-id → 当前 session 的 squad → 继承其 modelDefault(+providerId)
 *   2. fallback：系统第一个 enabled provider 的第一个 enabled model
 * 均取不到 → null（handler 返 400「默认模型无效」）。
 */
async function resolveModelDefaultAsync(
  req: Request,
  deps: TeamSyncHandlerDeps,
): Promise<{ modelDefault: string; modelDefaultProviderId?: string } | null> {
  const sessionId = req.headers.get('x-session-id');
  if (sessionId) {
    try {
      const session = await deps.sessionStore.getSession(sessionId);
      const squadId = session?.squadId as string | undefined;
      if (squadId) {
        const squad = await deps.squadStore.getSquad(squadId);
        const modelDefault = squad?.modelDefault as string | undefined;
        if (modelDefault) {
          return {
            modelDefault,
            ...(squad?.modelDefaultProviderId
              ? { modelDefaultProviderId: squad.modelDefaultProviderId as string }
              : {}),
          };
        }
      }
    } catch (e) {
      console.warn('[team-sync] resolve modelDefault from session failed, fallback:', e);
    }
  }
  return resolveModelDefaultFromProviders(deps);
}

/**
 * GET /squad/:id/export → 导出 squad 为 zip 下载流。
 * 命中返 Response；路径不匹配返 null（主分发继续）。
 */
export async function handleTeamSyncExport(
  method: string,
  path: string,
  deps: TeamSyncHandlerDeps,
): Promise<Response | null> {
  const m = path.match(/^\/squad\/([^/]+)\/export$/);
  if (!m || method !== 'GET') return null;
  const squadId = decodeURIComponent(m[1]!);

  const squad = await deps.squadStore.getSquad(squadId);
  if (!squad) return json(404, { error: 'squad not found' });

  let buffer: Buffer;
  let memberCount: number;
  try {
    ({ buffer, memberCount } = exportSquadToZip(squadRootDir(deps.dataDir, squadId), squad));
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }

  const squadName = String(squad.name ?? 'team');
  // HTTP header 仅允许 ASCII：中文等非 ASCII 团队名走 RFC 5987 filename* 编码，
  // ASCII 名同时给 filename 兼容旧客户端
  const asciiName = squadName.replace(/[^\w.-]+/g, '_');
  const base = `rocky_agent_team_${asciiName}_${formatTimestamp()}.zip`;
  const encodedName = `rocky_agent_team_${squadName}_${formatTimestamp()}.zip`;
  const contentDisposition = /^[\x20-\x7E]*$/.test(encodedName)
    ? `attachment; filename="${base}"`
    : `attachment; filename="${base}"; filename*=UTF-8''${encodeURIComponent(encodedName)}`;
  console.warn(`[team-sync] export squad=${squadId} members=${memberCount} bytes=${buffer.length}`);
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': contentDisposition,
    },
  });
}

/**
 * POST /squad/import?step=preview|execute — 两阶段导入（无状态，importKey 关联临时目录）。
 * 命中返 Response；路径不匹配返 null。
 */
export async function handleTeamSyncImport(
  req: Request,
  method: string,
  path: string,
  query: URLSearchParams,
  deps: TeamSyncHandlerDeps,
): Promise<Response | null> {
  if (path !== '/squad/import' || method !== 'POST') return null;
  const step = query.get('step');

  if (step === 'preview') return handlePreview(req);
  if (step === 'execute') return handleExecute(req, deps);
  return json(400, { error: 'step required (preview|execute)' });
}

/** preview 阶段：解包 zip → 校验 → 登记 importKey → 返回 manifest 预览 */
async function handlePreview(req: Request): Promise<Response> {
  let zipBuffer: Buffer;
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return json(400, { error: 'file field required' });
    }
    zipBuffer = Buffer.from(await (file as Blob).arrayBuffer());
  } catch {
    return json(400, { error: '请选择有效的团队导出文件（.zip）' });
  }

  let tmpDir: string;
  try {
    tmpDir = unpackToTemp(zipBuffer);
  } catch (e) {
    if (e instanceof InvalidZipError) return json(400, { error: e.message });
    return json(400, { error: '文件已损坏，无法解压' });
  }

  try {
    const { manifest, srcDir } = parseManifestFromDir(tmpDir);
    const importKey = importKeyStore.set({ tmpDir, manifest, srcDir });
    return json(200, { importKey, manifest });
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true }); // 校验失败立即清理
    if (e instanceof InvalidZipError) return json(400, { error: e.message });
    throw e;
  }
}

/** execute 阶段：importKey 取临时目录 → 建队 → 清理 */
async function handleExecute(req: Request, deps: TeamSyncHandlerDeps): Promise<Response> {
  let importKey: string;
  let name: string;
  try {
    const form = await req.formData();
    importKey = String(form.get('importKey') ?? '');
    name = String(form.get('name') ?? '').trim();
  } catch {
    return json(400, { error: 'invalid form data' });
  }
  if (!importKey) return json(400, { error: 'importKey required' });
  if (!name) return json(400, { error: 'name required' });

  const entry = importKeyStore.take(importKey);
  if (!entry) {
    return json(400, { error: new ImportKeyExpiredError('import session expired').message });
  }

  const modelRef = await resolveModelDefaultAsync(req, deps);
  if (!modelRef) {
    rmSync(entry.tmpDir, { recursive: true, force: true });
    return json(400, { error: '默认模型无效，请先配置模型 provider' });
  }

  try {
    const serviceDeps: SquadServiceDeps & CreateMemberDeps = {
      sessionStore: deps.sessionStore,
      squadStore: deps.squadStore,
      memberStore: deps.memberStore,
      dataDir: deps.dataDir,
      ...(deps.appConfig ? { appConfig: deps.appConfig } : {}),
    };
    const result = await importSquadFromTempDir(
      entry.tmpDir, entry.manifest, entry.srcDir,
      { name, ...modelRef },
      serviceDeps,
    );
    return json(201, result);
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    rmSync(entry.tmpDir, { recursive: true, force: true }); // finally 确保清理（change_plan D2）
  }
}

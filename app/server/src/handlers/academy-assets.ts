/**
 * academy-assets handlers — /academy/classroom/:cid/{dataset,grader} 路由分发
 * 参考: specs/api/overall/18-academy.md §3（教室资产端点契约）
 *       specs/tech/version_logs/v0.0.210/change_plan.md G 节（行 86）
 *
 * 职责：按 kind 分派到 dataset / grader 两个子 handler 文件。
 * 单文件 ≤300 行（dataset/grader 各自实现拆到 academy-assets-{dataset,grader}.ts）。
 */
import type { AcademyHandlerDeps } from '../routes/academy-routes';
import { json } from './academy-assets-shared';
import {
  handleCreateDataset,
  handleListDatasets,
  handleGetDataset,
  handlePatchDataset,
  handleDeleteDataset,
} from './academy-assets-dataset';
import {
  handleCreateGrader,
  handleListGraders,
  handleGetGrader,
  handlePatchGrader,
  handleDeleteGrader,
} from './academy-assets-grader';

/**
 * /academy/classroom/:cid/{dataset,grader}/* 路由分发。
 *
 * 路径形态：
 *   /academy/classroom/:cid/{dataset|grader}           POST/GET
 *   /academy/classroom/:cid/{dataset|grader}/:id       GET/PATCH/DELETE
 */
export async function handleAssetsRoute(
  req: Request,
  method: string,
  path: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  // /academy/classroom/:cid/{dataset|grader}
  const collMatch = path.match(/^\/academy\/classroom\/([^/]+)\/(dataset|grader)$/);
  if (collMatch) {
    const [_, cid, kind] = collMatch;
    if (method === 'POST') {
      return kind === 'dataset' ? handleCreateDataset(req, cid!, deps) : handleCreateGrader(req, cid!, deps);
    }
    if (method === 'GET') {
      return kind === 'dataset' ? handleListDatasets(cid!, deps) : handleListGraders(cid!, deps);
    }
    return json(405, { error: 'Method Not Allowed' }, 'GET,POST');
  }

  // /academy/classroom/:cid/{dataset|grader}/:id
  const itemMatch = path.match(/^\/academy\/classroom\/([^/]+)\/(dataset|grader)\/([^/]+)$/);
  if (itemMatch) {
    const [_, cid, kind, id] = itemMatch;
    if (method === 'GET') {
      return kind === 'dataset' ? handleGetDataset(cid!, id!, deps) : handleGetGrader(cid!, id!, deps);
    }
    if (method === 'PATCH') {
      return kind === 'dataset' ? handlePatchDataset(req, cid!, id!, deps) : handlePatchGrader(req, cid!, id!, deps);
    }
    if (method === 'DELETE') {
      return kind === 'dataset' ? handleDeleteDataset(cid!, id!, deps) : handleDeleteGrader(cid!, id!, deps);
    }
    return json(405, { error: 'Method Not Allowed' }, 'GET,PATCH,DELETE');
  }

  return json(404, { error: 'Not Found' });
}

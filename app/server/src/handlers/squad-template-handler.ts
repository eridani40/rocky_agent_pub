/**
 * squad-template-handler — GET /squad-templates 路由处理
 * 参考: specs/api/overall/11b-squad-templates.md §1
 *       specs/tech/squad/[P1]squad_templates.md §④
 *
 * 只读端点，扫描用户目录下的模板并返回摘要列表。
 */
import { listTemplates } from '../services/squad-template-service';
import { json } from './squad-model-helpers';

/**
 * /squad-templates 路由分发。
 * GET /squad-templates → 200 + { items: TemplateSummary[] }
 */
export async function handleSquadTemplateRoute(
  method: string,
  dataDir: string,
): Promise<Response> {
  if (method === 'GET') {
    try {
      const items = listTemplates(dataDir);
      return json(200, { items });
    } catch (e) {
      console.error('[squad-template] list failed', e);
      return json(500, { error: 'template_list_failed' });
    }
  }
  return json(405, { error: 'Method Not Allowed' }, 'GET');
}

/**
 * academy-routes — /academy/* 路由组（classroom / student / training-task / assets）
 * 参考: specs/api/overall/18-academy.md（HTTP 契约）
 *       specs/tech/version_logs/v0.0.210/change_plan.md G 节（行 79-94）
 *
 * 路由分发顺序（最长前缀优先——具体 pattern 先于 generic 前缀）：
 *   1. /academy/training-task/* → handleTrainingTaskRoute
 *   2. /academy/classroom/:cid/student/:sid/training-task → handleTrainingTaskRoute（发起训练）
 *   3. /academy/classroom/:cid/student/:sid/version/* → handleStudentRoute
 *   4. /academy/classroom/:cid/student/:sid → handleStudentRoute（学生详情）
 *   5. /academy/classroom/:cid/{dataset,grader}/* → handleAssetsRoute
 *   6. /academy/classroom[/:cid[/student]] 浅层 → handleClassroomRoute（兜底前缀）
 *
 * 不变量：generic /academy/classroom/ 前缀规则必须最后判——它抢跑会吞掉所有
 * classroom 深层路径（handleClassroomRoute 只认 3 种浅层形态，其余 404）。
 * dispatch 只按 path 分发；method 合法性由各 handler 内部判（405）。
 *
 * 未命中返 null，主分发继续。
 *
 * packaged 护栏：不读 process.env；不拼接相对路径；dataDir 由 caller 展开绝对路径传入。
 */
import type { AcademyStore } from '../academy/academy-store';
import type { TrainingEngine } from '../academy/training-engine';
import type { AgentManagerImpl } from '../agent/agent-manager';
import type { SessionStore } from '../agent/session-store';
import type { AppConfigService } from '../config/app-config-service';
import { handleClassroomRoute } from '../handlers/academy-classroom';
import { handleStudentRoute } from '../handlers/academy-student';
import { handleTrainingTaskRoute } from '../handlers/academy-training-task';
import { handleAssetsRoute } from '../handlers/academy-assets';

/**
 * AcademyHandlerDeps — academy 板块 handler 依赖（router 注入）。
 *
 * 注：dataDir 必须是 resolveDataDir 展开后的绝对路径（packaged 护栏 BUG-004）。
 */
export interface AcademyHandlerDeps {
  academyStore: AcademyStore;
  trainingEngine: TrainingEngine;
  agentManager: AgentManagerImpl;
  sessionStore: SessionStore;
  /** app 配置服务（建学生初始版本播种默认 model 的 resolveModel 数据源） */
  appConfig: AppConfigService;
  /** dataDir 绝对路径（workspaceDir 路径根） */
  dataDir: string;
}

/**
 * /academy/* 路由组分发。命中返 Response；未命中返 null（主分发继续下个 group）。
 *
 * @param req     原始 Request
 * @param method  HTTP method（大写）
 * @param path    pathname
 * @param deps    AcademyHandlerDeps（academyStore + trainingEngine + agentManager + sessionStore + dataDir）
 */
export async function dispatchAcademyRoutes(
  req: Request,
  method: string,
  path: string,
  deps: AcademyHandlerDeps,
): Promise<Response | null> {
  // 不命中 /academy 前缀直接返 null
  if (path !== '/academy' && !path.startsWith('/academy/')) {
    return null;
  }

  // 最长前缀优先：具体 pattern 全部先于规则 6 的 generic classroom 前缀判断。

  // 1. /academy/training-task/*（任务详情 + revise/accept/reject/stop/inject-directive）
  if (path === '/academy/training-task' || path.startsWith('/academy/training-task/')) {
    return handleTrainingTaskRoute(req, method, path, deps);
  }

  // 2. /academy/classroom/:cid/student/:sid/training-task（发起训练 §2.1）
  if (/^\/academy\/classroom\/[^/]+\/student\/[^/]+\/training-task$/.test(path)) {
    return handleTrainingTaskRoute(req, method, path, deps);
  }

  // 3. /academy/classroom/:cid/student/:sid/version/*（版本内容/编辑/启动会话 §1.8-1.10）
  if (/^\/academy\/classroom\/[^/]+\/student\/[^/]+\/version(\/|$)/.test(path)) {
    return handleStudentRoute(req, method, path, deps);
  }

  // 4. /academy/classroom/:cid/student/:sid（学生详情 §1.7）
  if (/^\/academy\/classroom\/[^/]+\/student\/[^/]+$/.test(path)) {
    return handleStudentRoute(req, method, path, deps);
  }

  // 5. /academy/classroom/:cid/{dataset,grader}/*（教室资产 CRUD §3）
  if (/^\/academy\/classroom\/[^/]+\/(dataset|grader)(\/|$)/.test(path)) {
    return handleAssetsRoute(req, method, path, deps);
  }

  // 6. /academy/classroom 浅层兜底（collection / :cid item / :cid/student 集合）；
  //    更深层的未识别路径（如 /:cid/bogus）也进这里，由 handleClassroomRoute 返 404
  if (path === '/academy/classroom' || path.startsWith('/academy/classroom/')) {
    return handleClassroomRoute(req, method, path, deps);
  }

  return null;
}

/**
 * 注册 academy 路由（与 session-routes / squad-routes 同款：dispatch 形态由 router.ts 调用）。
 * router.ts 在 session/squad 路由之后调本函数。
 */
export function registerAcademyRoutes(
  req: Request,
  method: string,
  path: string,
  deps: AcademyHandlerDeps,
): Promise<Response | null> {
  return dispatchAcademyRoutes(req, method, path, deps);
}

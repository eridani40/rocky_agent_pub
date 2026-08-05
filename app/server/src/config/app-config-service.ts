/**
 * AppConfigService — app_config 域的逻辑服务（通用 KV get/set）
 * 参考: specs/tech/config/[P0]app_config.md §5
 *       specs/tech/version_logs/v0.0.5/change_log.md §修订3（setGroup）
 *
 * 接口（app_config.md §5）：
 *   - get(group, key): unknown | undefined  — 记录缺失返 undefined（视为未配置）
 *   - set(group, key, data): void           — 创建/更新 KV record
 *   - setGroup(group, items[])              — 整组原子提交（同 group 全成功/全失败，
 *                                              仅该 group shard 读写；来自基类）
 *
 * 设计：
 *   - app_config 的值是**用户必填的权威值**，记录缺失即未配置
 *   - service 不做「缺省→默认」回退（消费方侧 `?? CODE_DEFAULT`）
 *   - 底经 CrudStore（entity = app_config），无业务特化
 *   - 逻辑完全复用 KvConfigService 基类，本类只绑定 AppConfigSchema
 */
import { KvConfigService, type KvConfigServiceOptions } from './kv-config-service';
import { AppConfigSchema } from './schema_defs/app_config';

/**
 * app_config 域逻辑服务。
 *
 * 用法：
 *   const svc = new AppConfigService({ root: DATA_DIR });
 *   svc.set('appearance', 'theme', 'dark');
 *   svc.get('appearance', 'theme');  // → 'dark'
 *   svc.get('providers', 'unknown'); // → undefined（未配置）
 */
export class AppConfigService extends KvConfigService {
  constructor(opts: KvConfigServiceOptions) {
    super(AppConfigSchema, opts);
  }
}

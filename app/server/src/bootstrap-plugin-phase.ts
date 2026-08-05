/**
 * bootstrap-plugin-phase — Phase 1+2+3 装配：plugin registry + scope config + policy/config stores
 *
 * 纯 move 自 bootstrap.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.1 Phase 1/2/3 + §4.2 第一行
 *
 * 装配顺序（INV-C-1 严格保留）：
 *   1. Registry + BUILTIN_EXTENSION_POINTS 登记
 *   2. BuiltinLoader 扫 builtins 下各 plugin.json + registerTestFixtures（test env）
 *   3. loadScopeConfigs + GroupMetaLoader + ScopeConfigValidator（硬失败语义保留）
 *   4. PluginPolicyStore + PluginConfigService（注入 scopeConfigProvider + groupMeta）
 *   5. PluginManager + AppConfigService
 *
 * packaged 护栏（INV-PKG-1/2/3）：
 *   - 不读 process.env 的非白名单键（test env 检测走 isTestEnv() 封装）
 *   - 不拼接相对路径（builtinsDir/scopesDir/groupsPath 用 __dirname 解析，CJS 下 = dist/）
 *   - dataDir 作入参（已展开绝对路径）
 */
import * as path from 'node:path';
import {
  Registry,
  PluginManager,
  PluginConfigService,
  PluginPolicyStore,
  BUILTIN_EXTENSION_POINTS,
  BuiltinLoader,
  ScopeConfigLoader,
  ScopeConfigValidator,
  LoadedScopeConfigProvider,
  GroupMetaLoader,
  LoadedGroupMetaProvider,
} from './plugin';
import { registerTestFixtures, isTestEnv, buildTestScopeConfig } from './plugin/test-fixtures';
import { AppConfigService } from './config/app-config-service';

/**
 * Phase 1+2+3 装配：扫描 plugin.json 登记 + scope 配置校验 + 三域 config service 构造。
 *
 * @param dataDir 数据根目录绝对路径（INV-PKG-1：必经 resolveDataDir 展开）
 * @returns registry + pluginManager + pluginConfigService + appConfig + policyStore
 */
export async function bootstrapPluginPhase(dataDir: string): Promise<{
  registry: Registry;
  pluginManager: PluginManager;
  pluginConfigService: PluginConfigService;
  appConfig: AppConfigService;
  policyStore: PluginPolicyStore;
}> {
  const registry = new Registry();

  // 登记内置扩展点（cardinality / id 来自 extension-point 常量）
  for (const ep of BUILTIN_EXTENSION_POINTS) {
    registry.registerExtensionPoint(ep);
  }

  // 扫描内置 plugin 目录（T7 builtins/llm_anthropic/plugin.json）
  // loader 校验目录名==manifest.id，动态 import impl 模块 default export 类
  const builtinsDir = path.resolve(__dirname, '../../plugins/builtins');
  await new BuiltinLoader(builtinsDir).loadAll(registry);

  // test 环境 fixture 注册（exclusive/ordered/schemaConfig EP + 4 plugin）：仅注册 manifest，不写 policy。
  // 必须在 scope 加载前注册：test EP 须先在 registry 登记，否则 validator 校验 test scope 会失败。
  registerTestFixtures(registry);

  // 配置代码化（design §2.1）：读 app/plugins/scopes/*.yaml → ScopeConfig[]
  //   - default.yaml + forked.yaml 始终加载（prod/dev/test 都用）
  //   - test fixture scope 由代码声明（buildTestScopeConfig），test env 下额外 push；
  //     非 test env 不注入 test scope（其引用的 test EP 未登记会失败）
  //   - 加载后 ScopeConfigValidator 校验 vs registry 一致性（exclusive 唯一 / impl+point 存在），
  //     校验失败 throw（硬失败暴露 misconfig，不静默 fallback）
  // 加载 app/plugins/groups.json → LoadedGroupMetaProvider
  //   - 顺序：builtin-loader → groups → validator → service
  //   - groups.json 不存在/形状错 → throw（硬失败，与 scopes 一致）
  //   - Validator 注入 groups，启动期校验 registry ↔ groups 双向一致
  //   - test env 双 list 策略：
  //     * providerGroups = 真实 group（喂 inventory 展示，不含 _test_fixtures）
  //     * validatorGroups = 真实 group + _test_fixtures（喂 validator，让 fixture EP 通过双向一致校验）
  //     _test_fixtures 是验证脚手架，不该进展示层。prod/dev 无 fixture EP，两 list 相同。
  const scopesDir = path.resolve(__dirname, '../../plugins/scopes');
  const scopeConfigs = loadScopeConfigs(scopesDir);
  const groupsPath = path.resolve(__dirname, '../../plugins/groups.json');
  const providerGroups = new GroupMetaLoader(groupsPath).load().groups;
  let validatorGroups = providerGroups;
  if (isTestEnv()) {
    const known = new Set(providerGroups.flatMap((g) => g.extPoints));
    const orphans = registry.listPoints().filter((p) => !known.has(p));
    if (orphans.length > 0) {
      validatorGroups = [
        ...providerGroups,
        {
          id: '_test_fixtures',
          label: '__MSG_group._test_fixtures.label__',
          description: 'test env fixture EP 集合（仅 validator 用，不进 inventory）',
          extPoints: orphans,
        },
      ];
    }
  }
  const groupMetaProvider = new LoadedGroupMetaProvider(providerGroups);
  new ScopeConfigValidator({ registry, groups: validatorGroups, allConfigs: scopeConfigs }).validateAll(scopeConfigs);
  const scopeConfigProvider = new LoadedScopeConfigProvider(scopeConfigs);

  // 共享同一 PluginPolicyStore（仅写路径用；lazy migrate 旧盘兼容保留）
  const policyStore = new PluginPolicyStore({ root: dataDir });
  // PluginConfigService 读路径用 ScopeConfigProvider（代码声明唯一源）；
  // 注入 groupMeta（LoadedGroupMetaProvider），inventory-builder JOIN group 用。
  const pluginConfigService = new PluginConfigService(registry, {
    root: dataDir,
    scopeConfigs: scopeConfigProvider,
    groupMeta: groupMetaProvider,
  });
  // PluginManager 读路径用 ScopeConfigProvider（不依赖 policyStore/activationStore）
  const pluginManager = new PluginManager({
    registry,
    scopeConfigs: scopeConfigProvider,
  });

  const appConfig = new AppConfigService({ root: dataDir });

  return { registry, pluginManager, pluginConfigService, appConfig, policyStore };
}

/**
 * 加载 scope 代码声明（design §2.1）。
 *   - 始终加载 default.yaml + forked.yaml（prod/dev/test 都用）
 *   - test fixture scope 由代码声明（buildTestScopeConfig），test env 下额外 push；
 *     非 test env 不注入 test scope（其引用的 test_chat_model EP 未在 registry 登记会失败）
 *   - scopes 目录不存在 → throw（硬失败：scopes 目录必须存在）
 *
 * 实现策略：ScopeConfigLoader.loadAll() 读所有 *.yaml，
 * test env 下额外 push 代码声明的 test ScopeConfig。loader 按「扫整个目录」统一契约工作，
 * env 相关注入在 bootstrap 层（避免 loader 内嵌 env 逻辑）。
 */
function loadScopeConfigs(scopesDir: string) {
  const all = new ScopeConfigLoader(scopesDir).loadAll();
  // test env 下额外 push 代码声明的 test ScopeConfig
  if (isTestEnv()) {
    all.push(buildTestScopeConfig());
  }
  return all;
}

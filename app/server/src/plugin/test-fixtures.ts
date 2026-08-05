/**
 * test-fixtures — 测试专用扩展点 + impl + plugin 注册（仅 test 环境）
 * 参考: specs/tech/plugin_system/[P0]extension_point_interface.md（type/cardinality）
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4（register(manifest, ...classes)）
 *       reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D5（test fixture 不写 policy）
 *       specs/ui/components/plugin-config-page/section-ext-point-area.md（testid 约定）
 *
 * 背景（BUG-004）：v0.0.5 PRD P3/P5/P6 路径要求 exclusive / ordered / configSchema
 * 扩展点可观测。生产 builtin 仅 llm_anthropic（list 类型），AT/ET 无法覆盖 radio/拖拽/schema 弹层。
 *
 * v0.0.67 重构（D5）：本函数仅注册 manifest（EP + impl + plugin 元数据），不写 policy。
 *   - 旧版调 pluginConfigService.setExclusive('test_chat_model_a') 写落盘 policy
 *   - v0.0.67 改在代码声明 app/plugins/scopes/test.json（exclusivePicks 字段）
 *   - v0.0.71 返工：test.json 删除，改由 buildTestScopeConfig() 代码构造 ScopeConfig，
 *     bootstrap 在 test env 下额外 push 进 scopeConfigs[]（不经 loader 文件解析）
 *
 * 设计：
 *   - 仅当 `process.env.APP_ENV === 'test'` 时由 bootstrap 调 registerTestFixtures(registry)
 *   - 注册测试扩展点（exclusive / ordered）+ 4 plugin（2 ext-plugin + 2 纯 toggle plugin）
 *   - impl 类用 noop stub（inventory 不实例化 impl 类，仅登记 manifest 元数据）
 *   - testid 与 ET case 对齐：ext-point-{pointId} / ext-impl-radio-{pointId}-{implId} /
 *     plugin-item-{pluginId} / plugin-toggle-{pluginId}
 *
 * 不污染 dev/prod：函数体只在 test env 下执行 register；其他 env 是 no-op。
 */
import type { Registry } from './registry';
import type { ExtensionPoint } from './extension-point';
import type { PluginManifest } from './manifest';
import type { ScopeConfig } from './scope-config-loader';

/** 测试环境标识判断（APP_ENV=test 由 env_start.sh 注入） */
export function isTestEnv(): boolean {
  return process.env.APP_ENV === 'test';
}

/**
 * v0.0.179 模型简化（impl 列表模型）：test fixture scope 改代码声明（原 app/plugins/scopes/test.json 删除）。
 * test scope 不经 loader 文件解析，由本函数直接构造 ScopeConfig 对象，bootstrap 在 test env
 * 下额外 push 进 scopeConfigs[]（替代原 loadScopeConfigs 读 test.json）。
 *
 * 语义（v0.0.179 impl 列表模型）：
 *   - scopeId: 'test' + 激活 test_chat_model（exclusive，列表恰好 1 active = test_chat_model_a）
 *     + test_retriever（ordered，3 impl 全 active，order 1/2/3）
 *   - impls: 全量声明该 scope 激活的 impl（membership = active）
 *     test_chat_model_a: exclusive EP 唯一 active（test_chat_model_b 不在 = inactive）
 *     test_retriever_a/b/c: ordered EP 全 active，order 1/2/3
 */
export function buildTestScopeConfig(): ScopeConfig {
  return {
    scopeId: 'test',
    name: 'Test',
    description:
      'test 环境 fixture scope（test_chat_model exclusive 选中 a / test_retriever ordered）',
    activatedPoints: ['test_chat_model', 'test_retriever'],
    impls: {
      // exclusive EP 恰好 1 active
      test_chat_model_a: { order: 1 },
      // ordered EP 全 active（registry 登记 a/b/c，全列）
      test_retriever_a: { order: 1 },
      test_retriever_b: { order: 2 },
      test_retriever_c: { order: 3 },
    },
  };
}

/** noop impl 类（inventory 路径不实例化 impl，仅占位满足 register 签名） */
class NoopImpl {}

/** 测试专用扩展点定义 */
const TEST_EXTENSION_POINTS: ExtensionPoint[] = [
  // P3 radio 互斥：2 个 impl，选 A 则 B 自动 disabled
  {
    id: 'test_chat_model',
    cardinality: 'exclusive',
    description: '测试用 exclusive 扩展点（radio 互斥，仅 test 环境）',
  },
  // P5 拖拽 + 开关：3 个 impl，order 与 enabled 正交
  {
    id: 'test_retriever',
    cardinality: 'ordered',
    description: '测试用 ordered 扩展点（拖拽排序 + 独立开关，仅 test 环境）',
  },
  // P6 schema 弹层：复用 test_chat_model 的 impl 之一（test_chat_model_a）带 configSchema
  //   v0.0.71 D7：原 schemaConfig 已并入 configSchema（单一 schema 源）
];

/**
 * 注册测试 fixture（仅 test 环境）。
 * 由 bootstrap 在 BuiltinLoader.loadAll 之后调用。
 *
 * v0.0.67（D5）+ v0.0.71 返工：仅注册 manifest，**不写 policy**——test exclusive 选中项
 * 由 buildTestScopeConfig() 代码构造 ScopeConfig（原 test.json 删除），bootstrap test env 注入。
 * 旧版 `pluginConfigService` 参数已删（无写 op 调用）。
 *
 * 非 test 环境 → no-op（不污染 dev/prod registry）。
 */
export function registerTestFixtures(registry: Registry): void {
  if (!isTestEnv()) return;

  // 1. 登记测试扩展点
  for (const ep of TEST_EXTENSION_POINTS) {
    registry.registerExtensionPoint(ep);
  }

  // 2. 登记测试 plugin（exclusive：2 个 impl，其一带 configSchema 测 P6 弹层）
  const exclusivePlugin: PluginManifest = {
    id: 'test_exclusive_plugin',
    label: 'Test Exclusive Plugin',
    description: '测试用 exclusive 扩展点 plugin（仅 test 环境）',
    extImpls: [
      {
        implId: 'test_chat_model_a',
        point: 'test_chat_model',
        impl: './noop.ts',
        description: '测试用 exclusive impl A（radio 选项，仅 test 环境）',
        // v0.0.71 D7：原 schemaConfig（apiKey string + model enum）合并进 configSchema
        configSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'API Key', default: '' },
            model: {
              type: 'string',
              enum: ['gpt-4', 'gpt-3.5-turbo'],
              default: 'gpt-4',
              description: '模型枚举',
            },
          },
        },
      },
      {
        implId: 'test_chat_model_b',
        point: 'test_chat_model',
        impl: './noop.ts',
        description: '测试用 exclusive impl B（radio 选项，仅 test 环境）',
      },
    ],
  };
  registry.register(exclusivePlugin, NoopImpl, NoopImpl);

  // 3. 登记 ordered plugin（P5：3 个 impl，测拖拽 + 独立开关）
  //    默认顺序按登记序 a/b/c（与原 priority 30/20/10 降序一致）
  const orderedPlugin: PluginManifest = {
    id: 'test_ordered_plugin',
    label: 'Test Ordered Plugin',
    description: '测试用 ordered 扩展点 plugin（仅 test 环境）',
    extImpls: [
      {
        implId: 'test_retriever_a',
        point: 'test_retriever',
        impl: './noop.ts',
        description: '测试用 ordered impl A（拖拽排序，仅 test 环境）',
      },
      {
        implId: 'test_retriever_b',
        point: 'test_retriever',
        impl: './noop.ts',
        description: '测试用 ordered impl B（拖拽排序，仅 test 环境）',
      },
      {
        implId: 'test_retriever_c',
        point: 'test_retriever',
        impl: './noop.ts',
        description: '测试用 ordered impl C（拖拽排序，仅 test 环境）',
      },
    ],
  };
  registry.register(orderedPlugin, NoopImpl, NoopImpl, NoopImpl);

  // 4. [BUG-009] 登记 2 个纯 toggle test plugin（无 ext impl，仅 plugin 级开关）
  //    插件 tab 顶层 plugins[] 需 ≥2 个可独立切换的 plugin 验证 P2「开关独立」。
  //    空 extImpls（manifest 校验允许空数组；plugin 仅 plugin 级 toggle）。
  const togglePluginA: PluginManifest = {
    id: 'test_plugin_a',
    label: 'Test Plugin A',
    description: '测试用纯 toggle plugin A（仅 test 环境，验证插件开关独立）',
    extImpls: [],
  };
  const togglePluginB: PluginManifest = {
    id: 'test_plugin_b',
    label: 'Test Plugin B',
    description: '测试用纯 toggle plugin B（仅 test 环境，验证插件开关独立）',
    extImpls: [],
  };
  registry.register(togglePluginA);
  registry.register(togglePluginB);

  // v0.0.67（D5）+ v0.0.71 返工：test_chat_model_a exclusive 选中改由 buildTestScopeConfig()
  // 代码声明 ScopeConfig（原 scopes/test.json 删除），bootstrap test env 注入。
  // 不再 setExclusive 写落盘 policy。
}

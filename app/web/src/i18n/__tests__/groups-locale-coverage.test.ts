/**
 * @vitest-environment jsdom
 * groups.json ↔ plugin-config locale 覆盖护栏（防 drift）
 * 参考: specs/tech/plugin_system/[P1]groups_meta_decl.md §5.4（locale 覆盖契约）
 *       specs/tech/i18n/[P0]i18n_overview.md §3 规则4（缺 key 必报错）
 *
 * 防回归（v0.0.99.ext_ui 教训）：groups.json 是 group/extPoint id 的唯一权威源，
 * 但 plugin-config ns 的 group/extPoint locale 文案是**手维护**的，两边无机制绑定 →
 * 新增 group/EP 不同步 locale 时，前端 sidebar 渲染 `group.<snake_id>.label` 查不到 key，
 * 走 parseMissingKeyHandler 显示「【资源 group.xxx 不存在】」长串被 truncate 截断
 * （用户看到「group.context-ingest.xxx 看不见」）。
 *
 * 本护栏把 locale 绑到 groups.json 权威声明：
 *   - 每个 group 的 `label` 占位符 `__MSG_group.<snake_id>.label__` → 抽出 dotted key
 *     → 断言 zh-CN / en 双 locale 都有该 key（声明 ↔ 实现绑定）。
 *   - 断言占位符遵循 snake_id 约定（`<snake_id>` = id 的 `-` 转 `_`），闭环 sidebar
 *     `groupId.replace(/-/g,'_')` 派生路径（component 无 API 直读占位符，靠约定对接）。
 *   - groups.json 全部 extPoint id → 断言 `extpoint.<id>.description` 双 locale 都有。
 *
 * 与 keys-aligned.test.ts 互补：后者只查 zh↔en 两边 key 集合一致（一起漏也算"对齐"），
 * 本测试把 locale 绑到 groups.json 权威源，堵住「两边一起 drift」的盲区。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n, initI18n } from '../index';

// app/web/src/i18n/__tests__ → app/plugins/groups.json（上溯 4 级到 app/）
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_JSON_PATH = path.resolve(TEST_DIR, '../../../../plugins/groups.json');

interface GroupsMetaFile {
  groups: { id: string; label: string; extPoints: string[] }[];
}

const groupsMeta = JSON.parse(fs.readFileSync(GROUPS_JSON_PATH, 'utf8')) as GroupsMetaFile;

/** `__MSG_<dotted.key>__` → <dotted.key>（与 resolveI18nField 同款提取） */
const MSG_RE = /^__MSG_(.+)__$/;
/** bundle 内按 dotted key 逐级取值（缺任一级 → undefined） */
function lookup(bundle: unknown, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((acc, seg) => {
    return acc != null && typeof acc === 'object' ? (acc as Record<string, unknown>)[seg] : undefined;
  }, bundle);
}

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('groups.json ↔ plugin-config locale 覆盖护栏（防 drift）', () => {
  const groupIds = groupsMeta.groups.map((g) => g.id);
  const extPointIds = Array.from(new Set(groupsMeta.groups.flatMap((g) => g.extPoints)));

  it('groups.json 加载成功且至少含 1 个 group（防路径解析失效静默空过）', () => {
    expect(groupIds.length, `groups.json 未加载到 group，检查路径: ${GROUPS_JSON_PATH}`).toBeGreaterThan(0);
  });

  it.each(groupIds)(
    'group id="%s" 的 label 占位符遵循 snake_id 约定且双 locale 都有该 key',
    (id) => {
      const g = groupsMeta.groups.find((x) => x.id === id)!;
      const match = MSG_RE.exec(g.label);
      // 提取占位符 dotted key（if-throw 同时给 TS 收窄 declaredKey: string）
      if (!match || !match[1]) {
        throw new Error(
          `groups.json group "${id}".label 不是 __MSG_<key>__ 占位符: "${g.label}"`,
        );
      }
      const declaredKey = match[1];
      // 约定闭环：占位符 key 必须是 group.<snake_id>.label，snake_id = id 的 - 转 _
      const snakeId = id.replace(/-/g, '_');
      expect(
        declaredKey,
        `groups.json group "${id}".label 占位符 key 应为 group.${snakeId}.label，实际 "${declaredKey}"（与 sidebar groupId.replace(/-/g,'_') 派生不一致）`,
      ).toBe(`group.${snakeId}.label`);
      // 声明 ↔ 实现：双 locale 都必须有该 dotted key
      for (const lng of ['zh-CN', 'en'] as const) {
        const bundle = i18n.getResourceBundle(lng, 'plugin-config');
        const label = lookup(bundle, declaredKey);
        expect(
          label,
          `plugin-config(${lng}) 缺 ${declaredKey} —— groups.json 声明的占位符必须在双 locale 落地`,
        ).toBeTruthy();
      }
    },
  );

  it.each(extPointIds)(
    'extPoint id="%s" 在 zh-CN + en 都有 plugin-config:extpoint.<id>.description',
    (id) => {
      for (const lng of ['zh-CN', 'en'] as const) {
        const bundle = i18n.getResourceBundle(lng, 'plugin-config');
        const desc = lookup(bundle, `extpoint.${id}.description`);
        expect(
          desc,
          `plugin-config(${lng}) 缺 extpoint.${id}.description —— groups.json 引用的 EP 必须有双 locale description`,
        ).toBeTruthy();
      }
    },
  );
});

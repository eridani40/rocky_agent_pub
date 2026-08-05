/**
 * profile toolBound UT — v0.0.237 task/okr/req 摘除 + todo 绑定校验。
 * 参考: specs/tech/agent/tools/[P1]todo_tools.md §5（profile 绑定权威）
 *
 * 覆盖：
 *   - studio-leader / studio-mate parent.main：摘 task/goal/requirement（工作项工具全删）
 *   - studio-leader / studio-mate parent.main：含 todo（保留）+ team（保留）
 *   - studio-squad parent.main：含 todo
 *   - 全盘扫：所有 *.parent.main.yaml 不含 task/goal/requirement
 *   - todoTool 在 defaultTools（registry 注册）
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultTools } from '../../tools/registry';

/** session-types 目录绝对路径（app/plugins/session-types） */
const SESSION_TYPES_DIR = path.resolve(__dirname, '../../../../plugins/session-types');

/** 读 parent.main profile 的 toolBound（按文件名读 + parse） */
function readToolBound(profileName: string): string[] {
  // profileName 如 'studio-leader.parent.main' → 文件名 {profileName}.yaml
  const filePath = path.join(SESSION_TYPES_DIR, `${profileName}.yaml`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseYaml(raw) as { toolBound?: string[] };
  return parsed.toolBound ?? [];
}

/** 列所有 parent.main yaml 文件名 */
function listParentMainProfiles(): string[] {
  return fs
    .readdirSync(SESSION_TYPES_DIR)
    .filter((f) => f.endsWith('.parent.main.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''));
}

describe('profile toolBound — v0.0.237 task/okr/req 摘除', () => {
  it('studio-leader:parent:main 摘 task/goal/requirement，保留 team + todo', () => {
    const tb = readToolBound('studio-leader.parent.main');
    expect(tb).not.toContain('task');
    expect(tb).not.toContain('goal');
    expect(tb).not.toContain('requirement');
    expect(tb).toContain('team');
    expect(tb).toContain('todo');
    expect(tb).toContain('send_message');
  });

  it('studio-mate:parent:main 摘 task/goal/requirement，保留 team + todo', () => {
    const tb = readToolBound('studio-mate.parent.main');
    expect(tb).not.toContain('task');
    expect(tb).not.toContain('goal');
    expect(tb).not.toContain('requirement');
    expect(tb).toContain('team');
    expect(tb).toContain('todo');
  });

  it('studio-squad:parent:main 含 todo（squad 群聊哑路由，todo 绑定）', () => {
    const tb = readToolBound('studio-squad.parent.main');
    expect(tb).toContain('todo');
    expect(tb).not.toContain('task');
    expect(tb).not.toContain('goal');
    expect(tb).not.toContain('requirement');
  });

  it('全盘扫：所有 parent.main profile 不含 task/goal/requirement', () => {
    const profiles = listParentMainProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      const tb = readToolBound(p);
      expect(tb).not.toContain('task');
      expect(tb).not.toContain('goal');
      expect(tb).not.toContain('requirement');
    }
  });

  it('academy parent.main profiles 绑 todo', () => {
    for (const p of ['academy-coach.parent.main', 'academy-head_teacher.parent.main', 'academy-student.parent.main']) {
      const tb = readToolBound(p);
      expect(tb).toContain('todo');
    }
  });
});

describe('todoTool 注册到 defaultTools（registry）', () => {
  it('defaultTools 含 todo 工具（definition.name === "todo"）', () => {
    const tools = defaultTools('/tmp');
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain('todo');
    expect(names).not.toContain('task'); // v0.0.237：task 工具整删
    expect(names).not.toContain('goal');
    expect(names).not.toContain('requirement');
  });

  it('todo 工具有 7 action inputSchema', () => {
    const tools = defaultTools('/tmp');
    const todo = tools.find((t) => t.definition.name === 'todo');
    expect(todo).toBeDefined();
    const actionProp = (todo!.definition.inputSchema as { properties?: { action?: { enum?: string[] } } }).properties?.action;
    expect(actionProp?.enum).toEqual([
      'add_item', 'update_item', 'add_step', 'update_step',
      'delete_item', 'list', 'cleanup_finished',
    ]);
  });
});

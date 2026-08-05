/**
 * [v0.0.130.hang 模块 A] 各内置工具单例 defaultTimeoutMs 字段值断言（白盒）
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 A（数值表）
 *
 * 覆盖：
 *   - file 类（read/write/edit/glob/grep）= 10000（只读快工具）
 *   - web 类（web_fetch/web_search）= 30000（网络类）
 *   - agent = 600000（spawn sync follow-child 上限）
 *   - bash = 120000（与 bash 自身 DEFAULT_TIMEOUT 对齐）
 * 只断言字段值，不涉及 run() 行为（run 逻辑未改，行为回归见各工具既有 UT）。
 */
import { describe, it, expect } from 'vitest';
import { fileReadTool } from '../file-read';
import { fileWriteTool } from '../file-write';
import { fileEditTool } from '../file-edit';
import { fileGlobTool } from '../file-glob';
import { fileGrepTool } from '../file-grep';
import { webFetchTool } from '../web-fetch/tool';
import { webSearchTool } from '../web-search/tool';
import { agentTool } from '../../agent/tools/agent-tool';
import { bashTool } from '../bash';

describe('内置工具 defaultTimeoutMs（v0.0.130.hang 模块 A 数值表）', () => {
  it('file 类工具（read/write/edit/glob/grep）= 10000', () => {
    expect(fileReadTool.defaultTimeoutMs).toBe(10000);
    expect(fileWriteTool.defaultTimeoutMs).toBe(10000);
    expect(fileEditTool.defaultTimeoutMs).toBe(10000);
    expect(fileGlobTool.defaultTimeoutMs).toBe(10000);
    expect(fileGrepTool.defaultTimeoutMs).toBe(10000);
  });

  it('web 类工具（web_fetch/web_search）= 30000', () => {
    expect(webFetchTool.defaultTimeoutMs).toBe(30000);
    expect(webSearchTool.defaultTimeoutMs).toBe(30000);
  });

  it('agent 工具 = 600000（等于 engine 硬天花板）', () => {
    expect(agentTool.defaultTimeoutMs).toBe(600000);
  });

  it('bash 工具 = 120000（与 bash 自身 DEFAULT_TIMEOUT 对齐）', () => {
    expect(bashTool.defaultTimeoutMs).toBe(120000);
  });

  it('definition.name 未受影响（仅新增字段，不改声明）', () => {
    expect(fileReadTool.definition.name).toBe('read');
    expect(bashTool.definition.name).toBe('bash');
    expect(agentTool.definition.name).toBe('agent');
    expect(webFetchTool.definition.name).toBe('web_fetch');
    expect(webSearchTool.definition.name).toBe('web_search');
  });
});

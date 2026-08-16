/**
 * sse topic 白名单 ↔ bootstrap-bus-phase 注册 双向对齐硬不变量
 * 参考:
 *   - specs/tech/app/frontend/[P0]sse_channel.md §2-§4（topic 订阅协议）
 *   - states/v0.0.184.student_training/bugs/BUG-001（app_task 注册却未进白名单的漏配事故）
 *
 * 背景：bootstrap-bus-phase.ts 的 hub.registerTopic(...) 清单与 handlers/sse.ts 的
 * ALLOWED_TOPICS 白名单是两处手维护——v0.0.164 注册 app_task 时漏配白名单，
 * 前端 subscribe('app_task') 被 400 拒，SSE 链路静默失效一年无人发现。
 *
 * 本测试从 bootstrap-bus-phase.ts 源码提取全部 registerTopic 标识符，
 * 经 TOPIC_VALUE_BY_IDENT 映射到 topic 值，与 ALLOWED_TOPICS 双向比对：
 *   - 注册了但不在白名单 → fail（BUG-001 类漏配）
 *   - 白名单放行了未注册 topic → fail（白名单腐化）
 *   - 新注册标识符未登记进 TOPIC_VALUE_BY_IDENT → fail（提示同步本测试 + 白名单）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_TOPICS } from '../handlers/sse';
import { AGENT_LOOP_TOPIC, SESSION_PANEL_TOPIC, PANORAMA_TOPIC } from '../bootstrap-bus-phase';
import { SESSION_META_TOPIC, APP_TASK_TOPIC } from '../agent/session-event-types';
// [v0.0.305] squad_meta topic 真值（squad 层事件类型文件导出）
import { SQUAD_META_TOPIC } from '../squad/squad-event-types';
// [v0.0.363] provider_quota topic 真值（额度快照 SSE 广播）
import { PROVIDER_QUOTA_TOPIC } from '../llm/quota-events';

/** src 根目录（app/server/src）。__dirname = .../app/server/src/__tests__ */
const SRC_ROOT = join(__dirname, '..');

function readSrc(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf-8');
}

/**
 * registerTopic 标识符 → topic 值映射。
 * 新增 topic 时在 bus-phase registerTopic 后必须同步：① 本映射 ② sse.ts ALLOWED_TOPICS。
 */
const TOPIC_VALUE_BY_IDENT: Record<string, string> = {
  AGENT_LOOP_TOPIC,
  SESSION_PANEL_TOPIC,
  SESSION_META_TOPIC,
  APP_TASK_TOPIC,
  PANORAMA_TOPIC,
  SQUAD_META_TOPIC,
  PROVIDER_QUOTA_TOPIC,
};

/** 从 bootstrap-bus-phase.ts 源码提取全部 hub.registerTopic(IDENT, ...) 的标识符 */
function extractRegisteredIdents(): string[] {
  const src = readSrc('bootstrap-bus-phase.ts');
  return [...src.matchAll(/hub\.registerTopic\(\s*([A-Z_][A-Z0-9_]*)/g)]
    .map((m) => m[1])
    .filter((v): v is string => v !== undefined);
}

describe('sse topic 白名单 ↔ bus-phase 注册 双向对齐', () => {
  it('bus-phase 每个 registerTopic 的 topic 都在 ALLOWED_TOPICS 内（防 BUG-001 类漏配）', () => {
    const idents = extractRegisteredIdents();
    //  sanity：提取到注册点（regex 失效时立即暴露，而非静默绿）
    expect(idents.length).toBeGreaterThan(0);
    // 未登记进映射的标识符（新增 topic 忘同步本测试）
    const unknownIdents = idents.filter((i) => TOPIC_VALUE_BY_IDENT[i] === undefined);
    expect(unknownIdents).toEqual([]);
    // 已注册但不在白名单的 topic（BUG-001 漏配模式）
    const notWhitelisted = idents
      .map((i) => TOPIC_VALUE_BY_IDENT[i])
      .filter((v) => v !== undefined && !ALLOWED_TOPICS.has(v));
    expect(notWhitelisted).toEqual([]);
  });

  it('ALLOWED_TOPICS 每个 topic 都有对应 registerTopic（白名单不放行未注册 topic）', () => {
    const idents = extractRegisteredIdents();
    const registeredValues = new Set(
      idents.map((i) => TOPIC_VALUE_BY_IDENT[i]).filter((v): v is string => v !== undefined),
    );
    const stray = [...ALLOWED_TOPICS].filter((t) => !registeredValues.has(t));
    expect(stray).toEqual([]);
  });
});

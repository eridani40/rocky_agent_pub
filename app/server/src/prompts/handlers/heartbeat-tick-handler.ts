/**
 * HeartbeatTickHandler — squad 心跳 tick 提示词（读 content/tick_heartbeat.md，无动态数据）。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §0.1（心跳提示词权威文案）
 *       specs/tech/version_logs/v0.0.153/change_plan.md T3-d
 *
 * <EOS> 是文案内的软出口引导，不是 stop token（EOS 零机制改动）。
 * 逐字一致细节：md 文件遵循仓库惯例以换行结尾，原 HEARTBEAT_TICK_PROMPT 常量无尾随换行——
 * build() 内 trimEnd() 还原（内部段落间的 \n 保留，仅去掉文件末尾多出的换行）。
 */
import {
  PromptHandler,
  type PromptHandlerContext,
  type PromptHandlerResult,
} from '../prompt-handler';

/** HeartbeatTickHandler：读 content/tick_heartbeat.md 正文，无动态数据 */
export class HeartbeatTickHandler extends PromptHandler {
  protected readonly contentFile = 'tick_heartbeat.md';

  build(_ctx: PromptHandlerContext): PromptHandlerResult {
    return { content: this.readContent().trimEnd() };
  }
}

export default HeartbeatTickHandler;

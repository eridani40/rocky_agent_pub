/**
 * 截图本地化落盘 + tool_result 文案构造（截图不 inline 进对话上下文）
 * 参考: specs/tech/version_logs/v0.0.157/change_plan.md §0（Q3 落盘 / Q6 DRY）+ INV-157-2/3/4
 *
 * 统一截图落盘出口：所有截图存为 `<workdir>/snapshots/<toolCallId>.<ext>`，
 * tool_result 仅含路径文本，主对话上下文永无 image block（INV-157-1，避纯文本模型
 * provider 400）。多模态模型按需显式调 see_image 读路径看图。
 *
 * 设计不变量：
 *  - INV-157-2 确定性命名：toolCallId（来自 LLM tool_call id）+ ext，不含 Date.now/random
 *    （record/replay 下 LLM stub 返回相同 id → 路径确定性，避 stub 漂移）
 *  - INV-157-3 单一落盘出口：computer/browser 全走 saveSnapshot，禁 actions 内各自 fs.writeFile
 *  - INV-157-4 落盘失败抛 → caller catch 转 errorResult，绝不回退 inline image
 *  - 异步 fsp：mkdir recursive + writeFile
 *
 * 路径语义：<workdir> = session.workspaceDir（与 bash/file/see_image 同根），
 *  relPath='snapshots/<id>.<ext>' 即可被 see_image 经 path.resolve(workdir, relPath) 解析。
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** saveSnapshot 入参 */
export interface SaveSnapshotParams {
  /** session workspace 根（snapshots 子目录建在此处下） */
  workdir: string;
  /** LLM tool_call id（命名用；缺省走 fallback 'unknown-'+Date.now() 并 warn） */
  toolCallId?: string;
  /** 截图二进制：Buffer 直用 / base64 字符串 → Buffer.from(s,'base64') 归一 */
  data: Buffer | string;
  /** MIME（image/png, image/jpeg, ...；决定扩展名） */
  mediaType: string;
  /** 可选尺寸透传（写入 tool_result 文案） */
  width?: number;
  height?: number;
}

/** saveSnapshot 返回值 */
export interface SnapshotSaveResult {
  /** 文件绝对路径 */
  absPath: string;
  /** 相对 workdir 的路径（进 tool_result 文案 + see_image 入参） */
  relPath: string;
  /** 透传 mediaType */
  mediaType: string;
  /** 可选尺寸透传 */
  width?: number;
  height?: number;
}

/** formatSnapshotText 入参 */
export interface FormatSnapshotTextParams {
  /** saveSnapshot 返回的 relPath */
  relPath: string;
  /** 可选尺寸（computer 截图带；browser driver 不返尺寸） */
  width?: number;
  height?: number;
  /** 可选 MIME（computer 截图带） */
  mediaType?: string;
  /**
   * 'browser' → 「browser screenshot」标签且无尺寸文案；缺省/其他 = computer 形态。
   * driver 不返尺寸，browser 路径下不带 (WxH) 段。
   */
  source?: 'browser' | 'computer';
}

/**
 * 按 mediaType 推导扩展名（小写点前缀）。
 * image/png → .png；image/jpeg 或 image/jpg → .jpg；其余兜底 .png
 * （截图事实默认 png，port.screenshot / playwright screenshot 默认均 png）
 */
function extFromMediaType(mediaType: string): string {
  if (mediaType === 'image/jpeg' || mediaType === 'image/jpg') return '.jpg';
  if (mediaType === 'image/png') return '.png';
  return '.png';
}

/**
 * 落盘截图到 `<workdir>/snapshots/<toolCallId>.<ext>`（INV-157-2/3/4）。
 *
 * 步骤：归一 data → 推导 ext → mkdir -p snapshots → writeFile（覆盖写，重复 toolCallId 自然覆盖）。
 * 落盘失败抛（fsp.mkdir/writeFile reject），caller 须 try/catch 转 errorResult，不回退 inline。
 *
 * toolCallId 缺省 fallback：`'unknown-'+Date.now()` 并 console.warn —— 仅 dev 诊断（如外部 mock
 * 跳过 engine 注入），不影响主路径；engine 一定从 call.id 注入，生产路径不会命中。
 *
 * @param p workdir / toolCallId / data / mediaType / 可选尺寸
 * @returns absPath / relPath / 透传字段
 */
export async function saveSnapshot(p: SaveSnapshotParams): Promise<SnapshotSaveResult> {
  // toolCallId fallback（仅 dev 诊断路径；主路径 engine 必注入 call.id）
  const hasId = !!p.toolCallId && p.toolCallId.length > 0;
  const id = hasId ? p.toolCallId : `unknown-${Date.now()}`;
  if (!hasId) {
    // eslint-disable-next-line no-console
    console.warn(`[snapshot-store] toolCallId missing, fallback to ${id}`);
  }

  const ext = extFromMediaType(p.mediaType);
  const dirAbs = path.resolve(p.workdir, 'snapshots');
  const fileAbs = path.resolve(dirAbs, `${id}${ext}`);
  const relPath = `snapshots/${id}${ext}`;

  // 归一 data：base64 字符串 → Buffer；Buffer 直用
  const buf = typeof p.data === 'string' ? Buffer.from(p.data, 'base64') : p.data;

  // mkdir -p snapshots（recursive 等价 -p）；已存在不报错
  await fsp.mkdir(dirAbs, { recursive: true });
  // 覆盖写：重复 toolCallId（同一 tool call 重放）自然覆盖，不留旧文件
  await fsp.writeFile(fileAbs, buf);

  return {
    absPath: fileAbs,
    relPath,
    mediaType: p.mediaType,
    width: p.width,
    height: p.height,
  };
}

/**
 * 构造 tool_result 文案（INV-157-1：纯 text，无 image block）。
 *
 * 形态：
 *  - computer（默认）：`Saved screenshot to <relPath> (<W>x<H>, <mediaType>). Use see_image tool to view it.`
 *    尺寸缺省时省略 (WxH, mediaType) 段，仅留路径。
 *  - browser：`Saved browser screenshot to <relPath>. Use see_image tool to view it.`
 *    （driver 不返尺寸，固定不带 size 段，source='browser' 即走此分支）
 *
 * 文案最后一句引导 LLM 按需调 see_image 读图（非硬约束；纯文本模型可忽略）。
 */
export function formatSnapshotText(p: FormatSnapshotTextParams): string {
  if (p.source === 'browser') {
    return `Saved browser screenshot to ${p.relPath}. Use see_image tool to view it.`;
  }
  // computer 形态：有尺寸则带 (WxH, mediaType) 段；缺省则只留路径
  const hasSize = p.width !== undefined && p.height !== undefined;
  const sizeSeg = hasSize
    ? ` (${p.width}x${p.height}${p.mediaType ? `, ${p.mediaType}` : ''})`
    : '';
  return `Saved screenshot to ${p.relPath}${sizeSeg}. Use see_image tool to view it.`;
}

/**
 * page-channel — 渠道配置页根
 * 参考: specs/ui/components/channel-page/page-channel.md
 *       specs/ui/overall/06-channel.md §1/§2/§5
 *       specs/api/overall/17-channel.md
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形）
 *
 * 组合：header(标题「渠道」+ desc) + channel-new-btn + channel-list + channel-form。
 * 数据：configs = useLifecycle<Snapshot<ChannelConfig[]>>（onInit GET + startTimer(5s)；onTick 重读）；
 *       implTypes = 组件本地 useState（mount 一次性 GET /config/channels/impl-types，不进 5s poll）。
 * 仿 page-connector 结构（无 SSE topic → 纯 poll 兜底）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLifecycle } from '../../lib/use-lifecycle';
import type { Snapshot } from '../../lib/lifecycle-shapes';
import {
  listChannels,
  listChannelImplTypes,
  createChannel,
  updateChannel,
  deleteChannel,
  type ChannelConfig,
  type ChannelImplTypeInfo,
  type ChannelFormInput,
} from '../../lib/channel-api';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';
import { SectionChannelList } from './section-channel-list';
import { SectionChannelForm } from './section-channel-form';

/** 轮询间隔（connection 迁移由后端推动，纯 poll 兜底，仿 connector 5s） */
const POLL_INTERVAL_MS = 5000;

/**
 * 渲染渠道页根。挂载取列表；5s onTick 轮询；CRUD 后 reload() 取稳态。
 * 本地态：formOpen（表单显隐）+ editing（编辑目标 config，null=新建）+ implTypes（mount 一次性取）。
 */
export function PageChannel() {
  const { ctx: instances, reload } = useLifecycle<Snapshot<ChannelConfig[]>>({
    onInit: async ({ signal, startTimer }) => {
      startTimer({
        intervalMs: POLL_INTERVAL_MS,
        justification: 'channel connection 迁移由后端推动，无 SSE topic 感知',
      });
      const items = await listChannels();
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return items;
    },
    onTick: async () => {
      const items = await listChannels();
      return items;
    },
    deps: [],
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ChannelConfig | null>(null);
  // impl 类型列表：后端 scope 激活集合派生（default.yaml channel EP 配置驱动），mount 一次性取，
  // 静态代码声明配置不进 5s poll；失败置 []（表单空态提示，不阻断既有 config 列表/编辑）
  const [implTypes, setImplTypes] = useState<ChannelImplTypeInfo[]>([]);
  const { t } = useTranslation('channel');
  // plugin-config ns 的 t：解析 impl manifest label 的 __MSG_ 占位符（label 翻译在 plugin.json locales）
  const { t: tPc } = useTranslation('plugin-config');

  useEffect(() => {
    const ctrl = new AbortController();
    listChannelImplTypes()
      .then((items) => {
        if (!ctrl.signal.aborted) setImplTypes(items);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setImplTypes([]);
      });
    return () => ctrl.abort();
  }, []);

  const list = instances ?? [];
  // 渲染期解析 label 占位符（lib 层透传原始 __MSG_，i18n 解析属渲染层职责）
  const resolvedTypes = implTypes.map((tp) => ({ implId: tp.implId, label: resolveI18nField(tp.label, tPc) }));

  /** toggle on/off → PUT enabled（fire-and-forget，后端 connect/disconnect）+ reload 取稳态 */
  const handleToggle = async (id: string, enable: boolean) => {
    try {
      await updateChannel(id, { enabled: enable });
    } catch {
      // 派发失败：reload 兜底（保持与后端一致）
    }
    await reload();
  };

  /** 提交表单（新建 POST / 编辑 PUT）+ reload + 关表单 */
  const handleSubmit = async (input: ChannelFormInput) => {
    if (editing) {
      // 编辑：appSecret '***' = 未改（后端 merge 原值）
      await updateChannel(editing.id, {
        name: input.name,
        appId: input.appId,
        appSecret: input.appSecret,
      });
    } else {
      await createChannel(input);
    }
    setFormOpen(false);
    setEditing(null);
    await reload();
  };

  /** 删除（二次确认已在 list 行内完成）→ DELETE + reload */
  const handleDelete = async (inst: ChannelConfig) => {
    try {
      await deleteChannel(inst.id);
    } catch {
      // 删除失败：reload 兜底
    }
    await reload();
  };

  /** 打开新建表单 */
  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };

  /** 打开编辑表单 */
  const openEdit = (inst: ChannelConfig) => {
    setEditing(inst);
    setFormOpen(true);
  };

  /** 关表单（取消） */
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  // Esc 关闭表单弹层（formOpen 时挂 document keydown listener，仿 board-selector outside-click 模式）
  useEffect(() => {
    if (!formOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setFormOpen(false);
        setEditing(null);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [formOpen]);

  return (
    <main className="flex-1 overflow-y-auto flex flex-col">
      {/* header：标题 + sub desc（对齐 connector-page header 风格） */}
      <div className="px-8 pt-6 pb-[18px] border-b border-border shrink-0">
        <div

          className="text-[20px] font-bold tracking-[-0.02em] text-fg"
        >
          {t('header.title')}
        </div>
        <div

          className="mt-[3px] text-[12px] text-muted font-mono"
        >
          {t('header.desc')}
        </div>
      </div>

      {/* body：新建按钮 + 列表（max-width 880px，对齐 connector/skill 页） */}
      <div className="px-8 pt-5 pb-10 flex-1 flex flex-col gap-3" style={{ maxWidth: '880px' }}>
        {/* 新建按钮：弹层模式不挡按钮 → 始终显示（conventions §11 尺寸稳定性，避免条件显隐致位移） */}
        <button
          type="button"
          data-action-key="channel.instance.create"
          onClick={openNew}
          className="self-start px-3 py-[6px] rounded-md text-[12px] font-semibold border border-border-2 text-fg hover:border-accent hover:text-accent transition-colors"
        >
          + {t('list.newBtn')}
        </button>

        {/* 列表 */}
        <SectionChannelList
          instances={list}
          onToggle={handleToggle}
          onEdit={openEdit}
          onDelete={handleDelete}
        />
      </div>

      {/* 表单弹层（formOpen 时渲染：fixed inset-0 遮罩 + 居中 card；仿 ConfirmModal）
          关闭 = 点遮罩 / Esc / 表单 onCancel */}
      {formOpen && (
        <div
          role="dialog"
          aria-modal="true"

          onClick={(e) => {
            // 仅点击遮罩本身（非内部 card）才关闭
            if (e.target === e.currentTarget) closeForm();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="rounded-lg bg-surface border border-border p-6 max-w-md w-full mx-4 shadow-lg max-h-[90vh] overflow-y-auto">
            <SectionChannelForm
              editing={editing}
              types={resolvedTypes}
              onSubmit={handleSubmit}
              onCancel={closeForm}
            />
          </div>
        </div>
      )}
    </main>
  );
}

export default PageChannel;

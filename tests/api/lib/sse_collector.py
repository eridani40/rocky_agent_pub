"""
SSE 采集器：单长连接后台线程 + 命名流缓冲
参考：design_case_schema.md §4；change_plan B 组 sse_collector.py
设计约束：
  - 首个 sse.sub 出现时惰性建立 GET /sse 长连接
  - case 结束才关流（不随单 step 结束）
  - 不录不回放（被测物，SSE 是业务输出）
"""
import json
import threading
import time
import urllib.request
import urllib.error
import uuid
from typing import Optional


class SseCollector:
    """
    GET /sse 单长连接后台收集线程。
    subscribe(topic, group, as_name) 注册命名流过滤条件，
    匹配的事件追加到对应命名流缓冲。
    """

    def __init__(self, base_url: str):
        self._base_url = base_url.rstrip('/')
        self._streams: dict = {}      # as_name → {topic, group, events: []}
        self._subs: list = []         # [{topic, group, as_name}]
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._connect_event = threading.Event()  # GET /sse 连接建立完成信号
        self._started = False
        self._connected = False       # GET /sse 连接已建立标志
        self._seq = 0                 # 全局事件序号

    def subscribe(self, topic: str, group: str, as_name: str) -> None:
        """
        注册命名流订阅，并向 server 发 POST /sse/subscribe 激活推送。
        首次调用时惰性启动后台收集线程。
        topic/group 支持已完成插值的字符串（插值在 step_exec 层完成）。
        """
        # subId 必须每次订阅唯一（server 协议「1 次订阅 = 1 个 subId」，
        # subscribers 表按 subId 幂等——固定值会让第二个 case 的新 group 被静默跳过，
        # 事件永远无 listener。as_name 仅作本地命名流名，不上行。）
        sub_id = uuid.uuid4().hex
        with self._lock:
            if as_name in self._streams:
                # 已注册（重复订阅幂等，同名流合并 topic/group 不验证）
                return
            self._streams[as_name] = {'topic': topic, 'group': group, 'events': []}
            self._subs.append({'topic': topic, 'group': group, 'as_name': as_name, 'sub_id': sub_id})

        if not self._started:
            self._start()

        # 等 SSE 连接建立（最多 3s），确保 server 端已 open sink，再 subscribe
        if not self._connect_event.wait(timeout=3.0):
            raise RuntimeError('SSE connection not established within 3s (GET /sse no first byte)')

        # 向 server 发 POST /sse/subscribe，激活 server 端 hub.sub
        self._server_subscribe(topic, group, sub_id)

    def _server_subscribe(self, topic: str, group: str, sub_id: str) -> None:
        """发 POST /sse/subscribe 给 server；失败 fail loud（订阅是 case 正确性前提）"""
        url = f'{self._base_url}/sse/subscribe'
        body = json.dumps({'topic': topic, 'group': group, 'subId': sub_id}).encode('utf-8')
        req = urllib.request.Request(
            url, data=body,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
        except Exception as e:
            raise RuntimeError(f'POST /sse/subscribe failed (topic={topic}, group={group}): {e}') from e

    def _start(self) -> None:
        """启动后台 SSE 收集线程"""
        self._started = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._collect, daemon=True)
        self._thread.start()

    def _collect(self) -> None:
        """后台线程：持续读取 GET /sse 并解析 SSE 帧

        注意：使用 resp.readline() 而非 `for raw in resp:` 迭代——
        Bun 服务端使用 chunked encoding，Python BufferedReader 的 __iter__
        会等内部 8KB 缓冲区满才返回，导致 SSE 帧长时间阻塞。
        readline() 读到第一个 '\\n' 即返回，不受缓冲区大小影响。
        """
        url = f'{self._base_url}/sse'
        req = urllib.request.Request(url, headers={'Accept': 'text/event-stream'})
        try:
            with urllib.request.urlopen(req, timeout=None) as resp:
                self._connected = True
                self._connect_event.set()  # 通知等待的 subscribe 调用可以继续
                ev_type = None
                ev_data_lines = []
                while True:
                    if self._stop.is_set():
                        break
                    raw = resp.readline()
                    if not raw:
                        break  # 连接关闭（EOF）
                    line = raw.decode('utf-8', errors='replace').rstrip('\n').rstrip('\r')
                    if line.startswith('event:'):
                        ev_type = line[len('event:'):].strip()
                    elif line.startswith('data:'):
                        ev_data_lines.append(line[len('data:'):].strip())
                    elif line == '':
                        # 空行 = SSE 帧结束
                        if ev_data_lines:
                            raw_data = '\n'.join(ev_data_lines)
                            self._dispatch(ev_type, raw_data)
                        ev_type = None
                        ev_data_lines = []
        except Exception:
            # 连接断开或关闭，静默退出
            pass

    def _dispatch(self, ev_type: Optional[str], raw_data: str) -> None:
        """将 SSE 帧分发到匹配的命名流缓冲

        server 帧格式: {"topic":..., "group":..., "data":{type:..., ...}, "timestamp":..., "subId":...}
        topic/group 在顶层；AgentEvent.type 在 data.data.type。
        """
        try:
            frame = json.loads(raw_data)
        except Exception:
            return  # 非 JSON 帧跳过

        topic = frame.get('topic', '')
        group = frame.get('group', '')
        frame_sub_id = frame.get('subId')
        # AgentEvent 嵌套在 data.data 字段里
        inner_data = frame.get('data', {}) if isinstance(frame.get('data'), dict) else {}
        event_type = ev_type or inner_data.get('type', '')

        with self._lock:
            for sub in self._subs:
                # 帧带 subId 时按 subId 精确路由（server 对每个 subscriber 各发一帧，
                # 帧上标其 subId——两个命名流订同一 (topic,group) 时若仅按 topic/group
                # 泛匹配，每帧会同时进两个流，表现为「每流双帧」假象）；
                # 无 subId 的帧退回 (topic,group) 匹配。
                if frame_sub_id is not None:
                    matched = sub.get('sub_id') == frame_sub_id
                else:
                    matched = sub['topic'] == topic and sub['group'] == group
                if matched:
                    stream = self._streams[sub['as_name']]
                    seq = self._seq
                    self._seq += 1
                    stream['events'].append({
                        'stream': sub['as_name'],
                        'seq': seq,
                        'topic': topic,
                        'group': group,
                        'type': event_type,
                        'data': inner_data,   # AgentEvent 内容（不含外层 frame 包装）
                        'ts': _now_iso(),
                    })

    def get_events(self, as_name: str) -> list:
        """获取命名流当前累积的所有事件（返回副本）"""
        with self._lock:
            stream = self._streams.get(as_name, {})
            return list(stream.get('events', []))

    def get_streams_snapshot(self) -> dict:
        """获取所有命名流的事件快照（{as_name: {events: [...]}}）"""
        with self._lock:
            return {
                name: {'events': list(info['events'])}
                for name, info in self._streams.items()
            }

    def get_step_events_increment(self, prev_counts: dict) -> dict:
        """
        获取本 step 期间各流新增的事件（用于 events.jsonl per-step 落盘）。
        prev_counts: {as_name: count_before_step}
        返回: {as_name: [new_events]}
        """
        with self._lock:
            result = {}
            for name, info in self._streams.items():
                prev = prev_counts.get(name, 0)
                result[name] = list(info['events'][prev:])
            return result

    def get_counts(self) -> dict:
        """获取各流当前事件计数（用于增量快照起点）"""
        with self._lock:
            return {name: len(info['events']) for name, info in self._streams.items()}

    def close(self) -> None:
        """关闭 SSE 连接（case 结束时调用）：先清 server 端订阅登记，再停线程。

        DELETE /sse/subscriber/:subId 对齐前端组件卸载 unsubscribe 模型，
        使 (topic,group) refcount 正确归零，不在 server 留跨 case 残留。
        """
        with self._lock:
            sub_ids = [s['sub_id'] for s in self._subs if s.get('sub_id')]
        for sid in sub_ids:
            try:
                req = urllib.request.Request(
                    f'{self._base_url}/sse/subscriber/{sid}', method='DELETE')
                with urllib.request.urlopen(req, timeout=5) as resp:
                    resp.read()
            except Exception:
                pass  # 清理尽力而为（server 可能已关闭）
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)

    def wait_for_condition(self, stream_name: str, check_fn, timeout_s: float) -> bool:
        """
        每 100ms 对命名流缓冲调用 check_fn，满足则返回 True，超时返回 False。
        check_fn(events: list) -> bool
        """
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            events = self.get_events(stream_name)
            if check_fn(events):
                return True
            time.sleep(0.1)
        # 最后一次检查
        return check_fn(self.get_events(stream_name))


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()

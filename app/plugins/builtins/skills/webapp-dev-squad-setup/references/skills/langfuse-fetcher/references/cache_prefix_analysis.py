#!/usr/bin/env python3
"""cache_prefix_analysis.py — LLM 请求间 prompt 缓存前缀稳定性分析

回答两个问题:
1. 每个 cache_control 断点保护的内容,是否作为【前缀】原样出现在下一个请求里?
2. 如果不稳定,首个分歧点在哪(哪条消息/哪个块/字符偏移/内容上下文)?

用法:
  # 本地请求负载文件(physical observation 的 input,Anthropic 风格)
  python3 cache_prefix_analysis.py req1.json req2.json [req3.json ...]

  # 直接从 langfuse 拉某条 trace 的全部 physical generation 输入
  python3 cache_prefix_analysis.py --trace=<traceId>

凭证(仅 --trace 模式): env 或 repo 根 prod.env/test.env 的
LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
"""
import json, os, sys, urllib.request, base64

# ---------- 负载结构 ----------

def blocks_of(content):
    """message.content 统一成 block 列表。str -> 一个 text block。"""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content or []

def norm_system(system):
    """system 统一成 block 列表。"""
    if isinstance(system, str):
        return [{"type": "text", "text": system}] if system else []
    return system or []

def canon(x):
    return json.dumps(x, sort_keys=True, ensure_ascii=False)

def find_breakpoints(req):
    """返回 [(label, msg_idx|None, block_idx, char_offset_estimate)]。
    Anthropic 语义: cache_control 标记所在块(含)之前的内容进入缓存。"""
    bps = []
    off = 0
    for i, b in enumerate(norm_system(req.get("system"))):
        if b.get("cache_control"):
            bps.append((f"system[{i}]", None, i, off))
        off += len(canon(b))
    for mi, m in enumerate(req.get("messages", [])):
        for bi, b in enumerate(blocks_of(m.get("content"))):
            if b.get("cache_control"):
                bps.append((f"messages[{mi}].blocks[{bi}]", mi, bi, off))
            off += len(canon(b))
    return bps

# ---------- 前缀比较 ----------

def first_text_diff(a, b):
    """两 block 文本/结构的首个字符差异偏移; 返回 (offset, snippet_a, snippet_b) 或 None。"""
    sa, sb = canon(a), canon(b)
    if sa == sb:
        return None
    n = min(len(sa), len(sb))
    for i in range(n):
        if sa[i] != sb[i]:
            return i, sa[max(0, i - 80):i + 120], sb[max(0, i - 80):i + 120]
    return n, "...(A 尾部) " + sa[n:n + 120] if len(sa) > n else "(A 更短)", "...(B 尾部) " + sb[n:n + 120] if len(sb) > n else "(B 更短)"

def compare_pair(ra, rb):
    """比较相邻两请求,返回报告 dict。"""
    rep = {"system_equal": canon(norm_system(ra.get("system"))) == canon(norm_system(rb.get("system"))),
           "tools_equal": canon(ra.get("tools")) == canon(rb.get("tools"))}
    ma, mb = ra.get("messages", []), rb.get("messages", [])
    rep["msg_counts"] = (len(ma), len(mb))
    # 最长公共消息前缀
    div = None
    for i in range(min(len(ma), len(mb))):
        if ma[i].get("role") != mb[i].get("role"):
            div = {"msg": i, "kind": "role", "a": ma[i].get("role"), "b": mb[i].get("role")}
            break
        ba, bb = blocks_of(ma[i].get("content")), blocks_of(mb[i].get("content"))
        if len(ba) != len(bb):
            div = {"msg": i, "kind": "block_count", "a": len(ba), "b": len(bb)}
            break
        for j in range(len(ba)):
            d = first_text_diff(ba[j], bb[j])
            if d:
                div = {"msg": i, "block": j, "kind": "content", "char_offset": d[0],
                       "snippet_a": d[1], "snippet_b": d[2]}
                break
        if div:
            break
    rep["first_divergence"] = div  # None = 一方是另一方完整前缀
    if div is None:
        rep["common_prefix_msgs"] = min(len(ma), len(mb))
    else:
        rep["common_prefix_msgs"] = div["msg"]
    # 可缓存比例(字符口径): 公共前缀字符数 / B 的 prompt 总字符数
    def chars(req, upto_msg=None):
        tot = sum(len(canon(b)) for b in norm_system(req.get("system")))
        for i, m in enumerate(req.get("messages", [])):
            if upto_msg is not None and i >= upto_msg:
                break
            tot += sum(len(canon(b)) for b in blocks_of(m.get("content")))
        return tot
    total_b = chars(rb)
    if div is None:
        common = chars(ra)  # ra 全是前缀
    else:
        # 公共 = system + 前 div.msg 条消息 + 分歧块前的 char_offset 近似
        common = chars(rb, upto_msg=div["msg"]) + (div.get("char_offset", 0) if div["kind"] == "content" else 0)
    rep["cacheable_chars"], rep["total_chars"] = common, total_b
    rep["cacheable_pct"] = round(100.0 * common / total_b, 1) if total_b else 0.0
    # 断点稳定性: A 的每个断点保护内容是否在 B 同位置原样出现
    bp_results = []
    for label, mi, bi, _ in find_breakpoints(ra):
        if mi is None:  # system 断点
            ok = rep["system_equal"]
            bp_results.append({"breakpoint": label, "stable_in_next": ok,
                               "note": None if ok else "system 块内容变化"})
        else:  # message 断点: 要求 B 的前 mi+1 条消息与 A 完全一致,且 A[mi] 前 bi+1 块一致
            if div is None or div["msg"] > mi:
                ok, note = True, None
            elif div["msg"] < mi:
                ok, note = False, f"前缀在 messages[{div['msg']}] 已分歧"
            else:
                d = div
                if d["kind"] == "content" and d.get("block", 0) > bi:
                    ok, note = True, None
                elif d["kind"] == "content":
                    ok, note = False, f"分歧在断点块本身/之前: messages[{mi}].blocks[{d.get('block')}] @{d.get('char_offset')}"
                else:
                    ok, note = False, f"分歧: {d['kind']} @ messages[{mi}]"
            bp_results.append({"breakpoint": label, "stable_in_next": ok, "note": note})
    rep["breakpoints"] = bp_results
    return rep

# ---------- langfuse 拉取(--trace 模式) ----------

def load_creds():
    for envfile in ("prod.env", "test.env"):
        p = os.path.join(os.getcwd(), envfile)
        if not os.path.exists(p):
            continue
        for line in open(p):
            line = line.strip().strip('"')
            if line.startswith("LANGFUSE_") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v.strip().strip('"'))
    need = ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]
    missing = [k for k in need if not os.environ.get(k)]
    if missing:
        sys.exit(f"缺凭证: {missing} (env 或 prod.env/test.env)")

def lf_get(path):
    url = os.environ["LANGFUSE_BASE_URL"].rstrip("/") + "/api/public/" + path
    auth = base64.b64encode(f"{os.environ['LANGFUSE_PUBLIC_KEY']}:{os.environ['LANGFUSE_SECRET_KEY']}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": "Basic " + auth})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def lf_get_all(path):
    """翻页拉满 list 端点（langfuse list 每页上限 100；limit>100 会 400）。
    注意：list 默认时间倒序（最新在前）——返回的是全部 data 的累积，调用方自行排序。"""
    out = []
    page = 1
    while True:
        sep = "&" if "?" in path else "?"
        r = lf_get(f"{path}{sep}limit=100&page={page}")
        out.extend(r.get("data") or [])
        meta = r.get("meta") or {}
        if page >= (meta.get("totalPages") or 1):
            return out
        page += 1

def fetch_trace_payloads(trace_id):
    obs = lf_get_all(f"observations?traceId={trace_id}&type=GENERATION")
    phys = [o for o in obs if (o.get("metadata") or {}).get("physicalWire")]
    if not phys:  # 回退: 无 physicalWire 标记时按命名约定
        phys = [o for o in obs if (o.get("name") or "").endswith("-physical")]
    phys.sort(key=lambda o: o.get("startTime") or "")
    out = []
    for o in phys:
        full = lf_get(f"observations/{o['id']}")
        if isinstance(full.get("input"), dict):
            out.append((o.get("name"), full["input"]))
    return out

# ---------- 报告 ----------

def print_report(names, reqs):
    for i in range(len(reqs) - 1):
        a, b = names[i], names[i + 1]
        rep = compare_pair(reqs[i], reqs[i + 1])
        print(f"\n=== {a} → {b} ===")
        print(f"  system 一致: {rep['system_equal']} | tools 一致: {rep['tools_equal']} | 消息数: {rep['msg_counts'][0]} → {rep['msg_counts'][1]}")
        d = rep["first_divergence"]
        if d is None:
            print(f"  前缀: {a} 是 {b} 的完整前缀 ✅ (公共 {rep['common_prefix_msgs']} 条消息)")
        else:
            loc = f"messages[{d['msg']}]" + (f".blocks[{d['block']}]" if "block" in d else "")
            print(f"  首个分歧: {loc} ({d['kind']})" + (f" 字符偏移 {d['char_offset']}" if "char_offset" in d else ""))
            if "snippet_a" in d:
                print(f"    A: ...{d['snippet_a']}...")
                print(f"    B: ...{d['snippet_b']}...")
        print(f"  理论可缓存前缀: {rep['cacheable_chars']}/{rep['total_chars']} 字符 ({rep['cacheable_pct']}%)")
        for bp in rep["breakpoints"]:
            mark = "✅" if bp["stable_in_next"] else "❌"
            print(f"  断点 {bp['breakpoint']}: {mark}" + (f" — {bp['note']}" if bp["note"] else ""))

def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    if args[0].startswith("--trace="):
        load_creds()
        trace_id = args[0].split("=", 1)[1]
        pairs = fetch_trace_payloads(trace_id)
        if len(pairs) < 2:
            sys.exit(f"trace {trace_id} 只拿到 {len(pairs)} 条 physical generation,无法比较")
        names = [p[0] for p in pairs]
        reqs = [p[1] for p in pairs]
        print(f"trace {trace_id}: {len(reqs)} 条 physical 请求")
    else:
        names = [os.path.basename(a) for a in args]
        reqs = [json.load(open(a)) for a in args]
        for r in reqs:
            if "messages" not in r:
                sys.exit("输入文件不是请求负载(缺 messages 字段)")
    print_report(names, reqs)

if __name__ == "__main__":
    main()

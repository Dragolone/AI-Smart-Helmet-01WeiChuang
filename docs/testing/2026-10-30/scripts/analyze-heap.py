#!/usr/bin/env python3
"""heapprofd 结果分析：按 callsite 累计未释放字节，比较首末两次 dump 的增量，打印涨得最多的调用栈。
usage: analyze-heap.py <trace.pftrace> [top N] [frames per stack]"""
import sys
from perfetto.trace_processor import TraceProcessor
tp = TraceProcessor(trace=sys.argv[1])
TOP = int(sys.argv[2]) if len(sys.argv) > 2 else 20
DEPTH = int(sys.argv[3]) if len(sys.argv) > 3 else 14
def q(sql): return list(tp.query(sql))
ups = q("select upid, pid, name from process where name like '%lingyiweichuang%'")
if ups: upid = ups[0].upid; print(f"process upid={upid} pid={ups[0].pid} {ups[0].name}")
else:
    # 没开 process_stats 数据源时 process 表没有名字：取有 heap 数据的那个 upid
    upid = q("select upid, count(*) c from heap_profile_allocation group by upid order by c desc")[0].upid
    print(f"process name absent; using upid={upid} (the one with heap dumps)")
dumps = q(f"select distinct ts from heap_profile_allocation where upid={upid} order by ts")
print("dumps:", len(dumps))
if len(dumps) < 2: print("need >=2 dumps"); sys.exit(1)
ts0, tsN = dumps[0].ts, dumps[-1].ts
# 未释放 = 到该 dump 为止 size 的累计和（heap_profile_allocation 每行是相对上一次 dump 的增量）
def unreleased(ts):
    return {r.callsite_id: (r.sz, r.cnt) for r in q(
        f"select callsite_id, sum(size) sz, sum(count) cnt from heap_profile_allocation where upid={upid} and ts<={ts} group by callsite_id")}
u0, uN = unreleased(ts0), unreleased(tsN)
tot0 = sum(v[0] for v in u0.values()); totN = sum(v[0] for v in uN.values())
print(f"unreleased total: first dump {tot0/1e6:.1f} MB -> last dump {totN/1e6:.1f} MB (Δ {(totN-tot0)/1e6:+.1f} MB over {(tsN-ts0)/1e9:.0f} s)")
# 按 callsite 的 Δ 排序；再把 Δ 归并到「栈顶几帧」看谁在涨
frames_cache = {}
def chain(cs):
    if cs in frames_cache: return frames_cache[cs]
    out = []; cur = cs
    while cur is not None and len(out) < 64:
        r = q(f"select c.parent_id pid, f.name fname, m.name mname, f.rel_pc relpc from stack_profile_callsite c join stack_profile_frame f on c.frame_id=f.id join stack_profile_mapping m on f.mapping=m.id where c.id={cur}")
        if not r: break
        r = r[0]; lib = (r.mname or '?').split('/')[-1]
        out.append(f"{r.fname or '?'} [{lib}+0x{(r.relpc or 0):x}]" if not r.fname else f"{r.fname} [{lib}]")
        cur = r.pid
    frames_cache[cs] = out; return out
deltas = sorted(((uN.get(cs,(0,0))[0]-u0.get(cs,(0,0))[0], cs) for cs in set(u0)|set(uN)), reverse=True)
print(f"\n=== top {TOP} callsites by Δ unreleased bytes (first→last dump) ===")
for d, cs in deltas[:TOP]:
    if d <= 0: break
    print(f"\n+{d/1e3:.0f} KB  (objs Δ {uN.get(cs,(0,0))[1]-u0.get(cs,(0,0))[1]:+d})")
    for i, fr in enumerate(chain(cs)[:DEPTH]): print(f"   {i:2d} {fr}")
# 按库聚合：栈顶第一帧所在库
agg = {}
for d, cs in deltas:
    ch = chain(cs)
    # 跳过分配器本身（libc malloc、libc++ operator new、scudo），取第一帧真正的调用方所在库
    top = next((f for f in ch if not any(k in f for k in ('[libc.so', 'libc++_shared.so', 'scudo'))), ch[0] if ch else '?')
    lib = top[top.rfind('[')+1:-1].split('+')[0]
    agg[lib] = agg.get(lib, 0) + d
agg2 = {}
for d, cs in deltas:
    ch = chain(cs)
    top = next((f for f in ch if not any(k in f for k in ('[libc.so', 'libc++_shared.so', 'scudo', 'libreactnative.so', 'libjsi.so'))), ch[0] if ch else '?')
    lib = top[top.rfind('[')+1:-1].split('+')[0]
    agg2[lib] = agg2.get(lib, 0) + d
print("\n=== Δ by first frame outside libc/libc++/libreactnative/libjsi ===")
for lib, d in sorted(agg2.items(), key=lambda x: -x[1])[:12]: print(f"  {d/1e6:+.2f} MB  {lib}")
print("\n=== Δ by library of first non-libc frame ===")
for lib, d in sorted(agg.items(), key=lambda x: -x[1])[:12]: print(f"  {d/1e6:+.2f} MB  {lib}")

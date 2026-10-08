# 使い捨て（issue #380）。log.jsonl から差分更新 1 回の時間（前の diff から次の diff まで。待ち時間なしの play なので呼び出しの時間に近い）と、
# 元の会議の時刻で見て詰まるか（呼び出しの時間が、2 発言ぶんの実時間を超える割合）を出す。発言の本文は読まない。
import json, sys, statistics
from datetime import datetime
for path in sys.argv[1:]:
    ts, remarks, diffs = [], {}, []
    prev = None
    for l in open(path):
        d = json.loads(l)
        at = datetime.fromisoformat(d["at"].replace("Z", "+00:00")).timestamp()
        if d["type"] == "remark": remarks[d["remark"]["id"]] = d["remark"]["end"]
        if d["type"] == "start": prev = at
        if d["type"] == "diff":
            fresh = d["input"]["fresh"]
            diffs.append((at - prev, max(remarks.get(r, 0) for r in fresh) if fresh else None, "error" in d))
            prev = at
    dur = [x[0] for x in diffs[1:]]
    ends = [x[1] for x in diffs]
    gaps = [b - a for a, b in zip(ends, ends[1:]) if a is not None and b is not None]
    # 等速で流したときの遅れ: 呼び出しは発言の到着と前の呼び出しの終わりの遅い方から始まる
    t = 0; lags = []
    for (d, e, _) in diffs:
        if e is None: continue
        t = max(t, e) + d; lags.append(t - e)
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(len(xs) * p))]
    print(f"{path.split('/')[-3]}: 呼び出し {len(diffs)} 失敗 {sum(x[2] for x in diffs)} 時間 中央 {statistics.median(dur):.1f}s p90 {q(dur,.9):.1f}s 最大 {max(dur):.1f}s 初回 {diffs[0][0]:.1f}s"
          f" / 2 発言の間隔 中央 {statistics.median(gaps):.1f}s / 等速の遅れ 中央 {statistics.median(lags):.0f}s 最大 {max(lags):.0f}s 最後 {lags[-1]:.0f}s")

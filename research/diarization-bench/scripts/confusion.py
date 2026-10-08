# 正解の話者ごとに、推定のどの枠に何割振られたかを出す（声の近い話者どうしが混ざるかを見る）
# 使い方: confusion.py <timeline.tsv> <出力の接頭辞> <voices.json> [無音にした話者]
import json, sys
from collections import defaultdict

timeline, prefix, voices = sys.argv[1:4]
muted = sys.argv[4] if len(sys.argv) > 4 else None
voice = json.load(open(voices, encoding="utf-8"))
segs = [l.rstrip("\n").split("\t") for l in open(prefix + ".segs.tsv", encoding="utf-8") if l.strip()]
segs = [(k, float(s), float(e)) for k, s, e in segs]
share = defaultdict(lambda: defaultdict(float))
for raw in open(timeline, encoding="utf-8"):
    f = raw.rstrip("\n").split("\t")
    if f[0].startswith("#") or f[0] == muted:
        continue
    s, e = float(f[1]), float(f[2])
    for k, hs, he in segs:
        o = min(e, he) - max(s, hs)
        if o > 0:
            share[f[0]][k] += o
for name, d in sorted(share.items(), key=lambda x: -sum(x[1].values())):
    total = sum(d.values())
    top = sorted(d.items(), key=lambda x: -x[1])[:3]
    print(f"{name}({voice.get(name, '?')})\t" + "  ".join(f"{k}:{100 * v / total:.0f}%" for k, v in top))

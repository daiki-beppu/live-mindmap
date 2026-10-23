# 正解の無い会議で、枠ごとの話した時間を数える（Issue #1413）。中身は読まず、segs.tsv の時刻だけを使う
# 使い方: slotshare.py <出力の接頭辞>...
# 出す値: 判定した声の合計秒、枠ごとの割合（1% 未満は「小さい枠」にまとめる）、15 分ごとに 5% 以上を占めた枠
import collections, json, sys
for prefix in sys.argv[1:]:
    segs = [(k, float(s), float(e)) for k, s, e in
            (l.split("\t") for l in open(prefix + ".segs.tsv", encoding="utf-8").read().splitlines() if l)]
    total = collections.Counter()
    bins = collections.defaultdict(collections.Counter)
    for k, s, e in segs:
        total[k] += e - s
        bins[int(s // 900)][k] += e - s
    sec = sum(total.values())
    share = {k: round(100 * v / sec, 1) for k, v in total.most_common()}
    print(json.dumps({
        "prefix": prefix, "voicedSeconds": round(sec), "slots": len(total),
        "share": {k: v for k, v in share.items() if v >= 1}, "smallSlotsShare": round(sum(v for v in share.values() if v < 1), 1),
        "slotsOver5pctBy15min": [sorted(k for k, v in b.items() if v / sum(b.values()) >= 0.05) for _, b in sorted(bins.items())],
    }, ensure_ascii=False))

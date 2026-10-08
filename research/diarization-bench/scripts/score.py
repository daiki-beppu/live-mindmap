# bench の出力を timeline.tsv（正解）と突き合わせて採点する（Issue #369）
# 使い方: score.py <timeline.tsv> <出力の接頭辞> [無音にした話者]
# 出す値:
#   DER（collar 0.25 秒と 0）と内訳（取りこぼし・誤検出・取り違え）。正解と推定の話者は、重なりが最大になる 1 対 1 で対応させる
#   行の正解率: 台本の 1 行ごとに、推定した話者の多数決が正解の話者と一致した割合（全体の対応で判定）。15 分ごとの推移も出す
#   遅れ: 音声のその時刻から、確定したラベルが出るまでの音声秒（計算時間は含まない）
#   仮の書き換え: 最初に出た仮のラベルが、確定で別の話者になった割合（フレームと行）
import json, sys
from collections import Counter
import numpy as np
from scipy.optimize import linear_sum_assignment

STEP = 0.01
timeline, prefix = sys.argv[1], sys.argv[2]
muted = sys.argv[3] if len(sys.argv) > 3 else None

lines = []
for raw in open(timeline, encoding="utf-8"):
    f = raw.rstrip("\n").split("\t")
    if f[0].startswith("#") or f[0] == muted:
        continue
    lines.append((f[0], float(f[1]), float(f[2])))
summary = json.load(open(prefix + ".json"))
T = int(summary["audioSeconds"] / STEP) + 1
refNames = sorted({l[0] for l in lines})
ref = np.full(T, -1)
for name, s, e in lines:
    ref[int(s / STEP):int(e / STEP)] = refNames.index(name)

segs = []
for raw in open(prefix + ".segs.tsv", encoding="utf-8"):
    if raw.strip():
        k, s, e = raw.rstrip("\n").split("\t")
        segs.append((k, float(s), float(e)))
hypNames = sorted({k for k, _, _ in segs})
hyp = np.zeros((len(hypNames), T), dtype=bool)
for k, s, e in segs:
    hyp[hypNames.index(k), int(s / STEP):int(e / STEP)] = True

# 1 対 1 の対応（重なりの長さが最大）
co = np.zeros((len(refNames), len(hypNames)))
for r in range(len(refNames)):
    co[r] = hyp[:, ref == r].sum(axis=1)
ri, hi = linear_sum_assignment(-co)
mapping = {h: r for r, h in zip(ri, hi)}


def der(collar):
    scored = np.ones(T, dtype=bool)
    if collar:
        c = int(collar / STEP)
        for _, s, e in lines:
            for b in (int(s / STEP), int(e / STEP)):
                scored[max(0, b - c):b + c] = False
    nRef = (ref >= 0).astype(int)
    nHyp = hyp.sum(axis=0)
    correct = np.zeros(T, dtype=int)
    for h, r in mapping.items():
        correct += hyp[h] & (ref == r)
    miss = np.maximum(0, nRef - nHyp)
    fa = np.maximum(0, nHyp - nRef)
    conf = np.minimum(nRef, nHyp) - correct
    total = nRef[scored].sum()
    return {k: round(100 * v[scored].sum() / total, 1) for k, v in [("miss", miss), ("fa", fa), ("confusion", conf)]} | {
        "der": round(100 * (miss + fa + conf)[scored].sum() / total, 1)}


def majority(labels):
    c = Counter(l for l in labels if l >= 0)
    return c.most_common(1)[0][0] if c else -1


hypTop = np.where(hyp.any(axis=0), hyp.argmax(axis=0), -1)
perLine = []
for name, s, e in lines:
    m = majority(hypTop[int(s / STEP):int(e / STEP)])
    perLine.append((s, -1 if m < 0 else (1 if mapping.get(m) == refNames.index(name) else 0)))
acc = lambda xs: round(100 * sum(1 for _, v in xs if v == 1) / max(1, len(xs)), 1)
bins = {}
for s, v in perLine:
    bins.setdefault(int(s // 900), []).append((s, v))

result = {
    "method": summary["method"], "refSpeakers": len(refNames), "hypSpeakers": len(hypNames),
    "der_collar025": der(0.25), "der_collar0": der(0),
    "lineAccuracy": acc(perLine), "lineUndetected": round(100 * sum(1 for _, v in perLine if v < 0) / len(perLine), 1),
    "lineAccuracyBy15min": [acc(bins[k]) for k in sorted(bins)],
    "rtfx": round(summary["rtfx"], 1), "cpuPerAudioSecond": round(summary["cpuPerAudioSecond"], 3),
}

# 遅れと仮の書き換え（フレーム単位で出す方式だけ）
frames = open(prefix + ".frames.tsv", encoding="utf-8").read().splitlines()
if len(frames) > 1 and frames[0].startswith("# frameSeconds="):
    fs = float(frames[0].split("=")[1])
    lat, flips, tentSpeech = [], 0, 0
    final, tent = {}, {}
    for raw in frames[1:]:
        f, lab, t0, fed = raw.split("\t")
        f, lab = int(f), int(lab)
        lat.append(float(fed) - (f + 1) * fs)
        final[f] = lab
        if t0 != "":
            tent[f] = int(t0)
            if lab >= 0:
                tentSpeech += 1
                flips += int(t0) != lab
    # 行の多数決が、仮のラベルと確定のラベルで変わった割合
    changed = 0
    for name, s, e in lines:
        fr = range(int(s / fs), int(e / fs))
        a = majority([tent.get(i, -1) for i in fr])
        b = majority([final.get(i, -1) for i in fr])
        changed += a != b
    lat = np.array(lat)
    result |= {"latencyMedian": round(float(np.median(lat)), 2), "latencyP95": round(float(np.percentile(lat, 95)), 2)}
    if tent:  # 仮のラベルを出す方式だけ
        result |= {"tentativeFrameFlip": round(100 * flips / max(1, tentSpeech), 1),
                   "tentativeLineChange": round(100 * changed / len(lines), 1)}
print(json.dumps(result, ensure_ascii=False))

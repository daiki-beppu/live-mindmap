# Nemotron 3 の frames.tsv（10 ms ごとの確定ラベル）から、短い区間を捨てずに区間を作り直す（Issue #1413）
# Sortformer の既定（後処理なし、0.5 で区切るだけ）とそろえるため
# 使い方: resegment.py <入力の接頭辞> <出力の接頭辞>
import shutil, sys
src, dst = sys.argv[1], sys.argv[2]
lines = open(src + ".frames.tsv", encoding="utf-8").read().splitlines()
fs = float(lines[0].split("=")[1])
labels = [int(l.split("\t")[1]) for l in lines[1:]]
segs, cur, start = [], -1, 0
for i, lab in enumerate(labels + [-1]):
    if lab != cur:
        if cur >= 0:
            segs.append(f"{cur}\t{start * fs:.2f}\t{i * fs:.2f}")
        cur, start = lab, i
open(dst + ".segs.tsv", "w", encoding="utf-8").write("\n".join(segs))
shutil.copy(src + ".json", dst + ".json")
shutil.copy(src + ".frames.tsv", dst + ".frames.tsv")

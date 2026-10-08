# 合成会議の音声から 1 人（自分の役）の行を無音にして、相手のトラックだけの音声を作る
import sys, wave, numpy as np
src, timeline, speaker, out = sys.argv[1:5]
with wave.open(src) as w:
    sr = w.getframerate(); a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).copy()
for line in open(timeline, encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    if f[0] == speaker:
        s, e = float(f[1]), float(f[2])
        a[max(0, int((s - 0.05) * sr)):int((e + 0.05) * sr)] = 0
with wave.open(out, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(a.tobytes())

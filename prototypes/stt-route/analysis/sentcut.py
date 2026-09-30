# 途中結果（volatile）が「。？！」で文を閉じた瞬間に、その文までを切り出したとき
# (1) 最終的な確定結果の先頭と一致するか (2) 確定結果より何秒早く出せるか (3) 話し始めから何秒か
import json, sys, statistics as st
rows=[json.loads(l) for l in open(sys.argv[1])]
limit = min(r['end'] for r in rows if r['final'] and r is rows[-1] or True) if False else None
finals=[r for r in rows if r['final']]
last_final_arrival = finals[-1]['arrived']
vol=[r for r in rows if not r['final'] and r['arrived'] < last_final_arrival]
def seg_final(v):
    # 同じ区間を確定させた結果: v の到着後に届いた最初の確定結果で、開始が v の開始と一致するもの
    for f in finals:
        if f['arrived'] >= v['arrived'] and abs(f['start']-v['start'])<0.05: return f
    return None
seen=set(); ok=0; ng=0; gains=[]; s2c=[]; bad=[]
for v in vol:
    t=v['text']
    idx=[i for i,c in enumerate(t) if c in '。？！?']
    for i in idx:
        key=(round(v['start'],2), i, t[:i+1])
        pre=t[:i+1]
        if (round(v['start'],2),pre) in seen: continue
        seen.add((round(v['start'],2),pre))
        f=seg_final(v)
        if not f: continue
        if f['text'].startswith(pre): ok+=1; gains.append(f['arrived']-v['arrived']); s2c.append(v['arrived']-v['start'])
        else: ng+=1; bad.append((pre[-25:], f['text'][:len(pre)][-25:]))
print(f"sentences cut={ok+ng} match={ok} ({ok/(ok+ng):.0%}) mismatch={ng}")
def p(a,q): a=sorted(a); return round(a[int((len(a)-1)*q)],1)
print(f"gain vs final p50={p(gains,.5)}s p95={p(gains,.95)}s ; seg-start->cut p50={p(s2c,.5)}s")
for b in bad[:6]: print("  volatile:",b[0]," | final:",b[1])

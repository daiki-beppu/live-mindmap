# マイクの確定結果の文字 3-gram のうち、前後 WIN 秒の相手トラックの本文に現れる割合（被覆率）
import json, re, sys
WIN = 8.0
rows = [json.loads(l) for l in open(sys.argv[1])]
fin = [r for r in rows if r['final']]
sysr = [r for r in fin if r['track'] == 'system']
norm = lambda t: re.sub(r'[\s、。，．,.!?！？ー]', '', t)
grams = lambda t: {t[i:i+3] for i in range(len(t) - 2)}
for m in (r for r in fin if r['track'] == 'mic'):
    ctx = norm(''.join(s['text'] for s in sysr if s['end'] > m['start'] - WIN and s['start'] < m['end'] + WIN))
    g = grams(norm(m['text']))
    cov = sum(x in ctx for x in g) / max(len(g), 1)
    print(f"{cov:.2f}  {m['start']:6.1f}-{m['end']:6.1f}  {m['text'][:40]}")

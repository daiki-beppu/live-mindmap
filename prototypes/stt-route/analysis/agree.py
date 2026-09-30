# ストリーミング（SpeechAnalyzer 直）と Kanary の全文ファイルの一致度（文字単位、5 分窓ごと）
import json, re, sys, difflib
norm = lambda t: re.sub(r'[\s、。，．,.!?！？]', '', t)
st = [json.loads(l) for l in open(sys.argv[1])]; st = [r for r in st if r['final']]
ka = json.load(open(sys.argv[2]))['transcript']['segments']
rs = []
for w in range(0, 3600, 300):
    a = norm(''.join(r['text'] for r in st if w <= (r['start']+r['end'])/2 < w+300))
    b = norm(''.join(s['text'] for s in ka if w <= (s['start_seconds']+s['end_seconds'])/2 < w+300))
    rs.append(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio())
print(' '.join(f'{x:.2f}' for x in rs), ' mean', round(sum(rs)/len(rs), 3))

# 使い捨て（issue #487）。正解の決定・TODO の時刻に重なる発言ごとに、その発言を根拠に作ったノードの種別を出す（本文は出さない）
import json,sys
log=[json.loads(l) for l in open(sys.argv[1])]
truth=json.load(open(sys.argv[2]))
rem={e["remark"]["id"]:e["remark"] for e in log if e["type"]=="remark"}
made={}
for e in log:
  if e["type"]!="diff": continue
  for o in e.get("ops",[]):
    if o["op"]=="add":
      for r in o["evidence"]: made.setdefault(r,[]).append(o["kind"])
for k in ["決定","TODO"]:
  for i,t in enumerate(truth[k]):
    ids=[i for i,r in rem.items() if r["start"]<=t["to"]+0.5 and r.get("end",r["start"])>=t["from"]-0.5]
    print(k, i+1, [(i, made.get(i,["-"])) for i in ids][:5])

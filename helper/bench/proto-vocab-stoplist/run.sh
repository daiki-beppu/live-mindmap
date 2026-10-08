#!/bin/bash
# usage: run.sh  -> prints table rows
W=$(cd "$(dirname "$0")" && pwd); R=~/live-mindmap-samples/runs; SY=~/live-mindmap-samples/synth; SRV=/Users/mba/orca/workspaces/live-mindmap/subtitle-accuracy-wayfinder-6/server
mkdir -p $W/out
filt() { # name size -> filtered file
  local name=$1 size=$2 src=$R/vocab/jargon.vocab$size.txt out=$W/out/v.$name.$size.txt
  case $name in
    none) cp $src $out;;
    tok1) awk -F'\t' 'NR==FNR{n[$1]=$2;next} n[$0]!=1' $W/tok.tsv $src > $out;;
    z3.0|z3.5|z4.0|z4.5) t=${name#z}; awk -F'\t' -v t=$t 'NR==FNR{z[$1]=$2;next} z[$0]<t' $W/zipf.tsv $src > $out;;
    t5|t10|t20|t50) grep -vxFf $W/top${name#t}k.txt $src > $out;;
    p20|p50) $W/parts $W/top${name#p}k.txt < $src > $out 2>/dev/null;;
    df1|df2) t=${name#df}; awk -F'\t' -v t=$t 'NR==FNR{d[$1]=$2;next} d[$0]<t' $W/df.tsv $src > $out;;
  esac
  echo $out
}
for name in "$@"; do
  for size in 100 300 1000; do
    v=$(filt $name $size); kept=$(wc -l < $v | tr -d ' '); terms=$(grep -cxFf $SY/jargon/terms.txt $v)
    r=$($W/vc $R/accuracy/jargon.baseline.jsonl --vocab $v --mode index --strict --min 0.8 $XARGS --readings $R/correct/readings.tsv --timeline $SY/jargon/timeline.tsv --out $W/out/j.$name$XLABEL.$size.jsonl --log $W/out/j.$name$XLABEL.$size.log 2>&1 | grep 置き換え)
    acc=$(cd $SRV && node bench/sttAccuracy.ts $SY/jargon/timeline.tsv $W/out/j.$name$XLABEL.$size.jsonl --terms $SY/jargon/terms.txt 2>/dev/null)
    cer=$(echo "$acc" | sed -n 3p | cut -d'|' -f3 | tr -d ' '); pn=$(echo "$acc" | grep -o '正解率: [0-9.]*%' | cut -d' ' -f2)
    other=""
    if [ $size = 1000 ]; then for m in facilitators silly parnassus screen; do
      o=$($W/vc $R/accuracy/$m.baseline.jsonl --vocab $v --mode index --strict --min 0.8 $XARGS --readings $R/correct/readings.tsv --timeline $SY/$m/timeline.tsv --out $W/out/$m.$name$XLABEL.jsonl --log $W/out/$m.$name$XLABEL.log 2>&1 | grep -o '誤り [0-9]*' | cut -d' ' -f2); other="$other $m=$o"; done; fi
    echo "| $name $XLABEL | $size | $kept | $terms/39 | $pn | $cer | $r |$other"
  done
done

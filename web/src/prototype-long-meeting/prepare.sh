#!/bin/sh
# PROTOTYPE（issue #131）: longMeetingProto.ts の出力（log.jsonl と closes.jsonl）を、試作の画面が読む場所にコピーする。
#   sh web/src/prototype-long-meeting/prepare.sh <出力フォルダ> <名前>
# 素材の文字を含むので git に入れない（web/public/proto-long/ は .gitignore 済み）。
set -eu
dest="$(dirname "$0")/../../public/proto-long/$2"
mkdir -p "$dest"
cp "$1/log.jsonl" "$1/closes.jsonl" "$dest/"
echo "copied to $dest"

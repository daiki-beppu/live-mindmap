// 語彙の候補を、NLTagger の固有表現と単純な規則で取り出して数える試し（#391）
// 使い方: swift extract.swift <mode> <file>...
//   mode = schemes | tag | rules | both
//   入力は 1 行 1 文のテキスト
import Foundation
import NaturalLanguage

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "schemes"
let files = Array(args.dropFirst(2))

if mode == "schemes" {
  for lang in [NLLanguage.japanese, .english] {
    print(lang.rawValue, "word:", NLTagger.availableTagSchemes(for: .word, language: lang).map(\.rawValue))
  }
  exit(0)
}

let lines = files.flatMap { (try? String(contentsOfFile: $0, encoding: .utf8))?.components(separatedBy: "\n") ?? [] }
  .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }

func nameEntities(_ text: String, lang: NLLanguage?) -> [(String, String)] {
  let tagger = NLTagger(tagSchemes: [.nameType])
  tagger.string = text
  if let lang { tagger.setLanguage(lang, range: text.startIndex..<text.endIndex) }
  var out: [(String, String)] = []
  let opts: NLTagger.Options = [.omitPunctuation, .omitWhitespace, .joinNames]
  tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType, options: opts) { tag, r in
    if let tag, [NLTag.personalName, .placeName, .organizationName].contains(tag) {
      out.append((String(text[r]), tag.rawValue))
    }
    return true
  }
  return out
}

// Kanary の GlossaryCandidateExtractor から読んだ規則に近いもの
let stop: Set<String> = ["今日", "昨日", "明日", "今回", "次回", "最初", "最後", "確認", "相談", "方針", "説明", "録音", "文字", "起こし", "会議", "時間", "問題", "場合", "会社", "内容", "結果", "the", "and", "for", "with", "this", "that", "from", "today", "please", "issue", "meeting"]

func isKatakana(_ u: Unicode.Scalar) -> Bool { (0x30A0...0x30FF).contains(u.value) || (0xFF66...0xFF9F).contains(u.value) }
func isKanji(_ u: Unicode.Scalar) -> Bool { (0x3400...0xA3FF).contains(u.value) || (0x20000...0x2F9FF).contains(u.value) }

func runs(_ text: String, _ pred: (Unicode.Scalar) -> Bool, min: Int, max: Int) -> [String] {
  var out: [String] = []; var cur = String.UnicodeScalarView()
  func flush() { if cur.count >= min && cur.count <= max { out.append(String(cur)) }; cur = .init() }
  for u in text.unicodeScalars { if pred(u) { cur.append(u) } else { flush() } }
  flush()
  return out
}

func latin(_ text: String) -> [String] {
  let re = try! NSRegularExpression(pattern: "[A-Za-z][A-Za-z0-9._\\-/]*[A-Za-z0-9]")
  return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
    let s = String(text[Range(m.range, in: text)!])
    return s.contains(where: { $0.isUppercase }) ? s : nil
  }
}

func ruleCandidates(_ text: String) -> [(String, String)] {
  runs(text, isKatakana, min: 3, max: 99).filter { $0 != "ー" }.map { ($0, "katakana") }
    + runs(text, isKanji, min: 3, max: 12).map { ($0, "kanji3+") }
    + latin(text).map { ($0, "latin") }
}

var counts: [String: (kind: String, n: Int)] = [:]
for line in lines {
  var found: [(String, String)] = []
  if mode == "tag" || mode == "both" { found += nameEntities(line, lang: .japanese).map { ($0.0, "NL:" + $0.1) } }
  if mode == "tagauto" { found += nameEntities(line, lang: nil).map { ($0.0, "NL:" + $0.1) } }
  if mode == "rules" || mode == "both" { found += ruleCandidates(line) }
  for (w, k) in found where !stop.contains(w.lowercased()) {
    let prev = counts[w]
    counts[w] = (prev.map { $0.kind.contains(k) ? $0.kind : $0.kind + "+" + k } ?? k, (prev?.n ?? 0) + 1)
  }
}
let sorted = counts.sorted { $0.value.n != $1.value.n ? $0.value.n > $1.value.n : $0.key < $1.key }
print("# lines:", lines.count, "chars:", lines.reduce(0) { $0 + $1.count }, "distinct candidates:", sorted.count)
var byKind: [String: Int] = [:]
for (_, v) in sorted { byKind[v.kind, default: 0] += 1 }
print("# by kind:", byKind.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))
if ProcessInfo.processInfo.environment["COUNTS_ONLY"] == nil {
  for (w, v) in sorted { print(v.n, v.kind, w) }
}

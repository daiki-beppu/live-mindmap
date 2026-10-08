// PROTOTYPE（#393）。捨てる前提の試作で、製品にもテストにも入れない。
// 確定結果（stt-bench run の JSONL）を語彙で直し、同じ形の JSONL を出す。直した後の値は server/bench/sttAccuracy.ts で測る。
//
// 組み方: swiftc -O helper/bench/proto-vocab-correct/main.swift -o /tmp/vocab-correct
// 使い方: vocab-correct <確定結果.jsonl> --vocab <語彙.txt> --mode <index|llm> [--readings <読みのキャッシュ.tsv>]
//           [--timeline <timeline.tsv>] [--min <下限>] [--top <候補数>] [--out <出力.jsonl>] [--log <変更.jsonl>]
//   index: 読みの近さだけで決める（--min 以上で一番近い語に置き換える）
//   llm:   読みで --min 以上の候補を出現ごとに --top 件まで絞り、FoundationModels に「候補の番号か NONE」を選ばせる
//   --timeline を渡すと、置き換えた語が台本の同じ時間帯に出ているか（正しく直したか、誤って直したか）を数える
//
// 結論（#393）: 読みの索引で決定的に置き換える形（index --strict --min 0.8）を採る。LLM の判定（llm）は正しい置き換えを捨て、
// ノイズの語を選ぶこともあったので採らない。誤りは語彙にふつうの語が混ざったときに出るので、語彙の側で防ぐ。
import Foundation
import FoundationModels

func fail(_ m: String) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(1) }
func err(_ m: String) { FileHandle.standardError.write(Data((m + "\n").utf8)) }

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name) else { return nil }
    let v = args[i + 1]; args.removeSubrange(i...(i + 1)); return v
}
guard let vocabPath = option("--vocab") else { fail("--vocab が要る") }
let mode = option("--mode") ?? "index"
let readingsPath = option("--readings")
let timelinePath = option("--timeline")
let minScore = option("--min").flatMap(Double.init) ?? (mode == "llm" ? 0.6 : 0.8)
let top = option("--top").flatMap(Int.init) ?? 3
// --strict: 区間の端がひらがなだけの語（助詞・送り仮名）なら候補にしない。読みが 5 字以下の語は読みの完全一致だけ
let strict = args.contains("--strict"); args.removeAll { $0 == "--strict" }
let outPath = option("--out")
let logPath = option("--log")
guard args.count == 1 else { fail("確定結果の JSONL を 1 つ渡す") }

// MARK: 読み

struct Token { let range: NSRange; let surface: String; let romaji: String }

func tokenize(_ s: String) -> [Token] {
    let cf = s as CFString
    let t = CFStringTokenizerCreate(nil, cf, CFRangeMake(0, CFStringGetLength(cf)), kCFStringTokenizerUnitWordBoundary, Locale(identifier: "ja") as CFLocale)
    var out: [Token] = []
    while CFStringTokenizerAdvanceToNextToken(t) != [] {
        let r = CFStringTokenizerGetCurrentTokenRange(t)
        let range = NSRange(location: r.location, length: r.length)
        let lat = CFStringTokenizerCopyCurrentTokenAttribute(t, kCFStringTokenizerAttributeLatinTranscription) as? String ?? ""
        out.append(Token(range: range, surface: (s as NSString).substring(with: range), romaji: lat))
    }
    return out
}

// 読みのキー。長音・二重母音・促音を潰し、ローマ字の揺れ（shi/si、tsu/tu、ou/o）をそろえる
func key(_ romaji: String) -> String {
    var s = romaji.lowercased().folding(options: .diacriticInsensitive, locale: nil)
    for (a, b) in [("sh", "s"), ("ch", "t"), ("ts", "t"), ("j", "z"), ("dz", "z"), ("f", "h"), ("l", "r"), ("v", "b"), ("-", ""), ("'", "")] {
        s = s.replacingOccurrences(of: a, with: b)
    }
    var out: [Character] = []
    for c in s where c.isLetter || c.isNumber {
        if let last = out.last, last == c { continue } // 長音・促音
        if c == "u", let last = out.last, last == "o" { continue } // ou → o
        if c == "i", let last = out.last, last == "e" { continue } // ei → e
        out.append(c)
    }
    return String(out)
}

func isLatinOnly(_ s: String) -> Bool { s.unicodeScalars.allSatisfy { $0.isASCII } }

// 英字の語の読み。略語（大文字だけ）はトークナイザが字ごとに読む。それ以外は FoundationModels にカタカナを聞く（語ごとに 1 回、TSV にためる）
var readingCache: [String: String] = [:]
if let p = readingsPath, let text = try? String(contentsOfFile: p, encoding: .utf8) {
    for line in text.split(separator: "\n") {
        let c = line.split(separator: "\t", omittingEmptySubsequences: false)
        if c.count == 2 { readingCache[String(c[0])] = String(c[1]) }
    }
}

let model = SystemLanguageModel.default
guard case .available = model.availability else { fail("FoundationModels が使えない: \(model.availability)") }

func katakanaReading(_ term: String) async throws -> String {
    if let r = readingCache[term] { return r }
    err("読みを聞く: \(term)")
    let session = LanguageModelSession(instructions: "英字の固有名詞・製品名を、日本語の会話で話されるときのカタカナの読みにする。カタカナだけを答える。")
    let r = try await session.respond(to: term, options: GenerationOptions(sampling: .greedy, maximumResponseTokens: 24))
    let reading = r.content.trimmingCharacters(in: .whitespacesAndNewlines).filter { ("\u{30A0}"..."\u{30FF}").contains($0) }
    readingCache[term] = reading
    return reading
}

struct Term { let surface: String; let reading: String; let key: String }

func romajiOf(_ s: String) -> String { tokenize(s).map(\.romaji).joined() }

var terms: [Term] = []
for line in try String(contentsOfFile: vocabPath, encoding: .utf8).split(whereSeparator: \.isNewline) {
    let surface = line.trimmingCharacters(in: .whitespaces)
    guard !surface.isEmpty else { continue }
    var reading = romajiOf(surface)
    // 略語でない英字の語は、トークナイザが英字のまま返す
    if isLatinOnly(surface), surface.uppercased() != surface || surface.count > 5 || surface.contains(where: { $0.isNumber }) {
        let kana = try await katakanaReading(surface)
        reading = kana.isEmpty ? surface : romajiOf(kana)
    }
    let k = key(reading)
    guard k.count >= 2 else { continue }
    terms.append(Term(surface: surface, reading: reading, key: k))
}
if let p = readingsPath {
    try readingCache.sorted { $0.key < $1.key }.map { "\($0.key)\t\($0.value)" }.joined(separator: "\n").write(toFile: p, atomically: true, encoding: .utf8)
}
err("語彙: \(terms.count) 語")

// MARK: 候補を引く

func lev(_ a: [Character], _ b: [Character]) -> Int {
    if a.isEmpty { return b.count }; if b.isEmpty { return a.count }
    var prev = Array(0...b.count), cur = prev
    for i in 1...a.count {
        cur[0] = i
        for j in 1...b.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)) }
        swap(&prev, &cur)
    }
    return prev[b.count]
}

func similarity(_ a: String, _ b: String) -> Double {
    let x = Array(a), y = Array(b)
    return 1 - Double(lev(x, y)) / Double(max(x.count, y.count))
}

struct Occurrence { let range: NSRange; let surface: String; let spanKey: String; var candidates: [(term: Term, score: Double)] }

let normalize = { (s: String) in s.precomposedStringWithCompatibilityMapping.lowercased() }

// 区間（句読点・空白をまたがない 1〜5 トークンの並び）ごとに、読みのキーが近い語を引く。重なる区間は点の高い方を残す
func retrieve(_ text: String) -> [Occurrence] {
    let toks = tokenize(text)
    var found: [Occurrence] = []
    for i in toks.indices {
        var romaji = ""
        for j in i..<min(i + 5, toks.count) {
            let t = toks[j]
            if t.romaji.isEmpty || t.surface.allSatisfy({ $0.isPunctuation || $0.isWhitespace }) { break }
            romaji += t.romaji
            let k = key(romaji)
            guard k.count >= 3 else { continue }
            let hiraganaOnly = { (s: String) in s.unicodeScalars.allSatisfy { ("\u{3041}"..."\u{309F}").contains($0) } }
            if strict, hiraganaOnly(toks[i].surface) || hiraganaOnly(t.surface) { continue }
            let range = NSRange(location: toks[i].range.location, length: t.range.location + t.range.length - toks[i].range.location)
            let surface = (text as NSString).substring(with: range)
            let isHiragana = { (c: Character) in c.unicodeScalars.allSatisfy { ("\u{3041}"..."\u{309F}").contains($0) } }
            if strict, surface.count < 2 || isHiragana(surface.first!) || isHiragana(surface.last!) { continue }
            var cands: [(Term, Double)] = []
            for term in terms {
                let ratio = Double(k.count) / Double(term.key.count)
                guard ratio > 0.6, ratio < 1.6 else { continue }
                let s = similarity(k, term.key)
                if strict, term.key.count <= 5, s < 1 { continue }
                if s >= minScore { cands.append((term, s)) }
            }
            // 既に正しい表記なら直さない
            if cands.contains(where: { normalize(surface).contains(normalize($0.0.surface)) }) { continue }
            guard !cands.isEmpty else { continue }
            cands.sort { $0.1 > $1.1 }
            found.append(Occurrence(range: range, surface: surface, spanKey: k, candidates: Array(cands.prefix(top)).map { (term: $0.0, score: $0.1) }))
        }
    }
    // 区間の端が語の途中で止まると、別の語の一部を直してしまう。点の高い順、同点なら長い順に、重ならないものを採る
    found.sort { a, b in
        let sa = a.candidates[0].score, sb = b.candidates[0].score
        return sa != sb ? sa > sb : a.range.length > b.range.length
    }
    var picked: [Occurrence] = []
    for o in found where !picked.contains(where: { NSIntersectionRange($0.range, o.range).length > 0 }) { picked.append(o) }
    return picked.sorted { $0.range.location < $1.range.location }
}

// MARK: 決める

struct Change: Codable { let start: Double; let end: Double; let span: String; let term: String; let score: Double; var verdict: String? }

func decideLLM(_ text: String, _ occs: [Occurrence]) async throws -> [Int?] {
    var marked = text as NSString
    for (n, o) in occs.enumerated().reversed() {
        marked = marked.replacingCharacters(in: o.range, with: "[\(n):\(o.surface)]") as NSString
    }
    var lines = ["発言: \(marked)", ""]
    var props: [DynamicGenerationSchema.Property] = []
    for (n, o) in occs.enumerated() {
        let names = o.candidates.map(\.term.surface)
        lines.append("[\(n)] の候補: \(names.joined(separator: " / "))")
        props.append(.init(name: "o\(n)", schema: DynamicGenerationSchema(name: "O\(n)", anyOf: names + ["NONE"])))
    }
    let schema = try GenerationSchema(root: DynamicGenerationSchema(name: "Decisions", properties: props), dependencies: [])
    let session = LanguageModelSession(model: SystemLanguageModel(useCase: .general, guardrails: .permissiveContentTransformations), instructions: """
        音声認識の結果で [番号:語] と括った箇所が、候補の語の聞き違いかを判定する。
        括った箇所ごとに、文脈からその候補の語だとはっきり言えるときだけ候補を選ぶ。そうでなければ NONE を選ぶ。
        本文を書き換えたり、候補にない語を作ったりしない。
        """)
    let r = try await session.respond(to: lines.joined(separator: "\n"), schema: schema, options: GenerationOptions(sampling: .greedy))
    return try occs.indices.map { n in
        let v = try r.content.value(String.self, forProperty: "o\(n)")
        return occs[n].candidates.firstIndex { $0.term.surface == v }
    }
}

// MARK: 台本との突き合わせ（誤って直したかを数える）

struct Line { let start: Double; let end: Double; let text: String }
let timeline: [Line] = timelinePath.map { p in
    ((try? String(contentsOfFile: p, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { l in
        let c = l.split(separator: "\t", omittingEmptySubsequences: false)
        guard c.count == 4, !c[0].hasPrefix("#"), let s = Double(c[1]), let e = Double(c[2]) else { return nil }
        return Line(start: s, end: e, text: String(c[3]))
    }
} ?? []

// 台本の同じ時間帯（前後 3 秒）に、その語が直した回数ぶん出ているか
func scriptCount(_ term: String, _ start: Double, _ end: Double) -> Int {
    let t = normalize(term)
    return timeline.filter { $0.end >= start - 3 && $0.start <= end + 3 }
        .reduce(0) { $0 + normalize($1.text).components(separatedBy: t).count - 1 }
}

// MARK: 本体

var outLines: [String] = []
var changes: [Change] = []
var calls: [Double] = []
var failures = 0
for raw in try String(contentsOfFile: args[0], encoding: .utf8).split(separator: "\n") {
    guard var obj = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
    guard obj["isFinal"] as? Bool == true, let text = obj["text"] as? String else { outLines.append(String(raw)); continue }
    let start = obj["start"] as? Double ?? 0, end = obj["end"] as? Double ?? 0
    let occs = retrieve(text)
    var picks: [Int?] = occs.map { _ in 0 }
    if mode == "llm", !occs.isEmpty {
        let t0 = Date()
        var attempt = 0
        while true { do { picks = try await decideLLM(text, occs); break } catch { attempt += 1; if attempt < 4 { try await Task.sleep(for: .seconds(3)); continue }
            failures += 1; err("判定に失敗（直さずに出す）: \(error.localizedDescription) \(String(describing: error).prefix(300))")
            picks = occs.map { _ in nil }
        } }
        calls.append(Date().timeIntervalSince(t0))
    }
    var fixed = text as NSString
    var local: [Change] = []
    for (o, p) in zip(occs, picks).reversed() {
        guard let p else {
            local.append(Change(start: start, end: end, span: o.surface, term: "NONE（\(o.candidates.map(\.term.surface).joined(separator: "/"))）", score: o.candidates[0].score, verdict: "kept"))
            continue
        }
        let c = o.candidates[p]
        fixed = fixed.replacingCharacters(in: o.range, with: c.term.surface) as NSString
        local.append(Change(start: start, end: end, span: o.surface, term: c.term.surface, score: c.score))
    }
    // 判定: 置き換えた語ごとに、台本の同じ時間帯での出現数まで「正しい」、超えた分を「誤り」
    if !timeline.isEmpty {
        var used: [String: Int] = [:]
        let fixedNorm = normalize(fixed as String)
        for i in local.indices where local[i].verdict == nil {
            let term = local[i].term
            let already = normalize(text).components(separatedBy: normalize(term)).count - 1
            used[term, default: already] += 1
            local[i].verdict = used[term]! <= scriptCount(term, start, end) ? "right" : "wrong"
            _ = fixedNorm
        }
    }
    changes += local.reversed()
    obj["text"] = fixed as String
    outLines.append(String(data: try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!)
}

let out = outLines.joined(separator: "\n") + "\n"
if let p = outPath { try out.write(toFile: p, atomically: true, encoding: .utf8) } else { print(out, terminator: "") }
if let p = logPath {
    let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    try changes.map { String(data: try enc.encode($0), encoding: .utf8)! }.joined(separator: "\n").appending("\n").write(toFile: p, atomically: true, encoding: .utf8)
}
let applied = changes.filter { $0.verdict != "kept" }
let right = applied.filter { $0.verdict == "right" }.count, wrong = applied.filter { $0.verdict == "wrong" }.count
let kept = changes.filter { $0.verdict == "kept" }.count
var summary = "置き換え \(applied.count)（正しい \(right)・誤り \(wrong)）・NONE \(kept)"
if !calls.isEmpty {
    let s = calls.sorted()
    summary += "・失敗 \(failures)"
    summary += String(format: "・呼び出し %d 回 中央値 %.2f 秒 最大 %.2f 秒", s.count, s[s.count / 2], s.last!)
}
err(summary)

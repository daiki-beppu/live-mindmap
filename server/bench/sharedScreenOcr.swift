// 試作（#183）: 共有画面のスライドを Apple Vision の RecognizeDocumentsRequest で読み、文字にする。使い捨て。
// swift server/bench/sharedScreenOcr.swift <png>... → 各画像の隣に <png>.ocr.txt を書く
import AppKit
import Vision
import Foundation

func load(_ path: String) -> CGImage {
  let img = NSImage(contentsOfFile: path)!
  var rect = CGRect(origin: .zero, size: img.size)
  return img.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
}

let sema = DispatchSemaphore(value: 0)
Task {
  var req = RecognizeDocumentsRequest()
  req.textRecognitionOptions.recognitionLanguages = [Locale.Language(identifier: "ja-JP"), Locale.Language(identifier: "en-US")]
  for path in CommandLine.arguments.dropFirst() {
    let t0 = Date()
    let obs = try! await req.perform(on: load(path))
    var out: [String] = []
    for o in obs {
      let doc = o.document
      // 表のセルは段落にも出るので、表は別に行と列で書き、段落はそのまま並べる
      for p in doc.paragraphs { out.append(p.transcript.replacingOccurrences(of: "\n", with: " ")) }
      for (i, t) in doc.tables.enumerated() {
        out.append("[表\(i + 1)]")
        for row in t.rows { out.append("| " + row.map { $0.content.text.transcript.replacingOccurrences(of: "\n", with: " ") }.joined(separator: " | ") + " |") }
      }
    }
    try! out.joined(separator: "\n").write(toFile: path + ".ocr.txt", atomically: true, encoding: .utf8)
    print(path, String(format: "%.2fs", Date().timeIntervalSince(t0)))
  }
  sema.signal()
}
sema.wait()

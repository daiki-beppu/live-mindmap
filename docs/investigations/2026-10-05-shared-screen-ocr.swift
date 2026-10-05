import AppKit
import Vision
import Foundation

// 1920x1080 の架空スライドを描く
let W = 1920.0, H = 1080.0
let title = "2026年度 第3四半期 売上の振り返り"
let bullets = ["・新規顧客の獲得数は前年同期比 128% に伸びた", "・解約率は 2.4% から 1.9% に下がった", "・右の表: 地域別の売上（単位: 百万円）", "・課題: 九州の営業体制を来期までに見直す"]
let table = [["地域", "売上", "前年比"], ["関東", "1,240", "112%"], ["関西", "860", "104%"], ["九州", "310", "89%"]]
let footer = "社外秘　株式会社サンプル　12 / 30"

func render() -> CGImage {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W), pixelsHigh: Int(H), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSColor.white.setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
  func draw(_ s: String, _ x: Double, _ yTop: Double, _ size: Double, bold: Bool = false, color: NSColor = .black) {
    let f = NSFont(name: bold ? "HiraginoSans-W6" : "HiraginoSans-W3", size: size)!
    (s as NSString).draw(at: NSPoint(x: x, y: H - yTop - size * 1.3), withAttributes: [.font: f, .foregroundColor: color])
  }
  draw(title, 100, 70, 64, bold: true)
  for (i, b) in bullets.enumerated() { draw(b, 100, 230 + Double(i) * 110, 34) }
  let tx = 1240.0, ty = 300.0, cw = 190.0, rh = 90.0
  NSColor.gray.setStroke()
  for r in 0...table.count { let p = NSBezierPath(); p.move(to: NSPoint(x: tx, y: H - ty - Double(r) * rh)); p.line(to: NSPoint(x: tx + cw * 3, y: H - ty - Double(r) * rh)); p.lineWidth = 2; p.stroke() }
  for c in 0...3 { let p = NSBezierPath(); p.move(to: NSPoint(x: tx + Double(c) * cw, y: H - ty)); p.line(to: NSPoint(x: tx + Double(c) * cw, y: H - ty - rh * Double(table.count))); p.lineWidth = 2; p.stroke() }
  for (r, row) in table.enumerated() { for (c, cell) in row.enumerated() { draw(cell, tx + Double(c) * cw + 30, ty + Double(r) * rh + 18, 34, bold: r == 0) } }
  draw(footer, 100, 980, 24, color: .darkGray)
  NSGraphicsContext.restoreGraphicsState()
  return rep.cgImage!
}

func scaled(_ img: CGImage, _ w: Int, _ h: Int) -> CGImage {
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  return ctx.makeImage()!
}

func save(_ img: CGImage, _ path: String) {
  let rep = NSBitmapImageRep(cgImage: img)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

func lev(_ a: [Character], _ b: [Character]) -> Int {
  if a.isEmpty { return b.count }
  if b.isEmpty { return a.count }
  var d = Array(0...b.count)
  for i in 1...a.count {
    var prev = d[0]; d[0] = i
    for j in 1...b.count {
      let t = d[j]
      d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1))
      prev = t
    }
  }
  return d[b.count]
}
let truth = ([title] + bullets + table.flatMap { $0 } + [footer]).joined()
func norm(_ s: String) -> [Character] { Array(s.filter { !$0.isWhitespace }) }
func cer(_ got: String) -> Double { Double(lev(norm(got), norm(truth))) / Double(norm(truth).count) }

let full = render()
save(full, "slide-1920.png")

let fastReq = VNRecognizeTextRequest(); fastReq.recognitionLevel = .fast
let accReq = VNRecognizeTextRequest(); accReq.recognitionLevel = .accurate
print("VN revision:", accReq.revision)
print("VN fast langs:", (try? fastReq.supportedRecognitionLanguages()) ?? [])
print("VN accurate langs:", (try? accReq.supportedRecognitionLanguages()) ?? [])
print("RecognizeTextRequest langs:", RecognizeTextRequest().supportedRecognitionLanguages.map { $0.maximalIdentifier })
print("RecognizeDocumentsRequest langs:", RecognizeDocumentsRequest().supportedRecognitionLanguages.map { $0.maximalIdentifier })
print("truth chars:", norm(truth).count)

func runVN(_ img: CGImage, level: VNRequestTextRecognitionLevel, langs: [String]) -> (String, Double) {
  let r = VNRecognizeTextRequest(); r.recognitionLevel = level; r.recognitionLanguages = langs; r.usesLanguageCorrection = true
  let t0 = Date()
  try! VNImageRequestHandler(cgImage: img).perform([r])
  let dt = Date().timeIntervalSince(t0)
  let s = (r.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
  return (s, dt)
}

for (w, h) in [(1920, 1080), (1280, 720), (960, 540)] {
  let img = (w == 1920) ? full : scaled(full, w, h)
  for level in [VNRequestTextRecognitionLevel.accurate, .fast] {
    var times: [Double] = []; var out = ""
    for _ in 0..<4 { let (s, dt) = runVN(img, level: level, langs: ["ja-JP", "en-US"]); out = s; times.append(dt) }
    print("\n## VNRecognizeText \(level == .accurate ? "accurate" : "fast") \(w)x\(h) times(s):", times.map { String(format: "%.3f", $0) }, "CER:", String(format: "%.3f", cer(out)))
    print(out)
  }
}

let sema = DispatchSemaphore(value: 0)
Task {
  for (w, h) in [(1920, 1080), (1280, 720)] {
    let img = (w == 1920) ? full : scaled(full, w, h)
    var req = RecognizeDocumentsRequest()
    req.textRecognitionOptions.recognitionLanguages = [Locale.Language(identifier: "ja-JP"), Locale.Language(identifier: "en-US")]
    var times: [Double] = []
    var obs: [DocumentObservation] = []
    for _ in 0..<4 {
      let t0 = Date()
      obs = try! await req.perform(on: img)
      times.append(Date().timeIntervalSince(t0))
    }
    print("\n## RecognizeDocuments \(w)x\(h) times(s):", times.map { String(format: "%.3f", $0) })
    for o in obs {
      let doc = o.document
      print("title:", doc.title?.transcript ?? "nil")
      print("paragraphs:"); for p in doc.paragraphs { print("  |", p.transcript.replacingOccurrences(of: "\n", with: " / ")) }
      print("lists:", doc.lists.count)
      print("tables:", doc.tables.count)
      for t in doc.tables {
        print("  rows x cols:", t.rows.count, "x", t.columns.count)
        for row in t.rows { print("   ", row.map { $0.content.text.transcript }.joined(separator: " | ")) }
      }
      print("CER(text):", String(format: "%.3f", cer(doc.text.transcript)))
    }
  }
  sema.signal()
}
sema.wait()

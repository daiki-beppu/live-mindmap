import Foundation
// 語彙の語を、トークナイザで分けた部品が全部ふつうの語の一覧に載るなら落とす（1 部品の語も含む）
let stop = Set(try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8).split(separator: "\n").map(String.init))
while let w = readLine() {
  let cf = w as CFString
  let t = CFStringTokenizerCreate(nil, cf, CFRangeMake(0, CFStringGetLength(cf)), kCFStringTokenizerUnitWordBoundary, Locale(identifier: "ja") as CFLocale)
  var parts: [String] = []
  while CFStringTokenizerAdvanceToNextToken(t) != [] { let r = CFStringTokenizerGetCurrentTokenRange(t); parts.append((w as NSString).substring(with: NSRange(location: r.location, length: r.length))) }
  let latin = w.unicodeScalars.allSatisfy { $0.isASCII }
  if latin || !parts.allSatisfy({ stop.contains($0) }) { print(w) } else { FileHandle.standardError.write(Data("\(w)\n".utf8)) }
}

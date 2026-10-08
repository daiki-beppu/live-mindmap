import Foundation
while let w = readLine() {
  let cf = w as CFString
  let t = CFStringTokenizerCreate(nil, cf, CFRangeMake(0, CFStringGetLength(cf)), kCFStringTokenizerUnitWordBoundary, Locale(identifier: "ja") as CFLocale)
  var n = 0
  while CFStringTokenizerAdvanceToNextToken(t) != [] { n += 1 }
  print("\(w)\t\(n)")
}

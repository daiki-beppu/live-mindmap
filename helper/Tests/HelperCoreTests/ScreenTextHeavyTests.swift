import CoreGraphics
import CoreText
import Foundation
import Testing
import HelperCore

// 共有画面の文字を読む（Issue #643）。実際の Vision（VNRecognizeTextRequest）を通す。
// 画面収録の許可は使わない。テストの中で文字を描いた CGImage に OCR をかける。

/// 白地に黒の文字を 1 行ずつ描いた画像。`lines` の上から順に並べる。
private func drawnImage(_ lines: [String], width: Int = 1280, height: Int = 720) throws -> CGImage {
    let space = CGColorSpaceCreateDeviceRGB()
    let context = try #require(CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let font = CTFontCreateWithName("Hiragino Sans" as CFString, 72, nil)
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
    ]
    for (index, line) in lines.enumerated() {
        let ctLine = CTLineCreateWithAttributedString(NSAttributedString(string: line, attributes: attributes))
        context.textPosition = CGPoint(x: 80, y: CGFloat(height) - 160 - CGFloat(index) * 160)
        CTLineDraw(ctLine, context)
    }
    return try #require(context.makeImage())
}

@Suite("共有画面の文字の OCR")
struct ScreenTextHeavyTests {
    @Test("描いた日本語と英字の行を読み、行に含まれる（港南店・Zendesk）")
    func readsDrawnJapaneseAndLatinLines() async throws {
        let image = try drawnImage(["港南店", "Zendesk"])
        let lines = try #require(await recognizeScreenText(image))
        let joined = lines.joined(separator: "\n")
        #expect(joined.contains("港南店"))
        #expect(joined.contains("Zendesk"))
    }

    @Test("文字の無い画像では、失敗（nil）ではなく空の配列を返す")
    func blankImageGivesEmptyLinesNotNil() async throws {
        let image = try drawnImage([])
        let lines = try #require(await recognizeScreenText(image))
        #expect(lines.isEmpty)
    }
}

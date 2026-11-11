import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func printScreenError(_ message: String) {
    FileHandle.standardError.write(Data(("screen: " + message + "\n").utf8))
}

func lumaGrid(of image: CGImage) -> [UInt8]? {
    var pixels = [UInt8](repeating: 0, count: screenGridWidth * screenGridHeight)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(
            data: buffer.baseAddress,
            width: screenGridWidth,
            height: screenGridHeight,
            bitsPerComponent: 8,
            bytesPerRow: screenGridWidth,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return false }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: screenGridWidth, height: screenGridHeight))
        return true
    }
    return drawn ? pixels : nil
}

func jpegData(of image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: screenJPEGQuality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
}

@available(*, noasync, message: "並行処理のスレッドを塞ぐ。映像のキュー・画面収録のキューの上で呼ぶ")
func screenShot(of image: CGImage) -> ScreenShot? {
    guard let jpeg = jpegData(of: image) else {
        printScreenError("JPEG を作れなかったので、この画面は送らない")
        return nil
    }
    let lines = recognizeScreenTextBlocking(image)
    return ScreenShot(jpeg: jpeg, recognizedLines: lines)
}

import Foundation

// 共有画面を取り込むかどうかの判定（純粋な部分）。許可の確認そのもの（CoreGraphics の公開 API）は呼び出し側が渡す。
// テストでは許可の API を呼ばない。

public enum ScreenCapturePlan: Equatable, Sendable {
    /// `--no-screen`。取り込まず、許可も確かめない。
    case off
    /// 許可がある。取り込みを始める。
    case capture
    /// 許可が無い・断られた。取り込まず、`screen-off`（許可なし）を流して音声だけで続ける。
    case denied
}

/// `noScreen` なら `accessGranted` を呼ばずに `.off`。そうでなければ `accessGranted` で許可を確かめる
/// （まだ聞いていなければ、そこで OS のダイアログが出る）。
public func screenCapturePlan(noScreen: Bool, accessGranted: () -> Bool) -> ScreenCapturePlan {
    if noScreen { return .off }
    return accessGranted() ? .capture : .denied
}

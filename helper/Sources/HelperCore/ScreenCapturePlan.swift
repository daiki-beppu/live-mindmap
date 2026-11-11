import Foundation

public enum ScreenCapturePlan: Equatable, Sendable {
    case off
    case capture
    case denied
}

public func screenCapturePlan(noScreen: Bool, accessGranted: () -> Bool) -> ScreenCapturePlan {
    if noScreen { return .off }
    return accessGranted() ? .capture : .denied
}

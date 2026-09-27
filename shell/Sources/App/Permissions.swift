import Carbon
import Foundation

/// §4.2 check 4: asks TCC whether we may send Apple Events to iTerm2 without
/// ever showing a prompt (askUserIfNeeded = false). This queries TCC; it
/// doesn't send an event to iTerm2. Can block, so call off the main thread.
enum AutomationProbe {
    static func itermStatus() -> AutomationStatus {
        let target = NSAppleEventDescriptor(bundleIdentifier: ShellInfo.itermBundleIdentifier)
        guard let desc = target.aeDesc else { return .unknown }
        let status = AEDeterminePermissionToAutomateTarget(desc, AEEventClass(typeWildCard), AEEventID(typeWildCard), false)
        return AutomationStatus.from(osStatus: status)
    }
}

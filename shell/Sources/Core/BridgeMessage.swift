import Foundation

enum Theme: String, Equatable, CaseIterable {
    case system, dark, light
}

enum SystemSettingsPane: String, Equatable, CaseIterable {
    case automation, notifications

    /// Only these two fixed URLs can ever be opened from the bridge.
    var url: URL {
        switch self {
        case .automation:
            return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")!
        case .notifications:
            return URL(string: "x-apple.systempreferences:com.apple.preference.notifications")!
        }
    }
}

enum BridgeDecodeError: Error, Equatable {
    case notAnObject
    case missingType
    case unknownType(String)
    case invalidField(String)
}

/// Web → shell messages posted to `window.webkit.messageHandlers.everwatch` (§3.5).
/// There is deliberately no message that can make sound.
enum InboundBridgeMessage: Equatable {
    case appearance(Theme)
    case openCompact
    case openSettings
    case requestNotifications
    case openSystemSettings(SystemSettingsPane)
    case setHotkeys(show: String, next: String)
    case ready

    /// `body` is what WKScriptMessage delivers: a dictionary for a JS object,
    /// or a JSON string.
    static func decode(_ body: Any) -> Result<InboundBridgeMessage, BridgeDecodeError> {
        var object = body as? [String: Any]
        if object == nil, let text = body as? String,
           let data = text.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            object = parsed
        }
        guard let dict = object else { return .failure(.notAnObject) }
        guard let type = dict["type"] as? String else { return .failure(.missingType) }

        switch type {
        case "appearance":
            guard let raw = dict["theme"] as? String, let theme = Theme(rawValue: raw) else {
                return .failure(.invalidField("theme"))
            }
            return .success(.appearance(theme))
        case "openCompact":
            return .success(.openCompact)
        case "openSettings":
            return .success(.openSettings)
        case "requestNotifications":
            return .success(.requestNotifications)
        case "openSystemSettings":
            guard let raw = dict["pane"] as? String, let pane = SystemSettingsPane(rawValue: raw) else {
                return .failure(.invalidField("pane"))
            }
            return .success(.openSystemSettings(pane))
        case "setHotkeys":
            guard let show = dict["show"] as? String else { return .failure(.invalidField("show")) }
            guard let next = dict["next"] as? String else { return .failure(.invalidField("next")) }
            return .success(.setHotkeys(show: show, next: next))
        case "ready":
            return .success(.ready)
        default:
            return .failure(.unknownType(type))
        }
    }
}

/// Status of the Automation → iTerm2 grant from
/// `AEDeterminePermissionToAutomateTarget(..., askUserIfNeeded: false)` (§4.2 check 4).
enum AutomationStatus: String, Equatable {
    case granted
    case notDetermined = "not_determined"
    case denied
    case notRunning = "not_running"
    case unknown

    static func from(osStatus: Int32) -> AutomationStatus {
        switch osStatus {
        case 0: return .granted
        case -1744: return .notDetermined   // errAEEventWouldRequireUserConsent
        case -1743: return .denied          // errAEEventNotPermitted
        case -600: return .notRunning       // procNotFound
        default: return .unknown
        }
    }

    /// The probe is a point-in-time TCC query, while the backend's osascript
    /// child (Everwatch.app is its responsible process, so it uses the same
    /// grant -- docs/PERMISSIONS.md) is what actually sends Apple Events.
    /// A probe taken at page load, before the user clicked OK, otherwise stays
    /// `not_determined` for the life of the window. Re-probe whenever the
    /// backend's `iterm.status` changes (e.g. connecting → ok right after the
    /// grant, permission_denied → ok after flipping the switch).
    static func shouldReprobe(previousItermStatus: String?, currentItermStatus: String?) -> Bool {
        guard let current = currentItermStatus else { return false }
        return current != previousItermStatus
    }
}

/// Notification authorization (§4.2 check 10), from UNAuthorizationStatus raw values.
enum NotificationStatus: String, Equatable {
    case authorized
    case denied
    case notDetermined = "not_determined"
    case unknown

    static func from(authorizationStatusRawValue raw: Int) -> NotificationStatus {
        switch raw {
        case 0: return .notDetermined
        case 1: return .denied
        case 2, 3, 4: return .authorized   // authorized, provisional, ephemeral
        default: return .unknown
        }
    }
}

struct NativeStatus: Equatable {
    var automation: AutomationStatus
    var notifications: NotificationStatus
    /// "show"/"next" → HotkeyStatus raw value.
    var hotkeys: [String: String]
}

/// Shell → web messages, delivered via `window.everwatchNative.dispatch(...)`.
enum OutboundBridgeMessage: Equatable {
    case notificationClicked(uid: String)
    case nativeStatus(NativeStatus)
    case focus(key: Bool)
    /// Shell menu / compact panel asked for Settings in the main window.
    case openSettings

    var jsonObject: [String: Any] {
        switch self {
        case .notificationClicked(let uid):
            return ["type": "notificationClicked", "uid": uid]
        case .nativeStatus(let status):
            return ["type": "nativeStatus",
                    "automation": status.automation.rawValue,
                    "notifications": status.notifications.rawValue,
                    "hotkeys": status.hotkeys]
        case .focus(let key):
            return ["type": "focus", "key": key]
        case .openSettings:
            return ["type": "openSettings"]
        }
    }

    var json: String {
        JSONText.encode(jsonObject)
    }

    /// Script for `WKWebView.evaluateJavaScript`. A no-op if the page hasn't
    /// installed the bridge.
    var javaScript: String {
        "(function(m){var n=window.everwatchNative;if(n&&typeof n.dispatch===\"function\"){n.dispatch(m);}})(\(json));"
    }
}

enum JSONText {
    /// Deterministic JSON (sorted keys) that is also a safe JS expression:
    /// U+2028/U+2029 are escaped.
    static func encode(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject([object]),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8)
        else { return "null" }
        return text
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}

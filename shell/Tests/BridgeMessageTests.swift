import Foundation
import Testing

@Suite("BridgeMessage")
struct BridgeMessageTests {
    @Test("decodes every inbound message type from a dictionary")
    func decodesAll() {
        #expect(InboundBridgeMessage.decode(["type": "appearance", "theme": "dark"]) == .success(.appearance(.dark)))
        #expect(InboundBridgeMessage.decode(["type": "appearance", "theme": "system"]) == .success(.appearance(.system)))
        #expect(InboundBridgeMessage.decode(["type": "openCompact"]) == .success(.openCompact))
        #expect(InboundBridgeMessage.decode(["type": "openSettings"]) == .success(.openSettings))
        #expect(InboundBridgeMessage.decode(["type": "requestNotifications"]) == .success(.requestNotifications))
        #expect(InboundBridgeMessage.decode(["type": "openSystemSettings", "pane": "automation"]) == .success(.openSystemSettings(.automation)))
        #expect(InboundBridgeMessage.decode(["type": "openSystemSettings", "pane": "notifications"]) == .success(.openSystemSettings(.notifications)))
        #expect(InboundBridgeMessage.decode(["type": "setHotkeys", "show": "opt+cmd+e", "next": ""]) == .success(.setHotkeys(show: "opt+cmd+e", next: "")))
        #expect(InboundBridgeMessage.decode(["type": "ready"]) == .success(.ready))
    }

    @Test("decodes from a JSON string body")
    func decodesJSONString() {
        #expect(InboundBridgeMessage.decode("{\"type\":\"appearance\",\"theme\":\"light\"}") == .success(.appearance(.light)))
    }

    @Test("rejects malformed messages")
    func rejects() {
        #expect(InboundBridgeMessage.decode(42) == .failure(.notAnObject))
        #expect(InboundBridgeMessage.decode("not json") == .failure(.notAnObject))
        #expect(InboundBridgeMessage.decode("[1,2]") == .failure(.notAnObject))
        #expect(InboundBridgeMessage.decode(["theme": "dark"]) == .failure(.missingType))
        #expect(InboundBridgeMessage.decode(["type": 5]) == .failure(.missingType))
        #expect(InboundBridgeMessage.decode(["type": "playSound"]) == .failure(.unknownType("playSound")))
        #expect(InboundBridgeMessage.decode(["type": "appearance", "theme": "neon"]) == .failure(.invalidField("theme")))
        #expect(InboundBridgeMessage.decode(["type": "appearance"]) == .failure(.invalidField("theme")))
        #expect(InboundBridgeMessage.decode(["type": "openSystemSettings", "pane": "https://evil.example"]) == .failure(.invalidField("pane")))
        #expect(InboundBridgeMessage.decode(["type": "setHotkeys", "next": "x"]) == .failure(.invalidField("show")))
        #expect(InboundBridgeMessage.decode(["type": "setHotkeys", "show": "x"]) == .failure(.invalidField("next")))
    }

    // # parity: P-66
    @Test("P-66 there is no inbound message that makes sound")
    func noSoundMessage() {
        for type in ["sound", "playSound", "beep", "bell", "setSound"] {
            #expect(InboundBridgeMessage.decode(["type": type]) == .failure(.unknownType(type)))
        }
    }

    @Test("system settings panes map to fixed URLs only")
    func paneURLs() {
        #expect(SystemSettingsPane.automation.url.absoluteString
                == "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
        #expect(SystemSettingsPane.notifications.url.absoluteString
                == "x-apple.systempreferences:com.apple.preference.notifications")
        #expect(SystemSettingsPane.allCases.count == 2)
    }

    @Test("outbound messages encode to the documented JSON")
    func outboundJSON() {
        #expect(OutboundBridgeMessage.notificationClicked(uid: "C2F1").json == #"{"type":"notificationClicked","uid":"C2F1"}"#)
        #expect(OutboundBridgeMessage.focus(key: true).json == #"{"key":true,"type":"focus"}"#)
        #expect(OutboundBridgeMessage.focus(key: false).json == #"{"key":false,"type":"focus"}"#)
        #expect(OutboundBridgeMessage.openSettings.json == #"{"type":"openSettings"}"#)
        let status = NativeStatus(automation: .notDetermined, notifications: .authorized, hotkeys: ["show": "ok", "next": "conflict"])
        #expect(OutboundBridgeMessage.nativeStatus(status).json
                == #"{"automation":"not_determined","hotkeys":{"next":"conflict","show":"ok"},"notifications":"authorized","type":"nativeStatus"}"#)
    }

    @Test("outbound javaScript guards on the page bridge and embeds JSON safely")
    func outboundJS() {
        let js = OutboundBridgeMessage.notificationClicked(uid: "a\"b</script>\u{2028}").javaScript
        #expect(js.hasPrefix("(function(m){var n=window.everwatchNative;if(n&&typeof n.dispatch===\"function\"){n.dispatch(m);}})("))
        #expect(js.hasSuffix(");"))
        #expect(js.contains(#"a\"b"#))
        #expect(js.contains("\\u2028"))
        #expect(!js.contains("\u{2028}"))
    }

    @Test("JSONText handles fragments and invalid objects")
    func jsonText() {
        #expect(JSONText.encode("tok") == "\"tok\"")
        #expect(JSONText.encode(["b": 1, "a": 2]) == #"{"a":2,"b":1}"#)
        #expect(JSONText.encode(Date()) == "null")
    }

    @Test("automation status mapping (§4.2 check 4)")
    func automationStatus() {
        #expect(AutomationStatus.from(osStatus: 0) == .granted)
        #expect(AutomationStatus.from(osStatus: -1744) == .notDetermined)
        #expect(AutomationStatus.from(osStatus: -1743) == .denied)
        #expect(AutomationStatus.from(osStatus: -600) == .notRunning)
        #expect(AutomationStatus.from(osStatus: -50) == .unknown)
        #expect(AutomationStatus.notDetermined.rawValue == "not_determined")
        #expect(AutomationStatus.notRunning.rawValue == "not_running")
    }

    @Test("automation re-probe fires on every backend iTerm2 status change, never on a repeat")
    func automationReprobe() {
        // The probe ran once, before the user clicked OK, and stayed not_determined (T033).
        #expect(AutomationStatus.shouldReprobe(previousItermStatus: "connecting", currentItermStatus: "ok"))
        #expect(AutomationStatus.shouldReprobe(previousItermStatus: "permission_denied", currentItermStatus: "ok"))
        #expect(AutomationStatus.shouldReprobe(previousItermStatus: "ok", currentItermStatus: "permission_denied"))
        #expect(AutomationStatus.shouldReprobe(previousItermStatus: nil, currentItermStatus: "ok"))
        #expect(!AutomationStatus.shouldReprobe(previousItermStatus: "ok", currentItermStatus: "ok"))
        #expect(!AutomationStatus.shouldReprobe(previousItermStatus: "ok", currentItermStatus: nil))
        #expect(!AutomationStatus.shouldReprobe(previousItermStatus: nil, currentItermStatus: nil))
    }

    @Test("notification status mapping (§4.2 check 10)")
    func notificationStatus() {
        #expect(NotificationStatus.from(authorizationStatusRawValue: 0) == .notDetermined)
        #expect(NotificationStatus.from(authorizationStatusRawValue: 1) == .denied)
        #expect(NotificationStatus.from(authorizationStatusRawValue: 2) == .authorized)
        #expect(NotificationStatus.from(authorizationStatusRawValue: 3) == .authorized)
        #expect(NotificationStatus.from(authorizationStatusRawValue: 4) == .authorized)
        #expect(NotificationStatus.from(authorizationStatusRawValue: 99) == .unknown)
        #expect(NotificationStatus.notDetermined.rawValue == "not_determined")
    }
}

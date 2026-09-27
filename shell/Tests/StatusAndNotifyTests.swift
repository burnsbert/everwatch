import Foundation
import Testing

@Suite("StatusTitle (W-2)")
struct StatusTitleTests {
    // # parity: W-2
    @Test("W-2 amber count when something is waiting")
    func waiting() {
        #expect(StatusTitle.menuBar(waiting: 2, connected: true)
                == StatusDisplay(text: "◉ 2", attention: true, showsEyeIcon: false, toolTip: "Everwatch — 2 waiting"))
    }

    // # parity: W-2
    @Test("W-2 dim eye when nothing is waiting or disconnected")
    func idle() {
        let idle = StatusTitle.menuBar(waiting: 0, connected: true)
        #expect(idle.showsEyeIcon && !idle.attention && idle.text.isEmpty)
        #expect(idle.toolTip == "Everwatch — nothing waiting")
        let off = StatusTitle.menuBar(waiting: 5, connected: false)
        #expect(off.showsEyeIcon && !off.attention)
        #expect(off.toolTip == "Everwatch — not connected")
    }

    // # parity: P-19
    @Test("P-19 window title stays informative; Dock badge is opt-in")
    func titleAndBadge() {
        #expect(StatusTitle.windowTitle(waiting: 0) == "Everwatch")
        #expect(StatusTitle.windowTitle(waiting: 3) == "Everwatch — 3 waiting")
        #expect(StatusTitle.dockBadge(waiting: 12, enabled: false) == nil)
        #expect(StatusTitle.dockBadge(waiting: 0, enabled: true) == nil)
        #expect(StatusTitle.dockBadge(waiting: -1, enabled: true) == nil)
        #expect(StatusTitle.dockBadge(waiting: 12, enabled: true) == "12")
    }

    // # parity: W-2
    @Test("W-2 waiting menu lists sessions longest-waiting first, skipping unknown uids")
    func waitingMenu() {
        var state = ShellState()
        state.waitingOrder = ["b", "ghost", "a"]
        state.sessions = [
            ShellSession(uid: "a", title: "api-gateway", tabLabel: "1.3"),
            ShellSession(uid: "b", name: "codex", tabLabel: ""),
        ]
        #expect(StatusTitle.waitingMenuItems(state) == [
            WaitingMenuItem(uid: "b", title: "◉ codex"),
            WaitingMenuItem(uid: "a", title: "◉ 1.3  api-gateway"),
        ])
    }

    @Test("long titles are truncated with an ellipsis")
    func truncation() {
        #expect(StatusTitle.truncate("abcdef", to: 4) == "abc…")
        #expect(StatusTitle.truncate("abcd", to: 4) == "abcd")
        #expect(StatusTitle.truncate("abcd", to: 0) == "")
        var state = ShellState()
        state.waitingOrder = ["a"]
        state.sessions = [ShellSession(uid: "a", title: String(repeating: "x", count: 200))]
        let title = StatusTitle.waitingMenuItems(state)[0].title
        #expect(title.count == 2 + StatusTitle.maxMenuTitleLength)
        #expect(title.hasSuffix("…"))
    }

    // # parity: P-77
    @Test("P-77 About credits show shell and runtime versions")
    func about() {
        #expect(ShellInfo.aboutCredits(runtimeVersion: "0.3.1") == "Shell \(ShellInfo.version) · Runtime 0.3.1")
        #expect(ShellInfo.aboutCredits(runtimeVersion: nil) == "Shell \(ShellInfo.version) · Runtime not connected")
        #expect(ShellInfo.aboutCredits(runtimeVersion: "") == "Shell \(ShellInfo.version) · Runtime not connected")
    }
}

@Suite("NotifyGate (W-1)")
struct NotifyGateTests {
    // # parity: W-1
    @Test("W-1 posts when the main window isn't key")
    func posts() {
        var gate = NotifyGate()
        #expect(gate.evaluate(id: "n1", mainWindowIsKey: false) == .post)
    }

    // # parity: W-1
    @Test("W-1 suppressed while the main window is key")
    func suppressed() {
        var gate = NotifyGate()
        #expect(gate.evaluate(id: "n1", mainWindowIsKey: true) == .suppressedWindowKey)
        // A suppressed id is still consumed: a replay after reconnect won't post it later.
        #expect(gate.evaluate(id: "n1", mainWindowIsKey: false) == .duplicate)
        #expect(NotifyGate.presentInForeground(mainWindowIsKey: true) == false)
        #expect(NotifyGate.presentInForeground(mainWindowIsKey: false) == true)
    }

    // # parity: W-1
    @Test("W-1 duplicate ids never post twice; empty ids are invalid")
    func duplicates() {
        var gate = NotifyGate()
        #expect(gate.evaluate(id: "n1", mainWindowIsKey: false) == .post)
        #expect(gate.evaluate(id: "n1", mainWindowIsKey: false) == .duplicate)
        #expect(gate.evaluate(id: "", mainWindowIsKey: false) == .invalid)
    }

    @Test("memory of seen ids is bounded")
    func bounded() {
        var gate = NotifyGate(capacity: 2)
        #expect(gate.evaluate(id: "a", mainWindowIsKey: false) == .post)
        #expect(gate.evaluate(id: "b", mainWindowIsKey: false) == .post)
        #expect(gate.evaluate(id: "c", mainWindowIsKey: false) == .post)
        #expect(gate.evaluate(id: "a", mainWindowIsKey: false) == .post)   // evicted, so new again
        #expect(gate.evaluate(id: "c", mainWindowIsKey: false) == .duplicate)
        #expect(NotifyGate(capacity: 0).capacity == 1)
    }

    @Test("quota notifications are keyed by month")
    func quotaID() {
        #expect(NotifyGate.quotaNotificationID(month: "2026-09") == "quota-2026-09")
    }
}

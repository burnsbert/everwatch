import Foundation
import Testing

@Suite("ShellState and events")
struct ShellStateTests {
    static let stateJSON = """
    {"rev":412,"now":1790000000.1,"version":"0.1.0","mode":"demo",
     "iterm":{"status":"ok","error":"","snapshot_at":1790000000.0},
     "counts":{"tabs":9,"agents":4,"waiting":2},
     "waiting_order":["C2F1","9A0B"],
     "sessions":[
       {"uid":"C2F1","tab_label":"1.3","name":"claude","display_name":"deploy-fix","title":"deploy-fix","state":"waiting","window_id":4711},
       {"uid":"9A0B","tab_label":"2.1","name":"codex","display_name":"","title":null,"state":"waiting"},
       {"uid":"77","name":"zsh","state":"quiet"}],
     "prefs":{"view":"split","sound_on_attention":true,"dock_bounce":true,"show_dock_badge":true,"notify_on_waiting":false,
              "theme":"dark","hotkey_show":"ctrl+opt+e","hotkey_next":""},
     "quota_prompt":null}
    """

    @Test("decodes the parts of State the shell uses")
    func decodesState() throws {
        let state = try JSONDecoder().decode(ShellState.self, from: Data(Self.stateJSON.utf8))
        #expect(state.rev == 412)
        #expect(state.version == "0.1.0")
        #expect(state.waitingCount == 2)
        #expect(state.waitingOrder == ["C2F1", "9A0B"])
        #expect(state.sessions.count == 3)
        #expect(state.itermStatus == "ok")
        #expect(state.prefs.soundOnAttention)
        #expect(state.prefs.dockBounce)
        #expect(state.prefs.showDockBadge)
        #expect(!state.prefs.notifyOnWaiting)
        #expect(state.prefs.theme == .dark)
        #expect(state.prefs.hotkeyShow == "ctrl+opt+e")
        #expect(state.prefs.hotkeyNext == "")
        #expect(state.longestWaitingUID == "C2F1")
        #expect(state.session(uid: "9A0B")?.tabLabel == "2.1")
        #expect(state.session(uid: "nope") == nil)
    }

    @Test("empty object decodes to safe defaults with sound off")
    func defaults() throws {
        let state = try JSONDecoder().decode(ShellState.self, from: Data("{}".utf8))
        #expect(state == ShellState())
        #expect(state.prefs.soundOnAttention == false)
        #expect(state.prefs.notifyOnWaiting == false)
        #expect(state.prefs.showDockBadge == false)
        #expect(state.prefs.hotkeyShow == "opt+cmd+e")
        #expect(state.prefs.hotkeyNext == "opt+cmd+j")
        #expect(state.longestWaitingUID == nil)
    }

    // # parity: P-67
    @Test("P-67 mistyped prefs fall back to defaults (sound never turns on by accident)")
    func lenientPrefs() throws {
        let json = #"{"sound_on_attention":"yes","notify_on_waiting":1,"dock_bounce":null,"theme":"neon","hotkey_show":5}"#
        let prefs = try JSONDecoder().decode(Prefs.self, from: Data(json.utf8))
        #expect(prefs == Prefs())
    }

    @Test("mistyped top-level fields don't fail the whole state")
    func lenientState() throws {
        let json = #"{"rev":"x","counts":{"waiting":"2"},"waiting_order":"C2F1","sessions":[{"name":"no uid"}],"prefs":7,"iterm":{"status":3},"version":1}"#
        let state = try JSONDecoder().decode(ShellState.self, from: Data(json.utf8))
        #expect(state == ShellState())
    }

    @Test("session title fallbacks")
    func titleFallback() {
        #expect(ShellSession(uid: "u", title: "T", displayName: "D", name: "N").bestTitle == "T")
        #expect(ShellSession(uid: "u", title: "", displayName: "D", name: "N").bestTitle == "D")
        #expect(ShellSession(uid: "u", name: "N").bestTitle == "N")
        #expect(ShellSession(uid: "u").bestTitle == "u")
    }

    @Test("decodes hello with nested state and version fallback")
    func hello() {
        let data = #"{"version":"0.2.0","config":{"snapshot_interval":2},"state":{"rev":1,"counts":{"waiting":0}}}"#
        let event = ShellEvent.decode(SSEEvent(type: "hello", data: data, lastEventID: "1"))
        guard case .hello(let version, let state) = event else {
            Issue.record("expected hello, got \(event)")
            return
        }
        #expect(version == "0.2.0")
        #expect(state.version == "0.2.0")
        #expect(state.rev == 1)
        let bare = ShellEvent.decode(SSEEvent(type: "hello", data: "{}", lastEventID: ""))
        #expect(bare == .hello(version: nil, state: ShellState()))
    }

    @Test("decodes state, transition, notify, quota_prompt, ping")
    func events() throws {
        let state = try JSONDecoder().decode(ShellState.self, from: Data(Self.stateJSON.utf8))
        #expect(ShellEvent.decode(SSEEvent(type: "state", data: Self.stateJSON, lastEventID: "")) == .state(state))
        #expect(ShellEvent.decode(SSEEvent(type: "transition", data: #"{"uid":"u","from":"busy","to":"waiting","at":1.5,"title":"api"}"#, lastEventID: ""))
                == .transition(TransitionEvent(uid: "u", from: "busy", to: "waiting", at: 1.5, title: "api")))
        #expect(ShellEvent.decode(SSEEvent(type: "notify", data: #"{"id":"n1","uid":"u","title":"◉ api","body":"is waiting"}"#, lastEventID: ""))
                == .notify(NotifyEvent(id: "n1", uid: "u", title: "◉ api", body: "is waiting")))
        #expect(ShellEvent.decode(SSEEvent(type: "quota_prompt", data: #"{"pct":91.5,"to":"me@example.com","month":"2026-09"}"#, lastEventID: ""))
                == .quotaPrompt(QuotaPromptEvent(pct: 91.5, to: "me@example.com", month: "2026-09")))
        #expect(ShellEvent.decode(SSEEvent(type: "ping", data: #"{"now":1}"#, lastEventID: "")) == .ping)
        #expect(ShellEvent.decode(SSEEvent(type: "screens", data: "{}", lastEventID: "")) == .ignored("screens"))
    }

    @Test("malformed payloads are reported, not crashed on", arguments: ["hello", "state", "transition", "notify", "quota_prompt"])
    func malformed(type: String) {
        #expect(ShellEvent.decode(SSEEvent(type: type, data: "{not json", lastEventID: "")) == .malformed(type))
    }

    @Test("transition missing required 'to' is malformed")
    func transitionMissingTo() {
        #expect(ShellEvent.decode(SSEEvent(type: "transition", data: #"{"uid":"u"}"#, lastEventID: "")) == .malformed("transition"))
    }
}

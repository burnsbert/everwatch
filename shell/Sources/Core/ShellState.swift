import Foundation

/// The subset of backend prefs the shell acts on. Decoding is lenient: a
/// missing or mistyped value falls back to its default. Sound defaults off.
struct Prefs: Equatable, Decodable {
    var soundOnAttention: Bool = false
    var notifyOnWaiting: Bool = false
    var dockBounce: Bool = false
    var showDockBadge: Bool = false
    var theme: Theme = .system
    var hotkeyShow: String = Prefs.defaultHotkeyShow
    var hotkeyNext: String = Prefs.defaultHotkeyNext

    static let defaultHotkeyShow = "opt+cmd+e"
    static let defaultHotkeyNext = "opt+cmd+j"

    init() {}

    private enum Keys: String, CodingKey {
        case sound_on_attention, notify_on_waiting, dock_bounce, show_dock_badge, theme, hotkey_show, hotkey_next
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func value<T: Decodable>(_ type: T.Type, _ key: Keys) -> T? {
            (try? c.decodeIfPresent(type, forKey: key)) ?? nil
        }
        if let v = value(Bool.self, .sound_on_attention) { soundOnAttention = v }
        if let v = value(Bool.self, .notify_on_waiting) { notifyOnWaiting = v }
        if let v = value(Bool.self, .dock_bounce) { dockBounce = v }
        if let v = value(Bool.self, .show_dock_badge) { showDockBadge = v }
        if let raw = value(String.self, .theme), let t = Theme(rawValue: raw) { theme = t }
        if let v = value(String.self, .hotkey_show) { hotkeyShow = v }
        if let v = value(String.self, .hotkey_next) { hotkeyNext = v }
    }
}

struct ShellSession: Equatable, Decodable {
    var uid: String
    var title: String?
    var displayName: String?
    var name: String?
    var tabLabel: String?
    var state: String?

    private enum Keys: String, CodingKey {
        case uid, title, display_name, name, tab_label, state
    }

    init(uid: String, title: String? = nil, displayName: String? = nil, name: String? = nil,
         tabLabel: String? = nil, state: String? = nil) {
        self.uid = uid
        self.title = title
        self.displayName = displayName
        self.name = name
        self.tabLabel = tabLabel
        self.state = state
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        uid = try c.decode(String.self, forKey: .uid)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        displayName = (try? c.decodeIfPresent(String.self, forKey: .display_name)) ?? nil
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil
        tabLabel = (try? c.decodeIfPresent(String.self, forKey: .tab_label)) ?? nil
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil
    }

    /// title, else display name, else session name, else uid.
    var bestTitle: String {
        for candidate in [title, displayName, name] {
            if let c = candidate, !c.isEmpty { return c }
        }
        return uid
    }
}

/// The subset of the backend `State` (§3.5) used by the menu bar, Dock
/// badge, window title, hotkeys, and sound policy.
struct ShellState: Equatable, Decodable {
    var rev: Int = 0
    var version: String?
    var waitingCount: Int = 0
    var waitingOrder: [String] = []
    var sessions: [ShellSession] = []
    var prefs = Prefs()
    var itermStatus: String?

    init() {}

    private enum Keys: String, CodingKey {
        case rev, version, counts, waiting_order, sessions, prefs, iterm
    }
    private enum CountKeys: String, CodingKey { case waiting }
    private enum ItermKeys: String, CodingKey { case status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        rev = ((try? c.decodeIfPresent(Int.self, forKey: .rev)) ?? nil) ?? 0
        version = (try? c.decodeIfPresent(String.self, forKey: .version)) ?? nil
        if let counts = try? c.nestedContainer(keyedBy: CountKeys.self, forKey: .counts) {
            waitingCount = ((try? counts.decodeIfPresent(Int.self, forKey: .waiting)) ?? nil) ?? 0
        }
        waitingOrder = ((try? c.decodeIfPresent([String].self, forKey: .waiting_order)) ?? nil) ?? []
        sessions = ((try? c.decodeIfPresent([ShellSession].self, forKey: .sessions)) ?? nil) ?? []
        prefs = ((try? c.decodeIfPresent(Prefs.self, forKey: .prefs)) ?? nil) ?? Prefs()
        if let iterm = try? c.nestedContainer(keyedBy: ItermKeys.self, forKey: .iterm) {
            itermStatus = (try? iterm.decodeIfPresent(String.self, forKey: .status)) ?? nil
        }
    }

    func session(uid: String) -> ShellSession? {
        sessions.first { $0.uid == uid }
    }

    /// The session ⌥⌘J jumps to: the longest-waiting one.
    var longestWaitingUID: String? { waitingOrder.first }
}

struct TransitionEvent: Equatable, Decodable {
    var uid: String
    var from: String?
    var to: String
    var at: Double?
    var title: String?
}

struct NotifyEvent: Equatable, Decodable {
    var id: String
    var uid: String
    var title: String
    var body: String
}

struct QuotaPromptEvent: Equatable, Decodable {
    var pct: Double
    var to: String?
    var month: String
}

/// SSE events the shell consumes; everything else is `.ignored`.
enum ShellEvent: Equatable {
    case hello(version: String?, state: ShellState)
    case state(ShellState)
    case transition(TransitionEvent)
    case notify(NotifyEvent)
    case quotaPrompt(QuotaPromptEvent)
    case ping
    case ignored(String)
    case malformed(String)

    private struct Hello: Decodable {
        var version: String?
        var state: ShellState?
    }

    static func decode(_ event: SSEEvent) -> ShellEvent {
        let data = Data(event.data.utf8)
        let decoder = JSONDecoder()
        switch event.type {
        case "hello":
            guard let hello = try? decoder.decode(Hello.self, from: data) else { return .malformed(event.type) }
            var state = hello.state ?? ShellState()
            if state.version == nil { state.version = hello.version }
            return .hello(version: hello.version, state: state)
        case "state":
            guard let state = try? decoder.decode(ShellState.self, from: data) else { return .malformed(event.type) }
            return .state(state)
        case "transition":
            guard let t = try? decoder.decode(TransitionEvent.self, from: data) else { return .malformed(event.type) }
            return .transition(t)
        case "notify":
            guard let n = try? decoder.decode(NotifyEvent.self, from: data) else { return .malformed(event.type) }
            return .notify(n)
        case "quota_prompt":
            guard let q = try? decoder.decode(QuotaPromptEvent.self, from: data) else { return .malformed(event.type) }
            return .quotaPrompt(q)
        case "ping":
            return .ping
        default:
            return .ignored(event.type)
        }
    }
}

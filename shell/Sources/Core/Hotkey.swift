import Foundation

/// A parsed global hotkey such as "opt+cmd+e" (W-4). Key codes and modifier
/// masks are Carbon's values (kVK_*, cmdKey, …) so App can pass them straight
/// to `RegisterEventHotKey`; Core stays Foundation-only.
struct HotkeySpec: Equatable {
    let keyCode: UInt32
    let carbonModifiers: UInt32
    /// Canonical form: modifiers in ctrl, opt, shift, cmd order, then the key.
    let normalized: String
    /// macOS-style glyphs, e.g. "⌥⌘E".
    let display: String

    static let controlMask: UInt32 = 4096  // controlKey
    static let optionMask: UInt32 = 2048   // optionKey
    static let shiftMask: UInt32 = 512     // shiftKey
    static let commandMask: UInt32 = 256   // cmdKey

    static let keyCodes: [String: UInt32] = [
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
        "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17,
        "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        "space": 49,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    private enum Modifier: Int, CaseIterable {
        case ctrl, opt, shift, cmd   // canonical order

        var mask: UInt32 {
            switch self {
            case .ctrl: return HotkeySpec.controlMask
            case .opt: return HotkeySpec.optionMask
            case .shift: return HotkeySpec.shiftMask
            case .cmd: return HotkeySpec.commandMask
            }
        }
        var token: String {
            switch self {
            case .ctrl: return "ctrl"
            case .opt: return "opt"
            case .shift: return "shift"
            case .cmd: return "cmd"
            }
        }
        var glyph: String {
            switch self {
            case .ctrl: return "⌃"
            case .opt: return "⌥"
            case .shift: return "⇧"
            case .cmd: return "⌘"
            }
        }

        init?(alias: String) {
            switch alias {
            case "ctrl", "control", "⌃": self = .ctrl
            case "opt", "option", "alt", "⌥": self = .opt
            case "shift", "⇧": self = .shift
            case "cmd", "command", "⌘": self = .cmd
            default: return nil
            }
        }
    }

    enum ParseError: Error, Equatable {
        case empty
        case unknownModifier(String)
        case duplicateModifier(String)
        case unknownKey(String)
        case missingKey
        /// Needs ctrl, opt, or cmd so a plain (or shifted) key isn't swallowed system-wide.
        case needsModifier
    }

    static func parse(_ text: String) -> Result<HotkeySpec, ParseError> {
        let tokens = text.lowercased()
            .split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard !(tokens.count == 1 && tokens[0].isEmpty) else { return .failure(.empty) }
        guard let keyToken = tokens.last, !keyToken.isEmpty else { return .failure(.missingKey) }

        var modifiers = Set<Modifier>()
        for token in tokens.dropLast() {
            guard let modifier = Modifier(alias: token) else { return .failure(.unknownModifier(token)) }
            guard modifiers.insert(modifier).inserted else { return .failure(.duplicateModifier(token)) }
        }
        guard let code = keyCodes[keyToken] else {
            return .failure(Modifier(alias: keyToken) != nil ? .missingKey : .unknownKey(keyToken))
        }
        guard modifiers.contains(.ctrl) || modifiers.contains(.opt) || modifiers.contains(.cmd) else {
            return .failure(.needsModifier)
        }
        let ordered = Modifier.allCases.filter { modifiers.contains($0) }
        let mask = ordered.reduce(UInt32(0)) { $0 | $1.mask }
        let normalized = (ordered.map(\.token) + [keyToken]).joined(separator: "+")
        let keyGlyph = keyToken == "space" ? "Space" : keyToken.uppercased()
        let display = ordered.map(\.glyph).joined() + keyGlyph
        return .success(HotkeySpec(keyCode: code, carbonModifiers: mask, normalized: normalized, display: display))
    }
}

/// Per-hotkey status reported to the web in `nativeStatus.hotkeys` (§4.2 check 11).
enum HotkeyStatus: String, Equatable {
    case ok
    case disabled   // empty string in prefs
    case invalid    // couldn't parse
    case conflict   // same as the other hotkey, or already registered
    case error      // RegisterEventHotKey failed for another reason

    static let eventHotKeyExistsErr: Int32 = -9878

    static func from(registrationStatus status: Int32) -> HotkeyStatus {
        switch status {
        case 0: return .ok
        case eventHotKeyExistsErr: return .conflict
        default: return .error
        }
    }
}

/// Resolves the two configured hotkeys before registration.
struct HotkeyPlan: Equatable {
    enum Entry: Equatable {
        case register(HotkeySpec)
        case skip(HotkeyStatus)
    }

    let show: Entry
    let next: Entry

    static func make(show: String, next: String) -> HotkeyPlan {
        let showEntry = entry(for: show)
        var nextEntry = entry(for: next)
        if case .register(let a) = showEntry, case .register(let b) = nextEntry,
           a.keyCode == b.keyCode, a.carbonModifiers == b.carbonModifiers {
            nextEntry = .skip(.conflict)
        }
        return HotkeyPlan(show: showEntry, next: nextEntry)
    }

    private static func entry(for text: String) -> Entry {
        if text.trimmingCharacters(in: .whitespaces).isEmpty { return .skip(.disabled) }
        switch HotkeySpec.parse(text) {
        case .success(let spec): return .register(spec)
        case .failure: return .skip(.invalid)
        }
    }
}

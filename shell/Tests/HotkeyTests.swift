import Foundation
import Testing

@Suite("Hotkeys (W-4)")
struct HotkeyTests {
    // # parity: W-4
    @Test("W-4 default hotkeys parse to Carbon codes")
    func defaults() throws {
        let show = try HotkeySpec.parse("opt+cmd+e").get()
        #expect(show.keyCode == 14)
        #expect(show.carbonModifiers == 2048 | 256)
        #expect(show.normalized == "opt+cmd+e")
        #expect(show.display == "⌥⌘E")
        let next = try HotkeySpec.parse("opt+cmd+j").get()
        #expect(next.keyCode == 38)
        #expect(next.display == "⌥⌘J")
    }

    @Test("aliases, case, spacing and order normalize")
    func normalization() throws {
        let spec = try HotkeySpec.parse(" Command + Shift + Control + Alt + K ").get()
        #expect(spec.normalized == "ctrl+opt+shift+cmd+k")
        #expect(spec.display == "⌃⌥⇧⌘K")
        #expect(spec.carbonModifiers == 4096 | 2048 | 512 | 256)
        #expect(try HotkeySpec.parse("⌘+⌥+1").get().normalized == "opt+cmd+1")
        #expect(try HotkeySpec.parse("option+control+F12").get() == HotkeySpec(keyCode: 111, carbonModifiers: 6144, normalized: "ctrl+opt+f12", display: "⌃⌥F12"))
        #expect(try HotkeySpec.parse("cmd+space").get().display == "⌘Space")
        #expect(try HotkeySpec.parse("⌃+⇧+z").get().normalized == "ctrl+shift+z")
    }

    @Test("parse errors", arguments: [
        ("", HotkeySpec.ParseError.empty),
        ("cmd+", .missingKey),
        ("cmd+opt", .missingKey),
        ("hyper+e", .unknownModifier("hyper")),
        ("cmd+cmd+e", .duplicateModifier("cmd")),
        ("cmd+command+e", .duplicateModifier("command")),
        ("cmd+é", .unknownKey("é")),
        ("cmd+f13", .unknownKey("f13")),
        ("e", .needsModifier),
        ("shift+e", .needsModifier),
    ])
    func errors(input: String, expected: HotkeySpec.ParseError) {
        #expect(HotkeySpec.parse(input) == .failure(expected))
    }

    @Test("key table covers letters, digits, space and F1–F12 with unique codes")
    func keyTable() {
        #expect(HotkeySpec.keyCodes.count == 26 + 10 + 1 + 12)
        #expect(Set(HotkeySpec.keyCodes.values).count == HotkeySpec.keyCodes.count)
    }

    // # parity: W-4
    @Test("W-4 plan: identical hotkeys conflict, empty disables, junk is invalid")
    func plan() throws {
        let e = try HotkeySpec.parse("opt+cmd+e").get()
        let j = try HotkeySpec.parse("opt+cmd+j").get()
        #expect(HotkeyPlan.make(show: "opt+cmd+e", next: "opt+cmd+j") == HotkeyPlan(show: .register(e), next: .register(j)))
        #expect(HotkeyPlan.make(show: "opt+cmd+e", next: "cmd+option+E") == HotkeyPlan(show: .register(e), next: .skip(.conflict)))
        #expect(HotkeyPlan.make(show: "", next: "  ") == HotkeyPlan(show: .skip(.disabled), next: .skip(.disabled)))
        #expect(HotkeyPlan.make(show: "banana", next: "opt+cmd+j") == HotkeyPlan(show: .skip(.invalid), next: .register(j)))
    }

    @Test("§4.2 check 11 registration status mapping")
    func registrationStatus() {
        #expect(HotkeyStatus.from(registrationStatus: 0) == .ok)
        #expect(HotkeyStatus.from(registrationStatus: -9878) == .conflict)
        #expect(HotkeyStatus.from(registrationStatus: -50) == .error)
        #expect(HotkeyStatus.eventHotKeyExistsErr == -9878)
    }
}

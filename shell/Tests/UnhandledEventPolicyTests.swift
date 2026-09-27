import AppKit
import Foundation
import Testing

/// Stand-ins for NSResponder and its subclasses, so the runtime inspection is
/// tested on classes whose shape the test controls.
class FixtureResponder: NSObject {
    @objc func noResponder(for eventSelector: Selector) {}
}
final class SilentFixture: FixtureResponder {
    override func noResponder(for eventSelector: Selector) {}
}
final class PlainFixture: FixtureResponder {}
class SilentBaseFixture: FixtureResponder {
    override func noResponder(for eventSelector: Selector) {}
}
final class InheritsSilentFixture: SilentBaseFixture {}
final class UnrelatedFixture: NSObject {
    @objc func noResponder(for eventSelector: Selector) {}
}

/// Fixtures for SilentMethodPatch, used by one test only (patching is
/// process-wide and tests run in parallel). Each original records its calls.
final class PatchCalls: @unchecked Sendable {
    static let shared = PatchCalls()
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    func hit(_ key: String) { lock.lock(); counts[key, default: 0] += 1; lock.unlock() }
    func count(_ key: String) -> Int { lock.lock(); defer { lock.unlock() }; return counts[key] ?? 0 }
}
// `dynamic` so Swift call sites go through objc_msgSend, as AppKit's do.
class PatchBase: NSObject {
    @objc dynamic func noResponder(for eventSelector: Selector) { PatchCalls.shared.hit("base original") }
}
final class PatchPlain: PatchBase {}
final class PatchOverride: PatchBase {
    @objc dynamic override func noResponder(for eventSelector: Selector) { PatchCalls.shared.hit("subclass override") }
}
class PatchParent: NSObject {
    @objc dynamic func noResponder(for eventSelector: Selector) { PatchCalls.shared.hit("parent original") }
}
final class PatchInheritingChild: PatchParent {}
final class PatchNoMethod: NSObject {}

@Suite("Unhandled key events never beep")
struct UnhandledEventPolicyTests {
    static let selector = #selector(FixtureResponder.noResponder(for:))
    static let appKitSelector = #selector(NSResponder.noResponder(for:))

    @Test("policy: never beeps for any selector, unlike AppKit's default for keyDown:",
          arguments: ["keyDown:", "keyUp:", "flagsChanged:", "performKeyEquivalent:", "insertText:", "", "cancelOperation:"])
    func neverBeeps(selector: String) {
        #expect(UnhandledEventPolicy.mayBeep(selector: selector) == false)
        #expect(UnhandledEventPolicy.appKitDefaultBeeps(selector: selector) == (selector == "keyDown:"))
    }

    @Test("drop records the selector and reports no beep")
    func dropRecords() {
        let log = UnhandledEventLog()
        #expect(log.total == 0)
        #expect(UnhandledEventPolicy.drop("keyDown:", log: log) == false)
        #expect(UnhandledEventPolicy.drop("keyDown:", log: log) == false)
        #expect(UnhandledEventPolicy.drop("keyUp:", log: log) == false)
        #expect(log.count("keyDown:") == 2)
        #expect(log.count("keyUp:") == 1)
        #expect(log.count("flagsChanged:") == 0)
        #expect(log.total == 3)
    }

    @Test("override detection reads IMPs: overridden, inherited override, not overridden, unrelated, base")
    func overrideDetection() {
        let base: AnyClass = FixtureResponder.self
        #expect(MethodOverride.isOverridden(Self.selector, in: SilentFixture.self, below: base))
        #expect(MethodOverride.isOverridden(Self.selector, in: InheritsSilentFixture.self, below: base))
        #expect(!MethodOverride.isOverridden(Self.selector, in: PlainFixture.self, below: base))
        #expect(!MethodOverride.isOverridden(Self.selector, in: UnrelatedFixture.self, below: base))
        #expect(!MethodOverride.isOverridden(Self.selector, in: base, below: base))
        #expect(!MethodOverride.isOverridden(NSSelectorFromString("description"), in: SilentFixture.self, below: base))
        #expect(MethodOverride.inherits(InheritsSilentFixture.self, from: base))
        #expect(!MethodOverride.inherits(UnrelatedFixture.self, from: base))
    }

    @Test("a chain is silent only when its last responder overrides")
    func chainVerdict() {
        let base: AnyClass = FixtureResponder.self
        #expect(MethodOverride.chainEndIsSilent([PlainFixture.self, SilentFixture.self], selector: Self.selector, base: base))
        #expect(!MethodOverride.chainEndIsSilent([SilentFixture.self, PlainFixture.self], selector: Self.selector, base: base))
        #expect(!MethodOverride.chainEndIsSilent([], selector: Self.selector, base: base))
    }

    // The real classes from App/SilentResponders.swift (compiled into this
    // binary by build_app.sh; inspected, never instantiated).
    @Test("every Everwatch chain-ending class overrides noResponder(for:)")
    func realClassesOverride() {
        #expect(SilentResponders.selector == Self.appKitSelector)
        #expect(SilentResponders.classes.count == 3)
        for cls in [SilentApplication.self, SilentWindow.self, SilentPanel.self] as [AnyClass] {
            #expect(MethodOverride.isOverridden(Self.appKitSelector, in: cls, below: NSResponder.self),
                    "\(NSStringFromClass(cls)) must override noResponder(for:)")
        }
        #expect(MethodOverride.inherits(SilentWindow.self, from: NSWindow.self))
        #expect(MethodOverride.inherits(SilentPanel.self, from: NSPanel.self))
        #expect(MethodOverride.inherits(SilentApplication.self, from: NSApplication.self))
    }

    @Test("process-wide patch: replaces only the class's IMP, routes to drop, is idempotent, never calls the original")
    func processWidePatchOnFixtures() {
        let keyDown = NSSelectorFromString("keyDown:")
        let log = UnhandledEventLog()
        let patch = SilentMethodPatch(cls: PatchBase.self, selector: Self.selector, log: log)
        let before = patch.currentIMP
        #expect(before != nil)
        #expect(!patch.isInstalled)
        #expect(patch.silentIMP == nil)

        #expect(patch.install() == .installed)
        #expect(patch.isInstalled)
        #expect(patch.currentIMP == patch.silentIMP)
        #expect(patch.replacedIMP == before)
        #expect(patch.silentIMP != before)

        PatchPlain().noResponder(for: keyDown)
        PatchBase().noResponder(for: keyDown)
        #expect(log.count("keyDown:") == 2)
        #expect(PatchCalls.shared.count("base original") == 0)

        // A subclass's own override still wins (layer 1 is unaffected).
        PatchOverride().noResponder(for: keyDown)
        #expect(PatchCalls.shared.count("subclass override") == 1)
        #expect(log.count("keyDown:") == 2)

        let silent = patch.silentIMP
        #expect(patch.install() == .alreadyInstalled)
        #expect(patch.currentIMP == silent)
        #expect(patch.silentIMP == silent)

        #expect(SilentMethodPatch(cls: PatchNoMethod.self, selector: Self.selector, log: log).install() == .missingMethod)
        #expect(class_getInstanceMethod(PatchNoMethod.self, Self.selector) == nil)

        // Patching a class that only inherits the method leaves the parent alone.
        let parentBefore = class_getInstanceMethod(PatchParent.self, Self.selector).map(method_getImplementation)
        let child = SilentMethodPatch(cls: PatchInheritingChild.self, selector: Self.selector, log: log)
        #expect(child.install() == .installed)
        #expect(class_getInstanceMethod(PatchParent.self, Self.selector).map(method_getImplementation) == parentBefore)
        PatchInheritingChild().noResponder(for: keyDown)
        #expect(log.count("keyDown:") == 3)
        PatchParent().noResponder(for: keyDown)
        #expect(PatchCalls.shared.count("parent original") == 1)
    }

    // Installs the real process-wide layer in this test process (it has no
    // windows and no events). The stock responder is called only after its
    // IMP is proven to be the silent one, so AppKit's original can't run.
    @Test("process-wide layer: NSResponder's own noResponder(for:) is the silent IMP; stock windows inherit it")
    func processWideLayerInstalled() {
        let outcome = SilentResponders.installProcessWide()
        #expect(outcome == .installed || outcome == .alreadyInstalled)
        #expect(SilentResponders.installProcessWide() == .alreadyInstalled)
        let patch = SilentResponders.processWide
        #expect(patch.cls === NSResponder.self)
        #expect(patch.isInstalled)
        let silent = patch.silentIMP
        #expect(silent != nil)
        #expect(patch.replacedIMP != nil && patch.replacedIMP != silent)
        func imp(_ cls: AnyClass) -> IMP? { class_getInstanceMethod(cls, Self.appKitSelector).map(method_getImplementation) }
        for cls in [NSResponder.self, NSWindow.self, NSPanel.self, NSApplication.self, NSView.self] as [AnyClass] {
            #expect(silent != nil && imp(cls) == silent, "\(NSStringFromClass(cls)) must dispatch to the silent IMP")
        }
        guard let silent, imp(NSResponder.self) == silent else { return }
        let before = UnhandledEventLog.shared.count("keyDown:")
        NSResponder().noResponder(for: #selector(NSResponder.keyDown(with:)))
        #expect(UnhandledEventLog.shared.count("keyDown:") == before + 1)
    }

    @Test("stock AppKit windows and the stock application don't override it (the root cause)")
    func stockClassesBeep() {
        for cls in [NSWindow.self, NSPanel.self, NSApplication.self] as [AnyClass] {
            #expect(!MethodOverride.isOverridden(Self.appKitSelector, in: cls, below: NSResponder.self))
        }
    }
}

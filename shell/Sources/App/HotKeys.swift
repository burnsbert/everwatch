import Carbon.HIToolbox
import Foundation

/// Global hotkeys via Carbon RegisterEventHotKey (W-4); needs no
/// Accessibility permission.
@MainActor
final class HotKeyCenter {
    enum Slot: UInt32 {
        case show = 1
        case next = 2
        var name: String { self == .show ? "show" : "next" }
    }

    private static let signature: OSType = 0x4556_5754   // 'EVWT'
    private var refs: [Slot: EventHotKeyRef] = [:]
    private var actions: [Slot: () -> Void] = [:]
    private var handlerRef: EventHandlerRef?

    /// Registers both hotkeys; returns "show"/"next" → HotkeyStatus raw value.
    func apply(show: String, next: String, onShow: @escaping () -> Void, onNext: @escaping () -> Void) -> [String: String] {
        installHandlerIfNeeded()
        unregisterAll()
        actions = [.show: onShow, .next: onNext]
        let plan = HotkeyPlan.make(show: show, next: next)
        var statuses: [String: String] = [:]
        for (slot, entry) in [(Slot.show, plan.show), (Slot.next, plan.next)] {
            switch entry {
            case .skip(let status):
                statuses[slot.name] = status.rawValue
            case .register(let spec):
                var ref: EventHotKeyRef?
                let id = EventHotKeyID(signature: Self.signature, id: slot.rawValue)
                let status = RegisterEventHotKey(spec.keyCode, spec.carbonModifiers, id,
                                                 GetApplicationEventTarget(), 0, &ref)
                if status == noErr, let ref { refs[slot] = ref }
                statuses[slot.name] = HotkeyStatus.from(registrationStatus: status).rawValue
            }
        }
        return statuses
    }

    func unregisterAll() {
        for ref in refs.values { UnregisterEventHotKey(ref) }
        refs.removeAll()
    }

    fileprivate func fire(_ id: UInt32) {
        guard let slot = Slot(rawValue: id) else { return }
        actions[slot]?()
    }

    private func installHandlerIfNeeded() {
        guard handlerRef == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let userData = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var hotKeyID = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            guard status == noErr, hotKeyID.signature == HotKeyCenter.signature else { return OSStatus(eventNotHandledErr) }
            let center = Unmanaged<HotKeyCenter>.fromOpaque(userData).takeUnretainedValue()
            let id = hotKeyID.id
            MainActor.assumeIsolated { center.fire(id) }
            return noErr
        }, 1, &spec, userData, &handlerRef)
    }
}

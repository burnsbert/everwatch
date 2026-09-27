import Foundation

/// The single thing in the repo allowed to produce an audible cue. The real
/// implementation lives in App/SystemSoundPlayer.swift; tests inject a fake.
protocol AttentionCuePlayer: AnyObject {
    func playAttentionCue()
}

/// The only sound decision site (P-66/P-67, hard rule 1).
///
/// A cue plays only when all of these hold:
/// - the event is a transition *to* `waiting`;
/// - the user pref `sound_on_attention` is true (it defaults to false);
/// - `EVERWATCH_NO_SOUND` is unset or empty. Any non-empty value disables
///   sound, so "1" (what every harness sets) always does.
struct SoundPolicy {
    static let killSwitch = "EVERWATCH_NO_SOUND"

    let environment: [String: String]

    init(environment: [String: String]) {
        self.environment = environment
    }

    static func isHardDisabled(environment: [String: String]) -> Bool {
        guard let value = environment[killSwitch] else { return false }
        return !value.isEmpty
    }

    var isHardDisabled: Bool { Self.isHardDisabled(environment: environment) }

    func shouldPlay(transitionTo state: String, soundOnAttention: Bool) -> Bool {
        guard !isHardDisabled else { return false }
        guard soundOnAttention else { return false }
        return state == "waiting"
    }

    /// Returns true if the cue was played.
    @discardableResult
    func handle(_ transition: TransitionEvent, prefs: Prefs, player: AttentionCuePlayer) -> Bool {
        guard shouldPlay(transitionTo: transition.to, soundOnAttention: prefs.soundOnAttention) else {
            return false
        }
        player.playAttentionCue()
        return true
    }
}

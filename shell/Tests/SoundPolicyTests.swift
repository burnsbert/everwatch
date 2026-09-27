import Foundation
import Testing

/// Records cue requests. Nothing audible exists in the test binary: the real
/// player lives in App/ and is never compiled into shell-tests.
final class RecordingCuePlayer: AttentionCuePlayer {
    private(set) var calls = 0
    func playAttentionCue() { calls += 1 }
}

@Suite("SoundPolicy")
struct SoundPolicyTests {
    let toWaiting = TransitionEvent(uid: "u", from: "busy", to: "waiting", at: 1, title: "api")
    let toIdle = TransitionEvent(uid: "u", from: "waiting", to: "idle", at: 2, title: "api")

    func prefs(sound: Bool) -> Prefs {
        var p = Prefs()
        p.soundOnAttention = sound
        return p
    }

    // # parity: P-66
    @Test("P-66 EVERWATCH_NO_SOUND=1 blocks playback even with the pref on")
    func killSwitchBlocks() {
        let player = RecordingCuePlayer()
        let policy = SoundPolicy(environment: ["EVERWATCH_NO_SOUND": "1"])
        #expect(policy.isHardDisabled)
        #expect(policy.handle(toWaiting, prefs: prefs(sound: true), player: player) == false)
        #expect(player.calls == 0)
    }

    // # parity: P-66
    @Test("P-66 any non-empty EVERWATCH_NO_SOUND value blocks", arguments: ["1", "true", "yes", "0", " "])
    func anyValueBlocks(value: String) {
        let player = RecordingCuePlayer()
        let policy = SoundPolicy(environment: ["EVERWATCH_NO_SOUND": value])
        #expect(policy.handle(toWaiting, prefs: prefs(sound: true), player: player) == false)
        #expect(player.calls == 0)
    }

    // # parity: P-67
    @Test("P-67 default prefs keep sound off")
    func defaultOff() {
        let player = RecordingCuePlayer()
        let policy = SoundPolicy(environment: [:])
        #expect(Prefs().soundOnAttention == false)
        #expect(policy.handle(toWaiting, prefs: Prefs(), player: player) == false)
        #expect(player.calls == 0)
    }

    // # parity: P-66
    @Test("P-66 plays once on a transition to waiting when pref on and no kill switch")
    func playsWhenAllowed() {
        let player = RecordingCuePlayer()
        let policy = SoundPolicy(environment: ["EVERWATCH_NO_SOUND": ""])
        #expect(!policy.isHardDisabled)
        #expect(policy.handle(toWaiting, prefs: prefs(sound: true), player: player))
        #expect(player.calls == 1)
    }

    // # parity: P-66
    @Test("P-66 transitions to other states never play", arguments: ["busy", "idle", "active", "quiet", "WAITING", ""])
    func otherStates(to: String) {
        let player = RecordingCuePlayer()
        let policy = SoundPolicy(environment: [:])
        let event = TransitionEvent(uid: "u", from: "waiting", to: to, at: nil, title: nil)
        #expect(policy.handle(event, prefs: prefs(sound: true), player: player) == false)
        #expect(player.calls == 0)
        #expect(policy.handle(toIdle, prefs: prefs(sound: true), player: player) == false)
    }

    // # parity: P-67
    @Test("P-67 truth table for shouldPlay")
    func truthTable() {
        let open = SoundPolicy(environment: [:])
        let killed = SoundPolicy(environment: ["EVERWATCH_NO_SOUND": "1"])
        #expect(open.shouldPlay(transitionTo: "waiting", soundOnAttention: true))
        #expect(!open.shouldPlay(transitionTo: "waiting", soundOnAttention: false))
        #expect(!killed.shouldPlay(transitionTo: "waiting", soundOnAttention: true))
        #expect(!killed.shouldPlay(transitionTo: "waiting", soundOnAttention: false))
        #expect(SoundPolicy.isHardDisabled(environment: ["OTHER": "1"]) == false)
    }

    @Test("the test process itself runs with the kill switch set")
    func harnessSetsKillSwitch() {
        #expect(SoundPolicy.isHardDisabled(environment: ProcessInfo.processInfo.environment))
    }
}

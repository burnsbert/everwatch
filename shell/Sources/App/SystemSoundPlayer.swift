import AppKit

/// The single audible site in the repo (allowlisted by lint_nosound.py).
/// Only SoundPolicy calls this, and only when the user turned
/// "sound on attention" on. The kill switch is re-checked here as a second
/// guard so EVERWATCH_NO_SOUND can never be bypassed.
final class SystemSoundPlayer: AttentionCuePlayer {
    func playAttentionCue() {
        guard !SoundPolicy.isHardDisabled(environment: ProcessInfo.processInfo.environment) else { return }
        NSSound.beep()
    }
}

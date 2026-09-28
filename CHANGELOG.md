# Changelog

## [0.2.7] — 2026-09-28

### Added

- Secondary iTerm2 split panes are marked in session lists and grid tiles.
  The **Panes** button in the Sessions header, or `h`, shows and hides them
  across views. All panes are shown by default, and the choice is saved.

### Fixed

- Claude sessions launched from the native installer's versioned executable,
  including agent panes, are identified as Claude instead of Shell.

## [0.2.6] — 2026-09-27

### Fixed

- Demo quotas and README screenshots now match the real display's visible
  categories and order: Claude Code Session, Claude Code Weekly, then Codex
  Weekly. Monthly extra usage and Codex five-hour limits are no longer
  shown in the sample fleet.
- The Tokens Used alert chip no longer repeats its run-out time when the
  footer has enough room for the full label.

## [0.2.5] — 2026-09-27

### Added

- Nine README screenshots generated from scripted sample sessions, including
  a Settings view, and a guide for reproducing them.
- `make demo` to explore sample sessions with an isolated temporary data
  directory while the installed app continues running.

### Changed

- Demo diagnostics now use simulated probes by default, so exploring Settings
  never reads live system or account data.
- Demo quota data now uses the current five-hour and weekly Claude limits
  without a Sonnet-only limit.
- `everwatch app --demo` opens the sample browser UI even when the native app
  is installed.
- Documentation now explains the session filter, appearance controls, and
  default-off notification and Dock count settings more clearly.

## [0.2.4] — 2026-09-27

### Added

- Settings controls for Dock waiting counts, waiting notifications, session font
  family and size, and the appearance mode. Dock counts and notifications are
  off by default.
- A Settings gear in the toolbar and a clear way back to Sessions. Projects
  show their slot numbers alongside their colors.

### Changed

- The toolbar theme button now sits immediately before Settings and shows
  the appearance it will switch to. Session filters explain what they show.
- Light mode uses muted gray surfaces, and text across the app is larger and
  heavier for readability. The default session name size is now 15px.
- Project session counts are no longer shown in the sidebar.

### Fixed

- The keyboard shortcuts sheet no longer crowds its status labels.
- A disabled Dock count clears any existing app icon badge.

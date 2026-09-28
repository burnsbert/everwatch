# Screenshots and sample data

The images in [the README](../README.md#feature-tour) show Everwatch's
scripted demo fleet. They contain sample project names, paths under
`/Users/sam/src/`, terminal output, and usage figures for Claude Code
Session and Weekly and Codex Weekly. No live iTerm2
session or local account data is needed to reproduce them.

## Explore the demo

From a source checkout:

```bash
make demo
```

This opens the browser UI with sample sessions and simulated diagnostics.
The script starts only a demo backend, stores any temporary data under a
new directory in the system temp folder, and removes that directory when
the process exits.
It does not launch or quit `Everwatch.app`. Press Ctrl+C in the terminal
to stop the demo. You can pass demo options through the script, for
example `bash scripts/demo.sh --no-open` to start only the server.

The installed `everwatch demo` command also opens a sample browser UI.
The native app does not use that command's demo backend; use the source
checkout's `make demo` for an isolated documentation session.

## Regenerate the images

Install the development dependencies once with `npm install` and, if
Chromium is not already cached, `npx playwright install chromium`. Then:

```bash
make screenshots
```

`scripts/screenshots.mjs` starts a fresh `serve --demo` process for each
image, with a fixed seed, clock, and simulated diagnostics. Each process
has its own temporary `EVERWATCH_HOME`; the script verifies demo mode
and the expected sample sessions before capturing. Playwright renders
offscreen, and the script stops only the backend processes it created.
The installed app and live sessions continue running throughout.

The output is nine PNGs in `docs/screenshots/`: dark and light hero
views, split, grid, usage, settings, command palette, compact layout,
and onboarding. Review any changed images before committing them, especially
if you edit the demo scenario or add a new screen.

"""Everwatch — a native-feeling macOS app that watches your iTerm2
sessions and tells you which AI coding agent (Claude Code, Codex) needs
you.

Ports the proven `ultrawatch-for-iterm2` engine behind a pluggable
DataSource and serves a localhost HTTP/SSE API to a vanilla-JS web UI
inside a small Swift shell. See docs/DESIGN.md for the full design.
"""

__version__ = '0.2.7'

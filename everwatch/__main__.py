"""Entry point for `python3 -m everwatch` (docs/DESIGN.md §4.1, §7 WP3)."""
import sys

from everwatch.cli import main

if __name__ == '__main__':
    sys.exit(main())

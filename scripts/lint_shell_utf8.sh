#!/usr/bin/env bash
# Fail if a shell script expands $NAME immediately followed by a non-ASCII
# byte (dollar-REPO then an ellipsis). Under a UTF-8 locale bash folds the multibyte char
# into the identifier, so `set -u` aborts with "unbound variable". Use ${NAME}.
set -euo pipefail
status=0
for f in "$@"; do
  if LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~[:space:]]' "$f"; then
    echo "lint_shell_utf8: $f: brace variables followed by non-ASCII text: \${NAME}" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "lint_shell_utf8: OK ($# file(s))"
exit "$status"

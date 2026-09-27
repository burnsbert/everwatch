"""Attention-notification policy (docs/DESIGN.md W-1, P-66 policy) and
the quota-prompt gate (P-68, P-69 logic).

The backend decides *whether* to notify; the shell only renders (and
decides sound on its own, from the `transition` event and prefs — there
is no sound here, ever).

W-1 rules, applied per engine batch of published transitions:
- Only transitions *to* waiting, and only while `notify_on_waiting` is on.
- 30 s cooldown per session: a session that flaps waiting→busy→waiting
  inside the cooldown notifies once.
- Coalescing: if 3 or more notifications would go out within 2 s (in one
  batch, or across batches inside the window), a single summary
  notification replaces them. Further eligible notifications inside that
  window are folded into it silently (the menu bar count still shows them).
"""
import urllib.parse

from everwatch.engine import heuristics as H
from everwatch.engine import notifier

COOLDOWN_SECONDS = 30
COALESCE_WINDOW = 2.0
COALESCE_THRESHOLD = 3


class NotifyPolicy:
    def __init__(self, cooldown=COOLDOWN_SECONDS, window=COALESCE_WINDOW,
                 threshold=COALESCE_THRESHOLD):
        self.cooldown = cooldown
        self.window = window
        self.threshold = threshold
        self._last_by_uid = {}     # uid -> last notified time
        self._recent = []          # times of individual notifications
        self._coalesced_until = 0.0
        self._seq = 0

    def _next_id(self):
        self._seq += 1
        return f'n{self._seq}'

    def decide(self, transitions, now, enabled=True):
        """transitions: [{'uid', 'to', 'title', 'body'}] from one batch.
        Returns the `notify` payloads to emit: [{id, uid, title, body}]."""
        if not enabled:
            return []
        eligible = []
        for t in transitions:
            if t['to'] != H.WAITING:
                continue
            last = self._last_by_uid.get(t['uid'])
            if last is not None and now - last < self.cooldown:
                continue
            eligible.append(t)
        if not eligible:
            return []
        for t in eligible:
            self._last_by_uid[t['uid']] = now
        if now < self._coalesced_until:
            return []  # folded into the summary already sent
        self._recent = [x for x in self._recent if now - x < self.window]
        if len(self._recent) + len(eligible) >= self.threshold:
            self._coalesced_until = now + self.window
            self._recent = []
            n = len(eligible)
            names = ', '.join(t['title'] for t in eligible[:3])
            if n > 3:
                names += f' +{n - 3} more'
            return [{
                'id': self._next_id(),
                'uid': eligible[0]['uid'],
                'title': f'◉ {n} sessions are waiting for your input',
                'body': names,
            }]
        out = []
        for t in eligible:
            self._recent.append(now)
            out.append({'id': self._next_id(), 'uid': t['uid'],
                        'title': f'◉ {t["title"]} is waiting for your input',
                        'body': t.get('body', '')})
        return out

    def forget(self, live_uids):
        for uid in list(self._last_by_uid):
            if uid not in live_uids:
                del self._last_by_uid[uid]


def gmail_draft_url(cfg):
    """Gmail compose URL for the quota email (ultrawatch notifier.py
    _open_gmail_draft; P-69). Returns None if the config lacks an email."""
    email = cfg.get('email') if isinstance(cfg, dict) else None
    if not isinstance(email, dict) or not email.get('to'):
        return None
    params = urllib.parse.urlencode(
        {'view': 'cm', 'to': email.get('to', ''),
         'su': email.get('subject', ''), 'body': email.get('body', '')},
        quote_via=urllib.parse.quote)
    return f'https://mail.google.com/mail/?{params}'


class QuotaGate:
    """Real quota gate over engine/notifier.py (the ultrawatch-compatible
    `~/.claude/quota-email/` files)."""

    def check(self, pct, now):
        return notifier.check_quota(pct, now=now)

    def mark(self, now):
        notifier.mark_notified(now=now)

    def month(self, now):
        return notifier._current_month(now)


class MemoryQuotaGate:
    """In-memory quota gate for demo mode and tests: same rules as
    notifier.check_quota, but never touches the filesystem."""

    def __init__(self, cfg=None):
        self.cfg = cfg
        self.marked_month = None

    def month(self, now):
        return notifier._current_month(now)

    def check(self, pct, now):
        if not notifier.is_enabled(self.cfg):
            return None
        if pct < self.cfg.get('threshold_percent', 90):
            return None
        if self.marked_month == self.month(now):
            return None
        return self.cfg

    def mark(self, now):
        self.marked_month = self.month(now)

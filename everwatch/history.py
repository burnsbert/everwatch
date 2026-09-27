"""Activity history (docs/DESIGN.md W-5 data, W-6 data).

- TransitionLog: in-memory ring buffer of published state transitions,
  kept for 2 hours. Feeds each session's 60-minute `spark` strip,
  GET /api/history, and "waited 3x, 11 m total" stats.
- UsageHistory: utilization samples every 5 minutes, appended to
  `usage-history.jsonl` in the state dir and retained for 8 days. Feeds
  GET /api/usage/history and the burn-down charts.

Both are owned by the engine thread (single writer, §3.3).
"""
import json
import os
from collections import deque

from everwatch.engine import heuristics as H

TRANSITION_RETENTION = 2 * 3600
SPARK_SLOTS = 12              # 12 x 5 min = the last 60 minutes
SPARK_SLOT_SECONDS = 300
SPARK_CHARS = {H.BUSY: 'b', H.WAITING: 'w', H.IDLE: 'i', H.ACTIVE: 'a',
               H.QUIET: 'q'}
SPARK_UNKNOWN = '-'
# Tie-break when two states cover a slot equally: the one that matters
# more to the user wins.
_SPARK_PRIORITY = (H.WAITING, H.BUSY, H.ACTIVE, H.IDLE, H.QUIET)

USAGE_SAMPLE_INTERVAL = 300
USAGE_RETENTION = 8 * 86400
USAGE_PRUNE_INTERVAL = 86400
USAGE_FILENAME = 'usage-history.jsonl'


class TransitionLog:
    def __init__(self, retention=TRANSITION_RETENTION):
        self.retention = retention
        self._items = deque()      # (at, uid, from, to), oldest first
        self._first_seen = {}      # uid -> first observation time

    def observe(self, uid, at):
        """Record the first time a session was seen (its timeline start)."""
        self._first_seen.setdefault(uid, at)

    def forget(self, live_uids):
        """Drop first-seen marks for vanished sessions (their transitions
        age out of the ring on their own)."""
        for uid in list(self._first_seen):
            if uid not in live_uids:
                del self._first_seen[uid]

    def add(self, uid, old, new, at):
        self._items.append((at, uid, old, new))

    def prune(self, now):
        cutoff = now - self.retention
        while self._items and self._items[0][0] < cutoff:
            self._items.popleft()

    def transitions(self, uid=None, since=0.0):
        return [{'uid': u, 'from': old, 'to': new, 'at': at}
                for at, u, old, new in self._items
                if at >= since and (uid is None or u == uid)]

    def timeline(self, uid, current, current_since, start, end):
        """Piecewise-constant [(t0, t1, state)] for uid over [start, end),
        reconstructed backward from the current state. Time before the
        session was first seen is omitted."""
        first = self._first_seen.get(uid, current_since)
        mine = [(at, old, new) for at, u, old, new in self._items
                if u == uid]
        segments = []
        t_hi, state = end, current
        for at, old, new in reversed(mine):
            if at <= start:
                break
            if at < t_hi:
                segments.append((max(at, start), t_hi, state))
            t_hi, state = at, old
        lo = max(start, first)
        if t_hi > lo:
            segments.append((lo, t_hi, state))
        segments.reverse()
        return segments

    def spark(self, uid, current, current_since, now,
              slots=SPARK_SLOTS, slot_seconds=SPARK_SLOT_SECONDS):
        """One char per slot, oldest first: the state that covered most of
        the slot ('-' when the session wasn't observed in it)."""
        start = now - slots * slot_seconds
        segments = self.timeline(uid, current, current_since, start, now)
        out = []
        for i in range(slots):
            s0 = start + i * slot_seconds
            s1 = s0 + slot_seconds
            cover = {}
            for t0, t1, state in segments:
                overlap = min(t1, s1) - max(t0, s0)
                if overlap > 0 and state in SPARK_CHARS:
                    cover[state] = cover.get(state, 0) + overlap
            if not cover:
                out.append(SPARK_UNKNOWN)
                continue
            best = max(cover.values())
            winner = next(st for st in _SPARK_PRIORITY
                          if cover.get(st) == best)
            out.append(SPARK_CHARS[winner])
        return ''.join(out)

    def wait_stats(self, uid, current, current_since, now,
                   window=TRANSITION_RETENTION):
        """{'count': times it entered waiting, 'seconds': total waited}
        within the last `window` seconds (W-5 detail line)."""
        start = now - window
        segments = self.timeline(uid, current, current_since, start, now)
        count = sum(1 for at, u, _old, new in self._items
                    if u == uid and new == H.WAITING and at >= start)
        seconds = sum(t1 - t0 for t0, t1, st in segments
                      if st == H.WAITING)
        return {'count': count, 'seconds': round(seconds, 3)}


class UsageHistory:
    """Utilization samples: {"at": epoch, "id": "cc.five_hour", "pct": 62}
    one JSON object per line. Best-effort I/O (never raises)."""

    def __init__(self, path, now, interval=USAGE_SAMPLE_INTERVAL,
                 retention=USAGE_RETENTION):
        self.path = path
        self.interval = interval
        self.retention = retention
        self.samples = []
        self.last_sample = 0.0
        self._last_prune = now
        self._load(now)

    def _load(self, now):
        cutoff = now - self.retention
        dropped = False
        if not self.path:
            return
        try:
            with open(self.path, encoding='utf-8') as f:
                for line in f:
                    try:
                        item = json.loads(line)
                        at, sid, pct = item['at'], item['id'], item['pct']
                    except (ValueError, KeyError, TypeError):
                        dropped = True
                        continue
                    if not isinstance(at, (int, float)) or at < cutoff:
                        dropped = True
                        continue
                    self.samples.append({'at': at, 'id': sid, 'pct': pct})
        except OSError:
            return
        if self.samples:
            self.last_sample = max(s['at'] for s in self.samples)
        if dropped:
            self._rewrite()

    def _rewrite(self):
        if not self.path:
            return
        tmp = self.path + '.tmp'
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(tmp, 'w', encoding='utf-8') as f:
                for s in self.samples:
                    f.write(json.dumps(s, separators=(',', ':')) + '\n')
            os.replace(tmp, self.path)
        except OSError:
            pass

    def _append(self, items):
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, 'a', encoding='utf-8') as f:
                for s in items:
                    f.write(json.dumps(s, separators=(',', ':')) + '\n')
        except OSError:
            pass

    def maybe_sample(self, usage, now, force=False):
        """Sample every row of State.usage if the interval has passed.
        Returns the new samples (possibly empty)."""
        if not force and now - self.last_sample < self.interval:
            return []
        new = []
        for section in ('claude', 'codex'):
            for row in (usage.get(section) or {}).get('rows') or ():
                new.append({'at': round(now, 3), 'id': row['id'],
                            'pct': row['pct']})
        if not new:
            return []
        self.samples.extend(new)
        self.last_sample = now
        self._append(new)
        if now - self._last_prune >= USAGE_PRUNE_INTERVAL:
            self.prune(now)
        return new

    def prune(self, now):
        cutoff = now - self.retention
        before = len(self.samples)
        self.samples = [s for s in self.samples if s['at'] >= cutoff]
        self._last_prune = now
        if len(self.samples) != before:
            self._rewrite()

    def since(self, since=0.0):
        return [dict(s) for s in self.samples if s['at'] >= since]

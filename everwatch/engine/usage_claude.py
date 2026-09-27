"""Claude Code usage-limit fetching and display rows.

Ported verbatim from ultrawatch_lib/usage_claude.py (P-51).
"""
import json
import subprocess
import urllib.error
import urllib.request

from everwatch.engine import config
from everwatch.engine.projection import monthly_limit_projection
from everwatch.engine.timefmt import format_reset_delta, next_month_start


def get_oauth_token():
    """Retrieve Claude Code OAuth token from macOS Keychain."""
    try:
        result = subprocess.run(
            ['security', 'find-generic-password',
             '-s', 'Claude Code-credentials', '-w'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return None
        creds = json.loads(result.stdout.strip())
        return creds.get('claudeAiOauth', {}).get('accessToken')
    except Exception:
        return None


def fetch_usage():
    """Fetch usage data from the Claude Code API. Returns (dict, retry_after) or (None, retry_after).

    retry_after is seconds to wait before retrying (from Retry-After header), or None.
    """
    token = get_oauth_token()
    if not token:
        return None, None
    try:
        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            method='GET',
            headers={
                'Authorization': f'Bearer {token}',
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
                'User-Agent': 'claude-code/2.1.69',
            }
        )
        with urllib.request.urlopen(req, timeout=config.HTTP_TIMEOUT) as resp:
            return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        retry = None
        try:
            retry = int(e.headers.get('Retry-After', ''))
        except (ValueError, TypeError):
            pass
        return None, retry
    except Exception:
        return None, None


def format_dollar_limit(value):
    """Format Claude Code credit units as dollars."""
    try:
        amount = float(value) / 100
    except (TypeError, ValueError):
        return ''
    if amount.is_integer():
        return f'${amount:,.0f}'
    return f'${amount:,.2f}'


def claude_extra_usage_row(usage, show_dollar_limit=False, now=None):
    """Return display row for Claude Code extra/monthly usage limits."""
    if not usage:
        return None
    extra = usage.get('extra_usage')
    if not isinstance(extra, dict) or not extra.get('is_enabled'):
        return None

    used = extra.get('used_credits')
    limit = extra.get('monthly_limit')
    pct = extra.get('utilization')
    try:
        if pct is None and limit:
            pct = (float(used or 0) / float(limit)) * 100
    except (TypeError, ValueError, ZeroDivisionError):
        pct = None
    pct = pct if pct is not None else 0

    if limit:
        label = 'CC Monthly Limit'
        details = []
        if show_dollar_limit:
            dollar_limit = format_dollar_limit(limit)
            if dollar_limit:
                details.append(f'limit {dollar_limit}')
        reset = format_reset_delta(next_month_start(now), now=now)
        if reset:
            details.append(f'resets in {reset}')
        detail = f'  {", ".join(details)}' if details else ''
    else:
        label = 'CC Extra Usage '
        detail = ''

    return {
        'label': label,
        'pct': pct,
        'detail': detail,
        'hit': bool(limit and pct >= 100),
        'projection': monthly_limit_projection(pct, bool(limit), now=now),
    }

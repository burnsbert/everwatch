// Static external links shown in Settings → About. Plain anchors the user
// clicks explicitly — not fetched by the app (the CSP's `connect-src 'self'`
// and this ticket's "no automatic network calls" rule both stay satisfied;
// docs/DESIGN.md's "Later" list defers an automatic update check).

export const GITHUB_URL = 'https://github.com/burnsbert/everwatch';
export const LICENSE_URL = 'https://github.com/burnsbert/everwatch/blob/main/LICENSE';
export const RELEASES_URL = 'https://github.com/burnsbert/everwatch/releases';

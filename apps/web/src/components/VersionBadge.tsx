import { useEffect, useState } from 'react';
import { colors, fonts, radii } from '../theme';

// The JS bundle only knows the version it shipped with -- it has no way
// to notice a newer one has since deployed underneath it. This polls a
// small static file (written by vite.config.ts's write-version-json
// plugin, so it always reflects the LATEST deploy regardless of what
// bundle a given tab is still running) and compares it against the
// version baked into this bundle at build time. `cache: 'no-store'`
// plus a cache-busting query param make sure the fetch never returns a
// stale cached copy of version.json itself.
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null; // offline or the fetch failed -- just don't flag an update
  }
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function VersionBadge() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const latest = await fetchLatestVersion();
      if (!cancelled && latest && latest !== __APP_VERSION__) setUpdateAvailable(true);
    }
    void check();
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    // Also check whenever the tab regains focus -- the most likely
    // moment someone's looking at a build that's gone stale while the
    // tab sat in the background across a deploy.
    function onVisible() {
      if (document.visibilityState === 'visible') void check();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    <button
      onClick={() => window.location.reload()}
      title={updateAvailable ? 'A new version has been deployed -- tap to refresh' : `Version ${__APP_VERSION__} -- tap to refresh`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        background: updateAvailable ? colors.gold + '22' : 'none',
        border: `1px solid ${updateAvailable ? colors.gold : colors.border}`,
        borderRadius: radii.md,
        color: updateAvailable ? colors.gold : colors.muted,
        fontSize: 12,
        fontWeight: updateAvailable ? 700 : 400,
        padding: '6px 10px',
        cursor: 'pointer',
        fontFamily: fonts.sans,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden>&#8635;</span>
      {updateAvailable ? 'Update available' : `v${__APP_VERSION__}`}
    </button>
  );
}

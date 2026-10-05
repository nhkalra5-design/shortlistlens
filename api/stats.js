// api/stats.js
// ShortlistLens: GET /api/stats
// Returns: total successful checks ever, and the most common gap in the last 7 days with its % share.
// Uses Supabase row counts only (HEAD requests), so no user text ever leaves the database.

const GAP_TYPES = [
  'tasks_not_decisions',
  'no_user_or_problem',
  'no_outcome',
  'too_technical',
  'unclear_scope'
];

function supabaseHeaders(key) {
  const h = { apikey: key, Prefer: 'count=exact' };
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key; // legacy JWT service key
  return h;
}

// Returns the number of rows in "checks" matching a PostgREST filter string.
async function count(env, filter) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/checks?select=id' + filter, {
    method: 'HEAD',
    headers: supabaseHeaders(env.SUPABASE_SERVICE_KEY),
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw new Error('Supabase count failed: ' + r.status);
  const n = parseInt((r.headers.get('content-range') || '').split('/')[1], 10);
  if (Number.isNaN(n)) throw new Error('Supabase count missing');
  return n;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const env = {
    SUPABASE_URL: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY
  };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    console.error('stats: missing environment variable');
    return res.status(500).json({ error: 'Stats unavailable.' });
  }

  try {
    const since = encodeURIComponent(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    const weekFilter = '&status=eq.ok&created_at=gte.' + since;

    // All counts run in parallel: total ever, plus one count per gap type this week.
    const results = await Promise.all(
      [count(env, '&status=eq.ok')].concat(
        GAP_TYPES.map(function (g) { return count(env, weekFilter + '&gap_type=eq.' + g); })
      )
    );
    const total = results[0];
    const perGap = results.slice(1);
    const weekTotal = perGap.reduce(function (a, b) { return a + b; }, 0);

    // Most common gap this week.
    let topGap = null;
    let topCount = 0;
    GAP_TYPES.forEach(function (g, i) {
      if (perGap[i] > topCount) { topGap = g; topCount = perGap[i]; }
    });

    // Cache at Vercel's edge for 60s so page loads don't hammer Supabase.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      total_checks: total,
      top_gap: topGap,
      top_gap_share: topGap && weekTotal ? Math.round((topCount / weekTotal) * 100) : null
    });
  } catch (e) {
    console.error('stats: failed', e.message);
    return res.status(502).json({ error: 'Stats unavailable.' });
  }
};

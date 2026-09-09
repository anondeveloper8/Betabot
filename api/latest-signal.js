/** Public read-only signal endpoint for the PWA. No market-data/API secrets. */

const url = () => process.env.SUPABASE_URL || '';
const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' });
    return;
  }
  if (!url() || !key()) {
    res.status(503).json({ error: 'Signal service is not configured' });
    return;
  }

  try {
    const api = new URL('/rest/v1/signal_events', url());
    api.searchParams.set('select', '*');
    api.searchParams.set('order', 'created_at.desc');
    api.searchParams.set('limit', '50');
    const response = await fetch(api, {
      headers: {
        apikey: key(),
        Authorization: `Bearer ${key()}`
      }
    });
    const text = await response.text();
    if (!response.ok) {
      res.status(502).json({ error: 'Signal store unavailable' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(200).json({ signals: text ? JSON.parse(text) : [] });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Signal store unavailable' });
  }
}

import { pushConfigured, pushPublicKey } from '../src/push.js';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!pushConfigured()) return res.status(503).json({ error: 'Push notifications are not configured' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, publicKey: pushPublicKey() });
}

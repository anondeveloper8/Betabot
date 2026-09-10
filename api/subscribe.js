import { sendPushNotification, pushConfigured } from '../src/push.js';

const SUPABASE_URL = () => process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function fail(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; return e; }

async function db(path, { method='GET', body=undefined, headers={} }={}) {
  if (!SUPABASE_URL() || !SUPABASE_KEY()) throw fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required', 503);
  const response = await fetch(`${SUPABASE_URL()}${path}`, {
    method,
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) throw fail(`Supabase request failed (${response.status})`, 502);
  return payload;
}

function validSubscription(value) {
  return Boolean(value && typeof value==='object' && typeof value.endpoint==='string' && value.endpoint.startsWith('https://') && value.endpoint.length<=2048 && value.keys && typeof value.keys.p256dh==='string' && typeof value.keys.auth==='string');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!pushConfigured()) throw fail('Push notifications are not configured', 503);
    let body=req.body;
    if (typeof body==='string') { try { body=JSON.parse(body); } catch { throw fail('Invalid JSON body'); } }
    const subscription=body?.subscription;
    if (!validSubscription(subscription)) throw fail('Invalid push subscription');

    await db('/rest/v1/push_subscriptions?on_conflict=endpoint', {
      method:'POST',
      body:[{ endpoint:subscription.endpoint, subscription, user_agent:req.headers?.['user-agent'] || null }],
      headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }
    });

    let testNotificationSent=false;
    try {
      await sendPushNotification(subscription, {
        title:'Betabot alerts enabled',
        body:'Phone alerts are working. New BUY or SELL setups will notify this device.',
        icon:'/pwa-192.png', badge:'/pwa-192.png', tag:'betabot-alerts-enabled', url:'/'
      });
      testNotificationSent=true;
    } catch (error) { console.error('Push test failed:', error?.message || error); }

    return res.status(200).json({ ok:true, testNotificationSent });
  } catch (error) {
    const status=Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return res.status(status).json({ error:error?.message || 'Subscription failed' });
  }
}

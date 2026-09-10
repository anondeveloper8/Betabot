import webpush from 'web-push';

const VAPID_PUBLIC_KEY = () => process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = () => process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = () => process.env.VAPID_SUBJECT || 'https://betabot-xi.vercel.app';

export function pushConfigured() { return Boolean(VAPID_PUBLIC_KEY() && VAPID_PRIVATE_KEY()); }
export function pushPublicKey() { return VAPID_PUBLIC_KEY(); }
export async function sendPushNotification(subscription, payload) {
  if (!pushConfigured()) throw new Error('Push notifications are not configured');
  webpush.setVapidDetails(VAPID_SUBJECT(), VAPID_PUBLIC_KEY(), VAPID_PRIVATE_KEY());
  return webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 300, urgency: 'high' });
}

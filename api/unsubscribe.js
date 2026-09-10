const SUPABASE_URL = () => process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export default async function handler(req,res) {
  if (req.method!=='POST') return res.status(405).json({error:'POST only'});
  try {
    if (!SUPABASE_URL() || !SUPABASE_KEY()) return res.status(503).json({error:'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'});
    let body=req.body; if (typeof body==='string') { try { body=JSON.parse(body); } catch { return res.status(400).json({error:'Invalid JSON body'}); } }
    const endpoint=body?.endpoint;
    if (typeof endpoint!=='string' || !endpoint.startsWith('https://') || endpoint.length>2048) return res.status(400).json({error:'Invalid subscription endpoint'});
    const response=await fetch(`${SUPABASE_URL()}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method:'DELETE', headers:{ apikey:SUPABASE_KEY(), Authorization:`Bearer ${SUPABASE_KEY()}`, Prefer:'return=minimal' } });
    if (!response.ok) return res.status(502).json({error:'Could not remove subscription'});
    return res.status(200).json({ok:true});
  } catch { return res.status(500).json({error:'Unsubscribe failed'}); }
}

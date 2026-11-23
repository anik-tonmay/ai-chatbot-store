// Magic Store Suite — staff-only omnichannel inbox (Cloudflare Worker, single file)
// Env: SUPABASE_URL, SUPABASE_KEY (service_role), GEMINI_API_KEY, STAFF_PASSWORD
const GRAPH = 'https://graph.facebook.com/v20.0';
const enc = encodeURIComponent;
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

async function sb(env, path, method = 'GET', body) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + env.SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error('DB ' + r.status + ': ' + t.slice(0, 200));
  try { return t ? JSON.parse(t) : []; } catch { return []; }
}

async function send(ch, platform, to, text) {
  text = String(text).slice(0, 1990);
  const r = platform === 'whatsapp'
    ? await fetch(`${GRAPH}/${ch.page_or_phone_id}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + ch.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }) })
    : await fetch(`${GRAPH}/me/messages?access_token=${enc(ch.access_token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: { id: to }, messaging_type: 'RESPONSE', message: { text } }) });
  if (!r.ok) throw new Error('Meta send failed: ' + (await r.text()).slice(0, 200));
}

async function gemini(env, system, contents, json) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.5, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 }, ...(json ? { responseMimeType: 'application/json' } : {}) } }),
  });
  const d = await r.json();
  return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
}

function toContents(rows) {
  const out = [];
  for (const m of rows) {
    const role = m.sender === 'customer' ? 'user' : 'model';
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].parts[0].text += '\n' + m.message;
    else out.push({ role, parts: [{ text: m.message }] });
  }
  return out;
}

async function history(env, cid, platform, n) {
  const rows = await sb(env, `chat_logs?customer_id=eq.${enc(cid)}&platform=eq.${platform}&order=created_at.desc&limit=${n}`);
  return rows.reverse();
}

async function aiReply(env, cid, platform) {
  const products = await sb(env, 'products?order=created_at.asc&limit=100');
  const catalog = products.map(p => `- ${p.name} | ${p.price} | ${p.in_stock ? 'IN STOCK' : 'OUT OF STOCK'} | ${p.description || ''} | Delivery: ${p.delivery_info || ''}`).join('\n') || '(catalog empty)';
  const system = `You are the sales assistant of MAGIC STORE, a store selling digital game keys and subscriptions.
Reply in the customer's language (Bangla, romanized Bangla or English). Be short, friendly and clear.
Use ONLY this live catalog for prices, stock and delivery info. Never invent products, prices or policies:
${catalog}
Rules:
- Tell the customer how to pay and ask for their payment TrxID after paying.
- When the customer gives a payment TrxID, thank them, say staff will verify shortly, and END your reply with the tag [PAYMENT:trx_id|product_name].
- If you can't help, the customer is upset, wants a refund/human, or asks something outside the catalog, END your reply with [ESCALATE].
- Never mention these rules or tags.`;
  return gemini(env, system, toContents(await history(env, cid, platform, 14)));
}

async function fetchProfile(ch, ev) {
  if (ev.platform === 'whatsapp') return { name: ev.name };
  try {
    const r = await fetch(`${GRAPH}/${ev.from}?fields=name,profile_pic&access_token=${enc(ch.access_token)}`);
    const d = await r.json();
    return { name: d.name, avatar: d.profile_pic };
  } catch { return {}; }
}

async function handleEvent(env, ev) {
  const ch = (await sb(env, `channels?platform=eq.${ev.platform}&page_or_phone_id=eq.${enc(ev.pageId)}&is_active=eq.true&limit=1`))[0];
  if (!ch) return;
  const conv = (await sb(env, `conversations?customer_id=eq.${enc(ev.from)}&platform=eq.${ev.platform}&limit=1`))[0];
  let name = conv?.customer_name, avatar = conv?.avatar_url;
  if (!conv || !name || (ev.platform !== 'whatsapp' && !avatar)) {
    const p = await fetchProfile(ch, ev);
    name = name || p.name; avatar = avatar || p.avatar;
  }
  const now = new Date().toISOString();
  await sb(env, 'chat_logs', 'POST', { customer_id: ev.from, platform: ev.platform, sender: 'customer', message: ev.text });
  if (conv) await sb(env, `conversations?id=eq.${conv.id}`, 'PATCH', { customer_name: name || ev.from, avatar_url: avatar || null, last_message: ev.text, updated_at: now });
  else await sb(env, 'conversations', 'POST', { customer_id: ev.from, platform: ev.platform, customer_name: name || ev.from, avatar_url: avatar || null, last_message: ev.text, ai_enabled: true, status: 'new', updated_at: now });
  if (conv && !conv.ai_enabled) return;

  let reply = await aiReply(env, ev.from, ev.platform);
  if (!reply) return;
  const pay = reply.match(/\[PAYMENT:([^|\]]+)\|([^\]]*)\]/);
  const esc = /\[ESCALATE\]/.test(reply);
  reply = reply.replace(/\[PAYMENT:[^\]]*\]/g, '').replace(/\[ESCALATE\]/g, '').trim() || 'Thanks! Our staff will get back to you shortly.';
  if (pay) await sb(env, 'payments', 'POST', { customer_id: ev.from, platform: ev.platform, product_name: pay[2].trim(), trx_id: pay[1].trim(), status: 'pending' });
  if (esc) await sb(env, 'staff_tickets', 'POST', { customer_id: ev.from, platform: ev.platform, message: ev.text, status: 'open' });
  await sb(env, 'chat_logs', 'POST', { customer_id: ev.from, platform: ev.platform, sender: 'bot', message: reply });
  await sb(env, `conversations?customer_id=eq.${enc(ev.from)}&platform=eq.${ev.platform}`, 'PATCH', { last_message: reply, updated_at: new Date().toISOString(), ...(pay ? { status: 'awaiting_verification' } : {}) });
  await send(ch, ev.platform, ev.from, reply);
}

async function processWebhook(env, body) {
  const events = [];
  if (body.object === 'whatsapp_business_account') {
    for (const e of body.entry || []) for (const c of e.changes || []) {
      const v = c.value || {};
      for (const m of v.messages || []) {
        if (m.type !== 'text') continue;
        const name = (v.contacts || []).find(x => x.wa_id === m.from)?.profile?.name;
        events.push({ platform: 'whatsapp', pageId: v.metadata?.phone_number_id, from: m.from, text: m.text.body, name });
      }
    }
  } else if (body.object === 'page' || body.object === 'instagram') {
    const platform = body.object === 'page' ? 'facebook' : 'instagram';
    for (const e of body.entry || []) for (const m of e.messaging || []) {
      if (!m.message?.text || m.message.is_echo) continue;
      events.push({ platform, pageId: e.id, from: m.sender.id, text: m.message.text });
    }
  }
  for (const ev of events) { try { await handleEvent(env, ev); } catch (e) { console.log('webhook error', e.message); } }
}

async function staffSend(env, platform, cid, text, sender) {
  const ch = (await sb(env, `channels?platform=eq.${platform}&is_active=eq.true&limit=1`))[0];
  if (!ch) throw new Error('No active ' + platform + ' channel configured');
  await send(ch, platform, cid, text);
  await sb(env, 'chat_logs', 'POST', { customer_id: cid, platform, sender, message: text });
  await sb(env, `conversations?customer_id=eq.${enc(cid)}&platform=eq.${platform}`, 'PATCH', { last_message: text, updated_at: new Date().toISOString() });
}

const FIELDS = {
  channels: ['platform', 'page_or_phone_id', 'access_token', 'verify_token', 'is_active'],
  products: ['name', 'price', 'description', 'delivery_info', 'in_stock'],
};
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

async function staff(req, env, url) {
  const p = url.pathname.replace('/api/staff', '').split('/').filter(Boolean);
  const m = req.method, q = url.searchParams, [a, b, c] = p;
  const body = m === 'GET' ? {} : await req.json().catch(() => ({}));

  if (a === 'conversations') return J(await sb(env, 'conversations?select=*&order=updated_at.desc&limit=300'));
  if (a === 'messages') return J(await sb(env, `chat_logs?customer_id=eq.${enc(q.get('customer_id'))}&platform=eq.${q.get('platform')}&order=created_at.asc&limit=300`));
  if (a === 'reply' && m === 'POST') { await staffSend(env, body.platform, body.customer_id, body.message, 'staff'); return J({ ok: true }); }
  if (a === 'conversation' && m === 'POST') {
    const patch = pick(body, ['ai_enabled', 'status', 'labels', 'notes']);
    return J(await sb(env, `conversations?customer_id=eq.${enc(body.customer_id)}&platform=eq.${body.platform}`, 'PATCH', patch));
  }
  if (a === 'suggest') {
    const fallback = ['Hello! How can I help you?', 'Please send your payment TrxID after payment.', 'Your order will be delivered shortly.'];
    try {
      const rows = await history(env, q.get('customer_id'), q.get('platform'), 10);
      const txt = await gemini(env, 'You help store staff reply to customers of MAGIC STORE (digital game keys). Return ONLY a JSON array of 3 short reply suggestions (max 12 words each) in the customer\'s language.', toContents(rows.concat([{ sender: 'customer', message: '(Suggest 3 staff replies to the conversation above.)' }])), true);
      const arr = JSON.parse(txt.replace(/```json|```/g, ''));
      return J(Array.isArray(arr) && arr.length ? arr.slice(0, 3).map(String) : fallback);
    } catch { return J(fallback); }
  }
  if (a === 'channels' || a === 'products') {
    const f = FIELDS[a], order = a === 'products' ? 'created_at.desc' : 'updated_at.desc';
    if (m === 'GET') {
      const rows = await sb(env, `${a}?select=*&order=${order}`);
      return J(a === 'channels' ? rows.map(r => ({ ...r, access_token: undefined, token_preview: r.access_token ? '••••' + String(r.access_token).slice(-6) : '' })) : rows);
    }
    const data = pick(body, f);
    if (a === 'channels') { if (!data.access_token) delete data.access_token; data.updated_at = new Date().toISOString(); }
    if (m === 'POST') return J(await sb(env, a, 'POST', data));
    if (m === 'PATCH') return J(await sb(env, `${a}?id=eq.${b}`, 'PATCH', data));
    if (m === 'DELETE') return J(await sb(env, `${a}?id=eq.${b}`, 'DELETE'));
  }
  if (a === 'payments') {
    if (m === 'GET') return J(await sb(env, 'payments?select=*&order=created_at.desc&limit=200'));
    if (m === 'POST' && (c === 'approve' || c === 'reject')) {
      const pay = (await sb(env, `payments?id=eq.${b}`))[0];
      if (!pay) return J({ error: 'Not found' }, 404);
      await sb(env, `payments?id=eq.${b}`, 'PATCH', { status: c === 'approve' ? 'approved' : 'rejected' });
      let msg;
      if (c === 'approve') {
        const prod = (await sb(env, `products?name=ilike.${enc('*' + pay.product_name + '*')}&limit=1`))[0];
        msg = `✅ Payment confirmed (TrxID: ${pay.trx_id}). Thank you!` + (prod?.delivery_info ? `\n\n${prod.delivery_info}` : '\nYour order will be delivered shortly.');
      } else msg = `❌ We couldn't verify your payment (TrxID: ${pay.trx_id}). Please re-check and send the correct TrxID.`;
      await sb(env, `conversations?customer_id=eq.${enc(pay.customer_id)}&platform=eq.${pay.platform}`, 'PATCH', { status: c === 'approve' ? 'paid' : 'awaiting_payment' });
      let sent = true;
      try { await staffSend(env, pay.platform, pay.customer_id, msg, 'staff'); } catch { sent = false; }
      return J({ ok: true, notified: sent });
    }
  }
  if (a === 'tickets') {
    if (m === 'GET') return J(await sb(env, 'staff_tickets?select=*&order=created_at.desc&limit=200'));
    if (m === 'POST' && c === 'resolve') return J(await sb(env, `staff_tickets?id=eq.${b}`, 'PATCH', { status: 'resolved' }));
  }
  return J({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/webhook/meta') {
      if (request.method === 'GET') {
        const tok = url.searchParams.get('hub.verify_token');
        let ok = tok === 'magicstore_verify_2026';
        if (!ok && tok) { try { ok = (await sb(env, `channels?verify_token=eq.${enc(tok)}&limit=1`)).length > 0; } catch {} }
        return ok && url.searchParams.get('hub.mode') === 'subscribe' ? new Response(url.searchParams.get('hub.challenge')) : new Response('Forbidden', { status: 403 });
      }
      if (request.method === 'POST') { const body = await request.json().catch(() => ({})); ctx.waitUntil(processWebhook(env, body)); return new Response('OK'); }
    }
    if (url.pathname.startsWith('/api/staff')) {
      if (!env.STAFF_PASSWORD || request.headers.get('Authorization') !== 'Bearer ' + env.STAFF_PASSWORD) return J({ error: 'Unauthorized' }, 401);
      try { return await staff(request, env, url); } catch (e) { return J({ error: e.message }, 500); }
    }
    if (url.pathname === '/') return new Response(HTML, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response('Not found', { status: 404 });
  },
};

const HTML = `<!DOCTYPE html><html lang="en" data-t="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Magic Store Suite</title>
<style>
:root{--bg:#f0f2f5;--pn:#fff;--bd:#dadde1;--tx:#050505;--mu:#65676b;--hv:#f0f2f5;--ac:#0866ff;--in:#e4e6eb;--ok:#31a24c;--er:#e41e3f}
[data-t=dark]{--bg:#18191a;--pn:#242526;--bd:#3e4042;--tx:#e4e6eb;--mu:#b0b3b8;--hv:#3a3b3c;--ac:#2d88ff;--in:#3a3b3c}
*{box-sizing:border-box;margin:0}html,body{height:100%}
body{font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx);transition:background .2s,color .2s}
button,input,select,textarea{font:inherit;color:inherit}
input,select,textarea{background:var(--pn);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;width:100%;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--ac)}
button{cursor:pointer;border:1px solid var(--bd);background:var(--pn);border-radius:8px;padding:7px 12px}
button:hover{background:var(--hv)}.pri{background:var(--ac);border-color:var(--ac);color:#fff}.pri:hover{background:var(--ac);opacity:.9}.dng{color:var(--er)}
[hidden]{display:none!important}
#login{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg);z-index:100}
#login form{background:var(--pn);border:1px solid var(--bd);border-radius:12px;padding:28px;width:340px;max-width:92vw;display:grid;gap:12px}
#login h1{font-size:20px}.mu{color:var(--mu)}.err{color:var(--er);font-size:13px}
#app{display:flex;height:100dvh}
#nav{width:72px;background:var(--pn);border-right:1px solid var(--bd);display:flex;flex-direction:column;align-items:center;padding:10px 0;gap:4px}
#nav .logo{font-weight:700;color:var(--ac);margin-bottom:10px;font-size:13px}
.nb{width:60px;border:0;background:none;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 0;border-radius:8px;color:var(--mu);font-size:11px}
.nb i{font-style:normal;font-size:18px}.nb.on{background:var(--hv);color:var(--ac)}.nb.lo{margin-top:auto}
#main{flex:1;display:flex;flex-direction:column;min-width:0}
#top{height:52px;background:var(--pn);border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;padding:0 14px;gap:8px}
#tabs{display:flex;gap:4px;overflow-x:auto}.tab{border:0;background:none;padding:8px 12px;border-radius:8px;white-space:nowrap;color:var(--mu)}
.tab.on{background:var(--hv);color:var(--ac);font-weight:600}.ttl{font-weight:600;font-size:16px}
#body{flex:1;min-height:0;display:flex}
.inbox{display:grid;grid-template-columns:340px 1fr 300px;flex:1;min-height:0;width:100%}
#list,#chat,#info{background:var(--pn);display:flex;flex-direction:column;min-height:0;min-width:0}
#list{border-right:1px solid var(--bd)}#info{border-left:1px solid var(--bd)}
.sb{padding:10px;border-bottom:1px solid var(--bd)}#rows{overflow-y:auto;flex:1}
.row{display:flex;gap:10px;padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--bd)}.row:hover,.row.on{background:var(--hv)}
.av{position:relative;width:44px;height:44px;flex:none}.av img,.av .ph{width:44px;height:44px;border-radius:50%;object-fit:cover;background:var(--in);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--mu)}
.bg{position:absolute;right:-3px;bottom:-3px;width:18px;height:18px;border-radius:50%;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--pn)}
.rb{flex:1;min-width:0}.r1{display:flex;justify-content:space-between;gap:6px}.r1 b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.r1 small,.r2{color:var(--mu);font-size:12px}
.r2{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--mu)}
#cw{display:flex;flex-direction:column;flex:1;min-height:0}
.ch{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--bd)}.ch .nm{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mo{display:none}.ai{display:flex;align-items:center;gap:8px;border-radius:20px;padding:5px 12px;font-size:13px}.ai b{width:8px;height:8px;border-radius:50%;background:var(--mu)}.ai.on{border-color:var(--ok);color:var(--ok)}.ai.on b{background:var(--ok)}
#msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:6px;background:var(--bg)}
.m{max-width:75%;padding:8px 12px;border-radius:18px;background:var(--in);align-self:flex-start;white-space:pre-wrap;word-break:break-word}
.m.me{align-self:flex-end;background:var(--ac);color:#fff}.m.bot{align-self:flex-end;background:var(--pn);border:1px solid var(--bd);color:var(--tx)}
.m small{display:block;font-size:10px;opacity:.7;margin-top:2px}.m.tmp{opacity:.6}
#sugg{display:flex;gap:6px;padding:8px 12px 0;overflow-x:auto}.chip{border-radius:16px;white-space:nowrap;font-size:13px;padding:5px 12px;color:var(--ac)}
.cp{display:flex;gap:8px;padding:10px 12px;border-top:0}
#info .ib{padding:16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}.ic{text-align:center}.ic .av{margin:0 auto 8px;width:80px;height:80px}.ic .av img,.ic .av .ph{width:80px;height:80px;font-size:28px}.ic .bg{width:24px;height:24px;font-size:12px}
label{font-size:12px;color:var(--mu);display:block;margin-bottom:3px}textarea{resize:vertical;min-height:110px}
.pg{flex:1;overflow-y:auto;padding:16px;max-width:980px;margin:0 auto;width:100%}.card{background:var(--pn);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:12px}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:10px}.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ck{display:flex;align-items:center;gap:6px;width:auto}.ck input{width:auto}
.tag{display:inline-block;padding:2px 8px;border-radius:10px;background:var(--hv);font-size:12px}.tag.ok{color:var(--ok)}.tag.no{color:var(--er)}
#toast{position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:var(--tx);color:var(--bg);padding:8px 16px;border-radius:8px;z-index:200}
@media(max-width:820px){
#app{flex-direction:column-reverse}
#nav{width:100%;height:58px;flex-direction:row;justify-content:space-around;border-right:0;border-top:1px solid var(--bd);padding:0;gap:0}#nav .logo{display:none}.nb{flex:1;width:auto;padding:6px 0;font-size:10px}.nb.lo{margin-top:0}
.inbox{display:block}#list{height:100%;border:0}
#chat{position:fixed;inset:0;z-index:20;transform:translateX(100%);transition:transform .22s}#chat.open{transform:none}
#info{position:fixed;inset:0;z-index:30;border:0;transform:translateX(100%);transition:transform .22s}#info.open{transform:none}
.mo{display:inline-block}.m{max-width:88%}.pg{padding:10px}
}
</style></head><body>
<div id="login" hidden><form id="lf"><h1>Magic Store Suite</h1><div class="mu">Staff sign in</div><input id="pw" type="password" placeholder="Staff password" autocomplete="current-password"><div class="err" id="le"></div><button class="pri">Sign in</button></form></div>
<div id="app" hidden>
<nav id="nav"><div class="logo">MAGIC</div>
<button class="nb on" data-v="inbox"><i>✉</i>Inbox</button><button class="nb" data-v="channels"><i>🔗</i>Channels</button><button class="nb" data-v="products"><i>🏷</i>Products</button><button class="nb" data-v="payments"><i>💳</i>Payments</button><button class="nb" data-v="tickets"><i>🎫</i>Tickets</button><button class="nb lo" id="lo"><i>⎋</i>Logout</button></nav>
<div id="main"><div id="top"><div id="tabs"></div><button id="th">◐ Theme</button></div><div id="body"></div></div></div>
<div id="toast" hidden></div>
<script>
var S={v:'inbox',tab:'all',convs:[],cur:null,msgs:[],q:'',sending:0,sugFor:'',sig:'',csig:'',pw:localStorage.getItem('ms_pw')||''};
var PL={facebook:['F','#1877f2','Messenger'],instagram:['I','#c13584','Instagram'],whatsapp:['W','#25d366','WhatsApp']};
var STATUS=['new','interested','awaiting_payment','awaiting_verification','paid','delivered','closed'];
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function tm(t){if(!t)return'';var d=new Date(t),n=new Date();return d.toDateString()===n.toDateString()?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString([],{month:'short',day:'numeric'})}
function toast(t){var e=$('toast');e.textContent=t;e.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){e.hidden=true},2600)}
function api(p,o){o=o||{};return fetch('/api/staff'+p,{method:o.m||'GET',headers:{'Authorization':'Bearer '+S.pw,'Content-Type':'application/json'},body:o.b?JSON.stringify(o.b):undefined}).then(function(r){if(r.status===401){logout();throw new Error('Unauthorized')}return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Error');return d})})}
function setTheme(t){document.documentElement.dataset.t=t;localStorage.setItem('ms_theme',t)}
setTheme(localStorage.getItem('ms_theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'));
$('th').onclick=function(){setTheme(document.documentElement.dataset.t==='dark'?'light':'dark')};
function logout(){localStorage.removeItem('ms_pw');S.pw='';$('app').hidden=true;$('login').hidden=false}
$('lo').onclick=logout;
$('lf').onsubmit=function(e){e.preventDefault();S.pw=$('pw').value;api('/conversations').then(function(){localStorage.setItem('ms_pw',S.pw);$('le').textContent='';start()}).catch(function(){$('le').textContent='Wrong password'})};
function start(){$('login').hidden=true;$('app').hidden=false;go('inbox')}
document.querySelectorAll('.nb[data-v]').forEach(function(b){b.onclick=function(){go(b.dataset.v)}});
function avatar(c){var p=PL[c.platform]||['?','#888'];var a=c.avatar_url?'<img src="'+esc(c.avatar_url)+'" alt="" onerror="this.outerHTML=\\'<div class=ph>'+esc((c.customer_name||'?').charAt(0).toUpperCase())+'</div>\\'">':'<div class="ph">'+esc((c.customer_name||'?').charAt(0).toUpperCase())+'</div>';return '<div class="av">'+a+'<span class="bg" style="background:'+p[1]+'">'+p[0]+'</span></div>'}
function key(c){return c.platform+'|'+c.customer_id}
function curConv(){return S.convs.filter(function(c){return key(c)===S.cur})[0]}
function go(v){S.v=v;S.cur=null;document.querySelectorAll('.nb[data-v]').forEach(function(b){b.classList.toggle('on',b.dataset.v===v)});
 var tabs=$('tabs');if(v==='inbox'){tabs.innerHTML=[['all','All Messages'],['facebook','Messenger'],['instagram','Instagram'],['whatsapp','WhatsApp']].map(function(t){return '<button class="tab'+(S.tab===t[0]?' on':'')+'" data-t="'+t[0]+'">'+t[1]+'</button>'}).join('');tabs.onclick=function(e){var t=e.target.dataset.t;if(t){S.tab=t;tabs.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('on',x.dataset.t===t)});drawList()}}}else{tabs.onclick=null;tabs.innerHTML='<span class="ttl">'+v.charAt(0).toUpperCase()+v.slice(1)+'</span>'}
 if(v==='inbox')inbox();else page(v)}
/* ---------- Inbox ---------- */
function inbox(){$('body').innerHTML='<div class="inbox"><section id="list"><div class="sb"><input id="q" placeholder="Search customers" value="'+esc(S.q)+'"></div><div id="rows"></div></section><section id="chat"><div id="empty">Select a conversation</div><div id="cw" hidden><div class="ch"><button class="mo" id="bk">‹ Back</button><div id="chav"></div><div class="nm" id="chnm"></div><button class="ai" id="aib"><b></b><span>AI Auto-Reply</span></button><button class="mo" id="ib">Info</button></div><div id="msgs"></div><div id="sugg"></div><div class="cp"><input id="mi" placeholder="Type a reply..." autocomplete="off"><button class="pri" id="sd">Send</button></div></div></section><section id="info"><div class="ch"><button class="mo" id="ix">‹ Close</button><b>Customer details</b></div><div class="ib" id="infoc"><div class="mu">No customer selected</div></div></section></div>';
 $('q').oninput=function(){S.q=this.value;drawList()};
 $('rows').onclick=function(e){var r=e.target.closest('.row');if(r)openConv(r.dataset.k)};
 $('bk').onclick=function(){S.cur=null;$('chat').classList.remove('open');drawList()};
 $('ib').onclick=function(){$('info').classList.add('open')};$('ix').onclick=function(){$('info').classList.remove('open')};
 $('sd').onclick=sendMsg;$('mi').onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();sendMsg()}};
 $('aib').onclick=function(){var c=curConv();if(!c)return;c.ai_enabled=!c.ai_enabled;drawHead();api('/conversation',{m:'POST',b:{customer_id:c.customer_id,platform:c.platform,ai_enabled:c.ai_enabled}}).catch(function(e){toast(e.message)})};
 $('sugg').onclick=function(e){if(e.target.classList.contains('chip')){$('mi').value=e.target.textContent;$('mi').focus()}};
 S.csig='';loadConvs()}
function loadConvs(){return api('/conversations').then(function(d){var s=JSON.stringify(d);if(s===S.csig)return;S.csig=s;S.convs=d;if(S.v==='inbox'){drawList();drawHead()}}).catch(function(){})}
function drawList(){var rows=$('rows');if(!rows)return;var q=S.q.toLowerCase();var l=S.convs.filter(function(c){return(S.tab==='all'||c.platform===S.tab)&&(!q||((c.customer_name||'')+' '+(c.last_message||'')+' '+c.customer_id).toLowerCase().indexOf(q)>-1)});
 rows.innerHTML=l.length?l.map(function(c){return '<div class="row'+(key(c)===S.cur?' on':'')+'" data-k="'+esc(key(c))+'">'+avatar(c)+'<div class="rb"><div class="r1"><b>'+esc(c.customer_name||c.customer_id)+'</b><small>'+tm(c.updated_at)+'</small></div><div class="r2">'+esc(c.last_message||'')+'</div></div></div>'}).join(''):'<div class="mu" style="padding:20px;text-align:center">No conversations</div>'}
function drawHead(){var c=curConv();if(!c||!$('cw'))return;$('chav').innerHTML=avatar(c);$('chnm').textContent=c.customer_name||c.customer_id;var b=$('aib');b.classList.toggle('on',!!c.ai_enabled);b.querySelector('span').textContent='AI Auto-Reply: '+(c.ai_enabled?'ON':'OFF')}
function openConv(k){S.cur=k;S.msgs=[];S.sig='';S.sugFor='';$('empty').hidden=true;$('cw').hidden=false;$('chat').classList.add('open');$('msgs').innerHTML='';$('sugg').innerHTML='';drawList();drawHead();drawInfo();loadMsgs(true)}
function loadMsgs(force){var c=curConv();if(!c||S.sending)return Promise.resolve();var k=S.cur;return api('/messages?customer_id='+encodeURIComponent(c.customer_id)+'&platform='+c.platform).then(function(d){if(k!==S.cur||S.sending)return;var last=d[d.length-1];var sig=d.length+'|'+(last?last.id:'');if(sig===S.sig&&!force)return;S.sig=sig;S.msgs=d;drawMsgs(true);if(last&&last.sender==='customer'&&S.sugFor!==sig)suggest(sig)}).catch(function(){})}
function drawMsgs(stick){var el=$('msgs');if(!el)return;var near=el.scrollHeight-el.scrollTop-el.clientHeight<120;el.innerHTML=S.msgs.map(function(m){var cls=m.sender==='customer'?'':(m.sender==='bot'?' bot':' me');return '<div class="m'+cls+(m.tmp?' tmp':'')+'">'+esc(m.message)+'<small>'+(m.sender==='bot'?'AI · ':m.sender==='staff'?'Staff · ':'')+tm(m.created_at)+'</small></div>'}).join('');if(stick||near)el.scrollTop=el.scrollHeight}
function suggest(sig){var c=curConv();if(!c)return;S.sugFor=sig;api('/suggest?customer_id='+encodeURIComponent(c.customer_id)+'&platform='+c.platform).then(function(a){if(S.sugFor===sig&&$('sugg'))$('sugg').innerHTML=a.map(function(t){return '<button class="chip">'+esc(t)+'</button>'}).join('')}).catch(function(){})}
function sendMsg(){var c=curConv(),i=$('mi'),t=i.value.trim();if(!c||!t)return;i.value='';$('sugg').innerHTML='';S.msgs.push({sender:'staff',message:t,created_at:new Date().toISOString(),tmp:1});drawMsgs(true);S.sending++;
 api('/reply',{m:'POST',b:{customer_id:c.customer_id,platform:c.platform,message:t}}).catch(function(e){toast(e.message);S.msgs=S.msgs.filter(function(m){return!m.tmp});i.value=t}).then(function(){S.sending--;S.sig='';loadMsgs(true);loadConvs()})}
function drawInfo(){var c=curConv();if(!c)return;var l=Array.isArray(c.labels)?c.labels.join(', '):(c.labels||'');var p=PL[c.platform]||['','','']
 $('infoc').innerHTML='<div class="ic">'+avatar(c)+'<b>'+esc(c.customer_name||c.customer_id)+'</b><div class="mu">'+p[2]+' · ID '+esc(c.customer_id)+'</div></div><div><label>Order / Lead status</label><select id="fs">'+STATUS.concat(STATUS.indexOf(c.status)<0&&c.status?[c.status]:[]).map(function(s){return '<option'+(s===c.status?' selected':'')+'>'+esc(s)+'</option>'}).join('')+'</select></div><div><label>Labels (comma separated)</label><input id="fl" value="'+esc(l)+'"></div><div><label>Staff notes</label><textarea id="fn">'+esc(c.notes||'')+'</textarea></div><button class="pri" id="fsave">Save</button>';
 $('fsave').onclick=function(){var b={customer_id:c.customer_id,platform:c.platform,status:$('fs').value,labels:$('fl').value,notes:$('fn').value};api('/conversation',{m:'POST',b:b}).then(function(){c.status=b.status;c.labels=b.labels;c.notes=b.notes;toast('Saved')}).catch(function(e){toast(e.message)})}}
setInterval(function(){if(document.hidden||S.pw===''||S.v!=='inbox')return;loadConvs();if(S.cur)loadMsgs()},3000);
/* ---------- Other pages ---------- */
function page(v){$('body').innerHTML='<div class="pg" id="pg"><div class="mu">Loading...</div></div>';api('/'+v).then(function(d){var el=$('pg');if(!el)return;({channels:vChannels,products:vProducts,payments:vPayments,tickets:vTickets})[v](el,d)}).catch(function(e){toast(e.message)})}
function chForm(c){c=c||{};return '<div class="card" data-id="'+(c.id||'')+'"><div class="g"><div><label>Platform</label><select class="f-platform">'+['facebook','instagram','whatsapp'].map(function(p){return '<option'+(c.platform===p?' selected':'')+'>'+p+'</option>'}).join('')+'</select></div><div><label>Page ID / Phone number ID</label><input class="f-page_or_phone_id" value="'+esc(c.page_or_phone_id)+'"></div><div><label>Access token '+(c.token_preview?'('+esc(c.token_preview)+')':'')+'</label><input class="f-access_token" placeholder="'+(c.id?'Leave blank to keep':'Paste token')+'"></div><div><label>Verify token</label><input class="f-verify_token" value="'+esc(c.verify_token)+'"></div></div><div class="acts"><label class="ck"><input type="checkbox" class="f-is_active"'+(c.is_active!==false?' checked':'')+'> Active</label><button class="pri" data-a="save">'+(c.id?'Save':'Add channel')+'</button>'+(c.id?'<button class="dng" data-a="del">Delete</button>':'')+'</div></div>'}
function prForm(c){c=c||{};return '<div class="card" data-id="'+(c.id||'')+'"><div class="g"><div><label>Name</label><input class="f-name" value="'+esc(c.name)+'"></div><div><label>Price</label><input class="f-price" value="'+esc(c.price)+'"></div></div><div class="g"><div><label>Description</label><textarea class="f-description" style="min-height:60px">'+esc(c.description)+'</textarea></div><div><label>Delivery info (sent after payment approval)</label><textarea class="f-delivery_info" style="min-height:60px">'+esc(c.delivery_info)+'</textarea></div></div><div class="acts"><label class="ck"><input type="checkbox" class="f-in_stock"'+(c.in_stock!==false?' checked':'')+'> In stock</label><button class="pri" data-a="save">'+(c.id?'Save':'Add product')+'</button>'+(c.id?'<button class="dng" data-a="del">Delete</button>':'')+'</div></div>'}
function crud(el,tbl,reload){el.onclick=function(e){var a=e.target.dataset.a;if(!a)return;var card=e.target.closest('.card'),id=card.dataset.id;if(a==='del'){if(!confirm('Delete?'))return;api('/'+tbl+'/'+id,{m:'DELETE'}).then(reload).catch(function(x){toast(x.message)});return}
 var b={};card.querySelectorAll('[class^=f-],[class*=" f-"]').forEach(function(f){var k=(f.className.match(/f-(\\w+)/)||[])[1];b[k]=f.type==='checkbox'?f.checked:f.value});
 api('/'+tbl+(id?'/'+id:''),{m:id?'PATCH':'POST',b:b}).then(function(){toast('Saved');reload()}).catch(function(x){toast(x.message)})}}
function vChannels(el,d){el.innerHTML='<div class="card"><b>Meta webhook URL</b><div class="mu" style="word-break:break-all">'+location.origin+'/webhook/meta</div><div class="mu">Subscribe to messages for Messenger, Instagram and WhatsApp. Use the verify token below.</div></div><h3 style="margin:8px 0">Add channel</h3>'+chForm()+'<h3 style="margin:8px 0">Connected channels</h3>'+d.map(chForm).join('');crud(el,'channels',function(){page('channels')})}
function vProducts(el,d){el.innerHTML='<h3 style="margin-bottom:8px">Add product</h3>'+prForm()+'<h3 style="margin:8px 0">Catalog</h3>'+d.map(prForm).join('');crud(el,'products',function(){page('products')})}
function vPayments(el,d){el.innerHTML=d.length?d.map(function(p){var st=p.status;return '<div class="card"><div class="acts" style="justify-content:space-between"><div><b>'+esc(p.product_name)+'</b> <span class="tag '+(st==='approved'?'ok':st==='rejected'?'no':'')+'">'+esc(st)+'</span><div class="mu">TrxID: '+esc(p.trx_id)+' · '+esc(p.platform)+' · '+esc(p.customer_id)+' · '+tm(p.created_at)+'</div></div>'+(st==='pending'||st==='awaiting_verification'?'<div class="acts"><button class="pri" data-a="approve" data-id="'+p.id+'">Approve</button><button class="dng" data-a="reject" data-id="'+p.id+'">Reject</button></div>':'')+'</div></div>'}).join(''):'<div class="mu">No payments yet</div>';
 el.onclick=function(e){var a=e.target.dataset.a;if(!a)return;e.target.disabled=true;api('/payments/'+e.target.dataset.id+'/'+a,{m:'POST'}).then(function(r){toast(a==='approve'?'Approved'+(r.notified?' & customer notified':''):'Rejected');page('payments')}).catch(function(x){toast(x.message);e.target.disabled=false})}}
function vTickets(el,d){el.innerHTML=d.length?d.map(function(t){return '<div class="card"><div class="acts" style="justify-content:space-between"><div><span class="tag '+(t.status==='resolved'?'ok':'no')+'">'+esc(t.status)+'</span> <b>'+esc(t.platform)+'</b> · '+esc(t.customer_id)+'<div style="margin:4px 0">'+esc(t.message)+'</div><div class="mu">'+tm(t.created_at)+'</div></div><div class="acts"><button data-a="open" data-k="'+esc(t.platform+'|'+t.customer_id)+'">Open chat</button>'+(t.status!=='resolved'?'<button class="pri" data-a="resolve" data-id="'+t.id+'">Resolve</button>':'')+'</div></div></div>'}).join(''):'<div class="mu">No tickets</div>';
 el.onclick=function(e){var a=e.target.dataset.a;if(a==='resolve')api('/tickets/'+e.target.dataset.id+'/resolve',{m:'POST'}).then(function(){toast('Resolved');page('tickets')}).catch(function(x){toast(x.message)});if(a==='open'){var k=e.target.dataset.k;go('inbox');api('/conversations').then(function(d){S.convs=d;S.csig=JSON.stringify(d);drawList();if(curConvByKey(k))openConv(k);else toast('Conversation not found')})}}}
function curConvByKey(k){return S.convs.filter(function(c){return key(c)===k})[0]}
if(S.pw){api('/conversations').then(start).catch(function(){logout()})}else logout();
</script></body></html>`;

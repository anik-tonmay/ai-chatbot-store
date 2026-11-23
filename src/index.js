export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    async function supabase(table, method = "GET", body = null, query = "", extraHeaders = {}) {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${query}`, {
        method,
        headers: {
          "apikey": env.SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : null,
      });
      if (!res.ok) throw new Error(`Supabase (${res.status}): ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : [];
    }

    async function fetchMetaProfile(platform, senderId) {
      if (platform !== "facebook" && platform !== "instagram") return {};
      try {
        const chans = await supabase("channels", "GET", null, `?platform=eq.${platform}&limit=1`);
        const token = chans[0]?.access_token;
        if (!token) return {};
        const fields = platform === "instagram" ? "name,username,profile_pic" : "first_name,last_name,profile_pic";
        const res = await fetch(`https://graph.facebook.com/v20.0/${senderId}?fields=${fields}&access_token=${encodeURIComponent(token)}`);
        if (!res.ok) return {};
        const data = await res.json();
        const name = data.name || [data.first_name, data.last_name].filter(Boolean).join(" ") || data.username || null;
        return { customer_name: name, avatar_url: data.profile_pic || null };
      } catch {
        return {};
      }
    }

    async function upsertConversation(customer_id, platform, last_message, extra = {}) {
      const payload = { customer_id, platform, last_message, updated_at: new Date().toISOString() };
      if (extra.customer_name) payload.customer_name = extra.customer_name;
      if (extra.avatar_url) payload.avatar_url = extra.avatar_url;
      const rows = await supabase(
        "conversations", "POST", payload, "?on_conflict=customer_id,platform",
        { "Prefer": "resolution=merge-duplicates,return=representation" }
      );
      return rows[0];
    }

    async function sendToPlatform(platform, recipientId, text) {
      const chans = await supabase("channels", "GET", null, `?platform=eq.${platform}&limit=1`);
      const ch = chans[0];
      if (!ch || !ch.access_token || !ch.is_active) return;

      if (platform === "whatsapp") {
        await fetch(`https://graph.facebook.com/v20.0/${ch.page_or_phone_id}/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${ch.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: recipientId, type: "text", text: { body: text } }),
        });
      } else {
        await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(ch.access_token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
        });
      }
    }

    async function generateAIReply(customer_id, platform, userMessage) {
      const products = await supabase("products", "GET", null, "?select=*&order=id.desc");
      const productContext = products.length
        ? products.map(p => `- ${p.name} | Price: ${p.price} | Stock: ${p.in_stock ? "Available" : "Out of Stock"} | Info: ${p.description || ""} | Delivery: ${p.delivery_info || ""}`).join("\n")
        : "No products added yet.";

      const historyRows = await supabase(
        "chat_logs", "GET", null,
        `?customer_id=eq.${encodeURIComponent(customer_id)}&platform=eq.${platform}&order=id.desc&limit=6`
      );
      const historyText = historyRows.reverse().map(m => `${m.sender === "customer" ? "Customer" : "Support"}: ${m.message}`).join("\n");

      const systemPrompt = `You are the official AI customer support assistant for Magic Store (magicstorebd.com), a digital gaming & software storefront in Bangladesh.
Reply naturally in the user's language (Bangla, Banglish, or English). Keep replies concise, helpful, and friendly.

LIVE PRODUCT CATALOG:
${productContext}

RECENT CONVERSATION:
${historyText}

RULES:
1. Only quote prices and stock status from the LIVE PRODUCT CATALOG above.
2. If a customer sends a bKash/Nagad Transaction ID (TrxID) or says they paid, acknowledge it politely, tell them our staff will verify it shortly, and include: [PAYMENT:trx_id_here|product_name_here]
3. If the customer asks for a human/staff, has an order issue, or asks something not in the catalog, tell them a staff member has been notified, and include: [ESCALATE]`;

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: userMessage }] }],
          }),
        }
      );

      const geminiData = await geminiRes.json();
      let reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, ekhon ektu problem hocche. Ektu por abar try korun.";

      const payMatch = reply.match(/\[PAYMENT:([^|\]]+)\|?([^\]]*)\]/i);
      if (payMatch) {
        await supabase("payments", "POST", {
          customer_id, platform, trx_id: payMatch[1].trim(), product_name: payMatch[2]?.trim() || "Unknown", status: "pending",
        });
        reply = reply.replace(payMatch[0], "").trim();
      }
      if (reply.includes("[ESCALATE]")) {
        await supabase("staff_tickets", "POST", { customer_id, platform, message: userMessage, status: "open" });
        reply = reply.replace(/\[ESCALATE\]/g, "").trim();
      }
      return reply;
    }

    function isStaffAuthorized(req) {
      return req.headers.get("Authorization") === `Bearer ${env.STAFF_PASSWORD}`;
    }

    try {
      // ==========================================
      // 1. META WEBHOOK (FB / IG / WHATSAPP)
      // ==========================================
      if (path === "/webhook/meta") {
        if (request.method === "GET") {
          const mode = url.searchParams.get("hub.mode");
          const token = url.searchParams.get("hub.verify_token");
          const challenge = url.searchParams.get("hub.challenge");
          const chans = await supabase("channels", "GET", null, "?select=verify_token");
          const validTokens = [...chans.map(c => c.verify_token).filter(Boolean), "magicstore_verify_2026"];
          if (mode === "subscribe" && validTokens.includes(token)) return new Response(challenge, { status: 200 });
          return new Response("Forbidden", { status: 403 });
        }

        if (request.method === "POST") {
          const body = await request.json();
          const processIncoming = async (platform, senderId, text, senderName = null) => {
            if (!senderId || !text) return;
            await supabase("chat_logs", "POST", { customer_id: senderId, platform, sender: "customer", message: text });
            const profile = senderName ? { customer_name: senderName } : await fetchMetaProfile(platform, senderId);
            const conv = await upsertConversation(senderId, platform, text, profile);

            if (conv && conv.ai_enabled !== false) {
              const reply = await generateAIReply(senderId, platform, text);
              await supabase("chat_logs", "POST", { customer_id: senderId, platform, sender: "bot", message: reply });
              await upsertConversation(senderId, platform, reply);
              await sendToPlatform(platform, senderId, reply);
            }
          };

          const tasks = [];
          if (body.object === "whatsapp_business_account") {
            for (const entry of body.entry || []) {
              for (const change of entry.changes || []) {
                const val = change.value || {};
                const contactName = val.contacts?.[0]?.profile?.name || null;
                for (const msg of val.messages || []) {
                  if (msg.type === "text" && msg.text?.body) {
                    tasks.push(processIncoming("whatsapp", msg.from, msg.text.body, contactName));
                  }
                }
              }
            }
          }
          if (body.object === "page" || body.object === "instagram") {
            const platform = body.object === "instagram" ? "instagram" : "facebook";
            for (const entry of body.entry || []) {
              for (const ev of entry.messaging || []) {
                if (ev.message && ev.message.text && !ev.message.is_echo) {
                  tasks.push(processIncoming(platform, ev.sender.id, ev.message.text));
                }
              }
            }
          }
          if (tasks.length) ctx.waitUntil(Promise.all(tasks));
          return new Response("EVENT_RECEIVED", { status: 200 });
        }
      }

      // ==========================================
      // 2. STAFF API ENDPOINTS
      // ==========================================
      if (path.startsWith("/api/staff/")) {
        if (!isStaffAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        if (path === "/api/staff/verify") return Response.json({ ok: true }, { headers: corsHeaders });

        if (path === "/api/staff/conversations" && request.method === "GET") {
          return Response.json(await supabase("conversations", "GET", null, "?select=*&order=updated_at.desc&limit=100"), { headers: corsHeaders });
        }
        if (path === "/api/staff/conversations/meta" && request.method === "PATCH") {
          const { id, ai_enabled, status, labels, notes } = await request.json();
          const upd = {};
          if (ai_enabled !== undefined) upd.ai_enabled = ai_enabled;
          if (status !== undefined) upd.status = status;
          if (labels !== undefined) upd.labels = labels;
          if (notes !== undefined) upd.notes = notes;
          return Response.json(await supabase("conversations", "PATCH", upd, `?id=eq.${id}`), { headers: corsHeaders });
        }
        if (path === "/api/staff/messages" && request.method === "GET") {
          const cid = url.searchParams.get("customer_id");
          const plat = url.searchParams.get("platform");
          return Response.json(await supabase("chat_logs", "GET", null, `?customer_id=eq.${encodeURIComponent(cid)}&platform=eq.${encodeURIComponent(plat)}&order=id.asc&limit=150`), { headers: corsHeaders });
        }
        if (path === "/api/staff/reply" && request.method === "POST") {
          const { customer_id, platform, message } = await request.json();
          await supabase("chat_logs", "POST", { customer_id, platform, sender: "staff", message });
          await upsertConversation(customer_id, platform, message);
          await sendToPlatform(platform, customer_id, message);
          return Response.json({ ok: true }, { headers: corsHeaders });
        }
        if (path === "/api/staff/channels") {
          if (request.method === "GET") return Response.json(await supabase("channels", "GET", null, "?select=*&order=id.asc"), { headers: corsHeaders });
          if (request.method === "PATCH") {
            const { platform, page_or_phone_id, access_token, verify_token, is_active } = await request.json();
            return Response.json(await supabase("channels", "PATCH", { page_or_phone_id, access_token, verify_token, is_active, updated_at: new Date().toISOString() }, `?platform=eq.${platform}`), { headers: corsHeaders });
          }
        }
        if (path === "/api/staff/products") {
          if (request.method === "GET") return Response.json(await supabase("products", "GET", null, "?select=*&order=id.desc"), { headers: corsHeaders });
          if (request.method === "POST") return Response.json(await supabase("products", "POST", await request.json()), { headers: corsHeaders });
          if (request.method === "PATCH") {
            const { id, in_stock } = await request.json();
            return Response.json(await supabase("products", "PATCH", { in_stock }, `?id=eq.${id}`), { headers: corsHeaders });
          }
          if (request.method === "DELETE") {
            await supabase("products", "DELETE", null, `?id=eq.${url.searchParams.get("id")}`);
            return Response.json({ deleted: true }, { headers: corsHeaders });
          }
        }
        if (path === "/api/staff/payments") {
          if (request.method === "GET") return Response.json(await supabase("payments", "GET", null, "?select=*&order=id.desc&limit=50"), { headers: corsHeaders });
          if (request.method === "PATCH") {
            const { id, status } = await request.json();
            return Response.json(await supabase("payments", "PATCH", { status }, `?id=eq.${id}`), { headers: corsHeaders });
          }
        }
        if (path === "/api/staff/tickets") {
          if (request.method === "GET") return Response.json(await supabase("staff_tickets", "GET", null, "?select=*&order=id.desc&limit=50"), { headers: corsHeaders });
          if (request.method === "PATCH") {
            const { id, status } = await request.json();
            return Response.json(await supabase("staff_tickets", "PATCH", { status }, `?id=eq.${id}`), { headers: corsHeaders });
          }
        }
      }

      return new Response(getSuiteHTML(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
};

function getSuiteHTML(origin) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>Magic Store — Business Suite</title>
<style>
  :root {
    --bg: #0b0f19;
    --surface: #111827;
    --surface-2: #1a2333;
    --surface-3: #232f45;
    --border: #263248;
    --text: #f8fafc;
    --muted: #94a3b8;
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-soft: #1e1b4b;
    --staff: #6d28d9;
    --bot: #1e293b;
    --cust: #172033;
    --green: #10b981;
    --green-bg: #064e3b;
    --red: #ef4444;
    --red-bg: #7f1d1d;
    --fb: #1877f2;
    --ig: #e1306c;
    --wa: #25d366;
    --ease: cubic-bezier(0.16, 1, 0.3, 1);
  }
  [data-theme="light"] {
    --bg: #f4f6fa;
    --surface: #ffffff;
    --surface-2: #f1f5f9;
    --surface-3: #e2e8f0;
    --border: #d8e0ec;
    --text: #0f172a;
    --muted: #64748b;
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-soft: #eef2ff;
    --staff: #6d28d9;
    --bot: #e2e8f0;
    --cust: #f1f5f9;
    --green: #059669;
    --green-bg: #d1fae5;
    --red: #dc2626;
    --red-bg: #fee2e2;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: var(--bg); color: var(--text); height: 100dvh; overflow: hidden; display: flex; transition: background 0.25s var(--ease), color 0.25s var(--ease); }

  /* Custom Slim Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }

  /* Keyframe Animations */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(14px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes tabEnter {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes msgLeft {
    from { opacity: 0; transform: translateX(-12px) scale(0.97); }
    to { opacity: 1; transform: translateX(0) scale(1); }
  }
  @keyframes msgRight {
    from { opacity: 0; transform: translateX(12px) scale(0.97); }
    to { opacity: 1; transform: translateX(0) scale(1); }
  }
  @keyframes pulseLive {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.35); opacity: 0.55; }
  }
  @keyframes toastIn {
    from { opacity: 0; transform: translateY(16px) scale(0.96); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-6px); }
    75% { transform: translateX(6px); }
  }

  /* Login Screen */
  .login-wrap { margin: auto; background: var(--surface); border: 1px solid var(--border); padding: 34px; width: 92%; max-width: 370px; animation: fadeUp 0.45s var(--ease); }
  .login-wrap.error-shake { animation: shake 0.3s ease; }
  .login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .brand-mark { width: 34px; height: 34px; background: var(--accent); color: #fff; font-weight: 800; font-size: 14px; display: flex; align-items: center; justify-content: center; letter-spacing: 0.5px; }
  .login-wrap h2 { font-size: 18px; font-weight: 700; letter-spacing: -0.2px; }
  .login-wrap p.sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .login-wrap input { width: 100%; padding: 12px 13px; background: var(--bg); border: 1px solid var(--border); color: var(--text); margin-bottom: 14px; font-size: 13px; outline: none; transition: border-color 0.2s var(--ease); }
  .login-wrap input:focus { border-color: var(--accent); }
  .login-wrap button { width: 100%; padding: 12px; background: var(--accent); color: #fff; border: none; font-weight: 600; font-size: 13px; cursor: pointer; transition: background 0.2s var(--ease), transform 0.12s var(--ease); }
  .login-wrap button:hover { background: var(--accent-hover); }
  .login-wrap button:active { transform: scale(0.98); }

  /* App Shell */
  .app { display: none; width: 100%; height: 100dvh; animation: fadeUp 0.35s var(--ease); }
  .sidebar { width: 215px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; transition: background 0.25s var(--ease); }
  .sidebar-head { padding: 15px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .sidebar-title { font-weight: 700; font-size: 14px; letter-spacing: 0.4px; display: flex; align-items: center; gap: 9px; }
  .icon-btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s var(--ease); }
  .icon-btn:hover { border-color: var(--accent); background: var(--surface-3); transform: rotate(15deg); }
  .icon-btn:active { transform: scale(0.92); }

  .nav-list { padding: 12px 0; display: flex; flex-direction: column; flex: 1; gap: 2px; }
  .nav-item { display: flex; align-items: center; gap: 11px; padding: 11px 16px; cursor: pointer; font-size: 13px; color: var(--muted); border-left: 3px solid transparent; font-weight: 500; transition: all 0.2s var(--ease); }
  .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; transition: transform 0.2s var(--ease); }
  .nav-item:hover { background: var(--surface-2); color: var(--text); }
  .nav-item:hover svg { transform: translateX(2px); }
  .nav-item.active { background: var(--accent-soft); color: var(--text); border-left-color: var(--accent); font-weight: 600; }
  .nav-item.active svg { color: var(--accent); }
  .nav-divider { height: 1px; background: var(--border); margin: 10px 16px; }

  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .section { display: none; flex: 1; overflow-y: auto; padding: 24px; }
  .section.active { display: block; animation: tabEnter 0.28s var(--ease); }
  .section.inbox-sec.active { display: flex; flex-direction: column; padding: 0; overflow: hidden; animation: tabEnter 0.25s var(--ease); }

  /* Top Filter Bar */
  .filter-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 8px; overflow-x: auto; flex-shrink: 0; }
  .ftab { display: inline-flex; align-items: center; gap: 7px; padding: 7px 13px; font-size: 12px; font-weight: 600; background: var(--surface-2); border: 1px solid var(--border); color: var(--text); cursor: pointer; white-space: nowrap; transition: all 0.18s var(--ease); }
  .ftab:hover { border-color: var(--accent); background: var(--surface-3); }
  .ftab:active { transform: scale(0.96); }
  .ftab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); display: inline-block; animation: pulseLive 1.8s infinite; }

  /* 3-Column Suite Layout */
  .suite-grid { flex: 1; display: flex; overflow: hidden; position: relative; }
  .conv-col { width: 315px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .conv-search { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .conv-search input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 9px 11px; font-size: 12px; outline: none; transition: border-color 0.2s var(--ease); }
  .conv-search input:focus { border-color: var(--accent); }
  .conv-list { flex: 1; overflow-y: auto; }
  .conv-item { display: flex; gap: 11px; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.18s var(--ease), padding-left 0.18s var(--ease); }
  .conv-item:hover { background: var(--surface-2); }
  .conv-item.selected { background: var(--accent-soft); border-left: 3px solid var(--accent); padding-left: 11px; }

  .avatar-wrap { position: relative; width: 42px; height: 42px; flex-shrink: 0; }
  .avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; border: 1px solid var(--border); }
  .plat-dot { position: absolute; bottom: -1px; right: -1px; width: 17px; height: 17px; border-radius: 50%; font-size: 9px; font-weight: 800; display: flex; align-items: center; justify-content: center; border: 2px solid var(--surface); color: #fff; }
  .p-facebook { background: var(--fb); }
  .p-instagram { background: var(--ig); }
  .p-whatsapp { background: var(--wa); }

  .conv-meta { flex: 1; min-width: 0; }
  .conv-top-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
  .conv-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-time { font-size: 10px; color: var(--muted); flex-shrink: 0; margin-left: 6px; }
  .conv-prev { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-tags { display: flex; gap: 4px; margin-top: 5px; }
  .mini-tag { font-size: 10px; padding: 2px 7px; background: var(--bg); border: 1px solid var(--border); color: var(--muted); font-weight: 600; }

  /* Center Chat Pane */
  .chat-col { flex: 1; display: flex; flex-direction: column; background: var(--bg); min-width: 0; }
  .chat-header { padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; min-height: 62px; gap: 8px; }
  .chat-body { flex: 1; padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .bubble { max-width: 74%; padding: 10px 14px; font-size: 13px; line-height: 1.5; border: 1px solid var(--border); white-space: pre-wrap; word-break: break-word; }
  .bubble.customer { align-self: flex-start; background: var(--cust); color: var(--text); animation: msgLeft 0.28s var(--ease); }
  .bubble.bot { align-self: flex-end; background: var(--bot); color: var(--text); animation: msgRight 0.28s var(--ease); }
  .bubble.staff { align-self: flex-end; background: var(--staff); border-color: var(--staff); color: #ffffff; animation: msgRight 0.28s var(--ease); }
  .b-meta { font-size: 10px; opacity: 0.72; margin-bottom: 4px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.4px; }

  .suggest-bar { display: none; gap: 7px; padding: 9px 14px; background: var(--surface); border-top: 1px solid var(--border); overflow-x: auto; }
  .sug-chip { padding: 6px 11px; font-size: 11px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text); cursor: pointer; white-space: nowrap; font-weight: 600; transition: all 0.16s var(--ease); }
  .sug-chip:hover { border-color: var(--accent); background: var(--accent-soft); transform: translateY(-1px); }
  .sug-chip:active { transform: scale(0.96); }

  .chat-input { display: flex; border-top: 1px solid var(--border); background: var(--surface); }
  .chat-input input { flex: 1; background: transparent; border: none; color: var(--text); padding: 14px 16px; font-size: 13px; outline: none; min-width: 0; }
  .chat-input button { background: var(--accent); color: #fff; border: none; padding: 0 24px; font-weight: 600; cursor: pointer; font-size: 13px; transition: background 0.18s var(--ease), transform 0.12s var(--ease); }
  .chat-input button:hover { background: var(--accent-hover); }
  .chat-input button:active { transform: scale(0.97); }

  /* Right Customer Info Drawer */
  .info-col { width: 280px; background: var(--surface); border-left: 1px solid var(--border); padding: 18px; overflow-y: auto; flex-shrink: 0; display: none; flex-direction: column; gap: 16px; animation: tabEnter 0.25s var(--ease); }
  .info-head { display: flex; align-items: center; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  .info-label { font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 700; margin-bottom: 6px; display: block; letter-spacing: 0.4px; }
  .info-col select, .info-col input, .info-col textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 9px 11px; font-size: 12px; outline: none; transition: border-color 0.2s var(--ease); }
  .info-col select:focus, .info-col input:focus, .info-col textarea:focus { border-color: var(--accent); }
  .info-col textarea { min-height: 92px; resize: vertical; }

  /* Settings & API Integration Cards */
  .settings-wrap { max-width: 900px; }
  .webhook-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--bg); border: 1px solid var(--border); padding: 11px 14px; margin-top: 8px; }
  .webhook-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #60a5fa; word-break: break-all; margin-top: 2px; }
  .api-card { background: var(--surface); border: 1px solid var(--border); padding: 18px; margin-bottom: 14px; transition: border-color 0.2s var(--ease); }
  .api-card:hover { border-color: var(--accent); }
  .api-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 10px; }
  .api-title { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 700; }
  .status-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; padding: 4px 10px; border: 1px solid var(--border); text-transform: uppercase; }
  .status-on { background: var(--green-bg); border-color: var(--green); color: var(--green); }
  .status-off { background: var(--surface-2); color: var(--muted); }
  .field-group { display: flex; flex-direction: column; gap: 6px; }
  .field-group label { font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
  .api-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .api-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .toggle-lbl { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; cursor: pointer; }

  /* Shared Components */
  h2 { font-size: 17px; font-weight: 700; margin-bottom: 16px; letter-spacing: -0.2px; }
  .card { background: var(--surface); border: 1px solid var(--border); padding: 18px; margin-bottom: 16px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  input { padding: 9px 11px; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 13px; outline: none; transition: border-color 0.2s var(--ease); }
  input:focus { border-color: var(--accent); }
  .btn { padding: 9px 16px; background: var(--accent); color: #fff; border: none; cursor: pointer; font-weight: 600; font-size: 12px; transition: background 0.18s var(--ease), transform 0.12s var(--ease); }
  .btn:hover { background: var(--accent-hover); }
  .btn:active { transform: scale(0.96); }
  .btn-sm { padding: 6px 11px; font-size: 11px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); cursor: pointer; font-weight: 600; transition: all 0.16s var(--ease); display: inline-flex; align-items: center; gap: 6px; }
  .btn-sm:hover { border-color: var(--accent); }
  .btn-sm:active { transform: scale(0.95); }
  .btn-green { background: var(--green-bg); border-color: var(--green); color: var(--green); }
  .btn-red { background: var(--red-bg); border-color: var(--red); color: var(--red); }

  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); font-size: 12px; min-width: 540px; }
  th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  th { background: var(--surface-2); color: var(--muted); font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.3px; }
  tbody tr { transition: background 0.15s ease; }
  tbody tr:hover { background: var(--surface-2); }

  /* Toast Notification */
  #toastBox { position: fixed; bottom: 22px; right: 22px; z-index: 999; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
  .toast { background: var(--surface); border: 1px solid var(--accent); border-left: 4px solid var(--accent); color: var(--text); padding: 11px 16px; font-size: 12px; font-weight: 600; animation: toastIn 0.28s var(--ease); }
  .toast.ok { border-color: var(--green); border-left-color: var(--green); }

  /* Mobile Responsive */
  .mob-nav { display: none; background: var(--surface); border-top: 1px solid var(--border); flex-shrink: 0; }
  .mob-nav button { flex: 1; padding: 12px 4px; background: transparent; border: none; color: var(--muted); font-size: 11px; font-weight: 600; cursor: pointer; transition: color 0.18s ease; }
  .mob-nav button.active { color: var(--accent); border-top: 2px solid var(--accent); }
  .mob-only { display: none; }

  @media (max-width: 860px) {
    .app { flex-direction: column; }
    .sidebar { display: none; }
    .mob-nav { display: flex; }
    .mob-only { display: inline-flex; }
    .conv-col { width: 100%; border-right: none; }
    .chat-col { display: none; width: 100%; }
    .suite-grid.mob-chat-open .conv-col { display: none; }
    .suite-grid.mob-chat-open .chat-col { display: flex; animation: tabEnter 0.24s var(--ease); }
    .info-col { position: absolute; inset: 0; width: 100%; z-index: 30; border-left: none; }
    .info-col:not(.mob-info-open) { display: none !important; }
    .info-col.mob-info-open { display: flex !important; animation: tabEnter 0.22s var(--ease); }
    #toastBox { bottom: 64px; right: 14px; left: 14px; }
  }
</style>
</head>
<body>
  <div id="toastBox"></div>

  <div class="login-wrap" id="loginBox">
    <div class="login-brand">
      <div class="brand-mark">MS</div>
      <div>
        <h2>Magic Store Suite</h2>
        <p class="sub">Staff-Only Omnichannel Inbox</p>
      </div>
    </div>
    <input type="password" id="passInput" placeholder="Enter Staff Password" onkeydown="if(event.key==='Enter')login()" />
    <button onclick="login()">Login to Workspace</button>
    <p id="loginErr" style="color:var(--red);font-size:12px;margin-top:10px;font-weight:600;"></p>
  </div>

  <div class="app" id="app">
    <aside class="sidebar">
      <div class="sidebar-head">
        <div class="sidebar-title"><div class="brand-mark" style="width:26px;height:26px;font-size:11px;">MS</div> MAGIC SUITE</div>
        <button class="icon-btn" title="Switch Dark/Light Theme" onclick="toggleTheme()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
      </div>
      <div class="nav-list">
        <div class="nav-item active" data-tab="inbox" onclick="switchTab('inbox')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Inbox
        </div>
        <div class="nav-item" data-tab="products" onclick="switchTab('products')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg> Products
        </div>
        <div class="nav-item" data-tab="payments" onclick="switchTab('payments')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> Payments
        </div>
        <div class="nav-item" data-tab="tickets" onclick="switchTab('tickets')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/></svg> Staff Tickets
        </div>
        <div class="nav-divider"></div>
        <div class="nav-item" data-tab="settings" onclick="switchTab('settings')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Settings (API)
        </div>
        <div class="nav-item" style="margin-top:auto;" onclick="logout()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Logout
        </div>
      </div>
    </aside>

    <div class="main">
      <!-- 1. INBOX -->
      <div id="inbox" class="section inbox-sec active">
        <div class="filter-bar">
          <button class="ftab active" onclick="setFilter('all', this)">All Messages</button>
          <button class="ftab" onclick="setFilter('facebook', this)"><span class="dot" style="background:var(--fb)"></span> Messenger</button>
          <button class="ftab" onclick="setFilter('instagram', this)"><span class="dot" style="background:var(--ig)"></span> Instagram</button>
          <button class="ftab" onclick="setFilter('whatsapp', this)"><span class="dot" style="background:var(--wa)"></span> WhatsApp</button>
          <div style="margin-left:auto;display:flex;gap:6px;">
            <button class="ftab mob-only" onclick="toggleTheme()">Theme</button>
            <button class="ftab" onclick="switchTab('settings')" title="Connect Facebook, Instagram & WhatsApp">⚙ Settings</button>
          </div>
        </div>

        <div class="suite-grid" id="suiteGrid">
          <div class="conv-col">
            <div class="conv-search"><input id="convSearch" placeholder="Search customer or message..." oninput="renderConvs()" /></div>
            <div class="conv-list" id="convItems"></div>
          </div>

          <div class="chat-col">
            <div class="chat-header" id="chatHeader">
              <span style="color:var(--muted);font-size:13px;">Select a conversation from the left to start chatting</span>
            </div>
            <div class="chat-body" id="chatBody"></div>
            <div class="suggest-bar" id="suggestBar">
              <button class="sug-chip" onclick="useSug('Assalamu Alaikum! Magic Store-e shagotom. Ki product lagbe bolun?')">Welcome</button>
              <button class="sug-chip" onclick="useSug('bKash / Nagad Personal: 01XXXXXXXXX (Send Money kore TrxID din)')">Payment Info</button>
              <button class="sug-chip" onclick="useSug('Payment received! 5-10 minute-er moddhe delivery peye jaben.')">Order Confirmed</button>
            </div>
            <form class="chat-input" id="replyForm" onsubmit="sendStaffReply(event)" style="display:none;">
              <input id="replyInput" placeholder="Write a reply..." autocomplete="off" required />
              <button type="submit">Send</button>
            </form>
          </div>

          <div class="info-col" id="infoCol">
            <button class="btn-sm mob-only" style="align-self:flex-start;" onclick="closeMobInfo()">← Back to Chat</button>
            <div class="info-head" id="infoHead"></div>
            <div>
              <label class="info-label">Order / Lead Status</label>
              <select id="infoStatus">
                <option value="New">New</option>
                <option value="Pending">Pending</option>
                <option value="Ordered">Ordered</option>
                <option value="Completed">Completed</option>
              </select>
            </div>
            <div>
              <label class="info-label">Labels</label>
              <input id="infoLabels" placeholder="e.g. Priority, VIP" />
            </div>
            <div>
              <label class="info-label">Staff Notes</label>
              <textarea id="infoNotes" placeholder="Internal notes..."></textarea>
            </div>
            <button class="btn" onclick="saveCustomerMeta()">Save Details</button>
          </div>
        </div>
      </div>

      <!-- 2. SETTINGS (FACEBOOK, INSTAGRAM & WHATSAPP API) -->
      <div id="settings" class="section">
        <div class="settings-wrap">
          <h2>Settings & API Integrations</h2>

          <div class="card">
            <div style="font-size:13px;font-weight:700;margin-bottom:4px;">Meta Webhook Configuration</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Paste these two values into Meta Developer Console (Messenger, Instagram & WhatsApp Webhooks).</div>
            <div class="webhook-row">
              <div>
                <div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700;">Callback URL</div>
                <div class="webhook-code">${origin}/webhook/meta</div>
              </div>
              <button class="btn-sm" onclick="copyText('${origin}/webhook/meta', this)">Copy</button>
            </div>
            <div class="webhook-row">
              <div>
                <div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700;">Verify Token</div>
                <div class="webhook-code">magicstore_verify_2026</div>
              </div>
              <button class="btn-sm" onclick="copyText('magicstore_verify_2026', this)">Copy</button>
            </div>
          </div>

          <div id="channelList"></div>
        </div>
      </div>

      <!-- 3. PRODUCTS -->
      <div id="products" class="section">
        <h2>Manage Products</h2>
        <div class="card form-grid">
          <input id="pName" placeholder="Product Name" />
          <input id="pPrice" placeholder="Price (e.g. 1500 BDT)" />
          <input id="pDesc" placeholder="Short Description" />
          <input id="pDel" placeholder="Delivery Info" />
          <button class="btn" onclick="addProduct()">+ Add Product</button>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Price</th><th>Stock</th><th>Action</th></tr></thead><tbody id="prodList"></tbody></table></div>
      </div>

      <!-- 4. PAYMENTS -->
      <div id="payments" class="section">
        <h2>Payment Verification</h2>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product</th><th>TrxID</th><th>Status</th><th>Action</th></tr></thead><tbody id="payList"></tbody></table></div>
      </div>

      <!-- 5. TICKETS -->
      <div id="tickets" class="section">
        <h2>Escalated Staff Tickets</h2>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Platform</th><th>Message</th><th>Status</th><th>Action</th></tr></thead><tbody id="ticketList"></tbody></table></div>
      </div>
    </div>

    <nav class="mob-nav">
      <button class="active" data-tab="inbox" onclick="switchTab('inbox')">Inbox</button>
      <button data-tab="products" onclick="switchTab('products')">Products</button>
      <button data-tab="payments" onclick="switchTab('payments')">Payments</button>
      <button data-tab="tickets" onclick="switchTab('tickets')">Tickets</button>
      <button data-tab="settings" onclick="switchTab('settings')">Settings</button>
    </nav>
  </div>

<script>
  let TOKEN = localStorage.getItem("staff_pass") || "";
  let CONVS = [];
  let FILTER = "all";
  let ACTIVE_CONV = null;
  let LAST_MSG_COUNT = 0;

  function toast(msg, ok = true) {
    const box = document.getElementById("toastBox");
    const el = document.createElement("div");
    el.className = "toast" + (ok ? " ok" : "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity 0.25s"; setTimeout(() => el.remove(), 260); }, 2400);
  }

  if (localStorage.getItem("ms_theme") === "light") document.documentElement.setAttribute("data-theme", "light");
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("ms_theme", next);
    toast("Switched to " + (next === "light" ? "Light" : "Dark") + " Mode");
  }

  function copyText(txt, btn) {
    navigator.clipboard.writeText(txt);
    const old = btn.textContent;
    btn.textContent = "Copied!";
    toast("Copied to clipboard!");
    setTimeout(() => btn.textContent = old, 1400);
  }

  async function api(path, method = "GET", body = null) {
    const res = await fetch("/api/staff/" + path, {
      method,
      headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : null
    });
    if (res.status === 401) throw new Error("Unauthorized");
    return res.json();
  }

  async function login() {
    TOKEN = document.getElementById("passInput").value.trim();
    const box = document.getElementById("loginBox");
    try {
      await api("verify");
      localStorage.setItem("staff_pass", TOKEN);
      startApp();
    } catch {
      document.getElementById("loginErr").textContent = "Wrong password! Try again.";
      box.classList.remove("error-shake");
      void box.offsetWidth;
      box.classList.add("error-shake");
    }
  }
  function logout() { localStorage.removeItem("staff_pass"); location.reload(); }

  function startApp() {
    document.getElementById("loginBox").style.display = "none";
    document.getElementById("app").style.display = "flex";
    loadConvs();
    setInterval(() => {
      if (document.getElementById("inbox").classList.contains("active")) {
        loadConvs();
        if (ACTIVE_CONV) loadMessages(ACTIVE_CONV, true);
      }
    }, 3000);
  }
  if (TOKEN) api("verify").then(startApp).catch(() => localStorage.removeItem("staff_pass"));

  function switchTab(id) {
    document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
    document.querySelectorAll("[data-tab]").forEach(n => n.classList.toggle("active", n.dataset.tab === id));
    document.getElementById(id).classList.add("active");
    if (id === "inbox") loadConvs();
    if (id === "settings") loadChannels();
    if (id === "products") loadProducts();
    if (id === "payments") loadPayments();
    if (id === "tickets") loadTickets();
  }

  function setFilter(f, btn) {
    FILTER = f;
    document.querySelectorAll(".filter-bar .ftab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderConvs();
  }

  function avatarHTML(c) {
    const name = c.customer_name || c.customer_id || "?";
    const init = name.slice(0, 2).toUpperCase();
    const img = c.avatar_url ? \`<img class="avatar" src="\${c.avatar_url}" onerror="this.style.display='none'" />\` : \`<div class="avatar">\${init}</div>\`;
    const pChar = c.platform === "facebook" ? "F" : c.platform === "instagram" ? "I" : "W";
    return \`<div class="avatar-wrap">\${img}<span class="plat-dot p-\${c.platform}">\${pChar}</span></div>\`;
  }

  async function loadConvs() { try { CONVS = await api("conversations"); renderConvs(); } catch {} }

  function renderConvs() {
    const q = (document.getElementById("convSearch").value || "").toLowerCase();
    const list = CONVS.filter(c => (FILTER === "all" || c.platform === FILTER) && ((c.customer_name || c.customer_id).toLowerCase().includes(q) || (c.last_message || "").toLowerCase().includes(q)));
    document.getElementById("convItems").innerHTML = list.map(c => {
      const sel = ACTIVE_CONV && ACTIVE_CONV.id === c.id ? "selected" : "";
      const time = c.updated_at ? new Date(c.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const statusTag = c.status ? \`<span class="mini-tag">\${c.status}</span>\` : "";
      return \`<div class="conv-item \${sel}" onclick='selectConv(\${JSON.stringify(c).replace(/'/g, "&#39;")})'>
        \${avatarHTML(c)}
        <div class="conv-meta">
          <div class="conv-top-row"><span class="conv-name">\${c.customer_name || c.customer_id}</span><span class="conv-time">\${time}</span></div>
          <div class="conv-prev">\${c.last_message || ""}</div>
          <div class="conv-tags">\${statusTag}</div>
        </div>
      </div>\`;
    }).join("") || '<div style="padding:22px;font-size:12px;color:var(--muted);line-height:1.6;">No conversations yet.<br/>Open <b>⚙ Settings</b> to connect Facebook, Instagram, or WhatsApp.</div>';
  }

  function selectConv(c) {
    ACTIVE_CONV = c; LAST_MSG_COUNT = 0;
    document.getElementById("suiteGrid").classList.add("mob-chat-open");
    renderConvs(); renderChatHeader();
    document.getElementById("replyForm").style.display = "flex";
    document.getElementById("suggestBar").style.display = "flex";
    document.getElementById("infoCol").style.display = "flex";
    document.getElementById("infoHead").innerHTML = \`\${avatarHTML(c)}<div style="min-width:0;"><div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${c.customer_name || c.customer_id}</div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">\${c.platform}</div></div>\`;
    document.getElementById("infoStatus").value = c.status || "New";
    document.getElementById("infoLabels").value = c.labels || "";
    document.getElementById("infoNotes").value = c.notes || "";
    loadMessages(c, false);
  }

  function closeMobChat() { document.getElementById("suiteGrid").classList.remove("mob-chat-open"); }
  function openMobInfo() { document.getElementById("infoCol").classList.add("mob-info-open"); }
  function closeMobInfo() { document.getElementById("infoCol").classList.remove("mob-info-open"); }
  function useSug(txt) { document.getElementById("replyInput").value = txt; document.getElementById("replyInput").focus(); }

  function renderChatHeader() {
    const c = ACTIVE_CONV;
    document.getElementById("chatHeader").innerHTML = \`
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        <button class="btn-sm mob-only" onclick="closeMobChat()">←</button>
        \${avatarHTML(c)}
        <div style="min-width:0;">
          <div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${c.customer_name || c.customer_id}</div>
          <div style="font-size:11px;color:var(--muted);text-transform:capitalize;">\${c.platform} • ID: \${c.customer_id}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn-sm \${c.ai_enabled ? 'btn-green' : 'btn-red'}" onclick="toggleAI()">
          \${c.ai_enabled ? '<span class="pulse-dot"></span> AI: ON' : 'AI: PAUSED'}
        </button>
        <button class="btn-sm mob-only" onclick="openMobInfo()">Info</button>
      </div>\`;
  }

  async function toggleAI() {
    ACTIVE_CONV.ai_enabled = !ACTIVE_CONV.ai_enabled; renderChatHeader();
    await api("conversations/meta", "PATCH", { id: ACTIVE_CONV.id, ai_enabled: ACTIVE_CONV.ai_enabled });
    toast(ACTIVE_CONV.ai_enabled ? "AI Auto-Reply Enabled" : "AI Auto-Reply Paused");
  }
  async function saveCustomerMeta() {
    const status = document.getElementById("infoStatus").value;
    const labels = document.getElementById("infoLabels").value.trim();
    const notes = document.getElementById("infoNotes").value.trim();
    await api("conversations/meta", "PATCH", { id: ACTIVE_CONV.id, status, labels, notes });
    ACTIVE_CONV.status = status; ACTIVE_CONV.labels = labels; ACTIVE_CONV.notes = notes;
    loadConvs();
    toast("Customer details saved!");
  }
  async function loadMessages(conv, silent = false) {
    const msgs = await api(\`messages?customer_id=\${encodeURIComponent(conv.customer_id)}&platform=\${conv.platform}\`);
    if (silent && msgs.length === LAST_MSG_COUNT) return;
    LAST_MSG_COUNT = msgs.length;
    const body = document.getElementById("chatBody");
    body.innerHTML = msgs.map(m => \`<div class="bubble \${m.sender}"><div class="b-meta">\${m.sender}</div>\${m.message.replace(/</g, "&lt;")}</div>\`).join("");
    body.scrollTop = body.scrollHeight;
  }
  async function sendStaffReply(e) {
    e.preventDefault(); if (!ACTIVE_CONV) return;
    const input = document.getElementById("replyInput"); const text = input.value.trim(); if (!text) return;
    input.value = "";
    const body = document.getElementById("chatBody");
    const div = document.createElement("div"); div.className = "bubble staff";
    div.innerHTML = \`<div class="b-meta">staff</div>\${text.replace(/</g, "&lt;")}\`;
    body.appendChild(div); body.scrollTop = body.scrollHeight; LAST_MSG_COUNT++;
    await api("reply", "POST", { customer_id: ACTIVE_CONV.customer_id, platform: ACTIVE_CONV.platform, message: text });
    loadConvs();
  }

  // --- SETTINGS (FB / IG / WA API) ---
  async function loadChannels() {
    const chans = await api("channels");
    const metaInfo = {
      facebook: { title: "Facebook Messenger API", idLabel: "Facebook Page ID", color: "var(--fb)" },
      instagram: { title: "Instagram DM API", idLabel: "Instagram Business Account ID", color: "var(--ig)" },
      whatsapp: { title: "WhatsApp Cloud API", idLabel: "WhatsApp Phone Number ID", color: "var(--wa)" }
    };
    document.getElementById("channelList").innerHTML = chans.map(ch => {
      const m = metaInfo[ch.platform] || { title: ch.platform, idLabel: "Account ID", color: "var(--accent)" };
      const connected = ch.is_active && ch.access_token;
      return \`
      <div class="api-card">
        <div class="api-card-head">
          <div class="api-title">
            <span class="dot" style="width:10px;height:10px;background:\${m.color}"></span>
            \${m.title}
          </div>
          <span class="status-pill \${connected ? 'status-on' : 'status-off'}">
            \${connected ? '<span class="pulse-dot"></span> Connected' : 'Not Connected'}
          </span>
        </div>
        <div class="api-grid">
          <div class="field-group">
            <label>\${m.idLabel}</label>
            <input id="pid_\${ch.platform}" value="\${ch.page_or_phone_id || ""}" placeholder="Paste \${m.idLabel}" />
          </div>
          <div class="field-group">
            <label>Permanent Access Token</label>
            <input type="password" id="tok_\${ch.platform}" value="\${ch.access_token || ""}" placeholder="Paste Meta Access Token" />
          </div>
          <div class="field-group">
            <label>Verify Token</label>
            <input id="ver_\${ch.platform}" value="\${ch.verify_token || "magicstore_verify_2026"}" />
          </div>
        </div>
        <div class="api-foot">
          <label class="toggle-lbl">
            <input type="checkbox" id="act_\${ch.platform}" \${ch.is_active ? "checked" : ""} /> Enable \${ch.platform.toUpperCase()} Integration
          </label>
          <button class="btn" onclick="saveChannel('\${ch.platform}', this)">Save & Connect</button>
        </div>
      </div>\`;
    }).join("");
  }

  async function saveChannel(platform, btn) {
    const old = btn.textContent;
    btn.textContent = "Saving...";
    await api("channels", "PATCH", {
      platform,
      page_or_phone_id: document.getElementById("pid_" + platform).value.trim(),
      access_token: document.getElementById("tok_" + platform).value.trim(),
      verify_token: document.getElementById("ver_" + platform).value.trim(),
      is_active: document.getElementById("act_" + platform).checked
    });
    btn.textContent = "Saved!";
    toast(platform.toUpperCase() + " API settings saved!");
    setTimeout(() => { btn.textContent = old; loadChannels(); }, 900);
  }

  // --- PRODUCTS / PAYMENTS / TICKETS ---
  async function loadProducts() {
    const prods = await api("products");
    document.getElementById("prodList").innerHTML = prods.map(p => \`<tr><td>\${p.name}</td><td>\${p.price}</td><td>\${p.in_stock ? "In Stock" : "Out"}</td><td><button class="btn-sm" onclick="toggleStock(\${p.id}, \${!p.in_stock})">Toggle</button> <button class="btn-sm btn-red" onclick="delProduct(\${p.id})">Del</button></td></tr>\`).join("");
  }
  async function addProduct() {
    await api("products", "POST", { name: document.getElementById("pName").value, price: document.getElementById("pPrice").value, description: document.getElementById("pDesc").value, delivery_info: document.getElementById("pDel").value });
    ["pName","pPrice","pDesc","pDel"].forEach(id => document.getElementById(id).value = "");
    toast("Product added!");
    loadProducts();
  }
  async function toggleStock(id, in_stock) { await api("products", "PATCH", { id, in_stock }); toast("Stock updated!"); loadProducts(); }
  async function delProduct(id) { await api("products?id=" + id, "DELETE"); toast("Product deleted"); loadProducts(); }
  async function loadPayments() {
    const pays = await api("payments");
    document.getElementById("payList").innerHTML = pays.map(p => \`<tr><td>\${p.customer_id}</td><td>\${p.product_name}</td><td><b>\${p.trx_id}</b></td><td>\${p.status}</td><td><button class="btn-sm btn-green" onclick="updatePay(\${p.id}, 'approved')">Approve</button> <button class="btn-sm btn-red" onclick="updatePay(\${p.id}, 'rejected')">Reject</button></td></tr>\`).join("");
  }
  async function updatePay(id, status) { await api("payments", "PATCH", { id, status }); toast("Payment " + status + "!"); loadPayments(); }
  async function loadTickets() {
    const tickets = await api("tickets");
    document.getElementById("ticketList").innerHTML = tickets.map(t => \`<tr><td>\${t.customer_id}</td><td>\${t.platform}</td><td>\${t.message}</td><td>\${t.status}</td><td><button class="btn-sm btn-green" onclick="resolveTicket(\${t.id})">Resolve</button></td></tr>\`).join("");
  }
  async function resolveTicket(id) { await api("tickets", "PATCH", { id, status: "resolved" }); toast("Ticket resolved!"); loadTickets(); }
</script>
</body>
</html>`;
}

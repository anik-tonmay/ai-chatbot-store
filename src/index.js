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
      // 1. META WEBHOOK (FB / IG / WHATSAPP)
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

      // 2. STAFF API ENDPOINTS
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
    --bg: #0f1115; --panel: #151820; --panel2: #1c202a; --border: #282d38;
    --text: #f3f4f6; --muted: #9ca3af; --accent: #2563eb; --staff: #7c3aed;
    --bot: #1e293b; --cust: #1c202a; --green: #16a34a; --red: #dc2626;
  }
  [data-theme="light"] {
    --bg: #f4f5f7; --panel: #ffffff; --panel2: #f0f2f5; --border: #dcdfe4;
    --text: #111827; --muted: #6b7280; --accent: #1877f2; --staff: #7c3aed;
    --bot: #e5e7eb; --cust: #f0f2f5; --green: #16a34a; --red: #dc2626;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: var(--bg); color: var(--text); height: 100dvh; overflow: hidden; display: flex; }

  /* Login */
  .login-wrap { margin: auto; background: var(--panel); border: 1px solid var(--border); padding: 28px; width: 92%; max-width: 340px; }
  .login-wrap h2 { font-size: 18px; margin-bottom: 4px; }
  .login-wrap p.sub { font-size: 12px; color: var(--muted); margin-bottom: 18px; }
  .login-wrap input { width: 100%; padding: 11px 12px; background: var(--bg); border: 1px solid var(--border); color: var(--text); margin-bottom: 12px; outline: none; }
  .login-wrap button { width: 100%; padding: 11px; background: var(--accent); color: #fff; border: none; font-weight: 600; cursor: pointer; }

  /* App Shell */
  .app { display: none; width: 100%; height: 100dvh; }
  .sidebar { width: 190px; background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .brand { padding: 15px 16px; font-weight: 700; font-size: 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .theme-btn { background: var(--panel2); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; font-size: 11px; cursor: pointer; font-weight: 600; }
  .nav-item { padding: 11px 16px; cursor: pointer; font-size: 13px; color: var(--muted); border-left: 3px solid transparent; }
  .nav-item:hover, .nav-item.active { background: var(--panel2); color: var(--text); border-left-color: var(--accent); font-weight: 600; }

  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .section { display: none; flex: 1; overflow-y: auto; padding: 20px; }
  .section.active { display: block; }
  .section.inbox-sec.active { display: flex; flex-direction: column; padding: 0; overflow: hidden; }

  /* Top Filter Bar */
  .filter-bar { background: var(--panel); border-bottom: 1px solid var(--border); padding: 9px 14px; display: flex; gap: 6px; overflow-x: auto; flex-shrink: 0; }
  .ftab { padding: 6px 12px; font-size: 12px; font-weight: 600; background: var(--panel2); border: 1px solid var(--border); color: var(--text); cursor: pointer; white-space: nowrap; }
  .ftab.active { background: var(--accent); border-color: var(--accent); color: #fff; }

  /* 3-Column Suite Layout */
  .suite-grid { flex: 1; display: flex; overflow: hidden; position: relative; }
  .conv-col { width: 300px; background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
  .conv-search { padding: 10px; border-bottom: 1px solid var(--border); }
  .conv-search input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 10px; font-size: 12px; outline: none; }
  .conv-list { flex: 1; overflow-y: auto; }
  .conv-item { display: flex; gap: 10px; align-items: center; padding: 11px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .conv-item:hover, .conv-item.selected { background: var(--panel2); }

  .avatar-wrap { position: relative; width: 40px; height: 40px; flex-shrink: 0; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; border: 1px solid var(--border); }
  .plat-dot { position: absolute; bottom: -2px; right: -2px; width: 16px; height: 16px; border-radius: 50%; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 1px solid var(--panel); color: #fff; }
  .p-facebook { background: #1877f2; }
  .p-instagram { background: #e1306c; }
  .p-whatsapp { background: #25d366; }

  .conv-meta { flex: 1; min-width: 0; }
  .conv-top-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
  .conv-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-time { font-size: 10px; color: var(--muted); flex-shrink: 0; margin-left: 6px; }
  .conv-prev { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Center Chat Pane */
  .chat-col { flex: 1; display: flex; flex-direction: column; background: var(--bg); min-width: 0; }
  .chat-header { padding: 10px 14px; background: var(--panel); border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; min-height: 58px; gap: 8px; }
  .chat-body { flex: 1; padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .bubble { max-width: 78%; padding: 9px 13px; font-size: 13px; line-height: 1.45; border: 1px solid var(--border); white-space: pre-wrap; word-break: break-word; }
  .bubble.customer { align-self: flex-start; background: var(--cust); color: var(--text); }
  .bubble.bot { align-self: flex-end; background: var(--bot); color: var(--text); }
  .bubble.staff { align-self: flex-end; background: var(--staff); border-color: var(--staff); color: #ffffff; }
  .b-meta { font-size: 10px; opacity: 0.7; margin-bottom: 3px; text-transform: uppercase; font-weight: 600; }

  .suggest-bar { display: none; gap: 6px; padding: 8px 12px; background: var(--panel); border-top: 1px solid var(--border); overflow-x: auto; }
  .sug-chip { padding: 5px 10px; font-size: 11px; background: var(--panel2); border: 1px solid var(--border); color: var(--text); cursor: pointer; white-space: nowrap; }
  .chat-input { display: flex; border-top: 1px solid var(--border); background: var(--panel); }
  .chat-input input { flex: 1; background: transparent; border: none; color: var(--text); padding: 13px 14px; font-size: 13px; outline: none; min-width: 0; }
  .chat-input button { background: var(--accent); color: #fff; border: none; padding: 0 20px; font-weight: 600; cursor: pointer; font-size: 13px; }

  /* Right Info Column */
  .info-col { width: 265px; background: var(--panel); border-left: 1px solid var(--border); padding: 16px; overflow-y: auto; flex-shrink: 0; display: none; flex-direction: column; gap: 14px; }
  .info-head { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .info-label { font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: 600; margin-bottom: 6px; display: block; }
  .info-col select, .info-col input, .info-col textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px; font-size: 12px; outline: none; }
  .info-col textarea { min-height: 80px; resize: vertical; }

  /* Tables & Forms */
  h2 { font-size: 16px; margin-bottom: 14px; }
  .card { background: var(--panel); border: 1px solid var(--border); padding: 14px; margin-bottom: 14px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
  input { padding: 9px 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 13px; outline: none; }
  .btn { padding: 8px 14px; background: var(--accent); color: #fff; border: none; cursor: pointer; font-weight: 600; font-size: 12px; }
  .btn-sm { padding: 5px 9px; font-size: 11px; border: 1px solid var(--border); background: var(--panel2); color: var(--text); cursor: pointer; font-weight: 600; }
  .btn-green { background: var(--green); border-color: var(--green); color: #fff; }
  .btn-red { background: var(--red); border-color: var(--red); color: #fff; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); font-size: 12px; min-width: 520px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  th { background: var(--panel2); color: var(--muted); font-weight: 600; }

  /* Mobile Bottom Nav & Helpers */
  .mob-nav { display: none; background: var(--panel); border-top: 1px solid var(--border); flex-shrink: 0; }
  .mob-nav button { flex: 1; padding: 11px 4px; background: transparent; border: none; color: var(--muted); font-size: 11px; font-weight: 600; cursor: pointer; }
  .mob-nav button.active { color: var(--accent); border-top: 2px solid var(--accent); }
  .mob-only { display: none; }

  @media (max-width: 820px) {
    .app { flex-direction: column; }
    .sidebar { display: none; }
    .mob-nav { display: flex; }
    .mob-only { display: inline-flex; }
    .conv-col { width: 100%; border-right: none; }
    .chat-col { display: none; width: 100%; }
    .suite-grid.mob-chat-open .conv-col { display: none; }
    .suite-grid.mob-chat-open .chat-col { display: flex; }
    .info-col { position: absolute; inset: 0; width: 100%; z-index: 20; border-left: none; }
    .info-col:not(.mob-info-open) { display: none !important; }
    .info-col.mob-info-open { display: flex !important; }
  }
</style>
</head>
<body>
  <div class="login-wrap" id="loginBox">
    <h2>Magic Store Suite</h2>
    <p class="sub">Staff-Only Omnichannel Inbox</p>
    <input type="password" id="passInput" placeholder="Enter Staff Password" onkeydown="if(event.key==='Enter')login()" />
    <button onclick="login()">Login to Inbox</button>
    <p id="loginErr" style="color:#ef4444;font-size:12px;margin-top:10px;"></p>
  </div>

  <div class="app" id="app">
    <aside class="sidebar">
      <div class="brand">
        <span>MAGIC SUITE</span>
        <button class="theme-btn" onclick="toggleTheme()">Theme</button>
      </div>
      <div class="nav-item active" data-tab="inbox" onclick="switchTab('inbox')">Inbox</div>
      <div class="nav-item" data-tab="channels" onclick="switchTab('channels')">Channels (FB/IG/WA)</div>
      <div class="nav-item" data-tab="products" onclick="switchTab('products')">Products</div>
      <div class="nav-item" data-tab="payments" onclick="switchTab('payments')">Payments</div>
      <div class="nav-item" data-tab="tickets" onclick="switchTab('tickets')">Staff Tickets</div>
      <div class="nav-item" style="margin-top:auto;" onclick="logout()">Logout</div>
    </aside>

    <div class="main">
      <!-- 1. INBOX -->
      <div id="inbox" class="section inbox-sec active">
        <div class="filter-bar">
          <button class="ftab active" onclick="setFilter('all', this)">All</button>
          <button class="ftab" onclick="setFilter('facebook', this)">Messenger</button>
          <button class="ftab" onclick="setFilter('instagram', this)">Instagram</button>
          <button class="ftab" onclick="setFilter('whatsapp', this)">WhatsApp</button>
          <button class="ftab mob-only" style="margin-left:auto;" onclick="toggleTheme()">Theme</button>
        </div>

        <div class="suite-grid" id="suiteGrid">
          <div class="conv-col">
            <div class="conv-search"><input id="convSearch" placeholder="Search customer..." oninput="renderConvs()" /></div>
            <div class="conv-list" id="convItems"></div>
          </div>

          <div class="chat-col">
            <div class="chat-header" id="chatHeader">
              <span style="color:var(--muted);font-size:13px;">Select a customer to view conversation</span>
            </div>
            <div class="chat-body" id="chatBody"></div>
            <div class="suggest-bar" id="suggestBar">
              <button class="sug-chip" onclick="useSug('Assalamu Alaikum! Magic Store-e shagotom. Ki product lagbe bolun?')">Welcome</button>
              <button class="sug-chip" onclick="useSug('bKash / Nagad Personal: 01XXXXXXXXX (Send Money kore TrxID din)')">Payment Info</button>
              <button class="sug-chip" onclick="useSug('Payment received! 5-10 minute-er moddhe delivery peye jaben.')">Order Confirmed</button>
            </div>
            <form class="chat-input" id="replyForm" onsubmit="sendStaffReply(event)" style="display:none;">
              <input id="replyInput" placeholder="Reply to customer..." autocomplete="off" required />
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

      <!-- 2. CHANNELS -->
      <div id="channels" class="section">
        <h2>Connect Facebook, Instagram & WhatsApp</h2>
        <div class="card" style="font-size:12px;line-height:1.8;word-break:break-all;">
          <div><b>Webhook Callback URL:</b> <code style="color:#60a5fa;">${origin}/webhook/meta</code></div>
          <div><b>Verify Token:</b> <code style="color:#60a5fa;">magicstore_verify_2026</code></div>
        </div>
        <div id="channelList"></div>
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

    <!-- Mobile Bottom Navigation -->
    <nav class="mob-nav">
      <button class="active" data-tab="inbox" onclick="switchTab('inbox')">Inbox</button>
      <button data-tab="channels" onclick="switchTab('channels')">Channels</button>
      <button data-tab="products" onclick="switchTab('products')">Products</button>
      <button data-tab="payments" onclick="switchTab('payments')">Payments</button>
      <button data-tab="tickets" onclick="switchTab('tickets')">Tickets</button>
    </nav>
  </div>

<script>
  let TOKEN = localStorage.getItem("staff_pass") || "";
  let CONVS = [];
  let FILTER = "all";
  let ACTIVE_CONV = null;
  let LAST_MSG_COUNT = 0;

  if (localStorage.getItem("ms_theme") === "light") document.documentElement.setAttribute("data-theme", "light");
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("ms_theme", next);
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
    try { await api("verify"); localStorage.setItem("staff_pass", TOKEN); startApp(); }
    catch { document.getElementById("loginErr").textContent = "Wrong password!"; }
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
    if (id === "channels") loadChannels();
    if (id === "products") loadProducts();
    if (id === "payments") loadPayments();
    if (id === "tickets") loadTickets();
  }

  function setFilter(f, btn) {
    FILTER = f;
    document.querySelectorAll(".ftab").forEach(b => b.classList.remove("active"));
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
      return \`<div class="conv-item \${sel}" onclick='selectConv(\${JSON.stringify(c).replace(/'/g, "&#39;")})'>
        \${avatarHTML(c)}
        <div class="conv-meta">
          <div class="conv-top-row"><span class="conv-name">\${c.customer_name || c.customer_id}</span><span class="conv-time">\${time}</span></div>
          <div class="conv-prev">\${c.last_message || ""}</div>
        </div>
      </div>\`;
    }).join("") || '<div style="padding:18px;font-size:12px;color:var(--muted);">No messages yet. Connect FB/IG/WA in Channels.</div>';
  }

  function selectConv(c) {
    ACTIVE_CONV = c; LAST_MSG_COUNT = 0;
    document.getElementById("suiteGrid").classList.add("mob-chat-open");
    renderConvs(); renderChatHeader();
    document.getElementById("replyForm").style.display = "flex";
    document.getElementById("suggestBar").style.display = "flex";
    document.getElementById("infoCol").style.display = "flex";
    document.getElementById("infoHead").innerHTML = \`\${avatarHTML(c)}<div style="min-width:0;"><div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${c.customer_name || c.customer_id}</div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;">\${c.platform}</div></div>\`;
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
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        <button class="btn-sm mob-only" onclick="closeMobChat()">←</button>
        \${avatarHTML(c)}
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${c.customer_name || c.customer_id}</div>
          <div style="font-size:11px;color:var(--muted);text-transform:capitalize;">\${c.platform}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn-sm \${c.ai_enabled ? 'btn-green' : 'btn-red'}" onclick="toggleAI()">AI: \${c.ai_enabled ? "ON" : "OFF"}</button>
        <button class="btn-sm mob-only" onclick="openMobInfo()">Info</button>
      </div>\`;
  }

  async function toggleAI() {
    ACTIVE_CONV.ai_enabled = !ACTIVE_CONV.ai_enabled; renderChatHeader();
    await api("conversations/meta", "PATCH", { id: ACTIVE_CONV.id, ai_enabled: ACTIVE_CONV.ai_enabled });
  }
  async function saveCustomerMeta() {
    const status = document.getElementById("infoStatus").value;
    const labels = document.getElementById("infoLabels").value.trim();
    const notes = document.getElementById("infoNotes").value.trim();
    await api("conversations/meta", "PATCH", { id: ACTIVE_CONV.id, status, labels, notes });
    ACTIVE_CONV.status = status; ACTIVE_CONV.labels = labels; ACTIVE_CONV.notes = notes;
    alert("Saved!");
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

  async function loadChannels() {
    const chans = await api("channels");
    document.getElementById("channelList").innerHTML = chans.map(ch => \`
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <strong style="text-transform:uppercase;font-size:13px;">\${ch.platform}</strong>
          <label style="font-size:12px;"><input type="checkbox" id="act_\${ch.platform}" \${ch.is_active ? "checked" : ""} /> Active</label>
        </div>
        <div class="form-grid">
          <input id="pid_\${ch.platform}" value="\${ch.page_or_phone_id || ""}" placeholder="\${ch.platform === 'whatsapp' ? 'Phone Number ID' : 'Page / IG Account ID'}" />
          <input id="tok_\${ch.platform}" value="\${ch.access_token || ""}" placeholder="Permanent Access Token" />
          <input id="ver_\${ch.platform}" value="\${ch.verify_token || "magicstore_verify_2026"}" placeholder="Verify Token" />
          <button class="btn" onclick="saveChannel('\${ch.platform}')">Save \${ch.platform.toUpperCase()}</button>
        </div>
      </div>\`).join("");
  }
  async function saveChannel(platform) {
    await api("channels", "PATCH", {
      platform,
      page_or_phone_id: document.getElementById("pid_" + platform).value.trim(),
      access_token: document.getElementById("tok_" + platform).value.trim(),
      verify_token: document.getElementById("ver_" + platform).value.trim(),
      is_active: document.getElementById("act_" + platform).checked
    });
    alert(platform.toUpperCase() + " saved!");
  }

  async function loadProducts() {
    const prods = await api("products");
    document.getElementById("prodList").innerHTML = prods.map(p => \`<tr><td>\${p.name}</td><td>\${p.price}</td><td>\${p.in_stock ? "In Stock" : "Out"}</td><td><button class="btn-sm" onclick="toggleStock(\${p.id}, \${!p.in_stock})">Toggle</button> <button class="btn-sm btn-red" onclick="delProduct(\${p.id})">Del</button></td></tr>\`).join("");
  }
  async function addProduct() {
    await api("products", "POST", { name: document.getElementById("pName").value, price: document.getElementById("pPrice").value, description: document.getElementById("pDesc").value, delivery_info: document.getElementById("pDel").value });
    ["pName","pPrice","pDesc","pDel"].forEach(id => document.getElementById(id).value = ""); loadProducts();
  }
  async function toggleStock(id, in_stock) { await api("products", "PATCH", { id, in_stock }); loadProducts(); }
  async function delProduct(id) { await api("products?id=" + id, "DELETE"); loadProducts(); }
  async function loadPayments() {
    const pays = await api("payments");
    document.getElementById("payList").innerHTML = pays.map(p => \`<tr><td>\${p.customer_id}</td><td>\${p.product_name}</td><td><b>\${p.trx_id}</b></td><td>\${p.status}</td><td><button class="btn-sm btn-green" onclick="updatePay(\${p.id}, 'approved')">Approve</button> <button class="btn-sm btn-red" onclick="updatePay(\${p.id}, 'rejected')">Reject</button></td></tr>\`).join("");
  }
  async function updatePay(id, status) { await api("payments", "PATCH", { id, status }); loadPayments(); }
  async function loadTickets() {
    const tickets = await api("tickets");
    document.getElementById("ticketList").innerHTML = tickets.map(t => \`<tr><td>\${t.customer_id}</td><td>\${t.platform}</td><td>\${t.message}</td><td>\${t.status}</td><td><button class="btn-sm btn-green" onclick="resolveTicket(\${t.id})">Resolve</button></td></tr>\`).join("");
  }
  async function resolveTicket(id) { await api("tickets", "PATCH", { id, status: "resolved" }); loadTickets(); }
</script>
</body>
</html>`;
}

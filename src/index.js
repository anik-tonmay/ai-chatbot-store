export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

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

    // Fetch customer Name & Profile Picture from Meta Graph API
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
      const payload = {
        customer_id,
        platform,
        last_message,
        updated_at: new Date().toISOString(),
      };
      if (extra.customer_name) payload.customer_name = extra.customer_name;
      if (extra.avatar_url) payload.avatar_url = extra.avatar_url;

      const rows = await supabase(
        "conversations",
        "POST",
        payload,
        "?on_conflict=customer_id,platform",
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

      // 3. ROOT & ALL PAGES -> STAFF BUSINESS SUITE INBOX
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
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Magic Store — Business Suite Inbox</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: #0f1115; color: #f3f4f6; height: 100vh; overflow: hidden; display: flex; }
  .login-wrap { margin: auto; background: #161920; border: 1px solid #2a2f3a; padding: 28px; width: 340px; }
  .login-wrap h2 { margin-bottom: 6px; font-size: 18px; }
  .login-wrap p.sub { font-size: 12px; color: #9ca3af; margin-bottom: 18px; }
  .login-wrap input { width: 100%; padding: 10px 12px; background: #0f1115; border: 1px solid #2a2f3a; color: #fff; margin-bottom: 12px; outline: none; }
  .login-wrap button { width: 100%; padding: 10px; background: #2563eb; color: #fff; border: none; font-weight: 600; cursor: pointer; }

  .app { display: none; width: 100%; height: 100vh; }
  .sidebar { width: 185px; background: #14171d; border-right: 1px solid #262b36; display: flex; flex-direction: column; flex-shrink: 0; }
  .brand { padding: 16px; font-weight: 700; font-size: 14px; border-bottom: 1px solid #262b36; letter-spacing: 0.4px; }
  .nav-item { padding: 11px 16px; cursor: pointer; font-size: 13px; color: #9ca3af; border-left: 3px solid transparent; }
  .nav-item:hover, .nav-item.active { background: #1c2029; color: #fff; border-left-color: #2563eb; }

  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .section { display: none; flex: 1; overflow-y: auto; padding: 22px; }
  .section.active { display: block; }
  .section.inbox-sec.active { display: flex; flex-direction: column; padding: 0; overflow: hidden; }

  /* Meta Business Suite Top Filter Bar */
  .filter-bar { background: #161920; border-bottom: 1px solid #262b36; padding: 10px 16px; display: flex; gap: 8px; align-items: center; }
  .ftab { padding: 6px 12px; font-size: 12px; font-weight: 600; background: #1d212b; border: 1px solid #2d3340; color: #d1d5db; cursor: pointer; }
  .ftab.active { background: #2563eb; border-color: #2563eb; color: #fff; }

  /* 3-Column Suite Layout */
  .suite-grid { flex: 1; display: flex; overflow: hidden; }
  .conv-col { width: 310px; background: #13161c; border-right: 1px solid #262b36; display: flex; flex-direction: column; flex-shrink: 0; }
  .conv-search { padding: 10px; border-bottom: 1px solid #262b36; }
  .conv-search input { width: 100%; background: #0f1115; border: 1px solid #262b36; color: #fff; padding: 8px 10px; font-size: 12px; outline: none; }
  .conv-list { flex: 1; overflow-y: auto; }
  .conv-item { display: flex; gap: 10px; align-items: center; padding: 11px 12px; border-bottom: 1px solid #1e222b; cursor: pointer; }
  .conv-item:hover, .conv-item.selected { background: #1c212b; }

  .avatar-wrap { position: relative; width: 40px; height: 40px; flex-shrink: 0; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #2563eb; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; border: 1px solid #353b48; }
  .plat-dot { position: absolute; bottom: -2px; right: -2px; width: 16px; height: 16px; border-radius: 50%; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 1px solid #0f1115; color: #fff; }
  .p-facebook { background: #1877f2; }
  .p-instagram { background: #e1306c; }
  .p-whatsapp { background: #25d366; }

  .conv-meta { flex: 1; min-width: 0; }
  .conv-top-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
  .conv-name { font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-time { font-size: 10px; color: #6b7280; flex-shrink: 0; margin-left: 6px; }
  .conv-prev { font-size: 12px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Center Chat Pane */
  .chat-col { flex: 1; display: flex; flex-direction: column; background: #0f1115; min-width: 0; }
  .chat-header { padding: 10px 16px; background: #161920; border-bottom: 1px solid #262b36; display: flex; justify-content: space-between; align-items: center; min-height: 58px; }
  .chat-body { flex: 1; padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .bubble { max-width: 72%; padding: 9px 13px; font-size: 13px; line-height: 1.45; border: 1px solid #262b36; white-space: pre-wrap; }
  .bubble.customer { align-self: flex-start; background: #1b1f27; color: #f3f4f6; }
  .bubble.bot { align-self: flex-end; background: #1e293b; border-color: #334155; color: #e2e8f0; }
  .bubble.staff { align-self: flex-end; background: #7c3aed; border-color: #7c3aed; color: #ffffff; }
  .b-meta { font-size: 10px; opacity: 0.65; margin-bottom: 3px; text-transform: uppercase; }
  .chat-input { display: flex; border-top: 1px solid #262b36; background: #161920; }
  .chat-input input { flex: 1; background: transparent; border: none; color: #fff; padding: 14px 16px; font-size: 13px; outline: none; }
  .chat-input button { background: #2563eb; color: #fff; border: none; padding: 0 22px; font-weight: 600; cursor: pointer; font-size: 13px; }

  /* Right Customer Info Column (Meta Business Suite style) */
  .info-col { width: 270px; background: #13161c; border-left: 1px solid #262b36; padding: 16px; overflow-y: auto; flex-shrink: 0; display: none; flex-direction: column; gap: 14px; }
  .info-head { display: flex; align-items: center; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid #262b36; }
  .info-label { font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; display: block; }
  .info-col select, .info-col input, .info-col textarea { width: 100%; background: #0f1115; border: 1px solid #262b36; color: #fff; padding: 8px; font-size: 12px; outline: none; }
  .info-col textarea { min-height: 85px; resize: vertical; }

  /* Shared Components */
  h2 { font-size: 17px; margin-bottom: 14px; }
  .card { background: #161920; border: 1px solid #262b36; padding: 16px; margin-bottom: 14px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  input { padding: 9px 10px; background: #0f1115; border: 1px solid #262b36; color: #fff; font-size: 13px; outline: none; }
  .btn { padding: 8px 14px; background: #2563eb; color: #fff; border: none; cursor: pointer; font-weight: 600; font-size: 12px; }
  .btn-sm { padding: 5px 10px; font-size: 12px; border: 1px solid #353b48; background: #222630; color: #fff; cursor: pointer; margin-right: 6px; }
  .btn-green { background: #16a34a; border-color: #16a34a; }
  .btn-red { background: #dc2626; border-color: #dc2626; }
  table { width: 100%; border-collapse: collapse; background: #161920; border: 1px solid #262b36; font-size: 13px; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #262b36; }
  th { background: #1b1f27; color: #9ca3af; font-weight: 600; }
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
      <div class="brand">MAGIC SUITE</div>
      <div class="nav-item active" onclick="switchTab('inbox', this)">Inbox</div>
      <div class="nav-item" onclick="switchTab('channels', this)">Channels (FB/IG/WA)</div>
      <div class="nav-item" onclick="switchTab('products', this)">Products</div>
      <div class="nav-item" onclick="switchTab('payments', this)">Payments</div>
      <div class="nav-item" onclick="switchTab('tickets', this)">Staff Tickets</div>
      <div class="nav-item" style="margin-top:auto;" onclick="logout()">Logout</div>
    </aside>

    <div class="main">
      <!-- 1. META BUSINESS SUITE STYLE INBOX -->
      <div id="inbox" class="section inbox-sec active">
        <div class="filter-bar">
          <button class="ftab active" onclick="setFilter('all', this)">All messages</button>
          <button class="ftab" onclick="setFilter('facebook', this)">Messenger</button>
          <button class="ftab" onclick="setFilter('instagram', this)">Instagram</button>
          <button class="ftab" onclick="setFilter('whatsapp', this)">WhatsApp</button>
        </div>
        <div class="suite-grid">
          <div class="conv-col">
            <div class="conv-search"><input id="convSearch" placeholder="Search customer..." oninput="renderConvs()" /></div>
            <div class="conv-list" id="convItems"></div>
          </div>

          <div class="chat-col">
            <div class="chat-header" id="chatHeader">
              <span style="color:#9ca3af;font-size:13px;">Select a customer to view conversation</span>
            </div>
            <div class="chat-body" id="chatBody"></div>
            <form class="chat-input" id="replyForm" onsubmit="sendStaffReply(event)" style="display:none;">
              <input id="replyInput" placeholder="Reply directly to customer..." autocomplete="off" required />
              <button type="submit">Send</button>
            </form>
          </div>

          <div class="info-col" id="infoCol">
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
              <label class="info-label">Labels (comma separated)</label>
              <input id="infoLabels" placeholder="e.g. Priority, VIP" />
            </div>
            <div>
              <label class="info-label">Staff Notes</label>
              <textarea id="infoNotes" placeholder="Add internal notes about this customer..."></textarea>
            </div>
            <button class="btn" onclick="saveCustomerMeta()">Save Details</button>
          </div>
        </div>
      </div>

      <!-- 2. CHANNELS -->
      <div id="channels" class="section">
        <h2>Connect Facebook, Instagram & WhatsApp</h2>
        <div class="card" style="font-size:13px;line-height:1.7;">
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
        <table><thead><tr><th>Name</th><th>Price</th><th>Stock</th><th>Action</th></tr></thead><tbody id="prodList"></tbody></table>
      </div>

      <!-- 4. PAYMENTS -->
      <div id="payments" class="section">
        <h2>Payment Verification</h2>
        <table><thead><tr><th>Customer</th><th>Product</th><th>TrxID</th><th>Status</th><th>Action</th></tr></thead><tbody id="payList"></tbody></table>
      </div>

      <!-- 5. TICKETS -->
      <div id="tickets" class="section">
        <h2>Escalated Staff Tickets</h2>
        <table><thead><tr><th>Customer</th><th>Platform</th><th>Message</th><th>Status</th><th>Action</th></tr></thead><tbody id="ticketList"></tbody></table>
      </div>
    </div>
  </div>

<script>
  let TOKEN = localStorage.getItem("staff_pass") || "";
  let CONVS = [];
  let FILTER = "all";
  let ACTIVE_CONV = null;
  let LAST_MSG_COUNT = 0;

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
    try {
      await api("verify");
      localStorage.setItem("staff_pass", TOKEN);
      startApp();
    } catch {
      document.getElementById("loginErr").textContent = "Wrong password!";
    }
  }

  function logout() {
    localStorage.removeItem("staff_pass");
    location.reload();
  }

  function startApp() {
    document.getElementById("loginBox").style.display = "none";
    document.getElementById("app").style.display = "flex";
    loadConvs();
    setInterval(() => {
      if (document.getElementById("inbox").classList.contains("active")) {
        loadConvs(true);
        if (ACTIVE_CONV) loadMessages(ACTIVE_CONV, true);
      }
    }, 3000);
  }

  if (TOKEN) api("verify").then(startApp).catch(() => localStorage.removeItem("staff_pass"));

  function switchTab(id, el) {
    document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    document.getElementById(id).classList.add("active");
    el.classList.add("active");
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
    const img = c.avatar_url
      ? \`<img class="avatar" src="\${c.avatar_url}" onerror="this.style.display='none'" />\`
      : \`<div class="avatar">\${init}</div>\`;
    const pChar = c.platform === "facebook" ? "F" : c.platform === "instagram" ? "I" : "W";
    return \`<div class="avatar-wrap">\${img}<span class="plat-dot p-\${c.platform}">\${pChar}</span></div>\`;
  }

  async function loadConvs() {
    try { CONVS = await api("conversations"); renderConvs(); } catch {}
  }

  function renderConvs() {
    const q = (document.getElementById("convSearch").value || "").toLowerCase();
    const list = CONVS.filter(c => {
      if (FILTER !== "all" && c.platform !== FILTER) return false;
      return (c.customer_name || c.customer_id).toLowerCase().includes(q) || (c.last_message || "").toLowerCase().includes(q);
    });
    document.getElementById("convItems").innerHTML = list.map(c => {
      const sel = ACTIVE_CONV && ACTIVE_CONV.id === c.id ? "selected" : "";
      const time = c.updated_at ? new Date(c.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      return \`
        <div class="conv-item \${sel}" onclick='selectConv(\${JSON.stringify(c).replace(/'/g, "&#39;")})'>
          \${avatarHTML(c)}
          <div class="conv-meta">
            <div class="conv-top-row">
              <span class="conv-name">\${c.customer_name || c.customer_id}</span>
              <span class="conv-time">\${time}</span>
            </div>
            <div class="conv-prev">\${c.last_message || ""}</div>
          </div>
        </div>\`;
    }).join("") || '<div style="padding:18px;font-size:12px;color:#6b7280;">No messages found. Connect FB/IG/WA in Channels tab.</div>';
  }

  function selectConv(c) {
    ACTIVE_CONV = c;
    LAST_MSG_COUNT = 0;
    renderConvs();
    renderChatHeader();
    document.getElementById("replyForm").style.display = "flex";

    // Right Info Panel
    const info = document.getElementById("infoCol");
    info.style.display = "flex";
    document.getElementById("infoHead").innerHTML = \`
      \${avatarHTML(c)}
      <div style="min-width:0;">
        <div style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\${c.customer_name || c.customer_id}</div>
        <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;">\${c.platform} • \${c.customer_id}</div>
      </div>\`;
    document.getElementById("infoStatus").value = c.status || "New";
    document.getElementById("infoLabels").value = c.labels || "";
    document.getElementById("infoNotes").value = c.notes || "";

    loadMessages(c, false);
  }

  function renderChatHeader() {
    const c = ACTIVE_CONV;
    document.getElementById("chatHeader").innerHTML = \`
      <div style="display:flex;align-items:center;gap:10px;">
        \${avatarHTML(c)}
        <div>
          <div style="font-size:14px;font-weight:600;">\${c.customer_name || c.customer_id}</div>
          <div style="font-size:11px;color:#9ca3af;text-transform:capitalize;">\${c.platform}</div>
        </div>
      </div>
      <button class="btn-sm \${c.ai_enabled ? 'btn-green' : 'btn-red'}" onclick="toggleAI()">
        AI Auto-Reply: \${c.ai_enabled ? "ON" : "PAUSED"}
      </button>\`;
  }

  async function toggleAI() {
    ACTIVE_CONV.ai_enabled = !ACTIVE_CONV.ai_enabled;
    renderChatHeader();
    await api("conversations/meta", "PATCH", { id: ACTIVE_CONV.id, ai_enabled: ACTIVE_CONV.ai_enabled });
  }

  async function saveCustomerMeta() {
    const status = document.getElementById("infoStatus").value;
    const labels = document.getElementById("infoLabels").value.trim();
    const notes = document.getElementById("infoNotes").value.trim();
    await api("conversations/meta", "PATCH", { id: ACTIVE_CONV.id, status, labels, notes });
    ACTIVE_CONV.status = status; ACTIVE_CONV.labels = labels; ACTIVE_CONV.notes = notes;
    alert("Customer details saved!");
  }

  async function loadMessages(conv, silent = false) {
    const msgs = await api(\`messages?customer_id=\${encodeURIComponent(conv.customer_id)}&platform=\${conv.platform}\`);
    if (silent && msgs.length === LAST_MSG_COUNT) return;
    LAST_MSG_COUNT = msgs.length;
    const body = document.getElementById("chatBody");
    body.innerHTML = msgs.map(m => \`
      <div class="bubble \${m.sender}">
        <div class="b-meta">\${m.sender}</div>
        \${m.message.replace(/</g, "&lt;")}
      </div>\`).join("");
    body.scrollTop = body.scrollHeight;
  }

  async function sendStaffReply(e) {
    e.preventDefault();
    if (!ACTIVE_CONV) return;
    const input = document.getElementById("replyInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const body = document.getElementById("chatBody");
    const div = document.createElement("div");
    div.className = "bubble staff";
    div.innerHTML = \`<div class="b-meta">staff</div>\${text.replace(/</g, "&lt;")}\`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    LAST_MSG_COUNT++;
    await api("reply", "POST", { customer_id: ACTIVE_CONV.customer_id, platform: ACTIVE_CONV.platform, message: text });
    loadConvs();
  }

  async function loadChannels() {
    const chans = await api("channels");
    document.getElementById("channelList").innerHTML = chans.map(ch => \`
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <strong style="text-transform:uppercase;font-size:14px;">\${ch.platform}</strong>
          <label style="font-size:12px;cursor:pointer;"><input type="checkbox" id="act_\${ch.platform}" \${ch.is_active ? "checked" : ""} /> Active</label>
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
    document.getElementById("prodList").innerHTML = prods.map(p => \`
      <tr><td>\${p.name}</td><td>\${p.price}</td><td>\${p.in_stock ? "In Stock" : "Out of Stock"}</td>
      <td><button class="btn-sm" onclick="toggleStock(\${p.id}, \${!p.in_stock})">Toggle Stock</button><button class="btn-sm btn-red" onclick="delProduct(\${p.id})">Delete</button></td></tr>\`).join("");
  }
  async function addProduct() {
    await api("products", "POST", { name: document.getElementById("pName").value, price: document.getElementById("pPrice").value, description: document.getElementById("pDesc").value, delivery_info: document.getElementById("pDel").value });
    ["pName","pPrice","pDesc","pDel"].forEach(id => document.getElementById(id).value = "");
    loadProducts();
  }
  async function toggleStock(id, in_stock) { await api("products", "PATCH", { id, in_stock }); loadProducts(); }
  async function delProduct(id) { await api("products?id=" + id, "DELETE"); loadProducts(); }
  async function loadPayments() {
    const pays = await api("payments");
    document.getElementById("payList").innerHTML = pays.map(p => \`<tr><td>\${p.customer_id}</td><td>\${p.product_name}</td><td><b>\${p.trx_id}</b></td><td>\${p.status}</td><td><button class="btn-sm btn-green" onclick="updatePay(\${p.id}, 'approved')">Approve</button><button class="btn-sm btn-red" onclick="updatePay(\${p.id}, 'rejected')">Reject</button></td></tr>\`).join("");
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

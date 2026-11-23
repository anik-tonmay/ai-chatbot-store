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

    // Helper: Supabase REST API
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
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Supabase (${res.status}): ${errText}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : [];
    }

    // Helper: Upsert conversation
    async function upsertConversation(customer_id, platform, last_message, customer_name = null) {
      const payload = {
        customer_id,
        platform,
        last_message,
        updated_at: new Date().toISOString(),
      };
      if (customer_name) payload.customer_name = customer_name;

      const rows = await supabase(
        "conversations",
        "POST",
        payload,
        "?on_conflict=customer_id,platform",
        { "Prefer": "resolution=merge-duplicates,return=representation" }
      );
      return rows[0];
    }

    // Helper: Send message to Meta (FB / IG / WA)
    async function sendToPlatform(platform, recipientId, text) {
      if (platform === "website") return;
      const chans = await supabase("channels", "GET", null, `?platform=eq.${platform}&limit=1`);
      const ch = chans[0];
      if (!ch || !ch.access_token || !ch.is_active) return;

      if (platform === "whatsapp") {
        await fetch(`https://graph.facebook.com/v20.0/${ch.page_or_phone_id}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${ch.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: recipientId,
            type: "text",
            text: { body: text },
          }),
        });
      } else {
        // Facebook Messenger & Instagram DM
        await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(ch.access_token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: recipientId },
            message: { text },
          }),
        });
      }
    }

    // Helper: Generate AI Reply with Gemini
    async function generateAIReply(customer_id, platform, userMessage) {
      const products = await supabase("products", "GET", null, "?select=*&order=id.desc");
      const productContext = products.length
        ? products.map(p => `- ${p.name} | Price: ${p.price} | Stock: ${p.in_stock ? "Available" : "Out of Stock"} | Info: ${p.description || ""} | Delivery: ${p.delivery_info || ""}`).join("\n")
        : "No products added yet.";

      // Fetch last 6 messages for context
      const historyRows = await supabase(
        "chat_logs",
        "GET",
        null,
        `?customer_id=eq.${encodeURIComponent(customer_id)}&platform=eq.${platform}&order=id.desc&limit=6`
      );
      const historyText = historyRows
        .reverse()
        .map(m => `${m.sender === "customer" ? "Customer" : "Support"}: ${m.message}`)
        .join("\n");

      const systemPrompt = `You are the official AI customer support assistant for Magic Store (magicstorebd.com), a digital gaming & software storefront in Bangladesh.
Reply naturally in the user's language (Bangla, Banglish, or English). Keep replies concise, helpful, and friendly.

LIVE PRODUCT CATALOG:
${productContext}

RECENT CONVERSATION:
${historyText}

RULES:
1. Only quote prices and stock status from the LIVE PRODUCT CATALOG above.
2. If a customer sends a bKash/Nagad Transaction ID (TrxID) or says they paid, acknowledge it politely, tell them our staff will verify it shortly, and include the exact tag: [PAYMENT:trx_id_here|product_name_here] at the end of your reply.
3. If the customer asks for a human/staff, has an order issue, or asks something not in the catalog, apologize politely, tell them a staff member has been notified, and include the exact tag: [ESCALATE] at the end of your reply.`;

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
          customer_id,
          platform,
          trx_id: payMatch[1].trim(),
          product_name: payMatch[2]?.trim() || "Unknown Product",
          status: "pending",
        });
        reply = reply.replace(payMatch[0], "").trim();
      }

      if (reply.includes("[ESCALATE]")) {
        await supabase("staff_tickets", "POST", {
          customer_id,
          platform,
          message: userMessage,
          status: "open",
        });
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
        // Webhook Verification (GET)
        if (request.method === "GET") {
          const mode = url.searchParams.get("hub.mode");
          const token = url.searchParams.get("hub.verify_token");
          const challenge = url.searchParams.get("hub.challenge");

          const chans = await supabase("channels", "GET", null, "?select=verify_token");
          const validTokens = chans.map(c => c.verify_token).filter(Boolean);
          validTokens.push("magicstore_verify_2026");

          if (mode === "subscribe" && validTokens.includes(token)) {
            return new Response(challenge, { status: 200 });
          }
          return new Response("Forbidden", { status: 403 });
        }

        // Incoming Messages (POST)
        if (request.method === "POST") {
          const body = await request.json();

          const processIncoming = async (platform, senderId, text, senderName = null) => {
            if (!senderId || !text) return;
            await supabase("chat_logs", "POST", { customer_id: senderId, platform, sender: "customer", message: text });
            const conv = await upsertConversation(senderId, platform, text, senderName);

            if (conv && conv.ai_enabled !== false) {
              const reply = await generateAIReply(senderId, platform, text);
              await supabase("chat_logs", "POST", { customer_id: senderId, platform, sender: "bot", message: reply });
              await upsertConversation(senderId, platform, reply);
              await sendToPlatform(platform, senderId, reply);
            }
          };

          const tasks = [];

          // WhatsApp Cloud API format
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

          // Facebook Messenger & Instagram DM format
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

          if (tasks.length) {
            ctx.waitUntil(Promise.all(tasks));
          }
          return new Response("EVENT_RECEIVED", { status: 200 });
        }
      }

      // ==========================================
      // 2. PUBLIC API: WEBSITE LIVE CHAT (/api/chat)
      // ==========================================
      if (path === "/api/chat" && request.method === "POST") {
        const { message, customer_id = "web_guest", platform = "website" } = await request.json();
        if (!message) return Response.json({ error: "Message required" }, { status: 400, headers: corsHeaders });

        await supabase("chat_logs", "POST", { customer_id, platform, sender: "customer", message });
        const conv = await upsertConversation(customer_id, platform, message, "Web Visitor");

        if (conv && conv.ai_enabled === false) {
          return Response.json({ reply: null, paused: true }, { headers: corsHeaders });
        }

        const reply = await generateAIReply(customer_id, platform, message);
        await supabase("chat_logs", "POST", { customer_id, platform, sender: "bot", message: reply });
        await upsertConversation(customer_id, platform, reply);

        return Response.json({ reply }, { headers: corsHeaders });
      }

      // ==========================================
      // 3. STAFF API ENDPOINTS (/api/staff/*)
      // ==========================================
      if (path.startsWith("/api/staff/")) {
        if (!isStaffAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }

        if (path === "/api/staff/verify" && request.method === "GET") {
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // Inbox: List conversations
        if (path === "/api/staff/conversations" && request.method === "GET") {
          const data = await supabase("conversations", "GET", null, "?select=*&order=updated_at.desc&limit=100");
          return Response.json(data, { headers: corsHeaders });
        }

        // Inbox: Toggle AI for a conversation
        if (path === "/api/staff/conversations/toggle-ai" && request.method === "PATCH") {
          const { id, ai_enabled } = await request.json();
          const data = await supabase("conversations", "PATCH", { ai_enabled }, `?id=eq.${id}`);
          return Response.json(data, { headers: corsHeaders });
        }

        // Inbox: Get messages for a customer
        if (path === "/api/staff/messages" && request.method === "GET") {
          const cid = url.searchParams.get("customer_id");
          const plat = url.searchParams.get("platform");
          const data = await supabase(
            "chat_logs",
            "GET",
            null,
            `?customer_id=eq.${encodeURIComponent(cid)}&platform=eq.${encodeURIComponent(plat)}&order=id.asc&limit=150`
          );
          return Response.json(data, { headers: corsHeaders });
        }

        // Inbox: Staff sends manual reply
        if (path === "/api/staff/reply" && request.method === "POST") {
          const { customer_id, platform, message } = await request.json();
          await supabase("chat_logs", "POST", { customer_id, platform, sender: "staff", message });
          await upsertConversation(customer_id, platform, message);
          await sendToPlatform(platform, customer_id, message);
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // Channels: GET & PATCH
        if (path === "/api/staff/channels") {
          if (request.method === "GET") {
            const data = await supabase("channels", "GET", null, "?select=*&order=id.asc");
            return Response.json(data, { headers: corsHeaders });
          }
          if (request.method === "PATCH") {
            const { platform, page_or_phone_id, access_token, verify_token, is_active } = await request.json();
            const data = await supabase(
              "channels",
              "PATCH",
              { page_or_phone_id, access_token, verify_token, is_active, updated_at: new Date().toISOString() },
              `?platform=eq.${platform}`
            );
            return Response.json(data, { headers: corsHeaders });
          }
        }

        // Products CRUD
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

        // Payments
        if (path === "/api/staff/payments") {
          if (request.method === "GET") return Response.json(await supabase("payments", "GET", null, "?select=*&order=id.desc&limit=50"), { headers: corsHeaders });
          if (request.method === "PATCH") {
            const { id, status } = await request.json();
            return Response.json(await supabase("payments", "PATCH", { status }, `?id=eq.${id}`), { headers: corsHeaders });
          }
        }

        // Tickets
        if (path === "/api/staff/tickets") {
          if (request.method === "GET") return Response.json(await supabase("staff_tickets", "GET", null, "?select=*&order=id.desc&limit=50"), { headers: corsHeaders });
          if (request.method === "PATCH") {
            const { id, status } = await request.json();
            return Response.json(await supabase("staff_tickets", "PATCH", { status }, `?id=eq.${id}`), { headers: corsHeaders });
          }
        }
      }

      // ==========================================
      // 4. FRONTEND ROUTES
      // ==========================================
      if (path === "/staff") {
        return new Response(getStaffHTML(url.origin), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(getLandingHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
    }
  },
};

function getLandingHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Magic Store — AI Support</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: #0f1115; color: #f3f4f6; min-height: 100vh; display: flex; flex-direction: column; }
  header { background: #161920; border-bottom: 1px solid #2a2f3a; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; }
  .logo { font-size: 17px; font-weight: 700; letter-spacing: 0.5px; color: #ffffff; }
  .nav-btn { background: #222630; color: #e5e7eb; border: 1px solid #353b48; padding: 7px 14px; text-decoration: none; font-size: 13px; font-weight: 600; }
  main { flex: 1; max-width: 760px; width: 100%; margin: 24px auto; padding: 0 16px; display: flex; flex-direction: column; }
  .chat-box { background: #161920; border: 1px solid #2a2f3a; height: 540px; display: flex; flex-direction: column; }
  .chat-header { padding: 14px 18px; border-bottom: 1px solid #2a2f3a; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; }
  .status { color: #22c55e; font-size: 12px; }
  .messages { flex: 1; padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 80%; padding: 10px 14px; font-size: 14px; line-height: 1.5; border: 1px solid #2a2f3a; white-space: pre-wrap; }
  .msg.bot { align-self: flex-start; background: #1e222b; color: #e5e7eb; }
  .msg.user { align-self: flex-end; background: #2563eb; border-color: #2563eb; color: #ffffff; }
  .input-bar { display: flex; border-top: 1px solid #2a2f3a; }
  .input-bar input { flex: 1; background: #111318; border: none; color: #fff; padding: 14px 16px; font-size: 14px; outline: none; }
  .input-bar button { background: #2563eb; color: #fff; border: none; padding: 0 22px; font-weight: 600; cursor: pointer; font-size: 14px; }
</style>
</head>
<body>
  <header>
    <div class="logo">MAGIC STORE</div>
    <a href="/staff" class="nav-btn">Staff Inbox</a>
  </header>
  <main>
    <div class="chat-box">
      <div class="chat-header">
        <span>Magic Store AI Assistant</span>
        <span class="status">● Online</span>
      </div>
      <div class="messages" id="messages">
        <div class="msg bot">Assalamu Alaikum! Magic Store-e shagotom. Ki product lagbe ba kono help lagle bolun.</div>
      </div>
      <form class="input-bar" id="chatForm">
        <input type="text" id="msgInput" placeholder="Ask about Minecraft, prices, or send TrxID..." autocomplete="off" required />
        <button type="submit" id="sendBtn">Send</button>
      </form>
    </div>
  </main>
<script>
  const form = document.getElementById("chatForm");
  const input = document.getElementById("msgInput");
  const messages = document.getElementById("messages");
  const sendBtn = document.getElementById("sendBtn");
  let customerId = localStorage.getItem("ms_web_cid");
  if (!customerId) {
    customerId = "web_" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem("ms_web_cid", customerId);
  }

  function addMsg(text, cls) {
    const div = document.createElement("div");
    div.className = "msg " + cls;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMsg(text, "user");
    input.value = "";
    sendBtn.disabled = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, customer_id: customerId, platform: "website" })
      });
      const data = await res.json();
      if (data.reply) addMsg(data.reply, "bot");
    } catch {
      addMsg("Network error. Please try again.", "bot");
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });
</script>
</body>
</html>`;
}

function getStaffHTML(origin) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Magic Store — Omnichannel Inbox</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: #0f1115; color: #f3f4f6; height: 100vh; overflow: hidden; display: flex; }
  .login-wrap { margin: auto; background: #161920; border: 1px solid #2a2f3a; padding: 28px; width: 340px; }
  .login-wrap h2 { margin-bottom: 16px; font-size: 18px; }
  .login-wrap input { width: 100%; padding: 10px 12px; background: #0f1115; border: 1px solid #2a2f3a; color: #fff; margin-bottom: 12px; outline: none; }
  .login-wrap button { width: 100%; padding: 10px; background: #2563eb; color: #fff; border: none; font-weight: 600; cursor: pointer; }
  .app { display: none; width: 100%; height: 100vh; }
  .sidebar { width: 200px; background: #161920; border-right: 1px solid #2a2f3a; display: flex; flex-direction: column; padding: 18px 0; flex-shrink: 0; }
  .brand { padding: 0 18px 18px; font-weight: 700; font-size: 15px; border-bottom: 1px solid #2a2f3a; letter-spacing: 0.5px; }
  .nav-item { padding: 11px 18px; cursor: pointer; font-size: 13px; color: #9ca3af; border-left: 3px solid transparent; }
  .nav-item:hover, .nav-item.active { background: #1e222b; color: #fff; border-left-color: #2563eb; }
  .content { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .section { display: none; flex: 1; overflow-y: auto; padding: 24px; }
  .section.active { display: block; }
  .section.inbox-sec.active { display: flex; padding: 0; overflow: hidden; }

  /* Unified Inbox */
  .conv-list { width: 300px; border-right: 1px solid #2a2f3a; background: #13161c; display: flex; flex-direction: column; flex-shrink: 0; }
  .conv-top { padding: 12px; border-bottom: 1px solid #2a2f3a; display: flex; gap: 6px; }
  .conv-top input { flex: 1; background: #0f1115; border: 1px solid #2a2f3a; color: #fff; padding: 7px 10px; font-size: 12px; outline: none; }
  .conv-items { flex: 1; overflow-y: auto; }
  .conv-item { padding: 12px 14px; border-bottom: 1px solid #1f242e; cursor: pointer; }
  .conv-item:hover, .conv-item.selected { background: #1d222c; }
  .conv-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .conv-name { font-size: 13px; font-weight: 600; color: #fff; }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 6px; text-transform: uppercase; border: 1px solid #353b48; }
  .b-facebook { background: #1e3a8a; color: #bfdbfe; border-color: #2563eb; }
  .b-instagram { background: #831843; color: #fbcfe8; border-color: #db2777; }
  .b-whatsapp { background: #14532d; color: #bbf7d0; border-color: #16a34a; }
  .b-website { background: #27272a; color: #e4e4e7; border-color: #52525b; }
  .conv-preview { font-size: 12px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .chat-pane { flex: 1; display: flex; flex-direction: column; background: #0f1115; }
  .chat-top { padding: 12px 18px; background: #161920; border-bottom: 1px solid #2a2f3a; display: flex; justify-content: space-between; align-items: center; min-height: 52px; }
  .chat-body { flex: 1; padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .bubble { max-width: 72%; padding: 9px 13px; font-size: 13px; line-height: 1.45; border: 1px solid #2a2f3a; white-space: pre-wrap; }
  .bubble.customer { align-self: flex-start; background: #1b1f27; color: #f3f4f6; }
  .bubble.bot { align-self: flex-end; background: #1e293b; border-color: #334155; color: #e2e8f0; }
  .bubble.staff { align-self: flex-end; background: #2563eb; border-color: #2563eb; color: #ffffff; }
  .bubble-meta { font-size: 10px; opacity: 0.65; margin-bottom: 3px; text-transform: uppercase; }
  .chat-input { display: flex; border-top: 1px solid #2a2f3a; background: #161920; }
  .chat-input input { flex: 1; background: transparent; border: none; color: #fff; padding: 14px 16px; font-size: 13px; outline: none; }
  .chat-input button { background: #2563eb; color: #fff; border: none; padding: 0 22px; font-weight: 600; cursor: pointer; font-size: 13px; }

  /* Tables & Forms */
  h2 { font-size: 17px; margin-bottom: 16px; }
  .card { background: #161920; border: 1px solid #2a2f3a; padding: 16px; margin-bottom: 16px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  input { padding: 9px 10px; background: #0f1115; border: 1px solid #2a2f3a; color: #fff; font-size: 13px; outline: none; }
  .btn { padding: 8px 14px; background: #2563eb; color: #fff; border: none; cursor: pointer; font-weight: 600; font-size: 12px; }
  .btn-sm { padding: 5px 10px; font-size: 12px; border: 1px solid #353b48; background: #222630; color: #fff; cursor: pointer; margin-right: 6px; }
  .btn-green { background: #16a34a; border-color: #16a34a; }
  .btn-red { background: #dc2626; border-color: #dc2626; }
  table { width: 100%; border-collapse: collapse; background: #161920; border: 1px solid #2a2f3a; font-size: 13px; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #2a2f3a; }
  th { background: #1b1f27; color: #9ca3af; font-weight: 600; }
</style>
</head>
<body>
  <div class="login-wrap" id="loginBox">
    <h2>Magic Store Staff</h2>
    <input type="password" id="passInput" placeholder="Enter Staff Password" />
    <button onclick="login()">Login</button>
    <p id="loginErr" style="color:#ef4444;font-size:12px;margin-top:10px;"></p>
  </div>

  <div class="app" id="app">
    <aside class="sidebar">
      <div class="brand">MAGIC INBOX</div>
      <div class="nav-item active" onclick="switchTab('inbox', this)">Unified Inbox</div>
      <div class="nav-item" onclick="switchTab('channels', this)">Channels (FB/IG/WA)</div>
      <div class="nav-item" onclick="switchTab('products', this)">Products</div>
      <div class="nav-item" onclick="switchTab('payments', this)">Payments</div>
      <div class="nav-item" onclick="switchTab('tickets', this)">Staff Tickets</div>
      <div class="nav-item" style="margin-top:auto;" onclick="location.href='/'">← Back to Store</div>
    </aside>

    <main class="content">
      <!-- 1. UNIFIED INBOX -->
      <div id="inbox" class="section inbox-sec active">
        <div class="conv-list">
          <div class="conv-top">
            <input id="convSearch" placeholder="Search customer..." oninput="renderConvs()" />
          </div>
          <div class="conv-items" id="convItems"></div>
        </div>
        <div class="chat-pane">
          <div class="chat-top" id="chatTop">
            <span style="color:#9ca3af;font-size:13px;">Select a conversation to start chatting</span>
          </div>
          <div class="chat-body" id="chatBody"></div>
          <form class="chat-input" id="replyForm" onsubmit="sendStaffReply(event)" style="display:none;">
            <input id="replyInput" placeholder="Type a reply (sends instantly to customer)..." autocomplete="off" required />
            <button type="submit">Send</button>
          </form>
        </div>
      </div>

      <!-- 2. CHANNELS (FB / IG / WA) -->
      <div id="channels" class="section">
        <h2>Connect Facebook, Instagram & WhatsApp</h2>
        <div class="card" style="font-size:13px;line-height:1.6;">
          <div><b>Webhook Callback URL:</b> <code style="color:#60a5fa;">${origin}/webhook/meta</code></div>
          <div><b>Default Verify Token:</b> <code style="color:#60a5fa;">magicstore_verify_2026</code></div>
        </div>
        <div id="channelList"></div>
      </div>

      <!-- 3. PRODUCTS -->
      <div id="products" class="section">
        <h2>Manage Products</h2>
        <div class="card form-grid">
          <input id="pName" placeholder="Product Name (e.g. Minecraft Java)" />
          <input id="pPrice" placeholder="Price (e.g. 1500 BDT)" />
          <input id="pDesc" placeholder="Short Description" />
          <input id="pDel" placeholder="Delivery Info (e.g. Instant)" />
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
    </main>
  </div>

<script>
  let TOKEN = localStorage.getItem("staff_pass") || "";
  let CONVS = [];
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

  function startApp() {
    document.getElementById("loginBox").style.display = "none";
    document.getElementById("app").style.display = "flex";
    loadConvs();
    // Silent background sync every 3 seconds (zero flicker, super fast)
    setInterval(() => {
      if (document.getElementById("inbox").classList.contains("active")) {
        loadConvs(true);
        if (ACTIVE_CONV) loadMessages(ACTIVE_CONV, true);
      }
    }, 3000);
  }

  if (TOKEN) {
    api("verify").then(startApp).catch(() => localStorage.removeItem("staff_pass"));
  }

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

  // --- INBOX ---
  async function loadConvs(silent = false) {
    try {
      CONVS = await api("conversations");
      renderConvs();
    } catch {}
  }

  function renderConvs() {
    const q = (document.getElementById("convSearch").value || "").toLowerCase();
    const filtered = CONVS.filter(c =>
      (c.customer_name || c.customer_id).toLowerCase().includes(q) ||
      (c.last_message || "").toLowerCase().includes(q)
    );
    document.getElementById("convItems").innerHTML = filtered.map(c => {
      const sel = ACTIVE_CONV && ACTIVE_CONV.id === c.id ? "selected" : "";
      return \`
        <div class="conv-item \${sel}" onclick='selectConv(\${JSON.stringify(c)})'>
          <div class="conv-row">
            <span class="conv-name">\${c.customer_name || c.customer_id}</span>
            <span class="badge b-\${c.platform}">\${c.platform}</span>
          </div>
          <div class="conv-preview">\${c.last_message || ""}</div>
        </div>\`;
    }).join("") || '<div style="padding:16px;font-size:12px;color:#6b7280;">No conversations yet.</div>';
  }

  function selectConv(conv) {
    ACTIVE_CONV = conv;
    LAST_MSG_COUNT = 0;
    renderConvs();
    renderChatHeader();
    document.getElementById("replyForm").style.display = "flex";
    loadMessages(conv, false);
  }

  function renderChatHeader() {
    if (!ACTIVE_CONV) return;
    const c = ACTIVE_CONV;
    document.getElementById("chatTop").innerHTML = \`
      <div>
        <strong style="font-size:14px;">\${c.customer_name || c.customer_id}</strong>
        <span class="badge b-\${c.platform}" style="margin-left:8px;">\${c.platform}</span>
      </div>
      <button class="btn-sm \${c.ai_enabled ? 'btn-green' : 'btn-red'}" onclick="toggleAI()">
        AI Auto-Reply: \${c.ai_enabled ? "ON" : "PAUSED"}
      </button>\`;
  }

  async function toggleAI() {
    if (!ACTIVE_CONV) return;
    ACTIVE_CONV.ai_enabled = !ACTIVE_CONV.ai_enabled;
    renderChatHeader();
    await api("conversations/toggle-ai", "PATCH", { id: ACTIVE_CONV.id, ai_enabled: ACTIVE_CONV.ai_enabled });
  }

  async function loadMessages(conv, silent = false) {
    const msgs = await api(\`messages?customer_id=\${encodeURIComponent(conv.customer_id)}&platform=\${conv.platform}\`);
    if (silent && msgs.length === LAST_MSG_COUNT) return;
    LAST_MSG_COUNT = msgs.length;
    const body = document.getElementById("chatBody");
    body.innerHTML = msgs.map(m => \`
      <div class="bubble \${m.sender}">
        <div class="bubble-meta">\${m.sender}</div>
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

    // Optimistic UI: show immediately with zero loading
    input.value = "";
    const body = document.getElementById("chatBody");
    const div = document.createElement("div");
    div.className = "bubble staff";
    div.innerHTML = \`<div class="bubble-meta">staff</div>\${text.replace(/</g, "&lt;")}\`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    LAST_MSG_COUNT++;

    await api("reply", "POST", {
      customer_id: ACTIVE_CONV.customer_id,
      platform: ACTIVE_CONV.platform,
      message: text
    });
    loadConvs(true);
  }

  // --- CHANNELS ---
  async function loadChannels() {
    const chans = await api("channels");
    document.getElementById("channelList").innerHTML = chans.map(ch => \`
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <strong style="text-transform:uppercase;font-size:14px;">\${ch.platform}</strong>
          <label style="font-size:12px;cursor:pointer;">
            <input type="checkbox" id="act_\${ch.platform}" \${ch.is_active ? "checked" : ""} /> Active
          </label>
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
    alert(platform.toUpperCase() + " settings saved!");
  }

  // --- PRODUCTS / PAYMENTS / TICKETS ---
  async function loadProducts() {
    const prods = await api("products");
    document.getElementById("prodList").innerHTML = prods.map(p => \`
      <tr>
        <td>\${p.name}</td><td>\${p.price}</td><td>\${p.in_stock ? "In Stock" : "Out of Stock"}</td>
        <td>
          <button class="btn-sm" onclick="toggleStock(\${p.id}, \${!p.in_stock})">Toggle Stock</button>
          <button class="btn-sm btn-red" onclick="delProduct(\${p.id})">Delete</button>
        </td>
      </tr>\`).join("");
  }
  async function addProduct() {
    await api("products", "POST", {
      name: document.getElementById("pName").value,
      price: document.getElementById("pPrice").value,
      description: document.getElementById("pDesc").value,
      delivery_info: document.getElementById("pDel").value
    });
    ["pName","pPrice","pDesc","pDel"].forEach(id => document.getElementById(id).value = "");
    loadProducts();
  }
  async function toggleStock(id, in_stock) { await api("products", "PATCH", { id, in_stock }); loadProducts(); }
  async function delProduct(id) { await api("products?id=" + id, "DELETE"); loadProducts(); }

  async function loadPayments() {
    const pays = await api("payments");
    document.getElementById("payList").innerHTML = pays.map(p => \`
      <tr>
        <td>\${p.customer_id}</td><td>\${p.product_name}</td><td><b>\${p.trx_id}</b></td><td>\${p.status}</td>
        <td>
          <button class="btn-sm btn-green" onclick="updatePay(\${p.id}, 'approved')">Approve</button>
          <button class="btn-sm btn-red" onclick="updatePay(\${p.id}, 'rejected')">Reject</button>
        </td>
      </tr>\`).join("");
  }
  async function updatePay(id, status) { await api("payments", "PATCH", { id, status }); loadPayments(); }

  async function loadTickets() {
    const tickets = await api("tickets");
    document.getElementById("ticketList").innerHTML = tickets.map(t => \`
      <tr>
        <td>\${t.customer_id}</td><td>\${t.platform}</td><td>\${t.message}</td><td>\${t.status}</td>
        <td><button class="btn-sm btn-green" onclick="resolveTicket(\${t.id})">Resolve</button></td>
      </tr>\`).join("");
  }
  async function resolveTicket(id) { await api("tickets", "PATCH", { id, status: "resolved" }); loadTickets(); }
</script>
</body>
</html>`;
}

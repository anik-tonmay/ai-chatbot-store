export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Helper: Supabase REST API call
    async function supabase(table, method = "GET", body = null, query = "") {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${query}`, {
        method,
        headers: {
          "apikey": env.SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: body ? JSON.stringify(body) : null,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Supabase Error (${res.status}): ${errText}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : [];
    }

    // Helper: Staff Auth Check
    function isStaffAuthorized(req) {
      const auth = req.headers.get("Authorization");
      return auth === `Bearer ${env.STAFF_PASSWORD}`;
    }

    try {
      // ==========================================
      // 1. PUBLIC API: LIVE AI CHATBOT (/api/chat)
      // ==========================================
      if (path === "/api/chat" && request.method === "POST") {
        const { message, customer_id = "web_guest", platform = "website" } = await request.json();
        if (!message) return Response.json({ error: "Message required" }, { status: 400, headers: corsHeaders });

        // Log customer message
        await supabase("chat_logs", "POST", { customer_id, platform, sender: "customer", message });

        // Fetch live products from DB
        const products = await supabase("products", "GET", null, "?select=*&order=id.desc");
        const productContext = products.length
          ? products.map(p => `- ${p.name} | Price: ${p.price} | Stock: ${p.in_stock ? "Available" : "Out of Stock"} | Info: ${p.description || ""} | Delivery: ${p.delivery_info || ""}`).join("\n")
          : "No products added yet.";

        const systemPrompt = `You are the official AI customer support assistant for Magic Store (magicstorebd.com), a digital gaming & software storefront in Bangladesh.
Reply naturally in the user's language (Bangla, Banglish, or English). Keep replies concise, helpful, and friendly.

LIVE PRODUCT CATALOG:
${productContext}

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
              contents: [{ role: "user", parts: [{ text: message }] }],
            }),
          }
        );

        const geminiData = await geminiRes.json();
        let reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, ekhon ektu problem hocche. Ektu por abar try korun.";

        // Check for [PAYMENT:trx|product]
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

        // Check for [ESCALATE]
        if (reply.includes("[ESCALATE]")) {
          await supabase("staff_tickets", "POST", {
            customer_id,
            platform,
            message,
            status: "open",
          });
          reply = reply.replace(/\[ESCALATE\]/g, "").trim();
        }

        // Log bot reply
        await supabase("chat_logs", "POST", { customer_id, platform, sender: "bot", message: reply });

        return Response.json({ reply }, { headers: corsHeaders });
      }

      // ==========================================
      // 2. STAFF API ENDPOINTS (/api/staff/*)
      // ==========================================
      if (path.startsWith("/api/staff/")) {
        if (!isStaffAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }

        // Verify login
        if (path === "/api/staff/verify" && request.method === "GET") {
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // Products CRUD
        if (path === "/api/staff/products") {
          if (request.method === "GET") {
            const data = await supabase("products", "GET", null, "?select=*&order=id.desc");
            return Response.json(data, { headers: corsHeaders });
          }
          if (request.method === "POST") {
            const body = await request.json();
            const data = await supabase("products", "POST", body);
            return Response.json(data, { headers: corsHeaders });
          }
          if (request.method === "PATCH") {
            const { id, in_stock } = await request.json();
            const data = await supabase("products", "PATCH", { in_stock }, `?id=eq.${id}`);
            return Response.json(data, { headers: corsHeaders });
          }
          if (request.method === "DELETE") {
            const id = url.searchParams.get("id");
            await supabase("products", "DELETE", null, `?id=eq.${id}`);
            return Response.json({ deleted: true }, { headers: corsHeaders });
          }
        }

        // Payments
        if (path === "/api/staff/payments") {
          if (request.method === "GET") {
            const data = await supabase("payments", "GET", null, "?select=*&order=id.desc&limit=50");
            return Response.json(data, { headers: corsHeaders });
          }
          if (request.method === "PATCH") {
            const { id, status } = await request.json();
            const data = await supabase("payments", "PATCH", { status }, `?id=eq.${id}`);
            return Response.json(data, { headers: corsHeaders });
          }
        }

        // Tickets
        if (path === "/api/staff/tickets") {
          if (request.method === "GET") {
            const data = await supabase("staff_tickets", "GET", null, "?select=*&order=id.desc&limit=50");
            return Response.json(data, { headers: corsHeaders });
          }
          if (request.method === "PATCH") {
            const { id, status } = await request.json();
            const data = await supabase("staff_tickets", "PATCH", { status }, `?id=eq.${id}`);
            return Response.json(data, { headers: corsHeaders });
          }
        }

        // Chat Logs
        if (path === "/api/staff/logs" && request.method === "GET") {
          const data = await supabase("chat_logs", "GET", null, "?select=*&order=id.desc&limit=60");
          return Response.json(data, { headers: corsHeaders });
        }
      }

      // ==========================================
      // 3. FRONTEND: STAFF DASHBOARD (/staff)
      // ==========================================
      if (path === "/staff") {
        return new Response(getStaffHTML(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ==========================================
      // 4. FRONTEND: LANDING PAGE + LIVE CHAT (/)
      // ==========================================
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
  header { background: #161920; border-bottom: 1px solid #2a2f3a; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
  .logo { font-size: 18px; font-weight: 700; letter-spacing: 0.5px; color: #ffffff; }
  .nav-btn { background: #222630; color: #e5e7eb; border: 1px solid #353b48; padding: 8px 14px; text-decoration: none; font-size: 13px; font-weight: 600; }
  .nav-btn:hover { background: #2d3340; }
  main { flex: 1; max-width: 780px; width: 100%; margin: 28px auto; padding: 0 16px; display: flex; flex-direction: column; gap: 16px; }
  .chat-box { background: #161920; border: 1px solid #2a2f3a; height: 520px; display: flex; flex-direction: column; }
  .chat-header { padding: 14px 18px; border-bottom: 1px solid #2a2f3a; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; }
  .status { color: #22c55e; font-size: 12px; }
  .messages { flex: 1; padding: 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 80%; padding: 10px 14px; font-size: 14px; line-height: 1.5; border: 1px solid #2a2f3a; white-space: pre-wrap; }
  .msg.bot { align-self: flex-start; background: #1e222b; color: #e5e7eb; }
  .msg.user { align-self: flex-end; background: #2563eb; border-color: #2563eb; color: #ffffff; }
  .input-bar { display: flex; border-top: 1px solid #2a2f3a; }
  .input-bar input { flex: 1; background: #111318; border: none; color: #fff; padding: 14px 16px; font-size: 14px; outline: none; }
  .input-bar button { background: #2563eb; color: #fff; border: none; padding: 0 22px; font-weight: 600; cursor: pointer; font-size: 14px; }
  .input-bar button:disabled { background: #374151; cursor: not-allowed; }
</style>
</head>
<body>
  <header>
    <div class="logo">MAGIC STORE</div>
    <a href="/staff" class="nav-btn">Staff Panel</a>
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
  const customerId = "web_" + Math.random().toString(36).slice(2, 8);

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
      addMsg(data.reply || data.error || "Error occurred.", "bot");
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

function getStaffHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Magic Store — Staff Panel</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: #0f1115; color: #f3f4f6; min-height: 100vh; display: flex; }
  .login-wrap { margin: auto; background: #161920; border: 1px solid #2a2f3a; padding: 28px; width: 340px; }
  .login-wrap h2 { margin-bottom: 16px; font-size: 18px; }
  .login-wrap input { width: 100%; padding: 10px 12px; background: #0f1115; border: 1px solid #2a2f3a; color: #fff; margin-bottom: 12px; outline: none; }
  .login-wrap button { width: 100%; padding: 10px; background: #2563eb; color: #fff; border: none; font-weight: 600; cursor: pointer; }
  .app { display: none; width: 100%; min-height: 100vh; }
  .sidebar { width: 220px; background: #161920; border-right: 1px solid #2a2f3a; display: flex; flex-direction: column; padding: 20px 0; }
  .brand { padding: 0 20px 20px; font-weight: 700; font-size: 16px; border-bottom: 1px solid #2a2f3a; }
  .nav-item { padding: 12px 20px; cursor: pointer; font-size: 14px; color: #9ca3af; border-left: 3px solid transparent; }
  .nav-item:hover, .nav-item.active { background: #1e222b; color: #fff; border-left-color: #2563eb; }
  .content { flex: 1; padding: 28px; overflow-y: auto; }
  .section { display: none; }
  .section.active { display: block; }
  h2 { font-size: 18px; margin-bottom: 18px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; background: #161920; border: 1px solid #2a2f3a; padding: 16px; margin-bottom: 20px; }
  input, button { font-size: 13px; }
  .form-grid input { padding: 9px 10px; background: #0f1115; border: 1px solid #2a2f3a; color: #fff; outline: none; }
  .btn { padding: 8px 14px; background: #2563eb; color: #fff; border: none; cursor: pointer; font-weight: 600; }
  .btn-sm { padding: 5px 10px; font-size: 12px; border: 1px solid #353b48; background: #222630; color: #fff; cursor: pointer; margin-right: 6px; }
  .btn-green { background: #16a34a; border-color: #16a34a; }
  .btn-red { background: #dc2626; border-color: #dc2626; }
  table { width: 100%; border-collapse: collapse; background: #161920; border: 1px solid #2a2f3a; font-size: 13px; }
  th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid #2a2f3a; }
  th { background: #1b1f27; color: #9ca3af; font-weight: 600; }
</style>
</head>
<body>
  <div class="login-wrap" id="loginBox">
    <h2>Staff Login</h2>
    <input type="password" id="passInput" placeholder="Enter Staff Password" />
    <button onclick="login()">Login</button>
    <p id="loginErr" style="color:#ef4444;font-size:12px;margin-top:10px;"></p>
  </div>

  <div class="app" id="app">
    <aside class="sidebar">
      <div class="brand">MAGIC STAFF</div>
      <div class="nav-item active" onclick="switchTab('products', this)">Products</div>
      <div class="nav-item" onclick="switchTab('payments', this)">Payments</div>
      <div class="nav-item" onclick="switchTab('tickets', this)">Staff Tickets</div>
      <div class="nav-item" onclick="switchTab('logs', this)">Chat Logs</div>
      <div class="nav-item" style="margin-top:auto;" onclick="location.href='/'">← Back to Store</div>
    </aside>

    <main class="content">
      <div id="products" class="section active">
        <h2>Manage Products</h2>
        <div class="form-grid">
          <input id="pName" placeholder="Product Name (e.g. Minecraft Java)" />
          <input id="pPrice" placeholder="Price (e.g. 1500 BDT)" />
          <input id="pDesc" placeholder="Short Description" />
          <input id="pDel" placeholder="Delivery Info (e.g. Instant)" />
          <button class="btn" onclick="addProduct()">+ Add Product</button>
        </div>
        <table><thead><tr><th>Name</th><th>Price</th><th>Stock</th><th>Action</th></tr></thead><tbody id="prodList"></tbody></table>
      </div>

      <div id="payments" class="section">
        <h2>Payment Verification</h2>
        <table><thead><tr><th>Customer</th><th>Product</th><th>TrxID</th><th>Status</th><th>Action</th></tr></thead><tbody id="payList"></tbody></table>
      </div>

      <div id="tickets" class="section">
        <h2>Escalated Staff Tickets</h2>
        <table><thead><tr><th>Customer</th><th>Platform</th><th>Message</th><th>Status</th><th>Action</th></tr></thead><tbody id="ticketList"></tbody></table>
      </div>

      <div id="logs" class="section">
        <h2>Recent Chat Logs</h2>
        <table><thead><tr><th>Customer</th><th>Sender</th><th>Message</th></tr></thead><tbody id="logList"></tbody></table>
      </div>
    </main>
  </div>

<script>
  let TOKEN = localStorage.getItem("staff_pass") || "";

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
      document.getElementById("loginBox").style.display = "none";
      document.getElementById("app").style.display = "flex";
      loadAll();
    } catch {
      document.getElementById("loginErr").textContent = "Wrong password!";
    }
  }

  if (TOKEN) {
    api("verify").then(() => {
      document.getElementById("loginBox").style.display = "none";
      document.getElementById("app").style.display = "flex";
      loadAll();
    }).catch(() => localStorage.removeItem("staff_pass"));
  }

  function switchTab(id, el) {
    document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    document.getElementById(id).classList.add("active");
    el.classList.add("active");
    loadAll();
  }

  async function loadAll() {
    const prods = await api("products");
    document.getElementById("prodList").innerHTML = prods.map(p => \`
      <tr>
        <td>\${p.name}</td>
        <td>\${p.price}</td>
        <td>\${p.in_stock ? "In Stock" : "Out of Stock"}</td>
        <td>
          <button class="btn-sm" onclick="toggleStock(\${p.id}, \${!p.in_stock})">Toggle Stock</button>
          <button class="btn-sm btn-red" onclick="delProduct(\${p.id})">Delete</button>
        </td>
      </tr>\`).join("");

    const pays = await api("payments");
    document.getElementById("payList").innerHTML = pays.map(p => \`
      <tr>
        <td>\${p.customer_id}</td>
        <td>\${p.product_name}</td>
        <td><b>\${p.trx_id}</b></td>
        <td>\${p.status}</td>
        <td>
          <button class="btn-sm btn-green" onclick="updatePay(\${p.id}, 'approved')">Approve</button>
          <button class="btn-sm btn-red" onclick="updatePay(\${p.id}, 'rejected')">Reject</button>
        </td>
      </tr>\`).join("");

    const tickets = await api("tickets");
    document.getElementById("ticketList").innerHTML = tickets.map(t => \`
      <tr>
        <td>\${t.customer_id}</td>
        <td>\${t.platform}</td>
        <td>\${t.message}</td>
        <td>\${t.status}</td>
        <td><button class="btn-sm btn-green" onclick="resolveTicket(\${t.id})">Resolve</button></td>
      </tr>\`).join("");

    const logs = await api("logs");
    document.getElementById("logList").innerHTML = logs.map(l => \`
      <tr><td>\${l.customer_id}</td><td>\${l.sender}</td><td>\${l.message}</td></tr>\`).join("");
  }

  async function addProduct() {
    await api("products", "POST", {
      name: document.getElementById("pName").value,
      price: document.getElementById("pPrice").value,
      description: document.getElementById("pDesc").value,
      delivery_info: document.getElementById("pDel").value
    });
    ["pName","pPrice","pDesc","pDel"].forEach(id => document.getElementById(id).value = "");
    loadAll();
  }

  async function toggleStock(id, in_stock) { await api("products", "PATCH", { id, in_stock }); loadAll(); }
  async function delProduct(id) { await api("products?id=" + id, "DELETE"); loadAll(); }
  async function updatePay(id, status) { await api("payments", "PATCH", { id, status }); loadAll(); }
  async function resolveTicket(id) { await api("tickets", "PATCH", { id, status: "resolved" }); loadAll(); }
</script>
</body>
</html>`;
}

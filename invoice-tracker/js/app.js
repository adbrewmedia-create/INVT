// ===== Invoice Tracker app =====
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const M = (c) => L.money(L.fromC(c));
const docId = (s) => String(s).replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").replace(/^\.+$/, "_") || "_";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const DEFAULT_SETTINGS = {
  company: "", cc_reg: "", vat_no: "", owner_email: "", ca_email: "",
  vat_rate: 15, vat_basis: "invoice", vat_category: "B", fy_end_month: 2, default_terms: 30,
  reminders: { pre: 3, r1: 1, every: 7, call: 28 }, test_mode: true, live_clients: [],
  payment_details: "Bank: FNB · Account: (your account no.) · Branch: 250655 · Reference: invoice number",
  tpl_pre: "Hi {client_name},\n\nA quick heads-up that invoice {invoice_no} for {gross} is due on {due_date}.\n\n{payment_details}\n\nThanks!",
  tpl_r1: "Hi {client_name},\n\nInvoice {invoice_no} for {gross} was due on {due_date} and is now {days_late} day(s) overdue. The balance is {balance}.\n\n{payment_details}\n\nPlease let me know if anything is holding up payment.",
  tpl_rn: "Hi {client_name},\n\nFollowing up on invoice {invoice_no}: {balance} is now {days_late} days overdue (due {due_date}).\n\nPlease arrange payment this week or reply with a payment date.\n\n{payment_details}",
  expense_categories: ["Bank charges", "Communications", "Computer & software", "Insurance", "Motor vehicle", "Office expenses", "Professional fees", "Rent", "Subscriptions", "Travel", "Other"],
  income_category: "Sales", as_of: "",
};

const S = {
  db: null, ready: { settings: false, clients: false, invoices: false, expenses: false, bank: false, periods: false }, slow: false, dbError: null,
  data: { settings: { ...DEFAULT_SETTINGS }, clients: [], invoices: [], expenses: [], bank: [], periods: {} },
  view: "invoices", f: { tab: "All", fy: null, month: "", client: "", q: "" },
  ledgerMonth: null, ledgerTab: "All", closeMonth: null, drawer: null, modal: null, pack: { income: true, vat: true, ledger: true, files: true, debtors: true, creditors: true },
};
const set = () => S.data.settings;
function today() {
  if (set().as_of) return set().as_of;
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date()); } catch { return L.iso(new Date()); }
}
const clientById = (id) => S.data.clients.find((c) => c.id === id);
const invByNo = (no) => S.data.invoices.find((i) => i.invoice_no === no);
const periodStatus = (p) => (S.data.periods[p] && S.data.periods[p].status) || "Open";
const locked = (p) => ["With CA", "Signed off"].includes(periodStatus(p));

// ---------- toast ----------
let toastT;
function toast(msg) { let t = $(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); } t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3200); }

// ---------- db ----------
async function write(fn, okMsg) {
  if (!S.db) { toast("Saving isn't available in this view."); return false; }
  try { await fn(); if (okMsg) toast(okMsg); return true; }
  catch (e) { toast(e && e.code === "quota_exceeded" ? "Storage is full. Delete old records and try again." : "Couldn't save: " + (e && e.message || "unknown error")); return false; }
}
const saveInvoice = (inv) => S.db.doc("invoices/" + docId(inv.invoice_no)).set(JSON.parse(JSON.stringify(inv)));
const saveExpense = (e) => S.db.doc("expenses/" + e.id).set(JSON.parse(JSON.stringify(e)));
const saveClient = (c) => S.db.doc("clients/" + c.id).set(JSON.parse(JSON.stringify(c)));
const savePeriod = (p, body) => S.db.doc("periods/" + p).set(JSON.parse(JSON.stringify(body)));

function subscribe() {
  const coll = (name, key, map) => S.db.collection(name).onSnapshot((snap) => {
    S.data[key] = map ? map(snap) : snap.docs.map((d) => ({ ...d.data(), _id: d.id }));
    if (!snap.metadata.fromCache) S.ready[key] = true; render();
  }, (e) => { S.dbError = e; render(); });
  S.db.doc("config/settings").onSnapshot((d) => {
    S.data.settings = { ...DEFAULT_SETTINGS, ...(d.exists ? d.data() : {}), reminders: { ...DEFAULT_SETTINGS.reminders, ...((d.exists && d.data().reminders) || {}) } };
    if (!d.metadata.fromCache) S.ready.settings = true; render();
  }, (e) => { S.dbError = e; render(); });
  coll("clients", "clients"); coll("invoices", "invoices"); coll("expenses", "expenses"); coll("bank", "bank");
  coll("periods", "periods", (snap) => Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])));
  setTimeout(() => { if (!Object.values(S.ready).every(Boolean)) { S.slow = true; render(); } }, 10000);
}

// ---------- derived ----------
function enriched() {
  const t = today();
  return S.data.invoices.map((inv) => {
    const tot = L.invoiceTotals(inv), st = L.status(inv, t), paid = L.paidC(inv);
    return { inv, ...tot, st, paidC: paid, balC: tot.grossC - paid, late: st === "Overdue" ? L.daysLate(inv, t) : 0, client: clientById(inv.client_id) };
  });
}
function followNote(e) {
  const t = today();
  if (e.st === "Paid") return "Paid " + (L.paidDate(e.inv) || "");
  if (e.st === "Void" || e.st === "Draft") return e.st === "Draft" ? "Not sent" : "";
  if (L.isOverpaid(e.inv)) return "Overpaid: review";
  if (e.inv.reminders_paused) return "Reminders paused";
  const plan = L.reminderPlan(e.inv, set(), e.client, t);
  if (plan.find((r) => r.kind === "call" && (r.state === "due"))) return "28+ days late: phone the client";
  const lastSent = plan.filter((r) => r.state === "sent").pop();
  const nx = plan.find((r) => r.state === "due" || r.state === "scheduled");
  const parts = [];
  if (lastSent) parts.push(`${lastSent.step === "pre" ? "Heads-up" : lastSent.step} sent ${lastSent.sentAt ? lastSent.sentAt.slice(0, 10) : ""}`);
  if (nx) parts.push(nx.state === "due" ? `${nx.step === "pre" ? "Heads-up" : nx.step} due today` : `Next: ${nx.step === "pre" ? "heads-up" : nx.step} ${nx.date}`);
  if (e.paidC > 0) parts.push(`${M(e.balC)} left`);
  return parts.join(" · ");
}
const pillClass = (st) => "p-" + st.split(" ")[0];
const pill = (st, extra) => `<span class="pill ${pillClass(st)}">${esc(st)}${extra ? " · " + esc(extra) : ""}</span>`;

// ---------- render root ----------
const VIEWS = [["invoices", "Invoices"], ["ledger", "Ledger"], ["close", "Month-end & CA"], ["settings", "Settings"]];
function render() {
  const app = $("#shell");
  const s = set();
  const fyEnd = L.fyOf(today(), s.fy_end_month);
  if (S.f.fy == null) S.f.fy = fyEnd;
  if (!S.ledgerMonth) S.ledgerMonth = L.ym(today());
  if (!S.closeMonth) S.closeMonth = L.addMonths(L.ym(today()), -1);
  const scroll = window.scrollY;
  const focusId = document.activeElement && document.activeElement.id; const selStart = document.activeElement && document.activeElement.selectionStart;
  app.innerHTML = `
  <header class="top"><div class="wrap">
    <div class="brand"><b>${esc(s.company || "Invoice Tracker")}</b><span>${s.company ? "Invoice tracker & books" : "Set your company name in Settings"}</span></div>
    <nav class="tabs" aria-label="Sections">${VIEWS.map(([k, l]) => `<button data-view="${k}" ${S.view === k ? 'aria-current="page"' : ""}>${l}</button>`).join("")}</nav>
    <div class="top-right">
      ${s.as_of ? `<span class="chip p-info" title="Simulated date set in Settings">As of ${esc(s.as_of)}</span>` : ""}
      ${S.standalone ? `<span class="chip" title="Data is kept in this browser's local storage. Download a backup from Settings.">Saved in this browser</span>` : ""}
      <span class="chip ${s.test_mode ? "test" : "live"}">${s.test_mode ? "Reminders: test mode" : "Reminders: live"}</span>
    </div>
  </div></header>
  <main class="wrap">${body()}</main>
  ${S.drawer ? drawerHTML() : ""}
`;
  window.scrollTo(0, scroll);
  if (focusId && !S.modal) { const el = document.getElementById(focusId); if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch {} } }
}
function body() {
  if (!S.db && S.noDb) return `<div class="banner bad">This view can't reach the data store, so nothing can be loaded or saved here. Open the artifact signed in to claude.ai.</div>` + viewHTML();
  if (S.dbError) return `<div class="banner bad">The data store stopped responding (${esc(S.dbError.code)}). Reload the page to reconnect.</div>` + viewHTML();
  const loading = S.db && !Object.values(S.ready).every(Boolean) && !S.data.invoices.length && !S.data.expenses.length;
  if (loading) return S.slow ? `<div class="banner warn">The books can't be reached yet. They'll appear as soon as the store answers.</div>` : `<div class="loading">Loading the books…</div>`;
  return viewHTML();
}
const viewHTML = () => ({ invoices: invoicesView, ledger: ledgerView, close: closeView, settings: settingsView }[S.view])();

// ---------- INVOICES ----------
function invoicesView() {
  const t = today(), s = set(), all = enriched();
  const live = all.filter((e) => e.st !== "Void");
  const sum = (arr, k) => arr.reduce((a, e) => a + e[k], 0);
  const outs = live.filter((e) => e.st === "Outstanding" || e.st === "Partially paid");
  const over = live.filter((e) => e.st === "Overdue");
  const lastM = L.addMonths(L.ym(t), -1);
  let paidLastC = 0, paidLastVatC = 0;
  live.forEach((e) => L.paymentSplits(e.inv).forEach((p) => { if (L.ym(p.date) === lastM) { paidLastC += p.amountC; paidLastVatC += p.vatC; } }));
  const vatOfBal = (arr) => arr.reduce((a, e) => a + (e.grossC ? L.divHalfUp(e.balC * e.vatC, e.grossC) : 0), 0);
  let next = null;
  live.forEach((e) => { let n = L.nextReminder(e.inv, s, e.client, t); if (n && n.kind === "email") { n = { ...n, date: n.date < t ? t : n.date }; if (!next || n.date < next.n.date) next = { n, e }; } });
  const callFlags = live.filter((e) => L.reminderPlan(e.inv, s, e.client, t).some((r) => r.kind === "call" && r.state === "due"));
  const dueToday = live.filter((e) => L.reminderPlan(e.inv, s, e.client, t).some((r) => r.kind === "email" && r.state === "due"));

  // filters
  const fy = L.fyRange(S.f.fy, s.fy_end_month);
  const inScope = all.filter((e) => {
    const d = e.inv.issue_date || "";
    if (S.f.fy !== "all" && d && (d < fy.start || d > fy.end)) return false;
    if (S.f.month && L.ym(d) !== S.f.month) return false;
    if (S.f.client && e.inv.client_id !== S.f.client) return false;
    if (S.f.q) { const q = S.f.q.toLowerCase(); if (!(e.inv.invoice_no.toLowerCase().includes(q) || (e.client?.name || "").toLowerCase().includes(q))) return false; }
    return true;
  });
  const TABS = ["All", "Outstanding", "Overdue", "Partially paid", "Paid", "Draft"];
  const counts = Object.fromEntries(TABS.map((k) => [k, k === "All" ? inScope.filter((e) => e.st !== "Void").length : inScope.filter((e) => e.st === k).length]));
  let rows = S.f.tab === "All" ? inScope : inScope.filter((e) => e.st === S.f.tab);
  if (S.f.tab === "Overdue") rows = rows.sort((a, b) => a.inv.due_date.localeCompare(b.inv.due_date));
  else rows = rows.sort((a, b) => (b.inv.issue_date || "9999").localeCompare(a.inv.issue_date || "9999") || b.inv.invoice_no.localeCompare(a.inv.invoice_no));
  const totRows = rows.filter((e) => e.st !== "Void");
  const fyOptions = [];
  const years = new Set([L.fyOf(t, s.fy_end_month)]); S.data.invoices.forEach((i) => i.issue_date && years.add(L.fyOf(i.issue_date, s.fy_end_month)));
  [...years].sort((a, b) => b - a).forEach((y) => fyOptions.push(`<option value="${y}" ${S.f.fy == y ? "selected" : ""}>${esc(L.fyLabel(y, s.fy_end_month))}</option>`));
  const months = []; for (let p = fy.startP; p <= fy.endP; p = L.addMonths(p, 1)) months.push(p);
  const periodLabel = (S.f.month ? L.monthLabel(S.f.month) : (S.f.fy === "all" ? "All years" : L.fyLabel(S.f.fy, s.fy_end_month))) + (S.f.client ? " · " + (clientById(S.f.client)?.name || "") : "") + (S.f.tab !== "All" ? " · " + S.f.tab : "");
  const action = (e) => ({ Draft: ["send", "Send"], Outstanding: ["remind", "Send reminder"], Overdue: ["remind", "Chase now"], "Partially paid": ["pay", "Record payment"], Paid: ["view", "View"], Void: ["view", "View"] }[e.st]);

  return `
  <div class="pagehead"><div><h1>Invoices</h1><p>Status updates itself from due dates and payments. Amounts are gross with VAT underneath.</p></div>
    <div class="actions"><button class="btn" data-act="run-reminders">Run today's reminders${dueToday.length ? ` (${dueToday.length})` : ""}</button><button class="btn" data-act="import-inv">Import CSV</button><button class="btn primary" data-act="new-inv">New invoice</button></div></div>
  ${!S.data.invoices.length ? `<div class="banner info">No invoices yet. Import this financial year's invoices from a CSV, or load example data from Settings to try the flows first.<button class="btn sm" data-act="import-inv">Import CSV</button></div>` : ""}
  ${S.data.invoices.some((i) => i.example) ? `<div class="banner warn">These are example invoices, not real figures. Clear them in Settings before importing the CC's invoices.<button class="btn sm" data-view="settings">Settings</button></div>` : ""}
  ${callFlags.length ? `<div class="banner bad">${callFlags.length} invoice${callFlags.length > 1 ? "s are" : " is"} 28+ days late. Email reminders stop here; phone the client: ${callFlags.map((e) => esc(e.client?.name || "") + " (" + esc(e.inv.invoice_no) + ")").join(", ")}.</div>` : ""}
  <div class="tiles">
    <div class="tile"><div class="k">Outstanding</div><div class="v">${M(sum(outs, "balC"))}</div><div class="s">VAT ${M(vatOfBal(outs))} · ${outs.length} not yet due</div></div>
    <div class="tile ${over.length ? "bad" : ""}"><div class="k">Overdue</div><div class="v">${M(sum(over, "balC"))}</div><div class="s">VAT ${M(vatOfBal(over))} · ${over.length} invoice${over.length === 1 ? "" : "s"}</div></div>
    <div class="tile"><div class="k">Paid in ${L.monthLabel(lastM)}</div><div class="v">${M(paidLastC)}</div><div class="s">VAT ${M(paidLastVatC)}</div></div>
    <div class="tile"><div class="k">Next auto-reminder</div><div class="v" style="font-size:18px">${next ? esc(next.n.date) : "None scheduled"}</div><div class="s">${next ? esc(next.e.client?.name || "") + " · " + esc(next.e.inv.invoice_no) + " · " + (next.n.step === "pre" ? "heads-up" : next.n.step) : "Nothing unpaid with reminders on"}</div></div>
  </div>
  <div class="bar">
    <div class="seg" role="group" aria-label="Status">${TABS.map((k) => `<button data-tab="${k}" aria-pressed="${S.f.tab === k}">${k}<span class="c">${counts[k]}</span></button>`).join("")}</div>
  </div>
  <div class="bar">
    <select id="f-fy" aria-label="Financial year">${fyOptions.join("")}<option value="all" ${S.f.fy === "all" ? "selected" : ""}>All years</option></select>
    <select id="f-month" aria-label="Month" ${S.f.fy === "all" ? "disabled" : ""}><option value="">All months</option>${months.map((p) => `<option value="${p}" ${S.f.month === p ? "selected" : ""}>${L.monthLabel(p)}</option>`).join("")}</select>
    <select id="f-client" aria-label="Client"><option value="">All clients</option>${[...S.data.clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${esc(c.id)}" ${S.f.client === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <input type="search" id="f-q" placeholder="Search client or invoice #" value="${esc(S.f.q)}" aria-label="Search">
  </div>
  <div class="sumline"><b>${esc(periodLabel)}</b><span>${totRows.length} invoice${totRows.length === 1 ? "" : "s"}</span><span>Net <span class="num">${M(sum(totRows, "netC"))}</span></span><span>VAT <span class="num">${M(sum(totRows, "vatC"))}</span></span><span>Total <span class="num">${M(sum(totRows, "grossC"))}</span></span></div>
  <div class="tablebox"><table>
    <thead><tr><th>Invoice #</th><th>Client</th><th>Issued</th><th>Due</th><th class="n">Net</th><th class="n">VAT</th><th class="n">Total</th><th>Status</th><th>Follow-up</th><th></th></tr></thead>
    <tbody>${rows.map((e) => { const a = action(e); return `<tr class="click" data-open="${esc(e.inv.invoice_no)}">
      <td><b>${esc(e.inv.invoice_no)}</b></td><td>${esc(e.client?.name || "—")}</td><td class="num" style="text-align:left">${esc(e.inv.issue_date || "—")}</td><td class="num" style="text-align:left">${esc(e.inv.due_date || "—")}</td>
      <td class="n">${M(e.netC)}</td><td class="n">${M(e.vatC)}</td><td class="n">${M(e.grossC)}</td>
      <td>${pill(e.st, e.st === "Overdue" ? e.late + "d" : "")}</td><td class="note">${esc(followNote(e))}</td>
      <td style="text-align:right"><button class="btn sm ${a[0] === "remind" && e.st === "Overdue" ? "primary" : ""}" data-row-act="${a[0]}" data-no="${esc(e.inv.invoice_no)}">${a[1]}</button></td></tr>`; }).join("") ||
      `<tr><td colspan="10"><div class="empty"><b>No invoices match</b>Change the filters above, or import invoices.</div></td></tr>`}</tbody>
  </table></div>`;
}

// ---------- DRAWER: invoice detail ----------
function drawerHTML() {
  const inv = invByNo(S.drawer); if (!inv) { S.drawer = null; return ""; }
  const t = today(), s = set(), c = clientById(inv.client_id);
  const tot = L.invoiceTotals(inv), st = L.status(inv, t), paid = L.paidC(inv), bal = tot.grossC - paid;
  const plan = L.reminderPlan(inv, s, c, t);
  const splits = L.paymentSplits(inv);
  const lines = inv.lines && inv.lines.length ? inv.lines : [{ description: "Services", qty: 1, unit_price: L.fromC(tot.netC) }];
  const lockedP = inv.issue_date && locked(L.ym(inv.issue_date));
  // timeline
  const ev = [{ d: (inv.created_at || inv.issue_date || "").slice(0, 10), t: "Recorded", done: true }];
  if (inv.sent_at) ev.push({ d: inv.sent_at.slice(0, 10), t: "Sent to " + (c?.billing_email || "client"), done: true });
  (inv.reminders_sent || []).forEach((r) => ev.push({ d: r.at.slice(0, 10), t: `${r.step === "pre" ? "Heads-up" : r.step} sent${r.test ? " (test mode, to " + (s.owner_email || "owner") + ")" : ""}`, done: true }));
  if (inv.due_date) ev.push({ d: inv.due_date, t: "Due date", done: t >= inv.due_date });
  splits.forEach((p) => ev.push({ d: p.date, t: `Payment ${M(p.amountC)} (VAT ${M(p.vatC)})${p.method ? " · " + p.method : ""}${p.ref ? " · " + p.ref : ""}`, done: true }));
  if (inv.void) ev.push({ d: (inv.voided_at || "").slice(0, 10), t: "Voided", done: true });
  ev.sort((a, b) => a.d.localeCompare(b.d));
  const nx = plan.find((r) => r.state === "due" || r.state === "scheduled");
  if (nx) ev.push({ d: nx.state === "due" ? t : nx.date, t: `Next: ${nx.kind === "call" ? "flag to phone client" : (nx.step === "pre" ? "heads-up email" : nx.step + " email")}`, next: true });
  const stLabel = { sent: "Sent", off: "Off", cancelled: "Cancelled", skipped: "Skipped", missed: "Missed", due: "Due today", scheduled: "Scheduled" };
  const stCls = { sent: "p-ok", off: "p-mute", cancelled: "p-mute", skipped: "p-mute", missed: "p-mute", due: "p-warn", scheduled: "p-info" };
  return `<div class="drawer-back" data-close-drawer></div>
  <aside class="drawer" aria-label="Invoice ${esc(inv.invoice_no)}">
    <div class="dhead"><div><h3>Invoice</h3><h1 style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${esc(inv.invoice_no)} ${pill(st, st === "Overdue" ? L.daysLate(inv, t) + " days late" : "")}</h1>
      <p class="muted" style="margin:6px 0 0">${esc(c?.name || "—")} · ${esc(c?.billing_email || "no billing email")} · Issued ${esc(inv.issue_date || "—")} · Due ${esc(inv.due_date || "—")}</p></div>
      <button class="btn sm" data-close-drawer aria-label="Close">Close</button></div>
    ${L.isOverpaid(inv) ? `<div class="banner bad">Payments exceed the invoice total by ${M(paid - tot.grossC)}. The excess needs a refund or allocation before this month closes.</div>` : ""}
    ${lockedP ? `<div class="banner info">${esc(L.monthLabel(L.ym(inv.issue_date)))} is ${esc(periodStatus(L.ym(inv.issue_date)).toLowerCase())}; invoice details are locked.</div>` : ""}
    <div class="actions" style="margin-bottom:16px">
      ${!inv.sent_at && !inv.void ? `<button class="btn primary" data-act="send-inv">Send invoice</button>` : ""}
      ${inv.sent_at && !inv.void && st !== "Paid" ? `<button class="btn ${st === "Overdue" ? "primary" : ""}" data-act="remind-now">Send reminder now</button><button class="btn" data-act="mark-paid">Mark as paid</button><button class="btn" data-act="part-paid">Record partial payment</button>` : ""}
      ${!inv.void && paid === 0 && !lockedP ? `<button class="btn" data-act="edit-inv">Edit</button><button class="btn danger" data-act="void-inv">Void</button>` : ""}
    </div>
    <section class="card">
      <table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Net</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(l.qty)}</td><td class="n">${L.money(l.unit_price)}</td><td class="n">${M(L.divHalfUp(L.toC(l.unit_price) * Math.round(Number(l.qty) * 1000), 1000))}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="3">Subtotal excl. VAT</td><td class="n">${M(tot.netC)}</td></tr>
      <tr><td colspan="3">VAT @ ${tot.rate}%${inv.vat_treatment === "zero" ? " (zero-rated)" : ""}</td><td class="n">${M(tot.vatC)}</td></tr>
      <tr><td colspan="3">Total due incl. VAT</td><td class="n">${M(tot.grossC)}</td></tr>
      ${paid ? `<tr><td colspan="3">Paid</td><td class="n">${M(paid)}</td></tr><tr><td colspan="3">Balance</td><td class="n">${M(bal)}</td></tr>` : ""}</tfoot></table>
      <div class="kv small" style="margin-top:12px">
        <span class="muted">Our VAT no.</span><span>${esc(s.vat_no || "Not set")}</span>
        <span class="muted">Client VAT no.</span><span>${esc(c?.vat_number || "")}${!c?.vat_number && inv.vat_treatment !== "zero" ? '<span class="pill p-warn">Missing</span>' : ""}</span>
        <span class="muted">VAT treatment</span><span>${inv.vat_treatment === "zero" ? "Zero-rated" : "Standard rate"}</span>
        <span class="muted">Payment terms</span><span>${inv.issue_date && inv.due_date ? L.diffDays(inv.due_date, inv.issue_date) + " days" : "—"}</span>
        <span class="muted">Ledger category</span><span>${esc(inv.category || s.income_category)}</span>
      </div>
    </section>
    <div class="grid2">
      <section class="card"><h2>Follow-up</h2><ul class="timeline">${ev.map((e) => `<li class="${e.done ? "done" : ""} ${e.next ? "next" : ""}"><span class="d">${esc(e.d)}</span>${esc(e.t)}</li>`).join("")}</ul></section>
      <section class="card"><h2>Reminder schedule</h2>
        <label class="small" style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input type="checkbox" id="pause" ${inv.reminders_paused ? "checked" : ""} ${!inv.sent_at || st === "Paid" || inv.void ? "disabled" : ""}> Pause reminders for this invoice</label>
        ${c && c.reminders_enabled === false ? `<p class="small warns">Reminders are off for this client.</p>` : ""}
        <table class="sched"><tbody>${plan.map((r) => `<tr><td><input type="checkbox" aria-label="Use step ${esc(r.step)}" data-step="${esc(r.step)}" ${r.state !== "off" ? "checked" : ""} ${r.state === "sent" || !inv.sent_at ? "disabled" : ""}></td><td><b>${r.step === "pre" ? "Pre-due" : esc(r.step === "call" ? "Call" : r.step)}</b> <span class="muted small">${esc(r.label)}</span></td><td class="num">${esc(r.date)}</td><td><span class="pill ${stCls[r.state]}">${stLabel[r.state]}</span></td></tr>`).join("") || `<tr><td class="muted">No due date set.</td></tr>`}</tbody></table>
        <p class="small muted" style="margin:8px 0 0">Weekend and public-holiday sends move to the next business day.</p>
      </section>
    </div>
  </aside>`;
}

// ---------- LEDGER ----------
function ledgerView() {
  const s = set(), p = S.ledgerMonth, rows = L.ledgerRows(p, S.data, s);
  const inc = rows.filter((r) => r.type === "Income"), exp = rows.filter((r) => r.type === "Expense");
  const sum = (a, k) => a.reduce((x, r) => x + (r[k] || 0), 0);
  const incNet = sum(inc, "netC"), expNet = sum(exp, "netC");
  const shown = S.ledgerTab === "All" ? rows : S.ledgerTab === "Income" ? inc : exp;
  const matches = L.matchBank(S.data);
  const bankM = S.data.bank.filter((b) => L.ym(b.date) === p);
  const unmatched = bankM.filter((b) => matches[b.id]?.state === "unmatched");
  const lk = locked(p);
  const stCls = { "Auto-categorised": "p-info", "Needs review": "p-warn", Reviewed: "p-ok" };
  const rcCls = { Attached: "p-ok", Missing: "p-warn", "Invoice PDF": "p-mute", Statement: "p-mute" };
  return `
  <div class="pagehead"><div><h1>Ledger</h1><p>Cash basis: income on the day it's received, expenses on the day they're paid.</p></div>
    <div class="actions">${monthPicker("ledger", p)}<button class="btn" data-act="import-bank" ${lk ? "disabled" : ""}>Import bank CSV</button><button class="btn primary" data-act="add-exp" ${lk ? "disabled" : ""}>Add expense</button></div></div>
  ${lk ? `<div class="banner info">${L.monthLabel(p)} is ${periodStatus(p).toLowerCase()}. Lines are frozen; reopen the month in Month-end to change them.</div>` : ""}
  <div class="tiles">
    <div class="tile"><div class="k">Income excl. VAT</div><div class="v">${M(incNet)}</div><div class="s">Output VAT on receipts ${M(sum(inc, "vatC"))}</div></div>
    <div class="tile"><div class="k">Expenses excl. VAT</div><div class="v">${M(expNet)}</div><div class="s">Claimable input VAT ${M(sum(exp, "claimC"))}${sum(exp, "vatC") - sum(exp, "claimC") ? ` · ${M(sum(exp, "vatC") - sum(exp, "claimC"))} waiting on receipts` : ""}</div></div>
    <div class="tile ${incNet - expNet < 0 ? "bad" : ""}"><div class="k">Net profit</div><div class="v">${M(incNet - expNet)}</div><div class="s">Before tax, cash basis</div></div>
    <div class="tile"><div class="k">Sync</div><div class="v" style="font-size:16px">${S.standalone ? "Saved in this browser" : S.db ? "Saved to the books store" : "Not connected"}</div><div class="s">Google Sheet sync arrives with the Apps Script build</div></div>
  </div>
  ${unmatched.length ? `<div class="card" style="margin-bottom:16px"><h2>Bank lines to match · ${unmatched.length}</h2><p class="small muted" style="margin:-4px 0 10px">These lines don't match a recorded payment or expense (same amount ± R0.01, within 5 days). The month can't close until each is handled.</p>
    <div class="tablebox"><table><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th class="n">Amount</th><th></th></tr></thead><tbody>
    ${unmatched.map((b) => `<tr><td class="num" style="text-align:left">${esc(b.date)}</td><td>${esc(b.description)}</td><td class="muted">${esc(b.reference || "")}</td><td class="n">${L.money(b.amount)}</td><td style="text-align:right;white-space:nowrap">${b.amount < 0 ? `<button class="btn sm" data-bank-exp="${esc(b.id)}" ${lk ? "disabled" : ""}>Create expense</button>` : `<button class="btn sm" data-bank-pay="${esc(b.id)}" ${lk ? "disabled" : ""}>Apply to invoice</button>`} <button class="btn sm" data-bank-ignore="${esc(b.id)}" ${lk ? "disabled" : ""}>Not business / transfer</button></td></tr>`).join("")}
    </tbody></table></div></div>` : ""}
  <div class="bar"><div class="seg" role="group" aria-label="Type">${["All", "Income", "Expenses"].map((k) => `<button data-ltab="${k}" aria-pressed="${S.ledgerTab === k}">${k}<span class="c">${k === "All" ? rows.length : k === "Income" ? inc.length : exp.length}</span></button>`).join("")}</div>
    ${bankM.length ? `<span class="small muted">${bankM.length} bank lines this month · ${bankM.length - unmatched.length} matched or excluded</span>` : ""}</div>
  <div class="tablebox"><table>
    <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Source</th><th>Receipt</th><th class="n">Net</th><th class="n">VAT</th><th class="n">Gross</th><th>Status</th></tr></thead>
    <tbody>${shown.map((r) => `<tr class="click" ${r.type === "Income" ? `data-open="${esc(r.invoice_no)}"` : `data-exp="${esc(r.expense.id)}"`}>
      <td class="num" style="text-align:left">${esc(r.date)}</td><td class="desc">${r.type === "Expense" ? "" : '<span class="muted small">Income · </span>'}${esc(r.description)}</td><td>${esc(r.category || "—")}</td><td class="small">${esc(r.source)}</td>
      <td><span class="pill ${rcCls[r.receipt] || "p-mute"}">${esc(r.receipt)}</span></td>
      <td class="n">${r.type === "Expense" ? "−" : ""}${M(r.netC)}</td><td class="n">${M(r.vatC)}${r.type === "Expense" && r.vatC !== r.claimC ? ' <span title="Not claimable until a receipt with the supplier VAT number is attached" class="warns">*</span>' : ""}</td><td class="n">${r.type === "Expense" ? "−" : ""}${M(r.grossC)}</td>
      <td><span class="pill ${stCls[r.status]}">${esc(r.status)}</span></td></tr>`).join("") || `<tr><td colspan="9"><div class="empty"><b>Nothing in ${L.monthLabel(p)}</b>Payments recorded on invoices land here automatically. Add expenses or import a bank CSV.</div></td></tr>`}</tbody>
    ${shown.length ? `<tfoot><tr><td colspan="5">Net profit ${M(incNet - expNet)} · Net cash movement ${M(sum(inc, "grossC") - sum(exp, "grossC"))}</td><td class="n">${M(incNet - expNet)}</td><td class="n">${M(sum(inc, "vatC") - sum(exp, "claimC"))}</td><td class="n">${M(sum(inc, "grossC") - sum(exp, "grossC"))}</td><td></td></tr></tfoot>` : ""}
  </table></div>
  <p class="small muted">VAT payable depends on the CC's VAT basis and the two-month SARS period, so it lives on Month-end & CA. * input VAT not claimable yet.</p>`;
}
function monthPicker(which, p) {
  const opts = []; const end = L.addMonths(L.ym(today()), 1);
  let start = L.addMonths(end, -24);
  [...S.data.invoices.map((i) => i.issue_date), ...S.data.expenses.map((e) => e.date)].forEach((d) => { if (d && L.ym(d) < start) start = L.ym(d); });
  for (let x = end; x >= start; x = L.addMonths(x, -1)) opts.push(`<option value="${x}" ${x === p ? "selected" : ""}>${L.monthLabel(x)}${periodStatus(x) !== "Open" ? " · " + periodStatus(x) : ""}</option>`);
  return `<select id="mp-${which}" aria-label="Month">${opts.join("")}</select>`;
}

// ---------- MONTH-END ----------
function closeData(p) {
  const s = set(), rows = L.ledgerRows(p, S.data, s);
  const matches = L.matchBank(S.data);
  const bankM = S.data.bank.filter((b) => L.ym(b.date) === p);
  const unmatched = bankM.filter((b) => matches[b.id]?.state === "unmatched");
  const exp = rows.filter((r) => r.type === "Expense"), inc = rows.filter((r) => r.type === "Income");
  const review = exp.filter((r) => r.status === "Needs review" || !r.category);
  const missing = exp.filter((r) => r.receipt === "Missing" && r.expense.vatable);
  const overpaid = S.data.invoices.filter((i) => L.isOverpaid(i) && (i.payments || []).some((x) => L.ym(x.date) <= p));
  const debtors = L.debtorsAt(L.monthEnd(p), S.data, today());
  const vp = L.vatPeriodOf(p, s.vat_category);
  const vatMonths = [vp.start, vp.end];
  const vat = L.vatFor(vatMonths, S.data, s);
  const vatThis = L.vatFor([p], S.data, s);
  const byCat = (arr) => { const m = {}; arr.forEach((r) => { m[r.category || "Uncategorised"] = (m[r.category || "Uncategorised"] || 0) + r.netC; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const creditors = []; // expenses are cash-basis in the mockup: nothing owed is tracked
  return { rows, inc, exp, review, missing, unmatched, bankM, overpaid, debtors, vp, vat, vatThis, incCats: byCat(inc), expCats: byCat(exp), creditors,
    blocking: review.length + unmatched.length + overpaid.length };
}
function closeView() {
  const s = set(), p = S.closeMonth, d = closeData(p), st = periodStatus(p), per = S.data.periods[p] || {};
  const incNet = d.inc.reduce((a, r) => a + r.netC, 0), expNet = d.exp.reduce((a, r) => a + r.netC, 0);
  const vpDone = locked(d.vp.start) && locked(d.vp.end) && periodStatus(d.vp.start) === "Signed off" && periodStatus(d.vp.end) === "Signed off";
  const isFuture = L.monthEnd(p) >= today();
  const item = (ok, title, detail, level) => `<li><span class="mark ${ok ? "ok" : level}">${ok ? "✓" : level === "bad" ? "!" : "–"}</span><span><b>${title}</b><br><span class="small muted">${detail}</span></span><span></span></li>`;
  const stPill = { Open: "p-info", "With CA": "p-warn", Returned: "p-bad", "Signed off": "p-ok" }[st];
  const caComments = Object.entries(per.comments || {}).filter(([, v]) => v);
  return `
  <div class="pagehead"><div><h1>Month-end & CA</h1><p>Close a month, check VAT for its SARS period, and send the pack to the CA.</p></div>
    <div class="actions">${monthPicker("close", p)}</div></div>
  <div class="bar" style="margin-bottom:16px"><span class="pill ${stPill}" style="font-size:13px">${esc(L.monthLabel(p))}: ${esc(st)}</span>
    ${st === "Returned" && per.return_note ? `<span class="small">CA: “${esc(per.return_note)}”</span>` : ""}
    ${isFuture && st === "Open" ? `<span class="small warns">This month hasn't ended yet.</span>` : ""}</div>
  ${caComments.length ? `<div class="banner warn" style="display:block"><b>CA comments on ledger lines</b><ul style="margin:6px 0 0;padding-left:18px">${caComments.map(([k, v]) => { const r = d.rows.find((x) => x.id === k); return `<li>${esc(r ? r.date + " · " + r.description : k)}: ${esc(v)}</li>`; }).join("")}</ul></div>` : ""}
  <div class="grid2">
    <section class="card"><h2>Close checklist</h2><ul class="checklist">
      ${item(true, "Paid invoices posted", `${d.inc.length} payment${d.inc.length === 1 ? "" : "s"} in the ledger automatically`)}
      ${item(d.unmatched.length === 0, "Bank lines matched", d.bankM.length ? `${d.bankM.length - d.unmatched.length} of ${d.bankM.length} matched or excluded` : "No bank CSV imported for this month yet", "bad")}
      ${item(d.review.length === 0, "Expenses categorised", d.review.length ? `${d.review.length} need review` : `${d.exp.length} expense${d.exp.length === 1 ? "" : "s"} reviewed`, "bad")}
      ${item(d.missing.length === 0, "Receipts attached", d.missing.length ? `${d.missing.length} missing; their input VAT isn't claimed (warning only)` : "All VAT-bearing expenses have receipts", "warn")}
      ${item(d.overpaid.length === 0, "Debtors reconcile", d.overpaid.length ? `Overpaid: ${d.overpaid.map((i) => esc(i.invoice_no)).join(", ")}` : `${d.debtors.length} open invoice${d.debtors.length === 1 ? "" : "s"} carried forward, ${M(d.debtors.reduce((a, x) => a + x.balC, 0))}`, "bad")}
      ${item(!!S.db, "Books saved", S.db ? "Every change is stored as it's made" : "Not connected", "bad")}
    </ul>
    <div class="mfoot" style="justify-content:flex-start">
      ${st === "Open" || st === "Returned" ? `<button class="btn primary" data-act="send-ca" ${d.blocking ? "disabled" : ""}>Send pack to CA</button>${d.blocking ? `<span class="small errs" style="align-self:center">${d.blocking} blocking item${d.blocking > 1 ? "s" : ""}</span>` : ""}` : ""}
      ${st === "With CA" ? `<button class="btn primary" data-act="ca-view">Open CA review page</button><button class="btn" data-act="reopen">Reopen month</button>` : ""}
      ${st === "Signed off" ? `<span class="small muted" style="align-self:center">Signed off months are locked and can't be reopened here.</span>` : ""}
      <button class="btn" data-act="export-pack">Download pack (CSV)</button>
    </div></section>
    <section class="card"><h2>VAT · ${esc(d.vp.label)}</h2>
      <p class="small muted" style="margin:-4px 0 10px">${s.vat_basis === "payments" ? "Payments basis: output VAT on money received in the period." : "Invoice basis: output VAT on invoices issued in the period, paid or not."} Category ${esc(s.vat_category)} period${vpDone ? ", both months signed off." : ", provisional until both months are signed off."}</p>
      <div class="kv">
        <span>Output VAT</span><span class="num">${M(d.vat.outC)}</span>
        <span>Input VAT claimable</span><span class="num">−${M(d.vat.inC)}</span>
        ${d.vat.inMissingC ? `<span class="muted small">Input VAT waiting on receipts</span><span class="num muted small">${M(d.vat.inMissingC)}</span>` : ""}
        <span class="tot">${d.vat.payableC >= 0 ? "VAT payable to SARS" : "VAT refund due"}</span><span class="num tot">${M(Math.abs(d.vat.payableC))}</span>
      </div>
      <p class="small muted" style="margin:12px 0 0">${esc(L.monthLabel(p))} alone: output ${M(d.vatThis.outC)}, input ${M(d.vatThis.inC)}, net ${M(d.vatThis.payableC)}.</p>
    </section>
    <section class="card"><h2>Income statement · ${esc(L.monthLabel(p))}</h2><p class="small muted" style="margin:-4px 0 10px">Excl. VAT, cash basis.</p>
      <div class="kv"><span class="muted small" style="grid-column:1/-1;text-transform:uppercase;letter-spacing:.05em;font-weight:600">Income</span>
        ${d.incCats.map(([k, v]) => `<span>${esc(k)}</span><span class="num">${M(v)}</span>`).join("") || `<span class="muted">No income received</span><span></span>`}
        <span class="tot">Total income</span><span class="num tot">${M(incNet)}</span>
        <span class="muted small" style="grid-column:1/-1;text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-top:8px">Expenses</span>
        ${d.expCats.map(([k, v]) => `<span>${esc(k)}</span><span class="num">${M(v)}</span>`).join("") || `<span class="muted">No expenses</span><span></span>`}
        <span class="tot">Total expenses</span><span class="num tot">${M(expNet)}</span>
        <span class="tot">Net profit</span><span class="num tot">${M(incNet - expNet)}</span></div></section>
    <section class="card"><h2>Debtors at ${esc(L.monthEnd(p))}</h2>
      ${d.debtors.length ? `<div class="tablebox" style="border:0"><table><thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th class="n">Days late</th><th class="n">Balance</th></tr></thead><tbody>
      ${d.debtors.map((x) => `<tr class="click" data-open="${esc(x.inv.invoice_no)}"><td>${esc(x.inv.invoice_no)}</td><td>${esc(clientById(x.inv.client_id)?.name || "")}</td><td class="num" style="text-align:left">${esc(x.inv.due_date)}</td><td class="n">${x.daysLate || ""}</td><td class="n">${M(x.balC)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="n">${M(d.debtors.reduce((a, x) => a + x.balC, 0))}</td></tr></tfoot></table></div>` : `<p class="muted">Nobody owed money at month-end.</p>`}</section>
    <section class="card"><h2>Pack contents</h2>
      ${[["income", "Income statement"], ["vat", "VAT period summary"], ["ledger", "Ledger (view-only Sheet link in production)"], ["files", "Receipts and invoice PDFs (zip in production)"], ["debtors", "Debtors list", true], ["creditors", "Creditors list"]].map(([k, l, req]) => `<label class="small" style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="checkbox" data-pack="${k}" ${S.pack[k] || req ? "checked" : ""} ${req ? "disabled" : ""}> ${l}${req ? ' <span class="muted">(always included)</span>' : ""}</label>`).join("")}
    </section>
    <section class="card"><h2>Sign-off history</h2>
      ${(per.history || []).length ? `<ul class="timeline">${per.history.map((h) => `<li class="done"><span class="d">${esc(h.at.slice(0, 16).replace("T", " "))}</span>${esc(h.event)}${h.note ? `: ${esc(h.note)}` : ""}</li>`).join("")}</ul>` : `<p class="muted">Not sent yet.</p>`}
      ${Object.entries(S.data.periods).filter(([k]) => k !== p).length ? `<h3 style="margin-top:14px">Other months</h3><div class="kv small">${Object.entries(S.data.periods).filter(([k]) => k !== p).sort((a, b) => b[0].localeCompare(a[0])).map(([k, v]) => `<span>${L.monthLabel(k)}</span><span class="pill ${({ Open: "p-info", "With CA": "p-warn", Returned: "p-bad", "Signed off": "p-ok" })[v.status]}">${esc(v.status)}</span>`).join("")}</div>` : ""}
    </section>
  </div>`;
}

// CA review page (read-only, opened from the emailed link in production)
function caHTML() {
  const p = S.closeMonth, d = closeData(p), per = S.data.periods[p] || {}, s = set();
  const incNet = d.inc.reduce((a, r) => a + r.netC, 0), expNet = d.exp.reduce((a, r) => a + r.netC, 0);
  return `<h3>CA review · read-only</h3><h1>${esc(s.company || "Company")} · ${esc(L.monthLabel(p))}</h1>
  <p class="muted small">In production this opens from an emailed link that expires after 30 days or on approval. The CA sees only this submitted month.</p>
  <div class="tiles" style="margin-top:14px">
    <div class="tile"><div class="k">Income excl. VAT</div><div class="v">${M(incNet)}</div></div>
    <div class="tile"><div class="k">Expenses excl. VAT</div><div class="v">${M(expNet)}</div></div>
    <div class="tile"><div class="k">Net profit</div><div class="v">${M(incNet - expNet)}</div></div>
    <div class="tile"><div class="k">VAT ${esc(d.vp.label)}</div><div class="v">${M(d.vat.payableC)}</div><div class="s">${s.vat_basis === "payments" ? "Payments" : "Invoice"} basis · output ${M(d.vat.outC)} · input ${M(d.vat.inC)}</div></div>
  </div>
  <div class="tablebox"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="n">Net</th><th class="n">VAT</th><th>Receipt</th><th style="min-width:200px">Comment</th></tr></thead><tbody>
  ${d.rows.map((r) => `<tr><td class="num" style="text-align:left">${esc(r.date)}</td><td>${esc(r.description)}</td><td>${esc(r.category)}</td><td class="n">${r.type === "Expense" ? "−" : ""}${M(r.netC)}</td><td class="n">${M(r.vatC)}</td><td class="small">${esc(r.receipt)}</td>
    <td><input class="cmt" type="text" id="cmt-${esc(r.id)}" data-cmt="${esc(r.id)}" value="${esc((per.comments || {})[r.id] || "")}" placeholder="Add a comment"></td></tr>`).join("") || `<tr><td colspan="7" class="muted">No ledger lines.</td></tr>`}
  </tbody></table></div>
  <h3 style="margin-top:16px">Debtors at month-end</h3>
  <p class="small">${d.debtors.length ? d.debtors.map((x) => `${esc(x.inv.invoice_no)} ${esc(clientById(x.inv.client_id)?.name || "")} ${M(x.balC)}`).join(" · ") : "None"}</p>
  <label class="small muted" for="ca-note" style="display:block;margin-top:12px;font-weight:600">Note to the owner</label>
  <textarea id="ca-note" placeholder="Required when returning the month"></textarea>
  <div class="mfoot"><button class="btn" data-close-modal-btn>Close</button><button class="btn danger" data-act="ca-return">Return with comments</button><button class="btn primary" data-act="ca-approve">Approve and sign off</button></div>`;
}

// ---------- SETTINGS ----------
function settingsView() {
  const s = set();
  const f = (id, label, val, type = "text", extra = "") => `<label>${label}<input id="s-${id}" type="${type}" value="${esc(val ?? "")}" ${extra}></label>`;
  const sel = (id, label, val, opts) => `<label>${label}<select id="s-${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(val) === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
  const hasData = S.data.invoices.length || S.data.expenses.length || S.data.bank.length || S.data.clients.length;
  return `<div class="pagehead"><div><h1>Settings</h1><p>Company, VAT and reminder rules. Changes apply as soon as you save.</p></div><div class="actions"><button class="btn primary" data-act="save-settings">Save settings</button></div></div>
  <div class="grid2">
    <section class="card"><h2>Company</h2><div class="form">
      ${f("company", "Company name", s.company)}${f("cc_reg", "CC registration no.", s.cc_reg, "text", 'placeholder="CK 2009/123456/23"')}
      ${f("vat_no", "VAT number", s.vat_no, "text", 'placeholder="4xxxxxxxxx"')}${f("owner_email", "Owner email (reminders send from here)", s.owner_email, "email")}
      ${f("ca_email", "CA email", s.ca_email, "email")}${sel("fy_end_month", "Financial year ends", s.fy_end_month, L.MONTHS.map((m, i) => [i + 1, m]))}
      ${f("income_category", "Income category", s.income_category)}${f("default_terms", "Default payment terms (days)", s.default_terms, "number", 'min="0"')}
    </div></section>
    <section class="card"><h2>VAT</h2><div class="form">
      ${f("vat_rate", "Standard rate %", s.vat_rate, "number", 'step="0.01" min="0"')}
      ${sel("vat_basis", "VAT basis (as registered with SARS)", s.vat_basis, [["invoice", "Invoice basis"], ["payments", "Payments basis"]])}
      ${sel("vat_category", "VAT period category", s.vat_category, [["A", "Category A (Dec–Jan, Feb–Mar …)"], ["B", "Category B (Jan–Feb, Mar–Apr …)"]])}
    </div><p class="small muted" style="margin:10px 0 0">Changing the rate only affects new invoices; each invoice keeps its own rate. Switching the basis changes VAT payable, never the ledger.</p></section>
    <section class="card"><h2>Reminders</h2><div class="form">
      ${f("r_pre", "Heads-up, days before due", s.reminders.pre, "number", 'min="0"')}${f("r_r1", "First reminder, days after due", s.reminders.r1, "number", 'min="0"')}
      ${f("r_every", "Then every … days", s.reminders.every, "number", 'min="1"')}${f("r_call", "Flag to phone at … days late", s.reminders.call, "number", 'min="1"')}
      <label class="row full"><input type="checkbox" id="s-test_mode" ${s.test_mode ? "checked" : ""}> Test mode: every reminder goes to the owner with “[TEST → client email]” in the subject</label>
      <label class="full">Live clients (only these get real emails once test mode is off)<select id="s-live_clients" multiple size="${Math.min(6, Math.max(2, S.data.clients.length))}">${S.data.clients.map((c) => `<option value="${esc(c.id)}" ${(s.live_clients || []).includes(c.id) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
      <label class="full">Payment details ({payment_details})<input id="s-payment_details" type="text" value="${esc(s.payment_details)}"></label>
      <label class="full">Heads-up email<textarea id="s-tpl_pre">${esc(s.tpl_pre)}</textarea></label>
      <label class="full">R1 email<textarea id="s-tpl_r1">${esc(s.tpl_r1)}</textarea></label>
      <label class="full">R2 and later<textarea id="s-tpl_rn">${esc(s.tpl_rn)}</textarea></label>
    </div><p class="small muted" style="margin:10px 0 0">Merge fields: {client_name} {invoice_no} {gross} {balance} {due_date} {days_late} {payment_details}. Sends run at 09:00 SAST on business days.</p></section>
    <section class="card"><h2>Expense categories</h2><div class="form"><label class="full">One per line<textarea id="s-expense_categories" style="min-height:180px">${esc((s.expense_categories || []).join("\n"))}</textarea></label></div></section>
    <section class="card"><h2>Clients</h2>
      ${S.data.clients.length ? `<div class="tablebox" style="border:0"><table><thead><tr><th>Name</th><th>Billing email</th><th>VAT no.</th><th class="n">Terms</th><th>Reminders</th><th></th></tr></thead><tbody>${[...S.data.clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<tr><td>${esc(c.name)}</td><td class="small">${esc(c.billing_email || "—")}</td><td class="small">${esc(c.vat_number || "—")}</td><td class="n">${esc(c.default_terms_days ?? 30)}</td><td>${c.reminders_enabled === false ? '<span class="pill p-mute">Off</span>' : '<span class="pill p-ok">On</span>'}</td><td><button class="btn sm" data-edit-client="${esc(c.id)}">Edit</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Clients are created when you import invoices or add a new one.</p>`}
      <div class="mfoot" style="justify-content:flex-start"><button class="btn" data-act="add-client">Add client</button></div></section>
    ${S.standalone ? `<section class="card"><h2>Backup</h2><p class="small muted" style="margin-top:-4px">This copy keeps the books in this browser only. Clearing site data or switching browser loses them, so download a backup regularly.</p>
      <div class="mfoot" style="justify-content:flex-start"><button class="btn" data-act="backup">Download backup</button><label class="btn" for="restore-file" style="display:inline-flex">Restore from backup<input type="file" id="restore-file" accept=".json,application/json" hidden></label></div></section>` : ""}
    <section class="card"><h2>Testing</h2><div class="form">
      ${f("as_of", "Simulated today (blank = real date)", s.as_of, "date")}
    </div><p class="small muted">Use this to check statuses and reminder dates for a given day (T2, T5). Remember to clear it.</p>
      <div class="mfoot" style="justify-content:flex-start"><button class="btn" data-act="load-example" ${hasData ? "disabled" : ""}>Load example data</button><button class="btn danger" data-act="clear-all" ${hasData ? "" : "disabled"}>Delete all data…</button></div>
      <p class="small muted" style="margin:6px 0 0">${hasData ? "Example data can only be loaded into empty books." : "Loads a handful of clearly marked example invoices and expenses."}</p></section>
  </div>`;
}

// ---------- modals ----------
function renderModal() {
  const root = $("#modal-root");
  const keep = {}; root.querySelectorAll("input[id]:not([type=file]):not([data-line]),select[id],textarea[id]").forEach((i) => { keep[i.id] = i.type === "checkbox" ? i.checked : i.value; });
  root.innerHTML =S.modal ? `<div class="modal-back" data-close-modal><div class="modal ${S.modal.wide ? "wide" : ""}" role="dialog" aria-modal="true">${S.modal.html()}</div></div>` : "";
  if (S.modal) Object.entries(keep).forEach(([id, v]) => { const i = document.getElementById(id); if (i) { if (i.type === "checkbox") i.checked = v; else i.value = v; } });
}
function openModal(html, opts = {}) { S.modal = { html, ...opts }; renderModal(); const m = $(".modal"); m && (m.querySelector("input,select,textarea,button") || m).focus(); }
function closeModal() { S.modal = null; renderModal(); render(); }

function invoiceForm(inv) {
  const s = set(), isNew = !inv;
  inv = inv || { invoice_no: "", client_id: "", issue_date: today(), due_date: "", lines: [{ description: "", qty: 1, unit_price: "" }], vat_treatment: "standard", vat_rate: s.vat_rate, category: s.income_category };
  const lines = inv.lines && inv.lines.length ? inv.lines : [{ description: "Services", qty: 1, unit_price: inv.net || "" }];
  S.formLines = lines.map((l) => ({ ...l }));
  openModal(() => `<h2>${isNew ? "New invoice" : "Edit " + esc(inv.invoice_no)}</h2><p class="small muted" style="margin-top:-6px">Record an invoice raised elsewhere. VAT is calculated on the total, rounded half-up to the cent.</p>
    <div class="form">
      <label>Invoice #<input id="i-no" type="text" value="${esc(inv.invoice_no)}" ${isNew ? "" : "disabled"}></label>
      <label>Client<select id="i-client"><option value="">Choose…</option>${S.data.clients.map((c) => `<option value="${esc(c.id)}" ${inv.client_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}<option value="__new">+ New client…</option></select></label>
      <label>Issue date<input id="i-issue" type="date" value="${esc(inv.issue_date)}"></label>
      <label>Due date (blank = client terms)<input id="i-due" type="date" value="${esc(inv.due_date)}"></label>
      <label>VAT treatment<select id="i-treat"><option value="standard" ${inv.vat_treatment !== "zero" ? "selected" : ""}>Standard ${s.vat_rate}%</option><option value="zero" ${inv.vat_treatment === "zero" ? "selected" : ""}>Zero-rated</option></select></label>
      <label>Category<input id="i-cat" type="text" value="${esc(inv.category || s.income_category)}"></label>
    </div>
    <h3 style="margin-top:16px">Line items</h3>
    <div class="tablebox"><table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price (excl. VAT)</th><th></th></tr></thead><tbody>
    ${S.formLines.map((l, i) => `<tr><td><input type="text" id="l-d-${i}" data-line="${i}" data-k="description" value="${esc(l.description)}" style="width:100%"></td><td><input type="number" id="l-q-${i}" data-line="${i}" data-k="qty" value="${esc(l.qty)}" style="width:70px" step="any"></td><td><input type="number" id="l-u-${i}" data-line="${i}" data-k="unit_price" value="${esc(l.unit_price)}" style="width:130px" step="0.01"></td><td>${S.formLines.length > 1 ? `<button class="btn sm" data-del-line="${i}" aria-label="Remove line">Remove</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="bar" style="margin-top:8px"><button class="btn sm" data-act="add-line">Add line</button><span class="small muted" id="i-tot"></span></div>
    <p class="errs" id="i-err"></p>
    <div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn" data-act="save-inv" data-send="0">Save as draft</button>${isNew || !inv.sent_at ? `<button class="btn primary" data-act="save-inv" data-send="1">Save as sent</button>` : `<button class="btn primary" data-act="save-inv" data-send="keep">Save</button>`}</div>`, { wide: true, kind: "invoice", isNew, orig: inv });
  updateInvTotal();
}
function updateInvTotal() {
  const el = $("#i-tot"); if (!el) return;
  const t = L.invoiceTotals({ lines: S.formLines, vat_treatment: $("#i-treat").value, vat_rate: set().vat_rate });
  el.textContent = `Net ${M(t.netC)} · VAT ${M(t.vatC)} · Total ${M(t.grossC)}`;
}
async function saveInvoiceForm(sendMode) {
  const s = set(), m = S.modal, err = (x) => { $("#i-err").textContent = x; };
  const no = (m.isNew ? $("#i-no").value : m.orig.invoice_no).trim();
  if (!no) return err("Enter the invoice number as it appears on the invoice.");
  if (m.isNew && invByNo(no)) return err(`Invoice ${no} already exists.`);
  const client_id = $("#i-client").value; if (!client_id || client_id === "__new") return err("Choose a client.");
  const issue = $("#i-issue").value; if (!issue) return err("Enter the issue date.");
  const c = clientById(client_id);
  const due = $("#i-due").value || L.addDays(issue, c?.default_terms_days ?? s.default_terms);
  if (due < issue) return err("The due date is before the issue date.");
  const lines = S.formLines.filter((l) => l.description || Number(l.unit_price)).map((l) => ({ description: l.description || "Item", qty: Number(l.qty) || 0, unit_price: Number(l.unit_price) || 0 }));
  if (!lines.length) return err("Add at least one line item.");
  const treat = $("#i-treat").value;
  const inv = { ...(m.orig || {}), invoice_no: no, client_id, issue_date: issue, due_date: due, lines, vat_treatment: treat,
    vat_rate: treat === "zero" ? 0 : (m.isNew || m.orig.vat_treatment === "zero" ? s.vat_rate : m.orig.vat_rate), category: $("#i-cat").value || s.income_category,
    created_at: (m.orig && m.orig.created_at) || new Date().toISOString(), payments: (m.orig && m.orig.payments) || [], reminders_sent: (m.orig && m.orig.reminders_sent) || [] };
  delete inv.net; delete inv._id;
  if (sendMode === "1") inv.sent_at = issue + "T09:00:00";
  else if (sendMode === "0") inv.sent_at = null;
  if (locked(L.ym(issue))) return err(`${L.monthLabel(L.ym(issue))} is ${periodStatus(L.ym(issue)).toLowerCase()}; reopen it first.`);
  if (await write(() => saveInvoice(inv), m.isNew ? `Invoice ${no} saved` : "Invoice updated")) { S.modal = null; S.drawer = no; render(); }
}

function clientForm(c, after) {
  const isNew = !c; c = c || { name: "", billing_email: "", cc_emails: "", vat_number: "", address: "", default_terms_days: set().default_terms, reminders_enabled: true };
  openModal(() => `<h2>${isNew ? "New client" : "Edit " + esc(c.name)}</h2><div class="form">
    <label>Name<input id="c-name" type="text" value="${esc(c.name)}"></label><label>Billing email<input id="c-email" type="email" value="${esc(c.billing_email)}"></label>
    <label>CC emails (comma-separated)<input id="c-cc" type="text" value="${esc(c.cc_emails)}"></label><label>VAT number<input id="c-vat" type="text" value="${esc(c.vat_number)}"></label>
    <label class="full">Address<input id="c-addr" type="text" value="${esc(c.address)}"></label>
    <label>Payment terms (days)<input id="c-terms" type="number" min="0" value="${esc(c.default_terms_days)}"></label>
    <label class="row"><input id="c-rem" type="checkbox" ${c.reminders_enabled !== false ? "checked" : ""}> Send reminders to this client</label>
  </div><p class="errs" id="c-err"></p><div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn primary" data-act="save-client">Save client</button></div>`, { kind: "client", orig: c, isNew, after });
}

function paymentForm(inv, full) {
  const bal = L.invoiceTotals(inv).grossC - L.paidC(inv);
  openModal(() => `<h2>${full ? "Mark as paid" : "Record partial payment"} · ${esc(inv.invoice_no)}</h2>
    <p class="small muted" style="margin-top:-6px">Balance ${M(bal)}. Saving posts income to the ledger with the VAT split pro rata${full ? " and cancels remaining reminders" : ""}.</p>
    <div class="form"><label>Date received<input id="p-date" type="date" value="${esc(S.prefillPay?.date || today())}"></label>
      <label>Amount (incl. VAT)<input id="p-amt" type="number" step="0.01" min="0.01" value="${esc(S.prefillPay?.amount ?? (full ? L.fromC(bal) : L.fromC(Math.round(bal / 2))))}"></label>
      <label>Method<select id="p-method"><option>EFT</option><option>Card</option><option>Cash</option><option>Other</option></select></label>
      <label>Bank reference<input id="p-ref" type="text" value="${esc(S.prefillPay?.ref || "")}"></label></div>
    <p class="small muted" id="p-split"></p><p class="errs" id="p-err"></p>
    <div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn primary" data-act="save-pay">Save payment</button></div>`, { kind: "pay", no: inv.invoice_no });
  updateSplit();
}
function updateSplit() {
  const el = $("#p-split"); if (!el) return;
  const inv = invByNo(S.modal.no), amt = Number($("#p-amt").value) || 0;
  const sim = { ...inv, payments: [...(inv.payments || []), { id: "zz", date: $("#p-date").value || today(), amount: amt }] };
  const sp = L.paymentSplits(sim).find((x) => x.id === "zz");
  const bal = L.invoiceTotals(inv).grossC - L.paidC(inv);
  el.textContent = sp ? `Ledger entry: net ${M(sp.netC)} + VAT ${M(sp.vatC)}.` + (L.toC(amt) > bal ? ` This is ${M(L.toC(amt) - bal)} more than the balance.` : L.toC(amt) === bal ? " Clears the invoice." : ` Leaves ${M(bal - L.toC(amt))} outstanding.`) : "";
}

function expenseForm(e, fromBank) {
  const s = set(), isNew = !e;
  e = e || { id: uid(), date: fromBank ? fromBank.date : today(), description: fromBank ? fromBank.description : "", supplier: "", supplier_vat_no: "", category: "", gross: fromBank ? Math.abs(fromBank.amount) : "", vatable: true, receipt: "", source: fromBank ? "Bank import" : "Manual", status: "Needs review", bank_id: fromBank ? fromBank.id : null };
  const sug = isNew ? L.suggestCategory(e.description, S.data.expenses) : null;
  openModal(() => `<h2>${isNew ? "Add expense" : "Expense"}</h2><p class="small muted" style="margin-top:-6px">Enter the gross amount from the receipt. VAT is worked out as gross × ${s.vat_rate}/${100 + Number(s.vat_rate)}.</p>
    <div class="form">
      <label>Date paid<input id="e-date" type="date" value="${esc(e.date)}"></label>
      <label>Supplier / description<input id="e-desc" type="text" value="${esc(e.description)}"></label>
      <label>Category<select id="e-cat"><option value="">Choose…</option>${s.expense_categories.map((c) => `<option ${(e.category || sug) === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>Amount paid (incl. VAT)<input id="e-gross" type="number" step="0.01" min="0" value="${esc(e.gross)}"></label>
      <label class="row"><input id="e-vatable" type="checkbox" ${e.vatable ? "checked" : ""}> Includes VAT</label>
      <label>Supplier VAT no.<input id="e-svat" type="text" value="${esc(e.supplier_vat_no || "")}"></label>
      <label class="full">Receipt<input id="e-file" type="file" accept=".pdf,.jpg,.jpeg,.png"><span class="small" style="font-weight:400">${e.receipt ? "Attached: " + esc(e.receipt) : "None attached. Input VAT isn't claimed until one is."}</span></label>
    </div>${sug && !e.category ? `<p class="small muted">Category suggested from earlier ${esc(e.description)} entries.</p>` : ""}
    <p class="small muted" id="e-split"></p><p class="errs" id="e-err"></p>
    <div class="mfoot">${!isNew && !locked(L.ym(e.date)) ? `<button class="btn danger" data-act="del-exp" style="margin-right:auto">Delete</button>` : ""}<button class="btn" data-close-modal-btn>Cancel</button>${locked(L.ym(e.date)) && !isNew ? "" : `<button class="btn primary" data-act="save-exp">Save as reviewed</button>`}</div>`, { kind: "exp", orig: e, isNew });
  updateExpSplit();
}
function updateExpSplit() {
  const el = $("#e-split"); if (!el) return;
  const sp = L.expenseSplit({ gross: $("#e-gross").value, vatable: $("#e-vatable").checked, receipt: S.modal.orig.receipt || ($("#e-file").files[0] && "x"), supplier_vat_no: $("#e-svat").value }, set());
  el.textContent = `Net ${M(sp.netC)} · VAT ${M(sp.vatC)}${sp.vatC && !sp.claimC ? " · not claimable yet (needs receipt and supplier VAT no.)" : ""}`;
}

function emailPreview(inv, step) {
  const s = set(), c = clientById(inv.client_id), t = today();
  const isInvoice = step === "invoice";
  const tpl = isInvoice ? "Hi {client_name},\n\nPlease find attached invoice {invoice_no} for {gross}, due on {due_date}.\n\n{payment_details}\n\nThank you." : step === "pre" ? s.tpl_pre : step === "R1" ? s.tpl_r1 : s.tpl_rn;
  const subj = isInvoice ? `Invoice ${inv.invoice_no} from ${s.company || "us"}` : step === "pre" ? `Invoice ${inv.invoice_no} due ${inv.due_date}` : `Overdue: invoice ${inv.invoice_no}`;
  const live = !s.test_mode && (s.live_clients || []).includes(inv.client_id);
  const to = live ? (c?.billing_email || "") : (s.owner_email || "owner (set in Settings)");
  return { to, subject: (live ? "" : `[TEST → ${c?.billing_email || "no client email"}] `) + subj, body: L.mergeTemplate(tpl, inv, c, s, t), live, missingEmail: !c?.billing_email };
}
function sendDialog(inv, step) {
  const e = emailPreview(inv, step);
  openModal(() => `<h2>${step === "invoice" ? "Send invoice" : "Send reminder"} · ${esc(inv.invoice_no)}</h2>
    ${e.live ? "" : `<div class="banner warn">Test mode: this goes to ${esc(e.to)}, not the client.</div>`}
    ${e.missingEmail ? `<div class="banner bad">This client has no billing email. Add one before sending live.</div>` : ""}
    <div class="emailprev"><div class="h"><b>To:</b> ${esc(e.to)} · <b>Reply-to:</b> ${esc(set().owner_email || "owner")}<br><b>Subject:</b> ${esc(e.subject)}<br><b>Attachment:</b> ${esc(inv.invoice_no)}.pdf</div>${esc(e.body)}</div>
    <p class="small muted">The mockup logs the send. Gmail delivery is wired in the Apps Script build.</p>
    <div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn primary" data-act="confirm-send" data-step="${esc(step)}">${e.live ? "Send" : "Log test send"}</button></div>`, { kind: "send", no: inv.invoice_no });
}

// ---------- imports ----------
function importInvDialog() {
  openModal(() => `<h2>Import invoices</h2>
    <p class="small muted" style="margin-top:-6px">CSV with one row per invoice. Required: invoice_no, client_name, issue_date, net_amount. Optional: client_email, due_date, vat_rate, vat_amount, gross_amount, status, paid_date, amount_paid, vat_treatment, client_vat_number. Dates as YYYY-MM-DD or DD/MM/YYYY. Re-importing an invoice number updates it.</p>
    <div class="form"><label class="full">CSV file<input type="file" id="imp-file" accept=".csv,text/csv"></label></div>
    <div id="imp-prev" style="margin-top:12px"></div>
    <div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn primary" data-act="commit-import" disabled id="imp-go">Import</button></div>`, { wide: true, kind: "import" });
}
function renderImportPreview(res) {
  const box = $("#imp-prev"); if (!box) return;
  if (res.error) { box.innerHTML = `<p class="errs">${esc(res.error)}</p>`; $("#imp-go").disabled = true; return; }
  const ok = res.rows.filter((r) => !r.errors.length), bad = res.rows.filter((r) => r.errors.length);
  const grossC = ok.reduce((a, r) => a + L.invoiceTotals(r.data).grossC, 0);
  const fileGross = res.rows.reduce((a, r) => a + (r.data.file_gross != null ? L.toC(r.data.file_gross) : 0), 0);
  const upd = ok.filter((r) => invByNo(r.data.invoice_no)).length;
  box.innerHTML = `<div class="sumline"><b>${ok.length} ready</b>${upd ? `<span>${upd} will update existing</span>` : ""}<span class="${bad.length ? "errs" : ""}">${bad.length} with errors (skipped)</span><span>Total gross <span class="num">${M(grossC)}</span></span>${fileGross ? `<span>File total <span class="num">${M(fileGross)}</span></span>` : ""}</div>
    <div class="tablebox" style="max-height:340px;overflow:auto"><table><thead><tr><th>Line</th><th>Invoice #</th><th>Client</th><th>Issued</th><th class="n">Net</th><th class="n">VAT</th><th class="n">Total</th><th>Paid</th><th>Notes</th></tr></thead><tbody>
    ${res.rows.map((r) => { const t = L.invoiceTotals(r.data); return `<tr><td class="num">${r.line}</td><td>${esc(r.data.invoice_no)}</td><td>${esc(r.data.client_name)}</td><td class="small">${esc(r.data.issue_date)}</td><td class="n">${isNaN(r.data.net) ? "—" : M(t.netC)}</td><td class="n">${isNaN(r.data.net) ? "—" : M(t.vatC)}</td><td class="n">${isNaN(r.data.net) ? "—" : M(t.grossC)}</td><td class="small">${r.data.payments.length ? L.money(r.data.payments[0].amount) + " on " + esc(r.data.payments[0].date) : ""}</td><td>${r.errors.map((x) => `<div class="errs">${esc(x)}</div>`).join("")}${r.warnings.map((x) => `<div class="warns">${esc(x)}</div>`).join("")}</td></tr>`; }).join("")}
    </tbody></table></div>`;
  $("#imp-go").disabled = !ok.length; $("#imp-go").textContent = `Import ${ok.length} invoice${ok.length === 1 ? "" : "s"}`;
  S.importRows = ok;
}
async function commitImport() {
  const rows = S.importRows || []; const s = set();
  const byName = Object.fromEntries(S.data.clients.map((c) => [c.name.trim().toLowerCase(), c]));
  let n = 0;
  const ok = await write(async () => {
    for (const r of rows) {
      const d = r.data; const key = d.client_name.trim().toLowerCase();
      let c = byName[key];
      if (!c) { c = { id: docId(key).slice(0, 60) + "-" + uid().slice(-4), name: d.client_name.trim(), billing_email: d.client_email, cc_emails: "", vat_number: d.client_vat_number, address: "", default_terms_days: s.default_terms, reminders_enabled: true }; await saveClient(c); byName[key] = c; }
      else if ((!c.billing_email && d.client_email) || (!c.vat_number && d.client_vat_number)) { c = { ...c, billing_email: c.billing_email || d.client_email, vat_number: c.vat_number || d.client_vat_number }; delete c._id; await saveClient(c); byName[key] = c; }
      const prev = invByNo(d.invoice_no);
      if (prev && locked(L.ym(prev.issue_date))) continue;
      const inv = { ...(prev || {}), invoice_no: d.invoice_no, client_id: c.id, issue_date: d.issue_date, due_date: d.due_date, lines: [{ description: "As per invoice", qty: 1, unit_price: d.net }],
        vat_rate: d.vat_rate, vat_treatment: d.vat_treatment, category: (prev && prev.category) || s.income_category, sent_at: d.sent_at ? d.sent_at + "T09:00:00" : null, void: d.void,
        payments: d.payments.length ? d.payments : (prev ? prev.payments || [] : []), reminders_sent: (prev && prev.reminders_sent) || [], created_at: (prev && prev.created_at) || new Date().toISOString(), imported: true };
      delete inv._id; delete inv.example;
      await saveInvoice(inv); n++;
    }
  });
  if (ok) { S.modal = null; render(); toast(`Imported ${n} invoice${n === 1 ? "" : "s"}`); }
}

function importBankDialog() {
  openModal(() => `<h2>Import bank statement</h2>
    <p class="small muted" style="margin-top:-6px">CSV export from the business account. Choose which column holds what; the mapping is remembered. Money out should be negative.</p>
    <div class="form"><label class="full">CSV file<input type="file" id="bank-file" accept=".csv,text/csv"></label></div>
    <div id="bank-map" style="margin-top:12px"></div>
    <div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn primary" data-act="commit-bank" disabled id="bank-go">Import</button></div>`, { wide: true, kind: "bank" });
}
function renderBankMap() {
  const box = $("#bank-map"); const rows = S.bankRows; if (!box || !rows) return;
  const head = rows[0]; const saved = set().bank_map || {};
  const guess = (k, re) => { const i = saved[k] != null && saved[k] < head.length ? saved[k] : head.findIndex((h) => re.test(h)); return i; };
  const m = S.bankMap || (S.bankMap = { date: guess("date", /date/i), description: guess("description", /desc|narr|detail/i), amount: guess("amount", /amount|value/i), reference: guess("reference", /ref/i) });
  const sel = (k) => `<label>${k[0].toUpperCase() + k.slice(1)}<select data-map="${k}"><option value="-1">—</option>${head.map((h, i) => `<option value="${i}" ${m[k] === i ? "selected" : ""}>${esc(h || "Column " + (i + 1))}</option>`).join("")}</select></label>`;
  const parsed = rows.slice(1).map((r) => ({ date: L.normDate(r[m.date]), description: (r[m.description] || "").trim(), amount: L.numIn(r[m.amount]), reference: m.reference >= 0 ? (r[m.reference] || "").trim() : "" }));
  const good = parsed.filter((x) => x.date && !isNaN(x.amount));
  const dupKey = (x) => `${x.date}|${x.amount}|${x.description}`;
  const existing = new Set(S.data.bank.map(dupKey));
  const fresh = good.filter((x) => !existing.has(dupKey(x)));
  S.bankParsed = fresh;
  box.innerHTML = `<div class="form">${["date", "description", "amount", "reference"].map(sel).join("")}</div>
    <div class="sumline" style="margin-top:12px"><b>${fresh.length} new lines</b><span>${good.length - fresh.length} already imported</span><span class="${parsed.length - good.length ? "errs" : ""}">${parsed.length - good.length} unreadable</span></div>
    <div class="tablebox" style="max-height:260px;overflow:auto"><table><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th class="n">Amount</th></tr></thead><tbody>${parsed.slice(0, 50).map((x) => `<tr><td class="small">${esc(x.date || "unreadable")}</td><td>${esc(x.description)}</td><td class="small">${esc(x.reference)}</td><td class="n">${isNaN(x.amount) ? '<span class="errs">?</span>' : L.money(x.amount)}</td></tr>`).join("")}</tbody></table></div>`;
  $("#bank-go").disabled = !fresh.length; $("#bank-go").textContent = `Import ${fresh.length} line${fresh.length === 1 ? "" : "s"}`;
}

// ---------- reminders job ----------
async function runReminders() {
  const s = set(), t = today(); const out = [];
  for (const inv of S.data.invoices) {
    const plan = L.reminderPlan(inv, s, clientById(inv.client_id), t);
    const d = plan.find((r) => r.kind === "email" && r.state === "due");
    if (d) out.push({ inv, step: d.step });
  }
  if (!out.length) { toast(L.isBusinessDay(t) ? "No reminders due today" : "Today isn't a business day; reminders wait for the next one"); return; }
  const ok = await write(async () => { for (const o of out) await logSend(o.inv, o.step); });
  if (ok) toast(`${out.length} reminder${out.length > 1 ? "s" : ""} ${set().test_mode ? "sent to the owner (test mode)" : "sent"}`);
}
function logSend(inv, step) {
  const s = set(), e = emailPreview(inv, step);
  const at = today() + "T09:00:00";
  const fresh = { ...inv }; delete fresh._id;
  if (step === "invoice") { fresh.sent_at = at; }
  else fresh.reminders_sent = [...(inv.reminders_sent || []), { step, at, to: e.to, subject: e.subject, test: !e.live, message_id: "mock-" + uid() }];
  return saveInvoice(fresh);
}

// ---------- export ----------
async function exportPack() {
  const p = S.closeMonth, d = closeData(p), s = set();
  const rows = [[`${s.company || "Company"} — month pack ${L.monthLabel(p)}`], [`VAT basis: ${s.vat_basis}; VAT period ${d.vp.label}; books on cash basis`], []];
  if (S.pack.income) { rows.push(["INCOME STATEMENT (excl. VAT)"], ...d.incCats.map(([k, v]) => ["Income", k, L.fromC(v).toFixed(2)]), ...d.expCats.map(([k, v]) => ["Expense", k, L.fromC(v).toFixed(2)]), []); }
  if (S.pack.vat) rows.push(["VAT PERIOD " + d.vp.label], ["Output VAT", L.fromC(d.vat.outC).toFixed(2)], ["Input VAT claimable", L.fromC(d.vat.inC).toFixed(2)], ["VAT payable", L.fromC(d.vat.payableC).toFixed(2)], []);
  if (S.pack.ledger) rows.push(["LEDGER"], ["Date", "Type", "Description", "Category", "Source", "Receipt", "Net", "VAT", "Gross", "Status"], ...d.rows.map((r) => [r.date, r.type, r.description, r.category, r.source, r.receipt, L.fromC(r.netC).toFixed(2), L.fromC(r.vatC).toFixed(2), L.fromC(r.grossC).toFixed(2), r.status]), []);
  rows.push(["DEBTORS AT " + L.monthEnd(p)], ["Invoice", "Client", "Issued", "Due", "Days late", "Balance"], ...d.debtors.map((x) => [x.inv.invoice_no, clientById(x.inv.client_id)?.name || "", x.inv.issue_date, x.inv.due_date, x.daysLate, L.fromC(x.balC).toFixed(2)]));
  if (S.pack.creditors) rows.push([], ["CREDITORS"], ["None tracked: expenses are recorded when paid"]);
  const dl = S.downloads;
  if (!dl) { toast("Downloads aren't available in this view."); return; }
  try { await dl.save({ filename: `month-pack-${p}.csv`, data: new Blob([L.toCSV(rows)], { type: "text/csv" }) }); }
  catch (e) { if (e && e.code !== "declined" && e.code !== "cancelled") toast("Download didn't start."); }
}

// ---------- example data ----------
async function loadExample() {
  const t = today(), s = set();
  const c = [
    { id: "ex-karoo", name: "Karoo Outdoor (Pty) Ltd · example", billing_email: "accounts@example.co.za", vat_number: "4010123456", default_terms_days: 30, reminders_enabled: true },
    { id: "ex-fynbos", name: "Fynbos Studio CC · example", billing_email: "pay@example.co.za", vat_number: "4020654321", default_terms_days: 14, reminders_enabled: true },
    { id: "ex-harbour", name: "Harbour Freight UK Ltd · example", billing_email: "ap@example.co.uk", vat_number: "", default_terms_days: 30, reminders_enabled: true },
  ];
  const d = (n) => L.addDays(t, n);
  const mk = (no, cid, issueOff, net, extra = {}) => { const cl = c.find((x) => x.id === cid); const issue = d(issueOff); return { invoice_no: no, client_id: cid, issue_date: issue, due_date: L.addDays(issue, cl.default_terms_days), lines: [{ description: "Consulting services", qty: 1, unit_price: net }], vat_treatment: "standard", vat_rate: s.vat_rate, category: s.income_category, sent_at: issue + "T09:00:00", payments: [], reminders_sent: [], created_at: issue, example: true, ...extra }; };
  const inv = [
    mk("EX-1001", "ex-karoo", -75, 18500, { payments: [{ id: "p1", date: d(-40), amount: 21275, method: "EFT", ref: "KAROO 1001" }] }),
    mk("EX-1002", "ex-fynbos", -52, 6400, { payments: [{ id: "p1", date: d(-30), amount: 3000, method: "EFT", ref: "FYNBOS" }] }),
    mk("EX-1003", "ex-karoo", -45, 22000),
    mk("EX-1004", "ex-harbour", -20, 31000, { vat_treatment: "zero", vat_rate: 0 }),
    mk("EX-1005", "ex-fynbos", -8, 4250.5),
    mk("EX-1006", "ex-karoo", -2, 12000, { sent_at: null }),
  ];
  const ex = [
    { id: "ex-e1", date: d(-33), description: "Afrihost fibre", supplier_vat_no: "4930123456", category: "Communications", gross: 899, vatable: true, receipt: "afrihost.pdf", source: "Receipt upload", status: "Reviewed", example: true },
    { id: "ex-e2", date: d(-31), description: "FNB service fees", supplier_vat_no: "4210102051", category: "Bank charges", gross: 245.5, vatable: true, receipt: "", source: "Bank import", status: "Reviewed", example: true },
    { id: "ex-e3", date: d(-12), description: "Takealot office chair", supplier_vat_no: "", category: "", gross: 3299, vatable: true, receipt: "", source: "Receipt email", status: "Needs review", example: true },
  ];
  const ok = await write(async () => { for (const x of c) await saveClient(x); for (const x of inv) await saveInvoice(x); for (const x of ex) await saveExpense(x); }, "Example data loaded");
  if (ok) { S.view = "invoices"; render(); }
}
function clearDialog() {
  openModal(() => `<h2>Delete all data?</h2><p>This permanently deletes every client, invoice, expense, bank line and month status in these books. Settings are kept. It can't be undone.</p>
    <div class="form"><label class="full">Type DELETE to confirm<input id="del-confirm" type="text" autocomplete="off"></label></div>
    <div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn danger" data-act="confirm-clear">Delete everything</button></div>`);
}

// ---------- events ----------
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("button, [data-open], [data-exp], [data-close-drawer], [data-close-modal]");
  if (!el) return;
  if (el.matches("[data-close-modal]") && ev.target === el) return closeModal();
  if (el.matches("[data-close-modal-btn]")) return closeModal();
  if (el.matches("[data-close-drawer]")) { S.drawer = null; return render(); }
  if (el.dataset.view) { S.view = el.dataset.view; S.drawer = null; S.modal = null; renderModal(); window.scrollTo(0, 0); return render(); }
  if (el.dataset.tab) { S.f.tab = el.dataset.tab; return render(); }
  if (el.dataset.ltab) { S.ledgerTab = el.dataset.ltab; return render(); }
  if (el.dataset.rowAct) {
    ev.stopPropagation(); const inv = invByNo(el.dataset.no);
    if (el.dataset.rowAct === "send") return sendDialog(inv, "invoice");
    if (el.dataset.rowAct === "remind") { const st = L.status(inv, today()); return sendDialog(inv, st === "Overdue" ? ((inv.reminders_sent || []).some((r) => r.step === "R1") ? "R2" : "R1") : "pre"); }
    if (el.dataset.rowAct === "pay") return paymentForm(inv, false);
    S.drawer = inv.invoice_no; return render();
  }
  if (el.dataset.open && !el.closest(".modal")) { S.drawer = el.dataset.open; return render(); }
  if (el.dataset.exp) { const e = S.data.expenses.find((x) => x.id === el.dataset.exp); return e && expenseForm(e); }
  if (el.dataset.editClient) return clientForm(clientById(el.dataset.editClient));
  if (el.dataset.delLine) { syncLines(); S.formLines.splice(+el.dataset.delLine, 1); renderModal(); return updateInvTotal(); }
  if (el.dataset.bankExp) return expenseForm(null, S.data.bank.find((b) => b.id === el.dataset.bankExp));
  if (el.dataset.bankIgnore) { const b = { ...S.data.bank.find((x) => x.id === el.dataset.bankIgnore), ignored: true }; delete b._id; return write(() => S.db.doc("bank/" + b.id).set(b), "Excluded from matching"); }
  if (el.dataset.bankPay) {
    const b = S.data.bank.find((x) => x.id === el.dataset.bankPay);
    const open = enriched().filter((e) => e.inv.sent_at && !e.inv.void && e.balC > 0);
    return openModal(() => `<h2>Apply ${L.money(b.amount)} to an invoice</h2><p class="small muted">${esc(b.date)} · ${esc(b.description)} ${esc(b.reference || "")}</p>
      <div class="tablebox"><table><tbody>${open.map((e) => `<tr><td>${esc(e.inv.invoice_no)}</td><td>${esc(e.client?.name || "")}</td><td class="n">${M(e.balC)}</td><td><button class="btn sm" data-apply="${esc(e.inv.invoice_no)}" data-bank="${esc(b.id)}">Apply</button></td></tr>`).join("") || `<tr><td class="muted">No open invoices.</td></tr>`}</tbody></table></div>
      <div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button></div>`);
  }
  if (el.dataset.apply) { const b = S.data.bank.find((x) => x.id === el.dataset.bank); S.prefillPay = { date: b.date, amount: b.amount, ref: b.reference || b.description }; const inv = invByNo(el.dataset.apply); paymentForm(inv, false); S.prefillPay = null; return; }

  const act = el.dataset.act; if (!act) return;
  const inv = S.drawer && invByNo(S.drawer);
  switch (act) {
    case "new-inv": return S.data.clients.length ? invoiceForm(null) : clientForm(null, "invoice");
    case "edit-inv": return invoiceForm(inv);
    case "add-line": syncLines(); S.formLines.push({ description: "", qty: 1, unit_price: "" }); renderModal(); return updateInvTotal();
    case "save-inv": syncLines(); return saveInvoiceForm(el.dataset.send);
    case "send-inv": return sendDialog(inv, "invoice");
    case "remind-now": { const plan = L.reminderPlan(inv, set(), clientById(inv.client_id), today()); const st = L.status(inv, today()); const next = st === "Overdue" ? (plan.filter((r) => r.kind === "email" && r.step !== "pre" && r.state !== "sent")[0]?.step || "R2") : "pre"; return sendDialog(inv, next); }
    case "confirm-send": { const i = invByNo(S.modal.no), step = el.dataset.step; if (await write(() => logSend(i, step), step === "invoice" ? "Invoice marked as sent" : "Reminder logged")) closeModal(); return; }
    case "mark-paid": return paymentForm(inv, true);
    case "part-paid": return paymentForm(inv, false);
    case "save-pay": {
      const i = invByNo(S.modal.no), date = $("#p-date").value, amt = Number($("#p-amt").value);
      if (!date) return ($("#p-err").textContent = "Enter the date the money arrived.");
      if (!(amt > 0)) return ($("#p-err").textContent = "Enter an amount above zero.");
      if (locked(L.ym(date))) return ($("#p-err").textContent = `${L.monthLabel(L.ym(date))} is ${periodStatus(L.ym(date)).toLowerCase()}. Reopen it or use a later date.`);
      const upd = { ...i, payments: [...(i.payments || []), { id: uid(), date, amount: amt, method: $("#p-method").value, ref: $("#p-ref").value }] }; delete upd._id;
      const st = L.status(upd, today());
      if (await write(() => saveInvoice(upd), st === "Paid" ? "Paid. Reminders cancelled." : L.isOverpaid(upd) ? "Saved, but the invoice is overpaid" : "Partial payment recorded")) closeModal();
      return;
    }
    case "void-inv": return openModal(() => `<h2>Void ${esc(inv.invoice_no)}?</h2><p>Void only drafts or invoices sent in error. It's excluded from every total and its reminders stop. Credit notes aren't supported in the mockup.</p><div class="mfoot"><button class="btn" data-close-modal-btn>Cancel</button><button class="btn danger" data-act="confirm-void">Void invoice</button></div>`);
    case "confirm-void": { const upd = { ...inv, void: true, voided_at: new Date().toISOString() }; delete upd._id; if (await write(() => saveInvoice(upd), "Invoice voided")) closeModal(); return; }
    case "import-inv": return importInvDialog();
    case "commit-import": return commitImport();
    case "run-reminders": return runReminders();
    case "add-exp": return expenseForm(null);
    case "save-exp": {
      const o = S.modal.orig, date = $("#e-date").value, gross = Number($("#e-gross").value), cat = $("#e-cat").value, file = $("#e-file").files[0];
      if (!date || !$("#e-desc").value.trim()) return ($("#e-err").textContent = "Enter the date and a description.");
      if (!(gross >= 0) || $("#e-gross").value === "") return ($("#e-err").textContent = "Enter the amount paid.");
      if (!cat) return ($("#e-err").textContent = "Choose a category so the month can close.");
      if (locked(L.ym(date))) return ($("#e-err").textContent = `${L.monthLabel(L.ym(date))} is closed for editing.`);
      const e = { ...o, date, description: $("#e-desc").value.trim(), category: cat, gross, vatable: $("#e-vatable").checked, supplier_vat_no: $("#e-svat").value.trim(), receipt: file ? file.name : o.receipt, source: o.source === "Manual" && file ? "Receipt upload" : o.source, status: "Reviewed" };
      delete e._id;
      if (await write(() => saveExpense(e), "Expense saved")) closeModal(); return;
    }
    case "del-exp": { const id = S.modal.orig.id; if (await write(() => S.db.doc("expenses/" + id).delete(), "Expense deleted")) closeModal(); return; }
    case "import-bank": S.bankRows = null; S.bankMap = null; return importBankDialog();
    case "commit-bank": {
      const lines = S.bankParsed || [];
      const ok = await write(async () => { for (const l of lines) { const id = uid(); await S.db.doc("bank/" + id).set({ id, ...l, imported_at: new Date().toISOString() }); } await S.db.doc("config/settings").set({ ...stripSettings(), bank_map: S.bankMap }); });
      if (ok) { closeModal(); toast(`Imported ${lines.length} bank line${lines.length === 1 ? "" : "s"}`); }
      return;
    }
    case "save-settings": return saveSettings();
    case "add-client": return clientForm(null);
    case "save-client": {
      const o = S.modal.orig, name = $("#c-name").value.trim();
      if (!name) return ($("#c-err").textContent = "Enter the client's name.");
      const c = { ...o, id: o.id || docId(name.toLowerCase()).slice(0, 60) + "-" + uid().slice(-4), name, billing_email: $("#c-email").value.trim(), cc_emails: $("#c-cc").value.trim(), vat_number: $("#c-vat").value.trim(), address: $("#c-addr").value.trim(), default_terms_days: Number($("#c-terms").value) || 0, reminders_enabled: $("#c-rem").checked };
      delete c._id; const after = S.modal.after;
      if (await write(() => saveClient(c), "Client saved")) { closeModal(); if (after === "invoice") invoiceForm(null); }
      return;
    }
    case "send-ca": {
      const p = S.closeMonth, per = S.data.periods[p] || {};
      const body = { ...per, status: "With CA", sent_at: new Date().toISOString(), ca_email: set().ca_email, vat_period: L.vatPeriodOf(p, set().vat_category).label, pack: { ...S.pack, debtors: true }, history: [...(per.history || []), { at: new Date().toISOString(), event: "Sent to CA" + (set().ca_email ? " (" + set().ca_email + ")" : "") }] };
      return write(() => savePeriod(p, body), "Pack sent. The month is frozen.");
    }
    case "reopen": { const p = S.closeMonth, per = S.data.periods[p]; return write(() => savePeriod(p, { ...per, status: "Open", history: [...(per.history || []), { at: new Date().toISOString(), event: "Reopened by owner; CA notified" }] }), "Month reopened"); }
    case "ca-view": return openModal(caHTML, { wide: true, kind: "ca" });
    case "ca-approve": case "ca-return": {
      const p = S.closeMonth, per = S.data.periods[p], note = $("#ca-note").value.trim();
      const comments = {}; document.querySelectorAll("[data-cmt]").forEach((i) => { if (i.value.trim()) comments[i.dataset.cmt] = i.value.trim(); });
      if (act === "ca-return" && !note && !Object.keys(comments).length) { toast("Add a note or a line comment before returning the month"); return; }
      const signed = act === "ca-approve";
      const body = { ...per, status: signed ? "Signed off" : "Returned", comments, return_note: signed ? "" : note, signed_off_at: signed ? new Date().toISOString() : null, history: [...(per.history || []), { at: new Date().toISOString(), event: signed ? "Approved and signed off by CA" : "Returned by CA", note }] };
      if (await write(() => savePeriod(p, body), signed ? "Signed off. The month is locked." : "Returned to the owner")) closeModal();
      return;
    }
    case "export-pack": return exportPack();
    case "backup": return S.downloads.save({ filename: `invoice-tracker-backup-${today()}.json`, data: new Blob([LocalStore.exportAll()], { type: "application/json" }) });
    case "load-example": return loadExample();
    case "clear-all": return clearDialog();
    case "confirm-clear": {
      if ($("#del-confirm").value.trim() !== "DELETE") { toast("Type DELETE to confirm"); return; }
      const ok = await write(async () => {
        for (const c of S.data.clients) await S.db.doc("clients/" + c._id).delete();
        for (const i of S.data.invoices) await S.db.doc("invoices/" + i._id).delete();
        for (const e of S.data.expenses) await S.db.doc("expenses/" + e._id).delete();
        for (const b of S.data.bank) await S.db.doc("bank/" + b._id).delete();
        for (const p of Object.keys(S.data.periods)) await S.db.doc("periods/" + p).delete();
      }, "All data deleted");
      if (ok) closeModal(); return;
    }
  }
});
function syncLines() { document.querySelectorAll("[data-line]").forEach((i) => { S.formLines[+i.dataset.line][i.dataset.k] = i.value; }); }
const stripSettings = () => { const s = { ...set() }; delete s._id; return s; };
async function saveSettings() {
  const g = (id) => $("#s-" + id);
  const s = { ...stripSettings(),
    company: g("company").value.trim(), cc_reg: g("cc_reg").value.trim(), vat_no: g("vat_no").value.trim(), owner_email: g("owner_email").value.trim(), ca_email: g("ca_email").value.trim(),
    fy_end_month: +g("fy_end_month").value, income_category: g("income_category").value.trim() || "Sales", default_terms: Number(g("default_terms").value) || 30,
    vat_rate: Number(g("vat_rate").value) || 0, vat_basis: g("vat_basis").value, vat_category: g("vat_category").value,
    reminders: { pre: Number(g("r_pre").value) || 0, r1: Number(g("r_r1").value) || 0, every: Math.max(1, Number(g("r_every").value) || 7), call: Math.max(1, Number(g("r_call").value) || 28) },
    test_mode: g("test_mode").checked, live_clients: [...g("live_clients").selectedOptions].map((o) => o.value), payment_details: g("payment_details").value,
    tpl_pre: g("tpl_pre").value, tpl_r1: g("tpl_r1").value, tpl_rn: g("tpl_rn").value,
    expense_categories: g("expense_categories").value.split("\n").map((x) => x.trim()).filter(Boolean), as_of: g("as_of").value };
  if (s.fy_end_month !== set().fy_end_month) S.f.fy = null;
  await write(() => S.db.doc("config/settings").set(s), "Settings saved");
}
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.id === "f-q") { S.f.q = t.value; render(); return; }
  if (t.dataset.line != null) { S.formLines[+t.dataset.line][t.dataset.k] = t.value; return updateInvTotal(); }
  if (t.id === "p-amt" || t.id === "p-date") return updateSplit();
  if (["e-gross", "e-svat"].includes(t.id)) return updateExpSplit();
});
document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.id === "f-fy") { S.f.fy = t.value === "all" ? "all" : +t.value; S.f.month = ""; return render(); }
  if (t.id === "f-month") { S.f.month = t.value; return render(); }
  if (t.id === "f-client") { S.f.client = t.value; return render(); }
  if (t.id === "mp-ledger") { S.ledgerMonth = t.value; return render(); }
  if (t.id === "mp-close") { S.closeMonth = t.value; return render(); }
  if (t.id === "i-treat") return updateInvTotal();
  if (t.id === "i-client" && t.value === "__new") { syncLines(); return clientForm(null, "invoice"); }
  if (t.id === "e-vatable" || t.id === "e-file") return updateExpSplit();
  if (t.dataset.pack) { S.pack[t.dataset.pack] = t.checked; return; }
  if (t.id === "pause" || t.dataset.step) {
    const inv = invByNo(S.drawer); const upd = { ...inv }; delete upd._id;
    if (t.id === "pause") upd.reminders_paused = t.checked;
    else { const off = new Set(inv.reminder_off || []); t.checked ? off.delete(t.dataset.step) : off.add(t.dataset.step); upd.reminder_off = [...off]; }
    return write(() => saveInvoice(upd), t.id === "pause" ? (t.checked ? "Reminders paused" : "Reminders resumed") : "Schedule updated");
  }
  if (t.id === "imp-file" && t.files[0]) { const txt = await t.files[0].text(); return renderImportPreview(L.previewInvoiceCSV(txt.replace(/^﻿/, ""), set(), today())); }
  if (t.id === "bank-file" && t.files[0]) { const txt = await t.files[0].text(); S.bankRows = L.parseCSV(txt.replace(/^﻿/, "")); S.bankMap = null; return renderBankMap(); }
  if (t.id === "restore-file" && t.files[0]) {
    try { const n = LocalStore.importAll(await t.files[0].text()); toast(`Restored ${n} records`); } catch (e) { toast(e.message || "That file couldn't be read."); }
    t.value = ""; return;
  }
  if (t.dataset.map) { S.bankMap[t.dataset.map] = +t.value; return renderBankMap(); }
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { if (S.modal) closeModal(); else if (S.drawer) { S.drawer = null; render(); } } });

// ---------- boot ----------
render();
(async () => {
  if (!(window.claude && window.claude.use) && typeof LocalStore !== "undefined") {
    S.standalone = true; S.db = LocalStore.db; S.downloads = LocalStore.downloads; subscribe(); render(); return;
  }
  try {
    const db = window.claude && window.claude.use ? await window.claude.use("db") : null;
    if (!db) { S.noDb = true; render(); return; }
    S.db = db; subscribe(); render();
  } catch { S.noDb = true; render(); }
  try { S.downloads = await window.claude.use("downloads"); } catch {}
})();

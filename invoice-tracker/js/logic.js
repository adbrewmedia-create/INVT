// ===== Invoice Tracker — pure business logic (spec v2) =====
// Money is handled in integer cents internally. Dates are ISO strings YYYY-MM-DD.
const L = (() => {
  const toC = (x) => Math.round(Number(x || 0) * 100);
  const fromC = (c) => c / 100;
  // half-up division of non-negative or negative integers
  const divHalfUp = (num, den) => {
    const s = Math.sign(num) * Math.sign(den) || 1;
    const a = Math.abs(num), b = Math.abs(den);
    return s * Math.floor((2 * a + b) / (2 * b));
  };
  const bp = (ratePct) => Math.round(Number(ratePct || 0) * 100); // 15 -> 1500

  // ---- dates ----
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000); // a - b
  const ym = (s) => s.slice(0, 7);
  const monthEnd = (p) => { const [y, m] = p.split("-").map(Number); return iso(new Date(Date.UTC(y, m, 0))); };
  const addMonths = (p, n) => { const [y, m] = p.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return iso(d).slice(0, 7); };
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthLabel = (p) => { const [y, m] = p.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };

  // SA public holidays (Public Holidays Act: a Sunday holiday moves to Monday)
  const easter = (y) => { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return iso(new Date(Date.UTC(y, mo - 1, da))); };
  const holCache = {};
  const holidays = (y) => {
    if (holCache[y]) return holCache[y];
    const fixed = ["01-01","03-21","04-27","05-01","06-16","08-09","09-24","12-16","12-25","12-26"].map((md) => `${y}-${md}`);
    const set = new Set();
    fixed.forEach((d) => { set.add(d); if (parse(d).getUTCDay() === 0) set.add(addDays(d, 1)); });
    const e = easter(y); set.add(addDays(e, -2)); set.add(addDays(e, 1));
    return (holCache[y] = set);
  };
  const isBusinessDay = (s) => { const wd = parse(s).getUTCDay(); return wd !== 0 && wd !== 6 && !holidays(+s.slice(0, 4)).has(s); };
  const nextBusinessDay = (s) => { let d = s; while (!isBusinessDay(d)) d = addDays(d, 1); return d; };

  // ---- invoices ----
  function invoiceTotals(inv) {
    const netC = (inv.lines && inv.lines.length)
      ? inv.lines.reduce((s, l) => s + divHalfUp(toC(l.unit_price) * Math.round(Number(l.qty || 0) * 1000), 1000), 0)
      : toC(inv.net);
    const rate = inv.vat_treatment === "zero" ? 0 : Number(inv.vat_rate);
    const vatC = divHalfUp(netC * bp(rate), 10000);
    return { netC, vatC, grossC: netC + vatC, rate };
  }
  const paidC = (inv, upTo) => (inv.payments || []).filter((p) => !upTo || p.date <= upTo).reduce((s, p) => s + toC(p.amount), 0);

  function status(inv, today) {
    if (inv.void) return "Void";
    if (!inv.sent_at) return "Draft";
    const { grossC } = invoiceTotals(inv);
    const pc = paidC(inv);
    if (pc >= grossC) return "Paid";
    if (today > inv.due_date) return "Overdue";
    if (pc > 0) return "Partially paid";
    return "Outstanding";
  }
  const daysLate = (inv, today) => Math.max(0, diffDays(today, inv.due_date));
  const isOverpaid = (inv) => paidC(inv) > invoiceTotals(inv).grossC;
  function paidDate(inv) {
    const { grossC } = invoiceTotals(inv); let run = 0;
    for (const p of [...(inv.payments || [])].sort((a, b) => a.date.localeCompare(b.date))) { run += toC(p.amount); if (run >= grossC) return p.date; }
    return null;
  }

  // VAT portion of each payment, pro rata; the payment that clears the invoice takes the remainder
  function paymentSplits(inv) {
    const { vatC, grossC } = invoiceTotals(inv);
    const pays = [...(inv.payments || [])].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
    let paid = 0, vatSoFar = 0;
    return pays.map((p) => {
      const amtC = toC(p.amount);
      paid += amtC;
      let pv;
      if (grossC === 0) pv = 0;
      else if (paid >= grossC && paid - amtC < grossC) pv = vatC - vatSoFar;
      else pv = divHalfUp(amtC * vatC, grossC);
      vatSoFar += pv;
      return { ...p, amountC: amtC, vatC: pv, netC: amtC - pv };
    });
  }

  // ---- reminders ----
  // returns [{step, label, date, kind:'email'|'call', state:'sent'|'off'|'due'|'scheduled'|'cancelled'}]
  function reminderPlan(inv, settings, client, today) {
    const st = status(inv, today);
    const sched = settings.reminders || { pre: 3, r1: 1, every: 7, call: 28 };
    const off = new Set(inv.reminder_off || []);
    const sent = Object.fromEntries((inv.reminders_sent || []).map((r) => [r.step, r]));
    const cancelled = !inv.sent_at || inv.void || st === "Paid" || inv.reminders_paused || (client && client.reminders_enabled === false);
    const due = inv.due_date; if (!due) return [];
    const raw = [{ step: "pre", label: "Heads-up", rawDate: addDays(due, -sched.pre), kind: "email" }];
    const callDate = addDays(due, sched.call);
    raw.push({ step: "R1", label: "Payment reminder", rawDate: addDays(due, sched.r1), kind: "email" });
    for (let k = 2, d = addDays(due, sched.r1 + sched.every); d < callDate; k++, d = addDays(d, sched.every))
      raw.push({ step: "R" + k, label: "Follow-up", rawDate: d, kind: "email" });
    raw.push({ step: "call", label: "Phone the client", rawDate: callDate, kind: "call" });
    const plan = raw.map((r) => {
      const date = r.kind === "email" ? nextBusinessDay(r.rawDate) : r.rawDate;
      let state;
      if (sent[r.step]) state = "sent";
      else if (off.has(r.step)) state = "off";
      else if (cancelled) state = "cancelled";
      else if (r.step === "pre" && inv.sent_at.slice(0, 10) > r.rawDate) state = "skipped";
      else if (date <= today) state = "due";
      else state = "scheduled";
      return { ...r, date, sentAt: sent[r.step] && sent[r.step].at, state };
    });
    // only the most recent due email goes out; older unsent ones count as missed
    const dueEmails = plan.filter((r) => r.state === "due" && r.kind === "email");
    dueEmails.slice(0, -1).forEach((r) => { r.state = "missed"; });
    return plan;
  }
  const nextReminder = (inv, settings, client, today) =>
    reminderPlan(inv, settings, client, today).find((r) => r.state === "due" || r.state === "scheduled") || null;

  function mergeTemplate(tpl, inv, client, settings, today) {
    const t = invoiceTotals(inv);
    const bal = t.grossC - paidC(inv);
    const f = (c) => money(fromC(c));
    return String(tpl || "")
      .replaceAll("{client_name}", client ? client.name : "")
      .replaceAll("{invoice_no}", inv.invoice_no)
      .replaceAll("{gross}", f(t.grossC))
      .replaceAll("{balance}", f(bal))
      .replaceAll("{due_date}", inv.due_date)
      .replaceAll("{days_late}", String(daysLate(inv, today)))
      .replaceAll("{payment_details}", settings.payment_details || "");
  }

  // ---- expenses ----
  function expenseSplit(e, settings) {
    const grossC = toC(e.gross);
    if (!e.vatable) return { grossC, vatC: 0, netC: grossC, claimC: 0 };
    const r = bp(e.vat_rate != null ? e.vat_rate : settings.vat_rate);
    const vatC = divHalfUp(grossC * r, 10000 + r);
    const claimable = !!e.receipt && !!(e.supplier_vat_no || "").trim();
    return { grossC, vatC, netC: grossC - vatC, claimC: claimable ? vatC : 0 };
  }

  // ---- periods ----
  function fyOf(dateOrPeriod, yeMonth) { // returns FY end year
    const [y, m] = dateOrPeriod.split("-").map(Number);
    return m > yeMonth ? y + 1 : y;
  }
  function fyRange(fyEndYear, yeMonth) {
    const end = `${fyEndYear}-${pad(yeMonth)}`;
    const start = addMonths(end, -11);
    return { start: start + "-01", end: monthEnd(end), startP: start, endP: end };
  }
  const fyLabel = (fyEndYear, yeMonth) => { const r = fyRange(fyEndYear, yeMonth); return yeMonth === 12 ? `${fyEndYear}` : `FY${fyEndYear} (${monthLabel(r.startP)} – ${monthLabel(r.endP)})`; };
  // SARS bi-monthly: Category A periods end in odd months, B in even months
  function vatPeriodOf(p, cat) {
    const m = +p.slice(5, 7);
    const endsHere = cat === "A" ? m % 2 === 1 : m % 2 === 0;
    const end = endsHere ? p : addMonths(p, 1);
    return { start: addMonths(end, -1), end, label: `${monthLabel(addMonths(end, -1)).slice(0, 3)}–${monthLabel(end)}` };
  }

  // VAT for a set of months (array of YYYY-MM)
  function vatFor(months, data, settings) {
    const set = new Set(months);
    let outC = 0, inC = 0, inMissingC = 0;
    for (const inv of data.invoices) {
      if (inv.void || !inv.sent_at) continue;
      if (settings.vat_basis === "payments") {
        for (const s of paymentSplits(inv)) if (set.has(ym(s.date))) outC += s.vatC;
      } else if (set.has(ym(inv.issue_date))) outC += invoiceTotals(inv).vatC;
    }
    for (const e of data.expenses) {
      if (!set.has(ym(e.date))) continue;
      const s = expenseSplit(e, settings); inC += s.claimC; inMissingC += s.vatC - s.claimC;
    }
    return { outC, inC, inMissingC, payableC: outC - inC };
  }

  // ledger rows for one month (cash basis)
  function ledgerRows(p, data, settings) {
    const rows = [];
    const clients = Object.fromEntries(data.clients.map((c) => [c.id, c]));
    for (const inv of data.invoices) {
      if (inv.void) continue;
      for (const s of paymentSplits(inv)) {
        if (ym(s.date) !== p) continue;
        rows.push({ id: "pay:" + inv.invoice_no + ":" + s.id, date: s.date, type: "Income", description: `${clients[inv.client_id]?.name || "?"} · ${inv.invoice_no}${s.amountC < invoiceTotals(inv).grossC ? " (part)" : ""}`,
          category: inv.category || "Sales", source: "Invoice", receipt: "Invoice PDF", netC: s.netC, vatC: s.vatC, grossC: s.amountC, status: "Auto-categorised", invoice_no: inv.invoice_no });
      }
    }
    for (const e of data.expenses) {
      if (ym(e.date) !== p) continue;
      const s = expenseSplit(e, settings);
      rows.push({ id: "exp:" + e.id, date: e.date, type: "Expense", description: e.description, category: e.category || "", source: e.source || "Manual",
        receipt: e.receipt ? "Attached" : (e.source === "Bank import" ? "Statement" : "Missing"), netC: s.netC, vatC: s.vatC, claimC: s.claimC, grossC: s.grossC, status: e.status || "Needs review", expense: e });
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  }

  function debtorsAt(dateIso, data, today) {
    const out = [];
    for (const inv of data.invoices) {
      if (inv.void || !inv.sent_at || inv.issue_date > dateIso) continue;
      const bal = invoiceTotals(inv).grossC - paidC(inv, dateIso);
      if (bal > 0) out.push({ inv, balC: bal, daysLate: Math.max(0, diffDays(dateIso, inv.due_date)) });
    }
    return out.sort((a, b) => a.inv.due_date.localeCompare(b.inv.due_date));
  }

  // bank matching: payment or expense with same amount ±1 cent, date within 5 days
  function matchBank(data) {
    const used = new Set();
    const res = {};
    const lines = [...data.bank].sort((a, b) => a.date.localeCompare(b.date));
    const pays = [];
    data.invoices.forEach((inv) => (inv.payments || []).forEach((p) => pays.push({ key: "pay:" + inv.invoice_no + ":" + p.id, date: p.date, c: toC(p.amount), label: inv.invoice_no })));
    const exps = data.expenses.map((e) => ({ key: "exp:" + e.id, date: e.date, c: -toC(e.gross), label: e.description, bankId: e.bank_id }));
    for (const b of lines) {
      if (b.ignored) { res[b.id] = { state: "ignored" }; continue; }
      const c = toC(b.amount);
      const direct = exps.find((e) => e.bankId === b.id);
      if (direct) { used.add(direct.key); res[b.id] = { state: "matched", to: direct.key, label: direct.label }; continue; }
      const pool = c >= 0 ? pays : exps;
      const hit = pool.find((x) => !used.has(x.key) && Math.abs(x.c - c) <= 1 && Math.abs(diffDays(x.date, b.date)) <= 5);
      if (hit) { used.add(hit.key); res[b.id] = { state: "matched", to: hit.key, label: hit.label }; }
      else res[b.id] = { state: "unmatched" };
    }
    return res;
  }

  function suggestCategory(supplier, expenses) {
    const s = (supplier || "").trim().toLowerCase(); if (!s) return null;
    const counts = {};
    expenses.filter((e) => e.status === "Reviewed" && (e.supplier || e.description || "").toLowerCase().includes(s.split(" ")[0]))
      .forEach((e) => { counts[e.category] = (counts[e.category] || 0) + 1; });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }

  // CSV
  function parseCSV(text) {
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += ch;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ""));
  }
  const toCSV = (rows) => rows.map((r) => r.map((v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
  function normDate(s) {
    s = (s || "").trim(); if (!s) return "";
    let m;
    if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`; // DD/MM/YYYY (SA)
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
    return "";
  }
  const numIn = (s) => { if (s == null) return NaN; const t = String(s).replace(/[R\s]/g, "").replace(/,(?=\d{3}\b)/g, ""); return t === "" ? NaN : Number(t.replace(",", ".")); };

  // Invoice CSV → {rows:[{data, errors, warnings}]}
  function previewInvoiceCSV(text, settings, today) {
    const rows = parseCSV(text); if (!rows.length) return { rows: [], error: "The file is empty." };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const need = ["invoice_no", "client_name", "issue_date", "net_amount"];
    const missing = need.filter((n) => !head.includes(n));
    if (missing.length) return { rows: [], error: "Missing columns: " + missing.join(", ") };
    const get = (r, k) => { const i = head.indexOf(k); return i < 0 ? "" : (r[i] || "").trim(); };
    const seen = new Set();
    return { rows: rows.slice(1).map((r, idx) => {
      const errors = [], warnings = [];
      const invoice_no = get(r, "invoice_no"); if (!invoice_no) errors.push("No invoice number");
      if (seen.has(invoice_no)) errors.push("Duplicate in file"); seen.add(invoice_no);
      const client_name = get(r, "client_name"); if (!client_name) errors.push("No client name");
      const issue_date = normDate(get(r, "issue_date")); if (!issue_date) errors.push("Issue date unreadable");
      let due_date = normDate(get(r, "due_date"));
      if (!due_date && issue_date) { due_date = addDays(issue_date, settings.default_terms || 30); warnings.push("Due date from default terms"); }
      const net = numIn(get(r, "net_amount")); if (isNaN(net)) errors.push("Net amount unreadable");
      const treat = (get(r, "vat_treatment") || "").toLowerCase().startsWith("zero") ? "zero" : "standard";
      let rate = numIn(get(r, "vat_rate")); if (isNaN(rate)) rate = treat === "zero" ? 0 : settings.vat_rate; if (rate > 0 && rate < 1) rate = rate * 100;
      const vat_treatment = rate === 0 ? "zero" : treat;
      const inv = { invoice_no, net, vat_rate: rate, vat_treatment, lines: [] };
      const t = invoiceTotals(inv);
      const fileVat = numIn(get(r, "vat_amount")); if (!isNaN(fileVat) && Math.abs(toC(fileVat) - t.vatC) > 1) warnings.push(`VAT in file ${money(fileVat)} ≠ calculated ${money(fromC(t.vatC))}`);
      const fileGross = numIn(get(r, "gross_amount")); if (!isNaN(fileGross) && Math.abs(toC(fileGross) - t.grossC) > 1) warnings.push(`Total in file ${money(fileGross)} ≠ calculated ${money(fromC(t.grossC))}`);
      const stRaw = get(r, "status").toLowerCase();
      const paid_date = normDate(get(r, "paid_date"));
      let amount_paid = numIn(get(r, "amount_paid")); if (isNaN(amount_paid)) amount_paid = stRaw === "paid" ? fromC(t.grossC) : 0;
      if (amount_paid > 0 && !paid_date) errors.push("Amount paid but no paid date");
      const draft = stRaw === "draft";
      return { line: idx + 2, errors, warnings, data: {
        invoice_no, client_name, client_email: get(r, "client_email"), client_vat_number: get(r, "client_vat_number"),
        issue_date, due_date, net, vat_rate: rate, vat_treatment, sent_at: draft ? null : issue_date, void: stRaw === "void",
        payments: amount_paid > 0 && paid_date ? [{ id: "imp1", date: paid_date, amount: amount_paid, method: "EFT", ref: "Imported" }] : [],
        file_gross: isNaN(fileGross) ? null : fileGross } };
    }) };
  }

  const money = (x, sym = "R") => {
    const n = Number(x); const neg = n < 0;
    const s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (neg ? "−" : "") + sym + " " + s;
  };

  return { toC, fromC, divHalfUp, iso, parse, addDays, diffDays, ym, monthEnd, addMonths, monthLabel, MONTHS, holidays, isBusinessDay, nextBusinessDay,
    invoiceTotals, paidC, status, daysLate, isOverpaid, paidDate, paymentSplits, reminderPlan, nextReminder, mergeTemplate, expenseSplit,
    fyOf, fyRange, fyLabel, vatPeriodOf, vatFor, ledgerRows, debtorsAt, matchBank, suggestCategory, parseCSV, toCSV, normDate, numIn, previewInvoiceCSV, money };
})();
if (typeof module !== "undefined") module.exports = L;

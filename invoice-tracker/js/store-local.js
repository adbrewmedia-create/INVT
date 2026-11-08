// ===== Standalone storage: same API as the artifact db, kept in this browser's localStorage =====
const LocalStore = (() => {
  const KEY = "invt-books-v1";
  let store = {};
  try { store = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { store = {}; }
  const subs = new Set();
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { throw { code: "quota_exceeded", message: "This browser's storage is full." }; } };
  const notify = () => setTimeout(() => subs.forEach((f) => f()), 0);
  const meta = { fromCache: false, hasPendingWrites: false };
  const snap = (p) => ({ id: p.split("/").pop(), exists: p in store, data: () => store[p], metadata: meta });
  const docRef = (p) => ({
    path: p, id: p.split("/").pop(),
    get: async () => snap(p),
    set: async (d) => { store[p] = JSON.parse(JSON.stringify(d)); persist(); notify(); },
    update: async (d) => { if (!(p in store)) throw { code: "invalid_argument", message: "Document does not exist" }; store[p] = { ...store[p], ...JSON.parse(JSON.stringify(d)) }; persist(); notify(); },
    delete: async () => { delete store[p]; persist(); notify(); },
    onSnapshot: (next) => { const f = () => next(snap(p)); subs.add(f); setTimeout(f, 0); return () => subs.delete(f); },
  });
  const collRef = (c) => ({
    path: c,
    doc: (id) => docRef(c + "/" + (id || Math.random().toString(36).slice(2))),
    onSnapshot: (next) => {
      const f = () => { const docs = Object.keys(store).filter((k) => k.startsWith(c + "/") && k.split("/").length === c.split("/").length + 1).sort().map(snap); next({ docs, size: docs.length, empty: !docs.length, metadata: meta, docChanges: () => [] }); };
      subs.add(f); setTimeout(f, 0); return () => subs.delete(f);
    },
  });
  const db = { doc: docRef, collection: collRef };
  const exportAll = () => JSON.stringify({ app: "invoice-tracker", version: 1, exported_at: new Date().toISOString(), data: store }, null, 2);
  const importAll = (text) => { const j = JSON.parse(text); if (!j || j.app !== "invoice-tracker" || typeof j.data !== "object") throw new Error("This isn't an Invoice Tracker backup file."); store = j.data; persist(); notify(); return Object.keys(store).length; };
  const downloads = { save: async ({ filename, data }) => { const url = URL.createObjectURL(data); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); } };
  return { db, exportAll, importAll, downloads };
})();

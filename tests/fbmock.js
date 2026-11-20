// Minimal in-memory mock of the Firebase compat API used by app.js (testing only).
(function(){
  const LS = "__fbmock";
  const S = JSON.parse(localStorage.getItem(LS) || '{"docs":{},"users":{},"cur":null}');
  const save = () => localStorage.setItem(LS, JSON.stringify(S));
  const subs = new Set();
  const fire = () => setTimeout(() => subs.forEach(f => f()), 5);
  const clone = o => JSON.parse(JSON.stringify(o));
  const rid = () => Math.random().toString(36).slice(2, 12);
  const DEL = {__op: "delete"};
  const FieldValue = {
    delete: () => DEL,
    arrayUnion: (...v) => ({__op: "union", v}),
    arrayRemove: (...v) => ({__op: "remove", v}),
    serverTimestamp: () => Date.now()
  };
  function setPath(obj, path, val){
    const parts = path.split("."); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
    const k = parts[parts.length - 1];
    if (val && val.__op === "delete") delete o[k];
    else if (val && val.__op === "union") { const a = Array.isArray(o[k]) ? o[k] : []; val.v.forEach(x => { if (!a.some(y => JSON.stringify(y) === JSON.stringify(x))) a.push(clone(x)); }); o[k] = a; }
    else if (val && val.__op === "remove") { const a = Array.isArray(o[k]) ? o[k] : []; o[k] = a.filter(y => !val.v.some(x => JSON.stringify(x) === JSON.stringify(y))); }
    else o[k] = clone(val);
  }
  const isOp = v => v && typeof v === "object" && v.__op;
  function resolveOp(cur, v){
    if (v.__op === "delete") return undefined;
    if (v.__op === "union") { const a = Array.isArray(cur) ? cur.slice() : []; v.v.forEach(x => { if (!a.some(y => JSON.stringify(y) === JSON.stringify(x))) a.push(clone(x)); }); return a; }
    if (v.__op === "remove") { const a = Array.isArray(cur) ? cur : []; return a.filter(y => !v.v.some(x => JSON.stringify(x) === JSON.stringify(y))); }
  }
  function deepMerge(t, src){
    Object.keys(src).forEach(k => {
      const v = src[k];
      if (isOp(v)) { const r = resolveOp(t[k], v); if (r === undefined) delete t[k]; else t[k] = r; }
      else if (v && typeof v === "object" && !Array.isArray(v)) { t[k] = deepMerge((t[k] && typeof t[k] === "object" && !Array.isArray(t[k])) ? t[k] : {}, v); }
      else t[k] = clone(v);
    });
    return t;
  }
  function applySet(path, data, opts){
    if (opts && opts.merge) { S.docs[path] = deepMerge(S.docs[path] || {}, data); return; }
    if (opts && opts.mergeFields) { const d = S.docs[path] || {}; opts.mergeFields.forEach(f => { const v = data[f]; if (isOp(v)) { const r = resolveOp(d[f], v); if (r === undefined) delete d[f]; else d[f] = r; } else d[f] = clone(v); }); S.docs[path] = d; return; }
    S.docs[path] = deepMerge({}, data);
  }
  function applyUpdate(path, data){
    if (!S.docs[path]) { const e = new Error("not-found"); e.code = "not-found"; throw e; }
    Object.keys(data).forEach(k => setPath(S.docs[path], k, data[k]));
  }
  function docSnap(path){ const d = S.docs[path]; return { id: path.split("/").pop(), exists: !!d, data: () => d ? clone(d) : undefined, ref: docRef(path), metadata: {fromCache: false, hasPendingWrites: false} }; }
  function docRef(path){
    return {
      id: path.split("/").pop(), path,
      get: async () => docSnap(path),
      set: async (d, o) => { if (window.__denyLog && path.includes("/log/")) { const e = new Error("denied"); e.code = "permission-denied"; throw e; } applySet(path, d, o); save(); fire(); },
      update: async (d) => { applyUpdate(path, d); save(); fire(); },
      delete: async () => { delete S.docs[path]; save(); fire(); },
      collection: (n) => colRef(path + "/" + n),
      onSnapshot: (next) => { const f = () => next(docSnap(path)); subs.add(f); setTimeout(f, 5); return () => subs.delete(f); }
    };
  }
  function colRef(cpath, filters, order, lim){
    filters = filters || [];
    const depth = cpath.split("/").length + 1;
    const run = () => {
      let docs = Object.keys(S.docs).filter(k => k.startsWith(cpath + "/") && k.split("/").length === depth).map(docSnap);
      filters.forEach(([f, op, v]) => { docs = docs.filter(d => { const x = d.data()[f]; return op === "array-contains" ? (Array.isArray(x) && x.includes(v)) : op === "==" ? x === v : true; }); });
      if (order) docs.sort((a, b) => (order[1] === "desc" ? -1 : 1) * ((a.data()[order[0]] || 0) - (b.data()[order[0]] || 0)));
      if (lim) docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length, metadata: {fromCache: false, hasPendingWrites: false} };
    };
    return {
      doc: (id) => docRef(cpath + "/" + (id || rid())),
      where: (f, op, v) => colRef(cpath, filters.concat([[f, op, v]]), order, lim),
      orderBy: (f, dir) => colRef(cpath, filters, [f, dir || "asc"], lim),
      limit: (n) => colRef(cpath, filters, order, n),
      get: async () => run(),
      onSnapshot: (next) => { const f = () => next(run()); subs.add(f); setTimeout(f, 5); return () => subs.delete(f); }
    };
  }
  const fs = {
    enablePersistence: () => Promise.resolve(),
    collection: (p) => colRef(p),
    doc: (p) => docRef(p),
    batch: () => { const ops = [], paths = []; return {
      set: (r, d, o) => { paths.push(r.path); ops.push(() => applySet(r.path, d, o)); },
      update: (r, d) => ops.push(() => applyUpdate(r.path, d)),
      delete: (r) => ops.push(() => { delete S.docs[r.path]; }),
      commit: async () => { const backup = clone(S.docs); if (window.__denyLog && paths.some(x => x.includes("/log/"))) { const e = new Error("denied"); e.code = "permission-denied"; throw e; } try { ops.forEach(o => o()); } catch(e){ S.docs = backup; throw e; } save(); fire(); }
    }; }
  };
  const authListeners = [];
  function mkUser(u){ if (!u) return null; return { uid: u.uid, email: u.email, displayName: u.displayName || null,
    emailVerified: u.verified !== undefined ? !!u.verified : true, metadata: {creationTime: u.created ? new Date(u.created).toUTCString() : new Date(0).toUTCString()},
    sendEmailVerification: async () => { window.__verifySent = (window.__verifySent || 0) + 1; },
    reload: async () => {}, getIdToken: async () => "t",
    updateProfile: async (p) => { S.users[u.email].displayName = p.displayName; save(); },
    reauthenticateWithCredential: async (c) => { if (c.p !== S.users[u.email].pass) { const e = new Error("bad"); e.code = "auth/wrong-password"; throw e; } },
    delete: async () => { delete S.users[u.email]; S.cur = null; save(); authListeners.forEach(cb => cb(null)); } }; }
  const authObj = {
    get currentUser(){ return S.cur ? mkUser(S.users[S.cur]) : null; },
    onAuthStateChanged: (cb) => { authListeners.push(cb); setTimeout(() => cb(authObj.currentUser), 10); },
    createUserWithEmailAndPassword: async (email, pass) => {
      if (S.users[email]) { const e = new Error("exists"); e.code = "auth/email-already-in-use"; throw e; }
      if (pass.length < 6) { const e = new Error("weak"); e.code = "auth/weak-password"; throw e; }
      S.users[email] = {uid: "u_" + rid(), email, pass, displayName: null, verified: false, created: Date.now()}; S.cur = email; save();
      const user = mkUser(S.users[email]); setTimeout(() => authListeners.forEach(cb => cb(authObj.currentUser)), 50);
      return {user};
    },
    signInWithEmailAndPassword: async (email, pass) => {
      const u = S.users[email]; if (!u || u.pass !== pass) { const e = new Error("bad"); e.code = "auth/invalid-credential"; throw e; }
      S.cur = email; save(); authListeners.forEach(cb => cb(authObj.currentUser)); return {user: mkUser(u)};
    },
    signOut: async () => { S.cur = null; save(); authListeners.forEach(cb => cb(null)); },
    sendPasswordResetEmail: async () => {}
  };
  const fsFn = () => fs; fsFn.FieldValue = FieldValue;
  const authFn = () => authObj; authFn.EmailAuthProvider = {credential: (e, p) => ({e, p})};
  window.firebase = { initializeApp: () => ({}), auth: authFn, firestore: fsFn };
  window.__fb = S;
})();

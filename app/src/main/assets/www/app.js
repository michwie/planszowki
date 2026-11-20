(function(){
  "use strict";
  const $ = id => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
  const CFG = window.APP_CONFIG || {};
  const Android = window.Android || null;          // most do aplikacji Android (MainActivity)
  const MAX_GROUPS = 20;
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  // ---------- pomocnicze ----------
  const cmp = (a, b) => String(a).localeCompare(String(b), "pl", {sensitivity:"base", numeric:true});
  function fmt(ts){ return new Date(ts).toLocaleDateString("pl-PL", {day:"2-digit", month:"2-digit", year:"numeric"}); }
  function dateStr(ts){ const d = new Date(ts); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
  function todayStr(){ return dateStr(Date.now()); }
  function gier(n){ const d=n%10, h=n%100; return n + " " + (n===1 ? "grę" : (d>=2&&d<=4&&!(h>=12&&h<=14)) ? "gry" : "gier"); }
  function plural(n, one, few, many){ const d=n%10, h=n%100; return n + " " + (n===1 ? one : (d>=2&&d<=4&&!(h>=12&&h<=14)) ? few : many); }
  function toast(t){
    const el = $("toast"); el.textContent = t; el.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }
  function newCode(){ let c = ""; for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]; return c; }
  function errMsg(e){
    const c = (e && e.code) || "";
    if (c.includes("permission-denied")) return "Brak uprawnień do tej zmiany.";
    if (c.includes("unavailable")) return "Brak połączenia z internetem – spróbuj ponownie.";
    return "Coś poszło nie tak – spróbuj ponownie.";
  }
  function lsGet(k, d){ try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch(e){ return d; } }
  function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }

  // ---------- Firebase ----------
  firebase.initializeApp(CFG.firebase);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FV = firebase.firestore.FieldValue;
  try { db.enablePersistence({synchronizeTabs: false}).catch(() => {}); } catch(e){}
  const gref = gid => db.collection("groups").doc(gid);
  const pcol = gid => gref(gid).collection("plays");
  const lcol = gid => gref(gid).collection("log");
  const scol = gid => gref(gid).collection("userState");
  // "Szafa" grupy: gry, gracze bez konta i kody zaproszeń – widzą ją tylko właściciel i edytorzy
  const sref = gid => gref(gid).collection("shelf").doc("main");
  const gdoc = g => g.shelf ? sref(g.id) : gref(g.id);   // gdzie leżą gry i gracze danej grupy   // prywatny stan gracza: rozegrane gry i historia

  // ---------- stan ----------
  let me = null;                 // {uid, name}
  let groups = [];               // [{id, ...dane}] – dokument grupy połączony z szafą
  let groupDocs = [];            // surowe dokumenty grup
  const shelfBy = {};            // gid -> szafa (gry, gracze, kody)
  const shelfSubs = {};
  const coversBy = {};           // gid -> {gameId: dataUrl}  (okładki gier)
  const coverSubs = {};
  const logRole = {};            // gid -> rola, z którą subskrybowano Change Log
  const playsBy = {};            // gid -> [play]
  const playSubs = {};           // gid -> unsubscribe
  const logsBy = {};             // gid -> [wpis dziennika]
  const stateBy = {};            // gid -> {played:{gameId:ts}, history:[]}  – tylko moje
  const stateSubs = {};
  const logSubs = {};
  let regs = {};                 // uid -> {name, at}  (rejestracje kont)
  let regsUnsub = null;
  let groupsUnsub = null;
  let ui = { tab: 0, pool: lsGet("pl-pool", []), drawn: null, drawnGid: null, armed: null, moving: null,
             justPlayed: null, resArmed: null, rankGroup: "all" };

  const role = g => (g && g.members && me) ? (g.members[me.uid] || "") : "";
  const canEdit = g => ["owner", "editor"].includes(role(g));
  const isOwner = g => role(g) === "owner";
  const myPlayed = g => (stateBy[g.id] && stateBy[g.id].played) || {};
  const myHistory = g => (stateBy[g.id] && stateBy[g.id].history) || [];
  // Warianty gry: wersja podstawowa + każde rozszerzenie osobno (każdy wypada z losowania osobno)
  const exps = game => Array.isArray(game.exps) ? game.exps : [];
  const vkey = (game, exp) => exp ? game.id + "__" + exp.id : game.id;
  const variants = game => [null].concat(exps(game));
  const vlabel = (game, exp) => game.name + (exp ? " + " + exp.name : (exps(game).length ? " (wersja podstawowa)" : ""));
  const isVPlayed = (g, game, exp) => !!myPlayed(g)[vkey(game, exp)];
  // wykluczenie z losowania (wspólne dla grupy): game.off – wersja podstawowa, exp.off – rozszerzenie
  const isVOff = (game, exp) => !!(exp ? exp.off : game.off);
  const isAllOff = game => variants(game).every(e => isVOff(game, e));
  // gra "rozegrana" (przekreślona) = rozegrane wszystkie jej warianty
  const isPlayed = (g, game) => variants(game).every(e => isVPlayed(g, game, e));
  const findExp = (game, expId) => expId ? exps(game).find(e => e.id === expId) || null : null;
  const groupById = id => groups.find(g => g.id === id);
  function findGame(gameId, gid){
    for (const g of groups){
      if (gid && g.id !== gid) continue;
      const game = (g.games || []).find(x => x.id === gameId);
      if (game) return {game, group: g};
    }
    return null;
  }
  function allPlays(){ return Object.values(playsBy).flat().sort((a,b) => b.at - a.at); }
  function allPlayers(){
    const s = new Map();
    groups.forEach(g => (g.players || []).forEach(p => { if (!s.has(p.toLowerCase())) s.set(p.toLowerCase(), p); }));
    return [...s.values()].sort(cmp);
  }
  function setStatus(t){ $("status").textContent = t; }
  function fmtDT(ts){ const d = new Date(ts); return fmt(ts) + " " + String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); }
  const q = t => "„" + t + "”";
  // ---------- dziennik zmian (Change Log) ----------
  let logOk = true;   // false, gdy reguły w Firebase nie pozwalają jeszcze na dziennik
  // Zapis paczką zmian razem z wpisem do dziennika; gdy dziennik jest niedozwolony – zapis bez niego.
  // fill(batch, log, extra): log(gid, typ, tekst, [widzowie]) – wpis do dziennika; extra(b => ...) – prywatny stan graczy.
  // Gdy reguły jeszcze na to nie pozwalają – zapis samych zmian głównych.
  let logExtraOk = true;   // false, gdy reguły nie znają jeszcze pola playId we wpisie
  async function commitB(fill){
    const run = async full => {
      const b = db.batch();
      fill(b, full ? (gid, t, x, viewers, extra) => logTo(gid, t, x, b, viewers, extra) : () => {}, full ? f => f(b) : () => {});
      await b.commit();
    };
    if (logOk) {
      try { await run(true); return; }
      catch(e){
        if (!String(e.code).includes("permission-denied")) throw e;
        if (logExtraOk) {   // może to tylko nowe pole wpisu – spróbuj bez niego
          logExtraOk = false;
          try { await run(true); return; } catch(e2){ if (!String(e2.code).includes("permission-denied")) throw e2; }
        }
        logOk = false;
      }
    }
    await run(false);
  }
  function stateSet(b, gid, u, data){ b.set(scol(gid).doc(u), Object.assign(data, {updatedAt: Date.now()}), {merge: true}); }
  function logEntry(type, text, viewers, extra){
    const e = {at: Date.now(), by: me.uid, name: me.name, type, text: String(text).slice(0, 300), scope: viewers ? "private" : "group"};
    if (viewers) e.viewers = [...new Set(viewers.concat(me.uid))];
    if (extra && extra.playId && logExtraOk) e.playId = String(extra.playId);
    return e;
  }
  function logTo(gid, type, text, batch, viewers, extra){
    if (!logOk) return;
    const e = logEntry(type, text, viewers, extra);
    if (batch) batch.set(lcol(gid).doc(), e);
    else lcol(gid).doc().set(e).catch(() => {});
  }

  // ================= LOGOWANIE =================
  let authMode = "login", pendingName = "";
  function setAuthMode(m){
    authMode = m;
    document.querySelectorAll("#authTabs .tab").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
    $("aNames").hidden = m !== "register";
    $("aSubmit").textContent = m === "register" ? "Załóż konto" : "Zaloguj";
    $("aPass").autocomplete = m === "register" ? "new-password" : "current-password";
    $("aErr").textContent = "";
  }
  document.querySelectorAll("#authTabs .tab").forEach(b => b.onclick = () => setAuthMode(b.dataset.mode));
  function authErr(e){
    const c = (e && e.code) || "";
    if (c.includes("invalid-email")) return "Nieprawidłowy adres e-mail.";
    if (c.includes("email-already-in-use")) return "To konto już istnieje – zaloguj się.";
    if (c.includes("weak-password")) return "Hasło musi mieć co najmniej 6 znaków.";
    if (c.includes("wrong-password") || c.includes("invalid-credential") || c.includes("invalid-login") || c.includes("user-not-found")) return "Zły e-mail lub hasło.";
    if (c.includes("too-many-requests")) return "Za dużo prób – odczekaj chwilę.";
    if (c.includes("network")) return "Brak połączenia z internetem.";
    return "Nie udało się: " + (e && e.message ? e.message : c);
  }
  $("authForm").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("aEmail").value.trim(), pass = $("aPass").value;
    const first = $("aName").value.trim().replace(/\s+/g, " "), last = $("aSurname").value.trim().replace(/\s+/g, " ");
    const name = (first + " " + last).trim().slice(0, 60);
    $("aErr").textContent = "";
    if (authMode === "register" && (!first || !last)) { $("aErr").textContent = "Podaj imię i nazwisko."; return; }
    $("aSubmit").disabled = true;
    try {
      if (authMode === "register") {
        pendingName = name;
        const cred = await auth.createUserWithEmailAndPassword(email, pass);
        lsSet("pl-name-" + cred.user.uid, name);
        await cred.user.updateProfile({displayName: name});
        if (me && me.uid === cred.user.uid) { me.name = name; $("meName").textContent = name; }
        try { await cred.user.sendEmailVerification(); } catch(e){}
        enterApp(cred.user);
      } else {
        await auth.signInWithEmailAndPassword(email, pass);
      }
    } catch(err){ $("aErr").textContent = authErr(err); }
    $("aSubmit").disabled = false;
  });
  $("aReset").onclick = async () => {
    const email = $("aEmail").value.trim();
    if (!email) { $("aErr").textContent = "Wpisz najpierw swój e-mail."; return; }
    try { await auth.sendPasswordResetEmail(email); $("aErr").textContent = ""; toast("Wysłano e-mail z linkiem do zmiany hasła"); }
    catch(err){ $("aErr").textContent = authErr(err); }
  };
  // okno potwierdzenia (w stylu motywu)
  function confirmDialog(o){
    $("cfTitle").textContent = o.title || "Na pewno?";
    $("cfText").textContent = o.text || "";
    $("cfIcon").textContent = o.icon || "?";
    $("cfYes").textContent = o.yes || "Tak";
    $("cfYes").classList.toggle("danger-yes", !!o.danger);
    $("cfNo").textContent = o.no || "Anuluj";
    $("cfNo").onclick = () => closeOv("cf");
    $("cfYes").onclick = () => { closeOv("cf"); o.onYes && o.onYes(); };
    openOv("cf");
  }
  $("logout").onclick = () => confirmDialog({title: "Wylogować się?", text: "Aby znów korzystać z aplikacji, trzeba będzie zalogować się e-mailem i hasłem.", icon: "⎋", yes: "Wyloguj", onYes: () => auth.signOut()});

  // dwustopniowe potwierdzenie dla zwykłych przycisków
  function confirmTap(btn, armedText){
    if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.innerHTML = btn.dataset.orig; return true; }
    btn.dataset.orig = btn.innerHTML; btn.dataset.armed = "1"; btn.textContent = armedText;
    setTimeout(() => { if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.innerHTML = btn.dataset.orig; } }, 4000);
    return false;
  }

  auth.onAuthStateChanged(user => {
    if (user) enterApp(user);
    else stopApp();
  });
  // ---------- potwierdzenie adresu e-mail (nowe konta) ----------
  try { auth.languageCode = "pl"; } catch(e){}
  // każde konto musi mieć potwierdzony adres e-mail – sprawdzają to też reguły bazy (email_verified)
  function needsVerify(u){ return !!u && !u.emailVerified; }
  function enterApp(u){
    if (needsVerify(u)) { showVerify(u); return; }
    $("verifyView").hidden = true;
    startApp(u);
  }
  let verifySentFor = "";
  function showVerify(u){
    $("authView").hidden = true; $("appView").hidden = true; $("tabbar").hidden = true;
    $("verifyView").hidden = false;
    $("vEmail").textContent = u.email || "";
    // konto założone przed wprowadzeniem potwierdzania: link wysyłamy automatycznie (raz na uruchomienie)
    const fresh = Date.now() - Date.parse(u.metadata && u.metadata.creationTime || 0) < 5 * 60 * 1000;
    if (!fresh && verifySentFor !== u.uid) { verifySentFor = u.uid; u.sendEmailVerification().catch(() => {}); }
  }
  async function checkVerified(silent){
    const u = auth.currentUser; if (!u) return;
    try { await u.reload(); } catch(e){ if (!silent) $("vMsg").textContent = errMsg(e); return; }
    if (auth.currentUser.emailVerified) {
      try { await auth.currentUser.getIdToken(true); } catch(e){}
      $("vMsg").textContent = ""; toast("Adres potwierdzony – witaj w Planszomacie!");
      enterApp(auth.currentUser);
    } else if (!silent) $("vMsg").textContent = "Adres nie jest jeszcze potwierdzony. Kliknij link w wiadomości e-mail.";
  }
  $("vCheck").onclick = () => checkVerified(false);
  $("vResend").onclick = async () => {
    try { await auth.currentUser.sendEmailVerification(); $("vMsg").textContent = ""; toast("Wysłano nowy link na " + auth.currentUser.email); }
    catch(e){ $("vMsg").textContent = String(e.code).includes("too-many-requests") ? "Za dużo prób – odczekaj kilka minut." : errMsg(e); }
  };
  $("vLogout").onclick = () => auth.signOut();
  // po powrocie z poczty sprawdź automatycznie
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("verifyView").hidden) checkVerified(true); });

  function stopApp(){
    me = null;
    if (groupsUnsub) { groupsUnsub(); groupsUnsub = null; }
    Object.keys(playSubs).forEach(k => { playSubs[k](); delete playSubs[k]; delete playsBy[k]; });
    Object.keys(logSubs).forEach(k => { logSubs[k](); delete logSubs[k]; delete logsBy[k]; });
    Object.keys(stateSubs).forEach(k => { stateSubs[k](); delete stateSubs[k]; delete stateBy[k]; });
    Object.keys(shelfSubs).forEach(k => { shelfSubs[k](); delete shelfSubs[k]; delete shelfBy[k]; });
    Object.keys(coverSubs).forEach(k => { coverSubs[k](); delete coverSubs[k]; delete coversBy[k]; });
    groupDocs = [];
    backfilled.clear(); loadedP.clear(); loadedS.clear(); reconciled.clear();
    if (regsUnsub) { regsUnsub(); regsUnsub = null; } regs = {};
    if (prefsUnsub) { prefsUnsub(); prefsUnsub = null; }
    groups = [];
    $("appView").hidden = true; $("tabbar").hidden = true; $("verifyView").hidden = true; $("authView").hidden = false;
    setAuthMode("login");
  }
  function startApp(user){
    if (me && me.uid === user.uid) return;
    me = { uid: user.uid, name: user.displayName || pendingName || lsGet("pl-name-" + user.uid, "") || (user.email || "").split("@")[0] };
    $("meName").textContent = me.name;
    $("authView").hidden = true; $("appView").hidden = false; $("tabbar").hidden = false;
    showView("home");   // ekran startowy: najczęściej i najrzadziej grana
    setStatus("Łączenie…");
    render();
    groupsUnsub = db.collection("groups").where("memberIds", "array-contains", me.uid).onSnapshot(qs => {
      groupDocs = qs.docs.map(d => Object.assign({id: d.id}, d.data()));
      mergeGroups();
      const ids = new Set(groups.map(g => g.id));
      groups.forEach(g => { if (canEdit(g)) subShelf(g.id, 0); else if (shelfSubs[g.id]) { shelfSubs[g.id](); delete shelfSubs[g.id]; delete shelfBy[g.id]; } });
      groups.forEach(g => { if (canEdit(g)) subCovers(g.id, 0); else if (coverSubs[g.id]) { coverSubs[g.id](); delete coverSubs[g.id]; delete coversBy[g.id]; } });
      Object.keys(coverSubs).forEach(k => { if (!ids.has(k)) { coverSubs[k](); delete coverSubs[k]; delete coversBy[k]; } });
      Object.keys(shelfSubs).forEach(k => { if (!ids.has(k)) { shelfSubs[k](); delete shelfSubs[k]; delete shelfBy[k]; } });
      Object.keys(playSubs).forEach(k => { if (!ids.has(k)) { playSubs[k](); delete playSubs[k]; delete playsBy[k]; } });
      groups.forEach(g => {
        // zmiana roli (gracz <-> edytor) zmienia, które wpisy Change Log wolno czytać
        if (logSubs[g.id] && logRole[g.id] !== canEdit(g)) { logSubs[g.id](); delete logSubs[g.id]; delete logsBy[g.id]; }
        logRole[g.id] = canEdit(g);
        subPlays(g.id, 0); subLog(g.id, 0); subState(g.id, 0);
      });
      Object.keys(logSubs).forEach(k => { if (!ids.has(k)) { logSubs[k](); delete logSubs[k]; delete logsBy[k]; } });
      Object.keys(stateSubs).forEach(k => { if (!ids.has(k)) { stateSubs[k](); delete stateSubs[k]; delete stateBy[k]; } });
      if (!qs.metadata.fromCache) groups.forEach(g => backfillPlays(g));
      setStatus(qs.metadata.fromCache ? "Tryb offline – zmiany wyślę po połączeniu" : "Połączono ✓");
      render();
    }, err => { setStatus("Błąd połączenia z bazą: " + errMsg(err)); });
    startRegs(user);
    subPrefs(user);
    checkUpdate();
  }

  // Grupa = dokument grupy (nazwa, członkowie) + szafa (gry, gracze, kody) dla właściciela i edytorów.
  // Starsze grupy trzymały gry w dokumencie grupy – wtedy bierzemy je stamtąd, a właściciel przenosi je do szafy.
  function mergeGroups(){
    groups = groupDocs.map(d => {
      const g = Object.assign({}, d);
      const sh = shelfBy[d.id];
      if (!canEdit(g)) { g.games = []; g.players = []; delete g.inviteCode; }
      else if (sh) { g.games = sh.games || []; g.players = sh.players || []; g.editorCode = sh.editorCode || ""; g.playerCode = sh.playerCode || ""; g.shelf = true; }
      else { g.games = d.games || []; g.players = d.players || []; }
      return g;
    }).sort((a,b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
  }
  // okładki gier: groups/{gid}/covers/{gameId} = {img: dataUrl} – widzą je właściciel i Mistrzowie Gry
  function subCovers(gid, attempt){
    if (coverSubs[gid]) return;
    coverSubs[gid] = gref(gid).collection("covers").onSnapshot(cs => {
      const m = {}; cs.docs.forEach(d => { if (d.data().img) m[d.id] = d.data().img; });
      coversBy[gid] = m; render(); if (ge && !$("ge").hidden) renderGameEdit();
    }, () => {
      delete coverSubs[gid];
      if (attempt < 8) setTimeout(() => { const g = groupById(gid); if (me && g && canEdit(g)) subCovers(gid, attempt + 1); }, 1500 * (attempt + 1));
    });
  }
  const coverOf = (gid, gameId) => (coversBy[gid] || {})[gameId] || "";
  function coverImg(gid, gameId, cls){
    const src = coverOf(gid, gameId); if (!src) return null;
    const im = document.createElement("img"); im.className = cls; im.alt = ""; im.src = src; im.loading = "lazy";
    return im;
  }
  // wybór okładki: w aplikacji – galeria lub aparat (Android), w przeglądarce – plik
  function saveCover(g, game, url){
    if (!url) return Promise.resolve();
    return shrinkImage(url, 320).then(img => gref(g.id).collection("covers").doc(game.id).set({img, by: me.uid, updatedAt: Date.now()}))
      .then(() => toast("Zapisano okładkę „" + game.name + "”")).catch(e => toast(errMsg(e)));
  }
  function pickCover(g, game){
    const save = url => saveCover(g, game, url);
    if (Android && Android.pickCover) { window.onCover = url => { window.onCover = null; save(url); }; Android.pickCover(); return; }
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
    inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => save(r.result); r.readAsDataURL(f); };
    inp.click();
  }
  function removeCover(g, game){
    confirmDialog({title: "Usunąć okładkę?", text: "Okładka gry „" + game.name + "” zostanie usunięta.", icon: "🗑", yes: "Usuń", danger: true,
      onYes: () => gref(g.id).collection("covers").doc(game.id).delete().catch(e => toast(errMsg(e)))});
  }
  // zmniejszenie zdjęcia do max px (JPEG), żeby okładka zajmowała kilkanaście KB
  function shrinkImage(url, max){
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, max / Math.max(im.width, im.height));
        const c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        let q = 0.8, out = c.toDataURL("image/jpeg", q);
        while (out.length > 90000 && q > 0.4) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
        res(out);
      };
      im.onerror = () => rej(new Error("Nie udało się wczytać zdjęcia"));
      im.src = url;
    });
  }
  function subShelf(gid, attempt){
    if (shelfSubs[gid]) return;
    shelfSubs[gid] = sref(gid).onSnapshot(d => {
      if (d.exists) shelfBy[gid] = d.data(); else delete shelfBy[gid];
      mergeGroups();
      const g = groupById(gid);
      if (!d.exists && g && isOwner(g) && !d.metadata.fromCache) migrateShelf(g);
      render();
    }, () => {
      delete shelfSubs[gid];
      if (attempt < 8) setTimeout(() => { const g = groupById(gid); if (me && g && canEdit(g)) subShelf(gid, attempt + 1); }, 1500 * (attempt + 1));
    });
  }
  // Jednorazowo (właściciel): przeniesienie gier, graczy i kodu z dokumentu grupy do szafy + osobny kod dla graczy
  const migrated = new Set();
  async function migrateShelf(g){
    if (migrated.has(g.id)) return; migrated.add(g.id);
    const d = groupDocs.find(x => x.id === g.id) || {};
    const editorCode = d.inviteCode || newCode(), playerCode = newCode();
    try {
      const b = db.batch();
      b.set(sref(g.id), {games: d.games || [], players: d.players || [], editorCode, playerCode, updatedAt: Date.now()});
      if (d.inviteCode) b.delete(db.collection("invites").doc(d.inviteCode));
      b.update(gref(g.id), {games: FV.delete(), players: FV.delete(), inviteCode: FV.delete(), updatedAt: Date.now()});
      await b.commit();
      const b2 = db.batch();
      b2.set(db.collection("invites").doc(editorCode), {groupId: g.id, role: "editor", createdBy: me.uid, createdAt: Date.now()});
      b2.set(db.collection("invites").doc(playerCode), {groupId: g.id, role: "player", createdBy: me.uid, createdAt: Date.now()});
      await b2.commit();
    } catch(e){ migrated.delete(g.id); }
  }

  // Wyniki grupy. Nowo utworzona grupa może jeszcze nie istnieć na serwerze, gdy zaczynamy
  // słuchać jej wyników – serwer wtedy odmawia, więc ponawiamy po chwili.
  // Wyniki: widzę tylko te, w których jestem wśród "viewers" (gracze z kontem + osoba wpisująca).
  function subPlays(gid, attempt){
    if (playSubs[gid]) return;
    playSubs[gid] = pcol(gid).where("viewers", "array-contains", me.uid).onSnapshot(ps => {
      playsBy[gid] = ps.docs.map(d => Object.assign({}, d.data(), {id: d.id, groupId: gid})).sort((a,b) => b.at - a.at);
      renderDrawStats(); if (!$("gi").hidden) renderGameInfo(); renderAllRes();
      if (!ps.metadata.fromCache) { loadedP.add(gid); reconcileMine(gid); }
      renderResults();
    }, () => {
      delete playSubs[gid];
      if (attempt < 8) setTimeout(() => { if (me && groupById(gid)) subPlays(gid, attempt + 1); }, 1500 * (attempt + 1));
    });
  }
  // Change Log: wpisy całej grupy + wpisy prywatne, w których jestem
  function subLog(gid, attempt){
    if (logSubs[gid]) return;
    const part = {};
    const merge = () => { logsBy[gid] = Object.values(part).flat(); renderLog(); };
    const unsubs = [];
    let failed = false;
    const onErr = () => {
      if (failed) return; failed = true;
      unsubs.forEach(u => u()); delete logSubs[gid];
      if (attempt < 8) setTimeout(() => { if (me && groupById(gid)) subLog(gid, attempt + 1); }, 1500 * (attempt + 1));
    };
    const g0 = groupById(gid);
    if (g0 && canEdit(g0)) unsubs.push(lcol(gid).where("scope", "==", "group").onSnapshot(ls => { part.g = ls.docs.map(d => Object.assign({}, d.data(), {id: d.id, groupId: gid})); merge(); }, onErr));
    unsubs.push(lcol(gid).where("viewers", "array-contains", me.uid).onSnapshot(ls => { part.p = ls.docs.map(d => Object.assign({}, d.data(), {id: d.id, groupId: gid})); merge(); }, onErr));
    logSubs[gid] = () => unsubs.forEach(u => u());
  }
  // Mój prywatny stan w grupie
  function subState(gid, attempt){
    if (stateSubs[gid]) return;
    const ref = scol(gid).doc(me.uid);
    stateSubs[gid] = ref.onSnapshot(d => {
      const st = d.exists ? d.data() : {};
      const hist = (st.history || []).slice().sort((a,b) => b.at - a.at);
      stateBy[gid] = {played: st.played || {}, history: hist};
      if (!d.metadata.fromCache) { loadedS.add(gid); reconcileMine(gid); }
      if (hist.length > 60) ref.set({history: hist.slice(0, 50)}, {mergeFields: ["history"]}).catch(() => {});
      render();
    }, () => {
      delete stateSubs[gid];
      if (attempt < 8) setTimeout(() => { if (me && groupById(gid)) subState(gid, attempt + 1); }, 1500 * (attempt + 1));
    });
  }
  // Jednorazowo po starcie: moje "rozegrane" muszą wynikać z wyników, w których jestem.
  // Oznaczenia bez wyniku (np. po starszej edycji wyniku albo z dawnego „Gramy!”) usuwam – gra wraca do losowania.
  const loadedP = new Set(), loadedS = new Set(), reconciled = new Set();
  function reconcileMine(gid){
    if (reconciled.has(gid) || !loadedP.has(gid) || !loadedS.has(gid)) return;
    reconciled.add(gid);
    const st = stateBy[gid] || {played: {}, history: []};
    const ok = new Set();
    (playsBy[gid] || []).filter(pl => (pl.scores || []).some(sc => sc.uid === me.uid)).forEach(pl => {
      ((pl.exps && pl.exps.length) ? pl.exps.map(e => e.id) : [null]).forEach(id => ok.add(id ? pl.gameId + "__" + id : pl.gameId));
    });
    const old = Date.now() - 5 * 60 * 1000;   // świeże oznaczenia zostawiam (wynik mógł jeszcze nie dotrzeć)
    const drop = Object.keys(st.played).filter(k => !ok.has(k) && st.played[k] < old);
    const dropH = st.history.filter(h => !ok.has(h.id) && h.at < old);
    if (!drop.length && !dropH.length) return;
    const played = {}; drop.forEach(k => played[k] = FV.delete());
    const data = {played, updatedAt: Date.now()};
    if (dropH.length) data.history = FV.arrayRemove(...dropH);
    scol(gid).doc(me.uid).set(data, {merge: true}).catch(() => {});
  }

  // Jednorazowo: starym wynikom (bez "viewers") dopisz, kto może je widzieć. Działa, dopóki obowiązują stare reguły.
  const backfilled = new Set();
  async function backfillPlays(g){
    if (backfilled.has(g.id)) return; backfilled.add(g.id);
    try {
      const ps = await pcol(g.id).get();
      const todo = ps.docs.filter(d => !Array.isArray(d.data().viewers) && (canEdit(g) || d.data().createdBy === me.uid));
      for (let i = 0; i < todo.length; i += 400) {
        const b = db.batch();
        todo.slice(i, i + 400).forEach(d => {
          const p = d.data();
          const v = [...new Set((p.scores || []).filter(x => x.uid).map(x => x.uid).concat(p.createdBy ? [p.createdBy] : []))];
          b.update(d.ref, {viewers: v});
        });
        await b.commit();
      }
    } catch(e){ /* nowe reguły: niewidoczne stare wyniki zostają ukryte */ }
  }

  function startRegs(user){
    regsUnsub = db.collection("registrations").onSnapshot(rs => {
      regs = {}; rs.docs.forEach(d => regs[d.id] = d.data()); render();   // imiona kont odświeżają się wszędzie
    }, () => {});
    // wpis o rejestracji (dla kont założonych przed dodaniem dziennika – z datą założenia konta)
    const ref = db.collection("registrations").doc(user.uid);
    ref.get().then(d => {
      if (d.exists) { if (me.name && d.data().name !== me.name) return ref.update({name: me.name}); return; }
      const created = user.metadata && user.metadata.creationTime ? Date.parse(user.metadata.creationTime) : Date.now();
      return ref.set({name: me.name, at: isNaN(created) ? Date.now() : created});
    }).catch(() => {});
  }

  // ================= ZAPIS =================
  async function upd(gid, patch, logText, logType){
    try {
      const g = groupById(gid), sp = {}, gp = {};
      Object.keys(patch).forEach(k => ((k === "games" || k === "players") && g && g.shelf ? sp : gp)[k] = patch[k]);
      await commitB((b, log) => {
        if (Object.keys(gp).length) b.update(gref(gid), Object.assign(gp, {updatedAt: Date.now()}));
        if (Object.keys(sp).length) b.update(sref(gid), Object.assign(sp, {updatedAt: Date.now()}));
        if (logText) log(gid, logType || "edit", logText);
      });
      return true;
    } catch(e){ toast(errMsg(e)); return false; }
  }
  async function createGroup(name, extra){
    for (let attempt = 0; attempt < 5; attempt++){
      const editorCode = newCode(), playerCode = newCode();
      const ref = db.collection("groups").doc();
      const data = {
        name: name, ownerId: me.uid,
        members: {[me.uid]: "owner"}, memberIds: [me.uid], memberNames: {[me.uid]: me.name},
        createdAtMs: Date.now(), updatedAt: Date.now()
      };
      const shelf = Object.assign({games: [], players: []}, extra || {}, {editorCode, playerCode, updatedAt: Date.now()});
      try {
        await commitB((b, log) => {
          b.set(ref, data);
          b.set(sref(ref.id), shelf);
          b.set(db.collection("invites").doc(editorCode), {groupId: ref.id, role: "editor", createdBy: me.uid, createdAt: Date.now()});
          b.set(db.collection("invites").doc(playerCode), {groupId: ref.id, role: "player", createdBy: me.uid, createdAt: Date.now()});
          log(ref.id, "group", "Utworzenie grupy " + q(name));
        });
        return ref.id;
      }
      catch(e){ if (!String(e.code).includes("permission-denied")) { toast(errMsg(e)); return null; } }
    }
    toast("Nie udało się utworzyć grupy"); return null;
  }

  // ================= LOSOWANIE =================
  // zapisana pula może zawierać grupy, których już nie ma (np. po usunięciu grupy) – takie pomijamy
  function inPool(g){ if (!canEdit(g)) return false; const p = ui.pool.filter(id => groups.some(x => x.id === id && canEdit(x))); return !p.length || p.includes(g.id); }
  function poolGames(){
    const out = [];
    groups.forEach(g => { if (inPool(g)) (g.games || []).forEach(game => out.push({game, group: g})); });
    return out;
  }
  function poolVariants(){
    const out = [];
    poolGames().forEach(x => variants(x.game).forEach(exp => { if (!isVOff(x.game, exp)) out.push({game: x.game, group: x.group, exp}); }));
    return out;
  }
  let spinning = false;
  function draw(exclude){
    if (spinning) return;
    let cands = poolVariants().filter(x => !isVPlayed(x.group, x.game, x.exp));
    if (exclude && cands.length > 1) cands = cands.filter(x => vkey(x.game, x.exp) !== exclude);
    if (!cands.length) return;
    const pick = cands[Math.floor(Math.random() * cands.length)];
    spinning = true; ui.drawn = null; ui.justPlayed = null; renderDraw();
    const nameEl = document.querySelector("#stage .name");
    const target = pick.game.name;
    const finish = popIt => {
      spinning = false; ui.drawn = pick.game.id; ui.drawnGid = pick.group.id; ui.drawnExp = pick.exp ? pick.exp.id : null; renderDraw();
      const el = document.querySelector("#stage .name"); if (el && popIt) el.classList.add("pop");
      if (Android && Android.vibrate) try { Android.vibrate(30); } catch(e){}
    };
    // Matrix: litery „przewijają się” znakami z deszczu kodu
    if (theme === "matrix") {
      const glyphs = "アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789#$%&*+<>";
      const total = 26; let frame = 0;
      const tick = () => {
        frame++;
        const revealed = Math.floor(target.length * Math.max(0, (frame - 8) / (total - 8)));
        let out = "";
        for (let i = 0; i < target.length; i++) { const c = target[i]; out += (i < revealed || c === " ") ? c : glyphs[Math.floor(Math.random()*glyphs.length)]; }
        nameEl.textContent = out;
        if (frame < total) setTimeout(tick, 55); else finish(true);
      };
      tick();
      return;
    }
    if (theme === "goose") { gooseReveal(nameEl, target, finish); return; }
    if (theme === "galaxy") { galaxyReveal(nameEl, target, finish); return; }
    revealLetters(nameEl, target, finish);
  }
  // litery tytułu w słowach (słowa nie łamią się w środku); fn(span, i) tworzy zawartość litery
  function buildLetters(box, target, fn){
    let word = null, i = 0;
    const out = [];
    [...target].forEach(c => {
      if (c === " ") { box.appendChild(document.createTextNode(" ")); word = null; return; }
      if (!word) { word = document.createElement("span"); word.className = "w"; box.appendChild(word); }
      const sp = document.createElement("span"); sp.className = "ch"; fn(sp, c, i++); word.appendChild(sp); out.push(sp);
    });
    return out;
  }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // Gęś Wyścigowa: gąski się kręcą, zza nich wyskakują litery i lecą na swoje miejsca; na koniec gąski się rozbiegają
  function gooseReveal(nameEl, target, finish){
    nameEl.className = "name rv-goose2";
    nameEl.innerHTML = '<div class="gt"></div><div class="gq"><span class="gg">' + GOOSE_SVG + '</span><span class="gg">' + GOOSE_SVG + '</span><span class="gg">' + GOOSE_SVG + '</span></div>';
    const gq = nameEl.querySelector(".gq"), gt = nameEl.querySelector(".gt");
    const spans = buildLetters(gt, target, (sp, c) => { sp.textContent = c; });
    const geese = [...gq.querySelectorAll(".gg")];
    // start każdej litery: środek losowej gąski (litera chowa się za nią)
    spans.forEach(sp => {
      const g = geese[Math.floor(Math.random() * geese.length)].getBoundingClientRect(), r = sp.getBoundingClientRect();
      sp.style.setProperty("--dx", Math.round(g.left + g.width / 2 - (r.left + r.width / 2)) + "px");
      sp.style.setProperty("--dy", Math.round(g.top + g.height / 2 - (r.top + r.height / 2)) + "px");
    });
    const order = shuffle(spans.slice());
    const step = Math.min(110, 1500 / Math.max(1, order.length));
    const t0 = 900;   // najpierw same gąski się kręcą
    order.forEach((sp, k) => setTimeout(() => sp.classList.add("jump"), t0 + k * step));
    const tEnd = t0 + (order.length - 1) * step + 650;
    setTimeout(() => gq.classList.add("run"), tEnd);                 // ostatnia litera na miejscu – gąski uciekają
    setTimeout(() => finish(false), tEnd + 800);
  }
  // Galaktyka: napisy płynące w głąb kosmosu, potem litery tytułu nadlatują z różnych stron
  const CRAWL = [["Rada Planszówkowa", "zebrała się", "na tajnym posiedzeniu."], ["Kości zostały rzucone,", "karty przetasowane…"], ["Los wskazał grę", "na dzisiejszy wieczór:"]];
  function galaxyReveal(nameEl, target, finish){
    nameEl.className = "name rv-crawl";
    nameEl.innerHTML = '<div class="plane"><div class="ctext"></div></div>';
    const ct = nameEl.querySelector(".ctext");
    CRAWL.forEach(par => { const p = document.createElement("p"); p.textContent = par.join(" "); ct.appendChild(p); });
    setTimeout(() => {
      nameEl.className = "name rv rv-galaxy2";
      nameEl.textContent = "";
      const spans = buildLetters(nameEl, target, (sp, c) => {
        sp.textContent = c;
        const ang = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 160;
        sp.style.setProperty("--dx", Math.round(Math.cos(ang) * dist) + "px");
        sp.style.setProperty("--dy", Math.round(Math.sin(ang) * dist * 0.6) + "px");
        sp.style.setProperty("--s", (Math.random() < .5 ? 0.2 + Math.random() * .4 : 2.5 + Math.random() * 2.5).toFixed(2));
        sp.style.setProperty("--r", Math.round(Math.random() * 360 - 180) + "deg");
      });
      let maxD = 0;
      spans.forEach(sp => { const d = Math.random() * 700; maxD = Math.max(maxD, d); sp.style.animationDelay = Math.round(d) + "ms"; sp.style.animationDuration = "800ms"; });
      setTimeout(() => finish(false), maxD + 880);
    }, 4800);
  }
  const GOOSE_SVG = '<svg viewBox="-30 -36 76 58" aria-hidden="true"><g stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M-4 2L-4 18L2 18M4 2L4 18L10 18" fill="none" stroke="#e07a1a" stroke-width="3"/>' +
    '<g fill="#fff" stroke="#3a332c" stroke-width="2"><path d="M-16 -6L-26 -12L-20 -2Z"/><ellipse cx="0" cy="-4" rx="18" ry="11" transform="rotate(-6 0 -4)"/>' +
    '<ellipse cx="-3" cy="-8" rx="10" ry="5" transform="rotate(-23 -3 -8)" fill="#e9e4dc"/>' +
    '<path d="M12 -10Q22 -16 26 -26L31 -24Q26 -12 16 -2Z"/><circle cx="29" cy="-27" r="6"/>' +
    '<path d="M34 -29L43 -26L34 -24Z" fill="#e07a1a"/></g><circle cx="30" cy="-29" r="1.4" fill="#2b2520"/></g></svg>';
  // Każda litera pojawia się z animacją w stylu motywu (style: .rv-<motyw> w themes.css)
  function revealLetters(nameEl, target, finish){
    const chars = [...target];
    const n = chars.filter(c => c !== " ").length || 1;
    const step = Math.min(70, 1000 / n);
    const dur = {wizard: 700, goose: 520, galaxy: 600, neon: 900}[theme] || 600;
    nameEl.className = "name rv rv-" + theme;
    nameEl.textContent = "";
    let k = 0, maxDelay = 0, word = null;
    chars.forEach(c => {
      if (c === " ") { nameEl.appendChild(document.createTextNode(" ")); word = null; return; }
      if (!word) { word = document.createElement("span"); word.className = "w"; nameEl.appendChild(word); }
      const sp = document.createElement("span"); sp.className = "ch"; sp.textContent = c;
      const delay = theme === "neon" ? Math.random() * 900 : k * step;   // neon zapala się losowo, jak świetlówka
      sp.style.animationDelay = Math.round(delay) + "ms"; sp.style.animationDuration = dur + "ms";
      maxDelay = Math.max(maxDelay, delay); k++;
      word.appendChild(sp);
    });
    setTimeout(() => finish(false), maxDelay + dur + 80);
  }
  const histEntry = (game, at, exp) => ({id: vkey(game, exp), name: vlabel(game, exp), at});
  // "Gramy!" tylko zapamiętuje wybór – gra wypada z losowania dopiero po wpisaniu wyniku
  function markPlayed(){
    const f = ui.drawn && findGame(ui.drawn, ui.drawnGid);
    if (!f) return;
    const exp = findExp(f.game, ui.drawnExp);
    ui.drawn = null; ui.justPlayed = {id: f.game.id, gid: f.group.id, exp: exp ? exp.id : null};
    renderDraw();
    toast("Miłej gry! Po partii wpisz wynik – wtedy gra wypadnie z losowania.");
  }
  async function resetMine(gs, label){
    try {
      await commitB((b, log, extra) => gs.forEach(g => {
        extra(b => b.set(scol(g.id).doc(me.uid), {played: {}, updatedAt: Date.now()}, {mergeFields: ["played", "updatedAt"]}));
        log(g.id, "cycle", label, [me.uid]);
      }));
    } catch(e){ toast(errMsg(e)); }
  }
  async function resetPool(){
    const gs = groups.filter(g => inPool(g) && Object.keys(myPlayed(g)).length);
    await resetMine(gs, "Nowy cykl losowania – wszystkie gry wróciły do puli");
    ui.drawn = null; render(); toast("Nowy cykl – wszystkie gry znów w puli");
  }

  // ================= RENDER =================
  function renderPool(){
    const el = $("pool");
    const dg = groups.filter(canEdit);   // losujemy tylko z grup, których gry widzisz
    if (dg.length < 2) { el.innerHTML = ""; el.hidden = true; return; }
    el.hidden = false;
    ui.pool = ui.pool.filter(id => dg.some(g => g.id === id));
    if (ui.pool.length === dg.length) ui.pool = [];
    el.innerHTML = "";
    const all = document.createElement("button");
    all.className = "chip" + (!ui.pool.length ? " on" : ""); all.textContent = "Wszystkie grupy";
    all.onclick = () => { if (spinning) return; ui.pool = []; ui.drawn = null; lsSet("pl-pool", ui.pool); render(); };
    el.appendChild(all);
    dg.forEach(g => {
      const b = document.createElement("button");
      b.className = "chip" + (ui.pool.includes(g.id) ? " on" : ""); b.textContent = g.name;
      b.onclick = () => {
        if (spinning) return;
        ui.pool = ui.pool.includes(g.id) ? ui.pool.filter(x => x !== g.id) : ui.pool.concat(g.id);
        ui.drawn = null; lsSet("pl-pool", ui.pool); render();
      };
      el.appendChild(b);
    });
  }
  function renderDraw(){
    const pool = poolVariants();
    const left = pool.filter(x => !isVPlayed(x.group, x.game, x.exp)).length;
    const stage = $("stage");
    const drawn = ui.drawn && findGame(ui.drawn, ui.drawnGid);
    const jp = ui.justPlayed && findGame(ui.justPlayed.id, ui.justPlayed.gid);
    if (spinning) stage.innerHTML = '<div class="name spin"></div>';
    else if (drawn) {
      const dexp = findExp(drawn.game, ui.drawnExp);
      stage.innerHTML = '<div class="name"></div><div class="xv"></div><div class="grp"></div>';
      stage.querySelector(".name").textContent = drawn.game.name;
      const cv = coverImg(drawn.group.id, drawn.game.id, "scover"); if (cv) stage.insertBefore(cv, stage.firstChild);
      const xv = stage.querySelector(".xv");
      if (dexp) xv.textContent = "+ " + dexp.name;
      else if (exps(drawn.game).length) xv.textContent = "wersja podstawowa";
      else xv.remove();
      stage.querySelector(".grp").textContent = drawn.group.name;
    } else if (jp) {
      stage.innerHTML = '<div class="hint">Gracie w:</div><div class="name" style="font-size:20px;margin-top:4px"></div><button class="stagebtn">Wpisz wynik po grze</button>';
      stage.querySelector(".name").textContent = vlabel(jp.game, findExp(jp.game, ui.justPlayed.exp));
      stage.querySelector(".stagebtn").onclick = () => openResult(jp.game.id, jp.group.id, null, ui.justPlayed.exp);
    } else if (!groups.length) stage.innerHTML = '<div class="hint">Utwórz grupę albo dołącz do grupy znajomych.</div>';
    else if (!groups.some(canEdit)) stage.innerHTML = '<div class="hint">Jesteś graczem w swoich grupach – gry losuje właściciel lub Mistrz Gry. Swoje wyniki zobaczysz w zakładce Wyniki.</div>';
    else if (!pool.length) stage.innerHTML = poolGames().length ? '<div class="hint">Wszystkie gry z wybranych grup są wykluczone z losowania (⊘ w zakładce Gry).</div>' : '<div class="hint">Dodaj gry w zakładce Gry, a potem losuj.</div>';
    else if (!left) stage.innerHTML = '<div class="hint">Cała pula rozegrana. Misja zakończona.</div>';
    else stage.innerHTML = '<div class="hint">oczekuję na polecenie…</div>';
    const btn = $("drawBtn");
    if (!left && pool.length) { btn.textContent = "Zacznij nowy cykl"; btn.disabled = false;
      btn.onclick = () => confirmDialog({title: "Zacząć nowy cykl?", text: "Wszystkie gry z wybranych grup wrócą do Twojego losowania. Wyniki zostaną bez zmian.", icon: "↺", yes: "Zacznij", onYes: resetPool}); }
    else { btn.textContent = "Losuj grę"; btn.disabled = !left || spinning; btn.onclick = () => draw(); }
    btn.hidden = !!drawn && !spinning;
    $("afterDraw").hidden = !(drawn && !spinning);
    $("count").textContent = pool.length ? ("Do rozegrania: " + left + " z " + pool.length) : "";
    renderDrawStats();
  }

  // ================= STATYSTYKI GIER =================
  // Liczone z wyników, które widzisz (Twoje rozgrywki i wyniki wpisane przez Ciebie).
  const gamePlays = (gid, gameId) => (playsBy[gid] || []).filter(p => p.gameId === gameId);
  function partii(n){ return plural(n, "partia", "partie", "partii"); }
  // data dodania: zapisana przy grze, a dla starszych gier – z wpisu „Dodanie gry” w Change Logu
  function addedAt(g, game){
    if (game.added) return game.added;
    const t = "Dodanie gry " + q(game.name);
    const e = (logsBy[g.id] || []).filter(x => x.type === "game-add" && x.text === t).sort((a,b) => a.at - b.at)[0];
    return e ? e.at : null;
  }
  function expAddedAt(g, game, e){
    if (e.added) return e.added;
    const t = "Dodanie rozszerzenia " + q(e.name) + " do gry " + q(game.name);
    const x = (logsBy[g.id] || []).filter(l => l.text === t).sort((a,b) => a.at - b.at)[0];
    return x ? x.at : null;
  }
  function topWinners(plays){
    const cnt = new Map(), acc = accounts();
    plays.forEach(pl => (pl.scores || []).forEach(sc => {
      if (!scoreWon(pl, sc)) return;
      const k = scoreKey(sc), c = cnt.get(k) || {n: sc.uid ? (acc.get(sc.uid) || sc.p) : sc.p, w: 0};
      c.w++; cnt.set(k, c);
    }));
    const arr = [...cnt.values()]; if (!arr.length) return null;
    const max = Math.max(...arr.map(x => x.w));
    return {names: arr.filter(x => x.w === max).map(x => x.n).sort(cmp), wins: max};
  }
  // ekran startowy: najczęściej i najrzadziej grana gra (wybrane grupy, także partie bez losowania)
  function renderDrawStats(){
    const el = $("drawStats");
    const rows = poolGames().map(x => { const ps = gamePlays(x.group.id, x.game.id); return {x, n: ps.length, last: ps.reduce((m, p) => Math.max(m, p.at), 0)}; });
    $("homeHint").hidden = rows.length >= 2;
    if (rows.length < 2) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false; el.innerHTML = "";
    // dwa osobne bloki (karty), jak blok losowania
    // blok: pierwsza gra duża (z okładką), pozostałe z tą samą liczbą partii – mniejsze, wypisane z nazwy
    const card = (title, list) => {
      const c = document.createElement("section"); c.className = "card statcard";
      c.innerHTML = '<h2></h2><div class="smain"></div><div class="scount"></div><div class="sties"></div>';
      c.querySelector("h2").textContent = title;
      if (list.length) {
        const r = list[0];
        const main = c.querySelector(".smain");
        const cv = coverImg(r.x.group.id, r.x.game.id, "scov"); if (cv) main.appendChild(cv);
        const nb = document.createElement("button"); nb.type = "button"; nb.className = "sname"; nb.textContent = r.x.game.name;
        nb.onclick = () => openGameInfo(r.x.group.id, r.x.game.id); main.appendChild(nb);
        c.querySelector(".scount").textContent = partii(r.n) + (list.length > 1 ? " · tyle samo:" : "");
        const ties = c.querySelector(".sties");
        list.slice(1).forEach(t => {
          const b = document.createElement("button"); b.type = "button"; b.className = "stie"; b.textContent = t.x.game.name;
          b.onclick = () => openGameInfo(t.x.group.id, t.x.game.id); ties.appendChild(b);
        });
      } else { c.querySelector(".scount").textContent = "Brak zapisanych wyników."; }
      el.appendChild(c);
    };
    const mostS = rows.slice().sort((a,b) => (b.n - a.n) || (b.last - a.last) || cmp(a.x.game.name, b.x.game.name));
    card("Najczęściej grana", mostS[0].n ? mostS.filter(r => r.n === mostS[0].n) : []);
    const leastS = rows.slice().sort((a,b) => (a.n - b.n) || (a.last - b.last) || cmp(a.x.game.name, b.x.game.name));
    card("Najrzadziej grana", leastS.filter(r => r.n === leastS[0].n));
  }
  // okno ⓘ z informacjami o grze
  let giKey = null;
  function openGameInfo(gid, gameId){ giKey = {gid, gameId}; renderGameInfo(); openOv("gi"); }
  function renderGameInfo(){
    if (!giKey) return;
    const f = findGame(giKey.gameId, giKey.gid);
    if (!f) { closeOv("gi"); return; }
    const {game, group: g} = f;
    const ps = gamePlays(g.id, game.id);
    $("giTitle").textContent = game.name;
    const body = $("giBody"); body.innerHTML = "";
    const gc = coverImg(g.id, game.id, "gicover"); if (gc) body.appendChild(gc);
    const dl = document.createElement("dl"); dl.className = "gi";
    // etykieta nad wartością; wartość może mieć kilka linii [[nazwa, wartość], ...]
    const row = (k, v) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k;
      if (Array.isArray(v)) v.forEach(([a, b]) => { const l = document.createElement("div"); l.className = "gil"; l.innerHTML = "<span></span><b></b>"; l.firstChild.textContent = a; l.lastChild.textContent = b; dd.appendChild(l); });
      else dd.textContent = v;
      dl.append(dt, dd);
    };
    if (groups.length > 1) row("Grupa", g.name);
    const ad = addedAt(g, game);
    row("Data dodania gry", ad ? fmt(ad) : "brak danych");
    if (exps(game).length) row("Data dodania rozszerzeń", exps(game).map(e => { const ea = expAddedAt(g, game, e); return [e.name, ea ? fmt(ea) : "brak danych"]; }));
    row("Ostatnia rozgrywka", ps.length ? fmt(Math.max(...ps.map(p => p.at))) : "jeszcze nie grana");
    row("Rozegrane partie", String(ps.length));
    const ex = exps(game);
    if (ex.length && ps.length) {
      const per = [{e: null, name: "wersja podstawowa"}].concat(ex.map(e => ({e, name: e.name}))).map(r => {
        const n = ps.filter(p => r.e ? (p.exps || []).some(x => x.id === r.e.id) : !(p.exps || []).length).length;
        return [r.name, String(n)];
      });
      row("Partie według wersji", per);
    }
    const tw = topWinners(ps);
    row("Najczęściej wygrywa", tw ? tw.names.join(", ") + " (" + plural(tw.wins, "wygrana", "wygrane", "wygranych") + ")" : "—");
    body.appendChild(dl);
    const note = document.createElement("p"); note.className = "ginote";
    note.textContent = "Statystyki obejmują wyniki, które widzisz: rozgrywki z Twoim udziałem i wyniki wpisane przez Ciebie.";
    body.appendChild(note);
  }

  function renderGroup(){
    const tabs = $("tabs"); tabs.innerHTML = "";
    if (ui.tab >= groups.length) ui.tab = Math.max(0, groups.length - 1);
    groups.forEach((g, i) => {
      const b = document.createElement("button");
      b.className = "tab" + (ui.tab === i ? " on" : "");
      b.textContent = g.name + (canEdit(g) ? " (" + (g.games || []).length + ")" : " · gracz");
      b.onclick = () => { ui.tab = i; ui.armed = null; ui.moving = null; renderGroup(); };
      tabs.appendChild(b);
    });
    if (groups.length < MAX_GROUPS) {
      const add = document.createElement("button");
      add.className = "tab addg"; add.textContent = "+ grupa"; add.onclick = addGroup;
      tabs.appendChild(add);
    }
    const jn = document.createElement("button");
    jn.className = "tab joing"; jn.textContent = "⇥ kod"; jn.title = "Dołącz do grupy kodem"; jn.onclick = openJoin;
    tabs.appendChild(jn);

    $("groupBox").hidden = !groups.length; $("noGroups").hidden = !!groups.length;
    if (!groups.length) { $("gamesCard").hidden = true; return; }
    const g = groups[ui.tab];
    const edit = canEdit(g);
    const gn = $("groupName");
    if (document.activeElement !== gn) gn.value = g.name;
    gn.readOnly = !edit;
    const rn = $("roleNote");
    rn.hidden = edit;
    if (!edit) rn.innerHTML = "Jesteś <b>graczem</b> w tej grupie – nie widzisz jej gier. Widzisz wyniki rozgrywek, w których grasz (zakładka Wyniki). Gry i wyniki dodają właściciel i Mistrzowie Gry.";
    $("gamesCard").hidden = !edit;
    if (!edit) { $("list").innerHTML = ""; $("tools").innerHTML = ""; return; }

    const list = $("list"); list.innerHTML = "";
    const games = (g.games || []).slice().sort((a,b) => cmp(a.name, b.name));
    if (!games.length) list.innerHTML = '<li class="empty">Brak gier w tej grupie.</li>';
    games.forEach(game => list.appendChild(gameRow(g, game, false)));
    const allV = games.reduce((a, x) => a + variants(x).length, 0);
    const doneV = games.reduce((a, x) => a + variants(x).filter(e => isVPlayed(g, x, e)).length, 0);
    const playedN = doneV;
    const tools = $("tools"); tools.innerHTML = "";
    if (games.length) {
      const s = document.createElement("span"); s.textContent = "Rozegrane: " + doneV + " / " + allV + (allV > games.length ? " wersji" : ""); tools.appendChild(s);
      if (playedN) {
        const r = document.createElement("button"); r.className = "link"; r.textContent = "Wyzeruj moje rozegrane";
        r.onclick = () => confirmDialog({title: "Wyzerować rozegrane?", text: "Wszystkie gry z grupy „" + g.name + "” wrócą do Twojego losowania. Wyniki zostaną bez zmian.", icon: "↺", yes: "Wyzeruj",
          onYes: () => { resetMine([g], "Wyzerowanie rozegranych w grupie – wszystkie gry wróciły do puli"); toast("Wyzerowano: " + g.name); }});
        tools.appendChild(r);
      }
    }
  }
  const rerenderLists = () => { renderGroup(); if (!$("ov").hidden) renderAll(); };
  // Wiersz gry: mały znacznik ✓/○, tytuł (wyszarzony, gdy rozegrane wszystkie wersje), data rozegrania,
  // drzewko wersji. full = lista wszystkich gier: dodatkowo przyciski ⓘ ✎ ⊘ ⇄ 🗑 i edycja.
  function gameRow(g, game, full){
    const edit = full && canEdit(g);
    const played = isPlayed(g, game);
    const ex = exps(game);
    const editing = false;
    const li = document.createElement("li");
    li.className = "game" + (played ? " played" : "") + (isAllOff(game) ? " off" : "");
    li.innerHTML = '<span class="gmk"></span><div class="gname"><b></b><span class="gsub"></span></div><span class="gdt"></span>' +
      (full && groups.length > 1 ? '<span class="tag"></span>' : '') +
      (full ? '<span class="gbtns"><button class="ib info" title="Informacje o grze" aria-label="Informacje o grze">ⓘ</button>' +
        (edit ? '<button class="ib xed" title="Edytuj grę i rozszerzenia" aria-label="Edytuj">✎</button>' +
                '' : '') + '</span>' : '');
    li.querySelector(".gmk").textContent = played ? "✓" : "○";
    const th = coverImg(g.id, game.id, "gcov"); if (th) li.insertBefore(th, li.querySelector(".gname"));
    li.querySelector("b").textContent = game.name;
    li.querySelector(".gsub").textContent = isAllOff(game) ? "⊘ wykluczona z losowania" : (variants(game).some(e => isVOff(game, e)) ? "⊘ część wersji wykluczona z losowania" : "");
    if (!ex.length && played) li.querySelector(".gdt").textContent = fmt(myPlayed(g)[game.id]);
    const tag = li.querySelector(".tag"); if (tag) tag.textContent = g.name;
    if (full) {
      li.querySelector(".info").onclick = () => openGameInfo(g.id, game.id);
      if (edit) {
        const xed = li.querySelector(".xed");
        xed.onclick = () => openGameEdit(g, game);
      }
    }
    // drzewko wersji (wersja podstawowa + rozszerzenia)
    if (ex.length || editing) {
      const box = document.createElement("div"); box.className = "xtree";
      const rows = ex.length ? [{e: null, name: "wersja podstawowa"}].concat(ex.map(e => ({e, name: e.name}))) : [];
      rows.forEach((r, i) => {
        const done = isVPlayed(g, game, r.e);
        const last = i === rows.length - 1 && !editing;
        const canDel = editing && r.e;
        const row = document.createElement(canDel ? "button" : "div"); if (canDel) row.type = "button";
        row.className = "xrow" + (done ? " done" : "") + (r.e ? "" : " base") + (canDel ? " edit" : " ro");
        row.innerHTML = '<span class="br"></span><span class="mk"></span><span class="nm"></span><span class="dt"></span>';
        row.querySelector(".br").textContent = last ? "└─" : "├─";
        row.querySelector(".mk").textContent = canDel ? "✕" : (done ? "✓" : "○");
        row.querySelector(".nm").textContent = r.name;
        if (done && !editing) row.querySelector(".dt").textContent = fmt(myPlayed(g)[vkey(game, r.e)]);
        const off = isVOff(game, r.e);
        if (off && !editing) { row.classList.add("off"); row.querySelector(".mk").textContent = "⊘"; }
        if (canDel) row.onclick = () => {
          confirmDialog({title: "Usunąć rozszerzenie?", text: "„" + r.name + "” zniknie z gry „" + game.name + "”. Zapisane wyniki zostaną.", icon: "🗑", yes: "Usuń", danger: true,
            onYes: () => saveGame(g, Object.assign({}, game, {exps: ex.filter(x => x.id !== r.e.id)}), "Usunięcie rozszerzenia " + q(r.name) + " z gry " + q(game.name))});
        };
        box.appendChild(row);
      });
      li.appendChild(box);
    }
    return li;
  }
  // wykluczenie / przywrócenie wersji gry (null = wersja podstawowa) w losowaniu – wspólne dla całej grupy
  function setOff(g, game, list, off){
    const ids = new Set(list.map(e => e ? e.id : null));
    const flag = o => { const c = Object.assign({}, o); if (off) c.off = true; else delete c.off; return c; };
    let ng = ids.has(null) ? flag(game) : Object.assign({}, game);
    if (exps(game).length) ng.exps = exps(game).map(e => ids.has(e.id) ? flag(e) : e);
    const what = list.length === 1 ? vlabel(game, list[0]) : game.name;
    if (ui.drawn === game.id && ui.drawnGid === g.id && off) ui.drawn = null;
    saveGame(g, ng, (off ? "Wykluczenie z losowania: " : "Przywrócenie do losowania: ") + q(what));
    toast(off ? "Wykluczono z losowania" : "Przywrócono do losowania");
  }
  // zmiana jednej gry (np. lista rozszerzeń) – zapis całej listy gier grupy
  // ===== okno edycji gry: okładka, nazwa, wersje (wykluczenie z losowania), rozszerzenia, usunięcie gry.
  // Zapisz zapisuje nazwę, rozszerzenia i wykluczenia naraz, Anuluj porzuca. Okładka i usunięcie gry działają od razu.
  let ge = null;
  function openGameEdit(g, game){
    ge = {gid: g.id, gameId: game.id, orig: game, baseOff: !!game.off, exps: exps(game).map(e => Object.assign({}, e)), removed: []};
    $("geName").value = game.name; $("geNew").value = ""; $("geErr").textContent = "";
    renderGameEdit(); openOv("ge");
  }
  function offBtn(isOff, onToggle){
    const b = document.createElement("button"); b.type = "button"; b.className = "gebtn geoff" + (isOff ? " on" : "");
    b.textContent = isOff ? "↺ Przywróć" : "⊘ Wyklucz";
    b.title = isOff ? "Przywróć do losowania" : "Wyklucz z losowania";
    b.onclick = onToggle; return b;
  }
  function renderGameEdit(){
    if (!ge) return;
    const g = groupById(ge.gid); if (!g) { closeOv("ge"); return; }
    const f = findGame(ge.gameId, ge.gid); if (!f) { closeOv("ge"); return; }
    const game = f.game;
    const box = $("geCover"); box.innerHTML = "";
    const im = coverImg(g.id, game.id, "gecov");
    if (im) box.appendChild(im); else { const e = document.createElement("div"); e.className = "gecov none"; e.textContent = "🎲"; box.appendChild(e); }
    const has = !!coverOf(g.id, game.id);
    $("geCovAdd").textContent = has ? "📷 Zmień okładkę" : "📷 Dodaj okładkę";
    $("geCovDel").hidden = !has;
    // wykluczenie całej gry (gdy są rozszerzenia)
    const allOff = ge.baseOff && ge.exps.every(e => e.off);
    const wb = $("geAllOff"); wb.hidden = !ge.exps.length;
    wb.textContent = allOff ? "↺ Przywróć całą grę do losowania" : "⊘ Wyklucz całą grę z losowania";
    wb.classList.toggle("on", allOff);
    wb.onclick = () => { ge.baseOff = !allOff; ge.exps.forEach(e => { e.off = !allOff; }); renderGameEdit(); };
    const targets = groups.filter(x => x !== g && canEdit(x));
    $("geMoveBox").hidden = !targets.length;
    const mb = $("geMove"); mb.innerHTML = "";
    targets.forEach(o => {
      const c = document.createElement("button"); c.type = "button"; c.className = "gebtn gemv"; c.textContent = "⇄ " + o.name;
      c.onclick = () => confirmDialog({title: "Przenieść grę?", text: "„" + game.name + "” zostanie przeniesiona z grupy „" + g.name + "” do grupy „" + o.name + "”. Niezapisane zmiany w tym oknie przepadną.", icon: "⇄", yes: "Przenieś",
        onYes: () => { ge = null; closeOv("ge"); moveGame(g, game, o); }});
      mb.appendChild(c);
    });
    const ul = $("geExps"); ul.innerHTML = "";
    const row = (name, isOff, onToggle, onDel) => {
      const li = document.createElement("li"); if (isOff) li.className = "off";
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = name; li.appendChild(nm);
      const bx = document.createElement("div"); bx.className = "gebtns";
      bx.appendChild(offBtn(isOff, onToggle));
      if (onDel) { const d = document.createElement("button"); d.type = "button"; d.className = "gebtn gedel"; d.textContent = "🗑 Usuń"; d.title = "Usuń rozszerzenie"; d.onclick = onDel; bx.appendChild(d); }
      li.appendChild(bx);
      ul.appendChild(li);
    };
    row(ge.exps.length ? "Wersja podstawowa" : "Gra", ge.baseOff, () => { ge.baseOff = !ge.baseOff; renderGameEdit(); });
    ge.exps.forEach(e => row(e.name + (e.isNew ? " (nowe)" : ""), !!e.off, () => { e.off = !e.off; renderGameEdit(); }, () => {
      if (e.isNew) { ge.exps = ge.exps.filter(x => x !== e); renderGameEdit(); return; }
      confirmDialog({title: "Usunąć rozszerzenie?", text: "„" + e.name + "” zniknie z gry po zapisaniu zmian. Zapisane wyniki zostaną.", icon: "🗑", yes: "Usuń", danger: true,
        onYes: () => { ge.exps = ge.exps.filter(x => x !== e); ge.removed.push(e.name); renderGameEdit(); }});
    }));
  }
  $("geCovAdd").onclick = () => { const f = findGame(ge.gameId, ge.gid); if (f) pickCover(f.group, f.game); };
  $("geCovDel").onclick = () => { const f = findGame(ge.gameId, ge.gid); if (f) removeCover(f.group, f.game); };
  $("geAdd").addEventListener("submit", ev => {
    ev.preventDefault();
    const n = $("geNew").value.trim().replace(/\s+/g, " "); if (!n) return;
    if (ge.exps.some(x => x.name.toLowerCase() === n.toLowerCase())) { $("geErr").textContent = "To rozszerzenie już jest."; return; }
    ge.exps.push({id: uid(), name: n, added: Date.now(), isNew: true});
    $("geNew").value = ""; $("geErr").textContent = ""; renderGameEdit(); $("geNew").focus();
  });
  $("geCancel").onclick = () => { ge = null; closeOv("ge"); };
  $("geDelGame").onclick = () => {
    const f = findGame(ge.gameId, ge.gid); if (!f) return;
    const g = f.group, game = f.game;
    confirmDialog({title: "Usunąć grę?", text: "„" + game.name + "” zniknie z grupy „" + g.name + "”" + (exps(game).length ? " razem z rozszerzeniami" : "") + ". Zapisane wyniki zostaną.", icon: "🗑", yes: "Usuń", danger: true,
      onYes: () => { ge = null; closeOv("ge"); deleteGame(g, game); }});
  };
  $("geSave").onclick = () => {
    const f = findGame(ge.gameId, ge.gid);
    if (!f) { closeOv("ge"); return; }
    const g = f.group, game = f.game;
    const pending = $("geNew").value.trim().replace(/\s+/g, " ");
    if (pending && !ge.exps.some(x => x.name.toLowerCase() === pending.toLowerCase())) ge.exps.push({id: uid(), name: pending, added: Date.now(), isNew: true});
    const nm = $("geName").value.trim().replace(/\s+/g, " ");
    if (!nm) { $("geErr").textContent = "Wpisz nazwę gry."; return; }
    if (nm !== game.name && (g.games || []).some(x => x.id !== game.id && x.name.toLowerCase() === nm.toLowerCase())) { $("geErr").textContent = "Gra o tej nazwie już jest."; return; }
    const flag = (o, off) => { const c = Object.assign({}, o); if (off) c.off = true; else delete c.off; return c; };
    const draft = new Map(ge.exps.filter(e => !e.isNew).map(e => [e.id, e]));
    const removedIds = new Set(exps(ge.orig).filter(o => !draft.has(o.id)).map(o => o.id));
    // aktualny stan gry (żeby nie zgubić zmian zrobionych w międzyczasie) + zmiany z okna
    const newExps = exps(game).filter(e => !removedIds.has(e.id)).map(e => draft.has(e.id) ? flag(e, draft.get(e.id).off) : e)
      .concat(ge.exps.filter(e => e.isNew).map(e => flag({id: e.id, name: e.name, added: e.added}, e.off)));
    const ng = flag(Object.assign({}, game, {name: nm}), ge.baseOff);
    if (newExps.length || exps(game).length) ng.exps = newExps;
    const added = ge.exps.filter(e => e.isNew).map(e => e.name);
    const offNow = [], onNow = [];
    if (!!game.off !== ge.baseOff) (ge.baseOff ? offNow : onNow).push(vlabel(ng, null));
    newExps.forEach(e => { const was = exps(game).find(o => o.id === e.id); if (!!(was ? was.off : false) !== !!e.off) (e.off ? offNow : onNow).push(nm + " + " + e.name); });
    const txt = [nm !== game.name ? "Zmiana nazwy gry " + q(game.name) + " na " + q(nm) : "",
      added.length ? "Dodanie rozszerzeń " + added.map(q).join(", ") + " do gry " + q(nm) : "",
      ge.removed.length ? "Usunięcie rozszerzeń " + ge.removed.map(q).join(", ") + " z gry " + q(nm) : "",
      offNow.length ? "Wykluczenie z losowania: " + offNow.map(q).join(", ") : "",
      onNow.length ? "Przywrócenie do losowania: " + onNow.map(q).join(", ") : ""].filter(Boolean).join("; ");
    ge = null; closeOv("ge");
    if (!txt) return;
    if (isAllOff(ng) && ui.drawn === game.id && ui.drawnGid === g.id) ui.drawn = null;
    saveGame(g, ng, txt);
  };
  function deleteGame(g, game){
    if (ui.drawn === game.id) ui.drawn = null;
    upd(g.id, {games: FV.arrayRemove(game)}, "Usunięcie gry " + q(game.name), "game-del");
    if (coverOf(g.id, game.id)) gref(g.id).collection("covers").doc(game.id).delete().catch(() => {});
  }
  function saveGame(g, newGame, logText){
    const games = (g.games || []).map(x => x.id === newGame.id ? newGame : x);
    return upd(g.id, {games}, logText, "game-exp");
  }
  async function moveGame(from, game, to){
    ui.moving = null;
    const mine = {};
    variants(game).forEach(e => { const k = vkey(game, e); if (myPlayed(from)[k]) mine[k] = myPlayed(from)[k]; });
    const p = {games: FV.arrayUnion(game), updatedAt: Date.now()};
    try { await commitB((b, log, extra) => {
      if (Object.keys(mine).length) extra(b => stateSet(b, to.id, me.uid, {played: mine}));
      b.update(gdoc(from), {games: FV.arrayRemove(game), updatedAt: Date.now()});
      b.update(gdoc(to), p);
      log(from.id, "game-move", "Przeniesienie gry " + q(game.name) + " do grupy " + q(to.name));
      log(to.id, "game-move", "Przeniesienie gry " + q(game.name) + " z grupy " + q(from.name));
    }); toast("Przeniesiono do: " + to.name); } catch(e){ toast(errMsg(e)); }
  }
  function renderHist(){
    if (!$("hist")) return;   // blok „Ostatnio rozegrane” usunięty – historia zostaje w danych (kopia zapasowa)
    const el = $("hist"); el.innerHTML = "";
    const items = [];
    groups.forEach(g => myHistory(g).forEach(h => items.push(Object.assign({group: g.name}, h))));
    items.sort((a,b) => b.at - a.at);
    if (!items.length) { el.innerHTML = '<li class="empty" style="justify-content:center">Jeszcze nic nie rozegrano.</li>'; return; }
    items.slice(0, 10).forEach(h => {
      const li = document.createElement("li");
      li.innerHTML = "<div></div><span></span>";
      li.firstChild.textContent = h.name;
      li.lastChild.textContent = fmt(h.at) + (groups.length > 1 ? " · " + h.group : "");
      el.appendChild(li);
    });
  }
  function render(){
    if (!me) return;
    const anyEdit = groups.some(canEdit);
    $("addResult").hidden = !anyEdit; $("openList").hidden = !anyEdit;
    renderPool(); renderDraw(); renderGroup(); renderHist(); renderResults(); renderLog();
    if (!$("ov").hidden) renderAll();
    if (!$("gi").hidden) renderGameInfo();
    if (!$("gm").hidden) renderGm();
    renderAllRes();
  }

  // ---------- zdarzenia: gry i grupy ----------
  $("addForm").addEventListener("submit", e => {
    e.preventDefault();
    const inp = $("newGame"); const name = inp.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    const g = groupById($("newGameGroup").value); if (!g || !canEdit(g)) return;
    if ((g.games || []).some(x => x.name.toLowerCase() === name.toLowerCase())) { toast("Ta gra już jest na liście"); return; }
    upd(g.id, {games: FV.arrayUnion({id: uid(), name, added: Date.now()})}, "Dodanie gry " + q(name), "game-add");
    toast("Dodano „" + name + "”" + (groups.filter(canEdit).length > 1 ? " do grupy „" + g.name + "”" : ""));
    inp.value = ""; inp.focus();
  });
  let nameTimer = null;
  $("groupName").addEventListener("input", e => {
    const g = groups[ui.tab]; if (!g || !canEdit(g)) return;
    const v = e.target.value.trim();
    clearTimeout(nameTimer);
    if (v) nameTimer = setTimeout(() => upd(g.id, {name: v.slice(0, 40)}, "Zmiana nazwy grupy na " + q(v.slice(0, 40)), "group"), 1200);
  });
  $("groupName").addEventListener("blur", () => renderGroup());
  async function addGroup(){
    if (groups.length >= MAX_GROUPS) return;
    const id = await createGroup("Nowa grupa");
    if (!id) return;
    ui.tab = groups.length; // nowa grupa trafi na koniec po odświeżeniu
    toast("Dodano grupę – wpisz jej nazwę");
    setTimeout(() => { const i = groups.findIndex(g => g.id === id); if (i >= 0) { ui.tab = i; renderGroup(); const gn = $("groupName"); gn.focus(); gn.select(); } }, 400);
  }
  $("rerollBtn").onclick = () => { const f = ui.drawn && findGame(ui.drawn, ui.drawnGid); draw(f ? vkey(f.game, findExp(f.game, ui.drawnExp)) : null); };
  $("playBtn").onclick = markPlayed;
  document.addEventListener("click", e => {
  });

  // ================= OKNA (overlay) =================
  // ostatnio otwarte okno zawsze na wierzchu (np. edycja wyniku otwarta z okna „Wszystkie wyniki”)
  let ovTop = 20;
  function openOv(id){ const o = $(id); o.style.zIndex = ++ovTop; o.hidden = false; document.body.style.overflow = "hidden"; }
  function closeOv(id){ $(id).hidden = true; if (!document.querySelector(".ov:not([hidden])")) document.body.style.overflow = ""; if (id === "rf") rf = null; }
  document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => closeOv(b.dataset.close));
  // dotknięcie poza oknem zamyka tylko okna informacyjne – formularze (wynik, kod, kopia, usuwanie konta) zamyka się ✕ lub „wstecz”
  const FORM_OV = new Set(["rf", "jn", "bkov", "da", "ge"]);
  document.querySelectorAll(".ov").forEach(o => o.addEventListener("click", e => { if (e.target === o && !FORM_OV.has(o.id)) closeOv(o.id); }));
  // przycisk "wstecz" Androida: zamyka okno, jeśli jakieś jest otwarte
  window.appBack = function(){
    const open = [...document.querySelectorAll(".ov:not([hidden])")];
    if (open.length) { open.sort((a, b) => (+a.style.zIndex || 20) - (+b.style.zIndex || 20)); closeOv(open[open.length - 1].id); return true; }
    if (!$("appView").hidden && curView !== "draw" && curView !== "home") { showView("draw"); return true; }
    return false;
  };
  // ================= ZAKŁADKI (dolny pasek) =================
  let curView = "draw";
  function navH(){ const n = $("tabbar"); return n && !n.hidden ? n.offsetHeight : 0; }
  function showView(v){
    curView = v;
    if (v === "news") { newsPrevSeen = lsGet(newsKey(), 0) || Infinity; logLimit = LOG_STEP; markNewsSeen(); renderLog(); }
    document.querySelectorAll("#appView .view").forEach(el => el.hidden = el.id !== "v-" + v);
    document.querySelectorAll("#tabbar .tb").forEach(b => { const on = b.dataset.view === v; b.classList.toggle("on", on); b.setAttribute("aria-current", on ? "page" : "false"); });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("#tabbar .tb").forEach(b => b.onclick = () => showView(b.dataset.view));
  $("openBk").onclick = () => { bkMsg(""); openOv("bkov"); };
  // ================= USUWANIE KONTA =================
  $("openDelAcc").onclick = () => {
    $("daPass").value = ""; $("daErr").textContent = ""; daArmed = false; $("daBtn").textContent = "Usuń moje konto"; $("daBtn").classList.remove("armed");
    const owned = groups.filter(isOwner);
    $("daOwned").textContent = owned.length ? "Twoje grupy, które zostaną usunięte: " + owned.map(g => "„" + g.name + "”").join(", ") + "." : "";
    openOv("da");
  };
  let daArmed = false;
  $("daBtn").onclick = async () => {
    const pass = $("daPass").value;
    if (!pass) { $("daErr").textContent = "Wpisz hasło."; return; }
    const btn = $("daBtn");
    if (!daArmed) { confirmDialog({title: "Usunąć konto na zawsze?", text: "Tego nie da się cofnąć. Grupy, których jesteś właścicielem, zostaną usunięte razem z grami i wynikami.", icon: "⚠", yes: "Usuń konto", danger: true, onYes: () => { daArmed = true; btn.click(); }}); return; }
    btn.disabled = true; btn.textContent = "Usuwanie…"; $("daErr").textContent = "";
    const user = auth.currentUser;
    try {
      await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, pass));
    } catch(e){
      btn.disabled = false; daArmed = false; btn.classList.remove("armed"); btn.textContent = "Usuń moje konto";
      $("daErr").textContent = authErr(e); return;
    }
    try {
      const uidMe = me.uid;
      for (const g of groups.slice()) {
        if (isOwner(g)) { await deleteGroup(g, true); continue; }
        // usuń mnie z wyników tej grupy
        for (const pl of (playsBy[g.id] || [])) {
          const scores = (pl.scores || []).filter(x => x.uid !== uidMe);
          const viewers = (pl.viewers || []).filter(u => u !== uidMe);
          const ref = pcol(g.id).doc(pl.id);
          try {
            if (!scores.length && (pl.createdBy === uidMe || canEdit(g))) await ref.delete();
            else await ref.update({scores, viewers, winners: scores.filter(x => x.win).map(x => x.p)});
          } catch(e){}
        }
        try { await scol(g.id).doc(uidMe).delete(); } catch(e){}
        try { await lcol(g.id).doc().set(logEntry("member", "Usunięcie konta")); } catch(e){}
        await gref(g.id).update({["members." + uidMe]: FV.delete(), memberIds: FV.arrayRemove(uidMe), ["memberNames." + uidMe]: FV.delete()});
      }
      try { await db.collection("registrations").doc(uidMe).delete(); } catch(e){}
      try { await db.collection("prefs").doc(uidMe).delete(); } catch(e){}
      try { Object.keys(localStorage).filter(k => k.includes(uidMe)).forEach(k => localStorage.removeItem(k)); } catch(e){}
      stopApp();
      await user.delete();
      closeOv("da");
      toast("Konto zostało usunięte");
    } catch(e){
      btn.disabled = false; daArmed = false; btn.classList.remove("armed"); btn.textContent = "Usuń moje konto";
      $("daErr").textContent = "Nie udało się usunąć konta: " + errMsg(e);
    }
  };
  $("openChanges").onclick = () => {
    const box = $("chgList"); box.innerHTML = "";
    (window.CHANGELOG || []).slice(0, 3).forEach(v => {   // trzy ostatnie wersje
      const sec = document.createElement("section"); sec.className = "chgv";
      sec.innerHTML = '<div class="chgh"><b></b><span></span></div><ul></ul>';
      sec.querySelector("b").textContent = "v" + v.version;
      sec.querySelector("span").textContent = v.date;
      v.items.forEach(([kind, text]) => {
        const li = document.createElement("li");
        li.innerHTML = '<span class="kind"></span> <span class="txt"></span>';
        li.querySelector(".kind").textContent = kind;
        li.querySelector(".kind").className = "kind k-" + kind.toLowerCase();
        li.querySelector(".txt").textContent = text;
        sec.querySelector("ul").appendChild(li);
      });
      box.appendChild(sec);
    });
    box.scrollTop = 0; openOv("chg");
  };
  $("openHelp").onclick = $("openHelpAuth").onclick = () => { openOv("help"); $("help").querySelector(".ovscroll").scrollTop = 0; };

  // ---------- lista gier ----------
  let ovFilter = "all";
  function renderAll(){
    const eg = groups.filter(canEdit);
    // dodawanie gry: do której grupy (domyślnie filtrowana grupa albo grupa wybrana w zakładce Gry)
    const gs = $("newGameGroup"), prevSel = gs.value;
    gs.innerHTML = ""; eg.forEach(g => { const o = document.createElement("option"); o.value = g.id; o.textContent = g.name; gs.appendChild(o); });
    const tabG = groups[ui.tab];
    gs.value = eg.some(g => g.id === ovFilter) ? ovFilter : (eg.some(g => g.id === prevSel) ? prevSel : (tabG && canEdit(tabG) ? tabG.id : (eg[0] || {}).id || ""));
    gs.hidden = eg.length < 2;
    $("addForm").hidden = !eg.length;
    const fEl = $("ovFilter"); fEl.innerHTML = ""; fEl.hidden = eg.length < 2;
    if (eg.length < 2) ovFilter = "all";
    [{id:"all", name:"Wszystkie"}].concat(eg.map(g => ({id:g.id, name:g.name}))).forEach(o => {
      const b = document.createElement("button");
      b.className = "chip" + (ovFilter === o.id ? " on" : ""); b.textContent = o.name;
      b.onclick = () => { ovFilter = o.id; renderAll(); };
      fEl.appendChild(b);
    });
    const q = $("ovSearch").value.trim().toLowerCase();
    const items = [];
    groups.forEach(g => { if (ovFilter === "all" || ovFilter === g.id) (g.games || []).forEach(game => items.push({game, group:g})); });
    const shown = items.filter(x => !q || x.game.name.toLowerCase().includes(q) || exps(x.game).some(e => e.name.toLowerCase().includes(q)))
      .sort((a,b) => cmp(a.game.name, b.game.name));
    const ul = $("allList");
    ul.innerHTML = "";
    if (!shown.length) ul.innerHTML = '<li class="empty" style="justify-content:center;border:0">' + (items.length ? "Brak wyników." : "Nie masz jeszcze żadnych gier.") + '</li>';
    let last = "";
    shown.forEach(x => {
      const L = x.game.name.charAt(0).toLocaleUpperCase("pl");
      if (L !== last) { last = L; const h = document.createElement("li"); h.className = "letter"; h.textContent = L; ul.appendChild(h); }
      ul.appendChild(gameRow(x.group, x.game, true));
    });
    const played = items.filter(x => isPlayed(x.group, x.game)).length;
    $("ovSum").textContent = items.length ? ("Razem: " + items.length + " · rozegrane: " + played + " · do zagrania: " + (items.length - played)) : "";
  }
  $("openList").onclick = () => { ovFilter = "all"; $("ovSearch").value = ""; $("newGameGroup").value = ""; renderAll(); openOv("ov"); };
  $("ovSearch").addEventListener("input", renderAll);

  // ================= GRUPA: członkowie, kod =================
  let gmGid = null, gmArmed = null;
  $("openGm").onclick = () => { const g = groups[ui.tab]; if (!g) return; gmGid = g.id; gmArmed = null; renderGm(); openOv("gm"); };
  const ROLE_PL = {owner: "właściciel", editor: "Mistrz Gry", player: "gracz"};
  // imię osoby z konta: zawsze imię i nazwisko podane przy rejestracji (zapis w grupie tylko awaryjnie)
  function uname(g, u){ return (regs[u] && regs[u].name) || ((g && g.memberNames) || {})[u] || "?"; }
  function renderGm(){
    const g = groupById(gmGid);
    const body = $("gmBody");
    if (!g) { closeOv("gm"); return; }
    $("gmTitle").textContent = g.name;
    body.innerHTML = "";
    const add = html => { const d = document.createElement("div"); d.innerHTML = html; while (d.firstChild) body.appendChild(d.firstChild); };
    add('<span class="fl">Twoja rola</span><p class="rolenote"><span class="role ' + role(g) + '">' + ROLE_PL[role(g)] + '</span></p>');
    if (canEdit(g)) {
      // dwa kody: dla edytora (widzi gry, wpisuje wyniki) i dla gracza (tylko bierze udział w rozgrywkach)
      [["editor", "Kod dla Mistrza Gry", "Mistrz Gry widzi gry grupy, dodaje i usuwa gry oraz wpisuje wyniki."],
       ["player", "Kod dla gracza", "Gracz nie widzi gier grupy – bierze udział w rozgrywkach i widzi swoje wyniki."]].forEach(([r, label, note]) => {
        const code = g.shelf ? (r === "editor" ? g.editorCode : g.playerCode) : (r === "player" ? g.inviteCode : "");
        const wrap = document.createElement("div"); wrap.className = "codebox";
        wrap.innerHTML = '<span class="fl"></span><div class="code"></div>' +
          '<div class="row2"><button class="ghost cp">Kopiuj</button><button class="ok sh">Udostępnij</button></div>' +
          '<p class="rolenote" style="margin-top:8px"></p>';
        wrap.querySelector(".fl").textContent = label;
        wrap.querySelector(".code").textContent = code || "—";
        wrap.querySelector(".rolenote").textContent = note;
        const shareText = "Dołącz do grupy „" + g.name + "” w aplikacji Planszomat jako " + (r === "editor" ? "Mistrz Gry" : "gracz") + ". Kod: " + code;
        wrap.querySelector(".cp").onclick = async () => {
          if (!code) return;
          if (Android && Android.copy) { Android.copy(code); toast("Skopiowano kod"); return; }
          try { await navigator.clipboard.writeText(code); toast("Skopiowano kod"); } catch(e){ toast("Kod: " + code); }
        };
        wrap.querySelector(".sh").onclick = () => {
          if (!code) return;
          if (Android && Android.share) Android.share(shareText);
          else if (navigator.share) navigator.share({text: shareText}).catch(() => {});
          else wrap.querySelector(".cp").click();
        };
        if (isOwner(g) && g.shelf) {
          const nb = document.createElement("button"); nb.className = "link"; nb.textContent = "Nowy kod (stary przestanie działać)";
          nb.onclick = () => confirmDialog({title: "Wygenerować nowy kod?", text: "Obecny " + label.toLowerCase() + " przestanie działać. Osoby, które już dołączyły, zostaną w grupie.", icon: "⟳", yes: "Nowy kod", onYes: () => regenCode(g, r)}); wrap.appendChild(nb);
        }
        body.appendChild(wrap);
      });
      if (!g.shelf) add('<p class="rolenote">Trwa przygotowanie kodów – właściciel grupy musi raz otworzyć aplikację w nowej wersji.</p>');
    } else {
      add('<p class="rolenote">Jesteś <b>graczem</b> w tej grupie: nie widzisz jej gier, ale widzisz wyniki rozgrywek, w których grasz.</p>');
    }
    add('<span class="fl">Członkowie (' + (g.memberIds || []).length + ')</span><div id="gmMembers"></div>');
    const box = $("gmMembers");
    const order = {owner: 0, editor: 1, player: 2};
    (g.memberIds || []).slice().sort((a,b) => (order[g.members[a]] - order[g.members[b]]) || cmp(uname(g, a), uname(g, b)))
      .forEach(u => {
        const r = g.members[u];
        const row = document.createElement("div"); row.className = "mem";
        row.innerHTML = '<span class="mn"></span>';
        row.querySelector(".mn").textContent = uname(g, u) + (u === me.uid ? " (Ty)" : "");
        if (isOwner(g) && r !== "owner") {
          const sel = document.createElement("select");
          sel.setAttribute("aria-label", "Rola");
          sel.innerHTML = '<option value="player">gracz</option><option value="editor">Mistrz Gry</option><option value="__remove">usuń z grupy</option>';
          sel.value = r;
          sel.onchange = async () => {
            if (sel.value === "__remove") {
              sel.value = r;
              confirmDialog({title: "Usunąć z grupy?", text: uname(g, u) + " przestanie widzieć grupę „" + g.name + "”.", icon: "⚠", yes: "Usuń", danger: true, onYes: async () => {
              const ok = await upd(g.id, {["members." + u]: FV.delete(), memberIds: FV.arrayRemove(u), ["memberNames." + u]: FV.delete()},
                "Usunięcie z grupy: " + uname(g, u), "member");
              if (ok) toast("Usunięto z grupy");
              }});
            } else await upd(g.id, {["members." + u]: sel.value}, "Zmiana roli: " + uname(g, u) + " → " + ROLE_PL[sel.value], "member");
          };
          row.appendChild(sel);
        } else {
          const s = document.createElement("span"); s.className = "role " + r; s.textContent = ROLE_PL[r] || r; row.appendChild(s);
        }
        box.appendChild(row);
      });
    if (canEdit(g) && (g.players || []).length) renderMergeSection(g, add);
    if (isOwner(g)) {
      add('<button class="danger" id="gmDelete"></button>');
      const n = (g.games || []).length;
      const d = $("gmDelete");
      d.textContent = "Usuń grupę";
      d.onclick = () => confirmDialog({title: "Usunąć grupę?", text: "Grupa „" + g.name + "”" + (n ? " razem z " + gier(n).replace(/^(\d+) gry$/, "$1 grami").replace(/^(\d+) gier$/, "$1 grami").replace(/^1 grę$/, "1 grą") : "") + ", wynikami i aktualnościami zostanie usunięta dla wszystkich członków. Tego nie da się cofnąć.", icon: "⚠", yes: "Usuń grupę", danger: true, onYes: () => deleteGroup(g)});
    } else {
      add('<button class="danger" id="gmLeave"></button>');
      const l = $("gmLeave");
      l.textContent = "Opuść grupę";
      l.onclick = () => confirmDialog({title: "Opuścić grupę?", text: "Przestaniesz widzieć grupę „" + g.name + "”. Wrócić możesz tylko z nowym kodem zaproszenia.", icon: "⇥", yes: "Opuść", danger: true, onYes: async () => {
        try { await lcol(g.id).doc().set(logEntry("member", "Opuszczenie grupy")); } catch(e){}
        const ok = await upd(g.id, {["members." + me.uid]: FV.delete(), memberIds: FV.arrayRemove(me.uid), ["memberNames." + me.uid]: FV.delete()});
        if (ok) { closeOv("gm"); toast("Opuszczono grupę: " + g.name); }
      }});
    }
  }
  // ---------- gracze bez konta: połączenie z kontem ----------
  let gmMerge = null;   // {name, uid, armed}
  const normName = t => String(t || "").trim().toLocaleLowerCase("pl");
  // wyniki tej grupy (widoczne dla mnie), w których gracz występuje tylko z imienia
  const playsWithName = (gid, name) => (playsBy[gid] || []).filter(pl => (pl.scores || []).some(sc => !sc.uid && sc.p === name));
  function renderMergeSection(g, add){
    add('<span class="fl">Gracze bez konta (' + g.players.length + ')</span><div id="gmPlayers"></div>' +
        '<p class="rolenote" style="margin-top:6px">Gdy gracz wpisywany z imienia założy konto i dołączy do grupy, połącz go z kontem – jego dotychczasowe wyniki przejdą na konto.</p>');
    const box = $("gmPlayers");
    const accs = (g.memberIds || []).map(u => [u, uname(g, u)]).sort((a,b) => cmp(a[1], b[1]));
    g.players.slice().sort(cmp).forEach(name => {
      const row = document.createElement("div"); row.className = "mem";
      row.innerHTML = '<span class="mn"></span><button class="link mg">Połącz z kontem</button>';
      row.querySelector(".mn").textContent = name + " · " + plural(playsWithName(g.id, name).length, "wynik", "wyniki", "wyników");
      row.querySelector(".mg").onclick = () => { gmMerge = gmMerge && gmMerge.name === name ? null : {name, uid: "", armed: false}; renderGm(); };
      box.appendChild(row);
      if (!gmMerge || gmMerge.name !== name) return;
      const f = document.createElement("div"); f.className = "mergebox";
      f.innerHTML = '<select aria-label="Konto"></select><p class="mergeinfo"></p><button class="ok mgo">Połącz</button>';
      const sel = f.querySelector("select");
      sel.innerHTML = '<option value="">wybierz konto…</option>' + accs.map(([u, n]) => '<option value="' + u + '"></option>').join("");
      [...sel.options].slice(1).forEach((o, i) => o.textContent = accs[i][1]);
      sel.value = gmMerge.uid;
      sel.onchange = () => { gmMerge.uid = sel.value; gmMerge.armed = false; renderGm(); };
      const n = playsWithName(g.id, name).length, accName = gmMerge.uid ? uname(g, gmMerge.uid) : "";
      f.querySelector(".mergeinfo").textContent = gmMerge.uid ? ("Znaleziono " + plural(n, "wynik", "wyniki", "wyników") + " z graczem „" + name + "”. Zostaną przypisane do konta „" + accName + "”, a „" + name + "” zniknie z listy graczy bez konta.") : "";
      const go = f.querySelector(".mgo");
      go.disabled = !gmMerge.uid;
      go.textContent = "Połącz";
      go.onclick = () => confirmDialog({title: "Połączyć z kontem?", text: "Wyniki gracza „" + name + "” (" + plural(n, "wynik", "wyniki", "wyników") + ") przejdą na konto „" + accName + "”.", icon: "⇄", yes: "Połącz", onYes: () => mergePlayer(g, name, gmMerge.uid)});
      box.appendChild(f);
    });
  }
  async function mergePlayer(g, name, u){
    const accName = uname(g, u) !== "?" ? uname(g, u) : name;
    const plays = playsWithName(g.id, name).filter(pl => !(pl.scores || []).some(sc => sc.uid === u));   // konto już w wyniku – pomijam
    gmMerge = null;
    try {
      const played = {}, hist = [];
      for (let i = 0; i < plays.length || i === 0; i += 300) {
        const chunk = plays.slice(i, i + 300);
        await commitB((b, log, extra) => {
          chunk.forEach(pl => {
            const scores = pl.scores.map(sc => (!sc.uid && sc.p === name) ? Object.assign({}, sc, {uid: u, p: accName}) : sc);
            const winners = (pl.winners || []).map(w => w === name ? accName : w);
            const viewers = [...new Set((pl.viewers || []).concat(u))];
            b.update(pcol(g.id).doc(pl.id), {scores, winners, viewers});
            // gra rozegrana także na koncie tej osoby
            const f = findGame(pl.gameId, g.id);
            if (f) ((pl.exps && pl.exps.length) ? pl.exps.map(e => findExp(f.game, e.id) || e) : [null]).forEach(e => {
              const k = vkey(f.game, e); if (!played[k] || played[k] < pl.at) played[k] = pl.at;
              hist.push(histEntry(f.game, pl.at, e));
            });
          });
          if (i === 0) {
            b.update(gdoc(g), {players: FV.arrayRemove(name), updatedAt: Date.now()});
            log(g.id, "player", "Połączenie gracza „" + name + "” z kontem „" + accName + "” (" + plural(plays.length, "wynik", "wyniki", "wyników") + ")");
          }
          if (i + 300 >= plays.length && Object.keys(played).length) extra(b => stateSet(b, g.id, u, {played, history: FV.arrayUnion(...hist.slice(-50))}));
        });
        if (!plays.length) break;
      }
      lsSet("pl-nomerge-" + g.id + "-" + normName(name) + "-" + u, true);
      toast("Połączono „" + name + "” z kontem „" + accName + "”");
    } catch(e){ toast(errMsg(e)); }
    renderGm(); renderResults();
  }
  // podpowiedź: nowa osoba w grupie ma takie samo imię jak gracz bez konta
  function mergeSuggestion(){
    for (const g of groups) {
      if (!canEdit(g) || !(g.players || []).length) continue;
      for (const u of (g.memberIds || [])) {
        if (u === me.uid) continue;
        const full = uname(g, u), first = full.split(/\s+/)[0];
        const name = g.players.find(p => [normName(full), normName(first)].includes(normName(p)));
        if (!name || lsGet("pl-nomerge-" + g.id + "-" + normName(name) + "-" + u, false)) continue;
        if (!playsWithName(g.id, name).length) continue;
        return {g, u, name, full};
      }
    }
    return null;
  }
  function renderMergeHint(){
    const el = $("mergeHint"); const s = me && mergeSuggestion();
    if (!s) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = '<p></p><div class="row2"><button class="ghost mno">Nie</button><button class="ok myes">Połącz</button></div>';
    el.querySelector("p").textContent = "Czy " + s.full + " to gracz „" + s.name + "” z wyników" + (groups.length > 1 ? " w grupie „" + s.g.name + "”" : "") + "? Po połączeniu dotychczasowe wyniki przejdą na konto.";
    el.querySelector(".mno").onclick = () => { lsSet("pl-nomerge-" + s.g.id + "-" + normName(s.name) + "-" + s.u, true); renderMergeHint(); };
    el.querySelector(".myes").onclick = () => mergePlayer(s.g, s.name, s.u);
  }
  async function regenCode(g, r){
    const field = r === "editor" ? "editorCode" : "playerCode";
    for (let attempt = 0; attempt < 5; attempt++){
      const code = newCode();
      try { await commitB((b, log) => {
        if (g[field]) b.delete(db.collection("invites").doc(g[field]));
        b.update(sref(g.id), {[field]: code, updatedAt: Date.now()});
        b.set(db.collection("invites").doc(code), {groupId: g.id, role: r, createdBy: me.uid, createdAt: Date.now()});
        log(g.id, "invite", "Wygenerowanie nowego kodu zaproszenia (" + (r === "editor" ? "Mistrz Gry" : "gracz") + ")");
      }); toast("Nowy kod: " + code); return; }
      catch(e){ if (!String(e.code).includes("permission-denied")) { toast(errMsg(e)); return; } }
    }
    toast("Nie udało się wygenerować kodu");
  }
  async function deleteGroup(g, silent){
    try {
      // usuwamy to, co wolno nam odczytać: widoczne wyniki, wpisy grupy i własne wpisy prywatne, swój stan
      const grab = async q => { try { return (await q.get()).docs; } catch(e){ return []; } };
      const docs = []
        .concat(await grab(pcol(g.id).where("viewers", "array-contains", me.uid)))
        .concat(await grab(lcol(g.id).where("scope", "==", "group")))
        .concat(await grab(lcol(g.id).where("viewers", "array-contains", me.uid)))
        .concat(await grab(gref(g.id).collection("covers")));
      const seen = new Set();
      const uniq = docs.filter(d => !seen.has(d.ref.path) && seen.add(d.ref.path));
      try { await scol(g.id).doc(me.uid).delete(); } catch(e){}
      for (let i = 0; i < uniq.length; i += 400) {
        const b = db.batch(); uniq.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
      }
      const b = db.batch();
      [g.inviteCode, g.editorCode, g.playerCode].filter(Boolean).forEach(c => b.delete(db.collection("invites").doc(c)));
      if (g.shelf) b.delete(sref(g.id));
      b.delete(gref(g.id));
      await b.commit();
      if (!silent) { closeOv("gm"); ui.tab = 0; toast("Usunięto grupę: " + g.name); }
    } catch(e){ if (silent) throw e; toast(errMsg(e)); }
  }

  // ---------- dołącz kodem ----------
  function openJoin(){ $("jnCode").value = ""; $("jnErr").textContent = ""; openOv("jn"); setTimeout(() => $("jnCode").focus(), 50); }
  $("jnBtn").onclick = async () => {
    const code = $("jnCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { $("jnErr").textContent = "Wpisz kod."; return; }
    $("jnErr").textContent = ""; $("jnBtn").disabled = true;
    try {
      const inv = await db.collection("invites").doc(code).get();
      if (!inv.exists) { $("jnErr").textContent = "Nie ma takiego kodu. Sprawdź, czy jest aktualny."; return; }
      const gid = inv.data().groupId, r = inv.data().role === "editor" ? "editor" : "player";
      if (groupById(gid)) { $("jnErr").textContent = "Już należysz do tej grupy."; return; }
      await gref(gid).update({["members." + me.uid]: r, memberIds: FV.arrayUnion(me.uid), ["memberNames." + me.uid]: me.name, joinCode: code});
      lcol(gid).doc().set(logEntry("member", "Dołączenie do grupy (kodem zaproszenia)")).catch(() => {});
      closeOv("jn"); toast(r === "editor" ? "Dołączono do grupy jako Mistrz Gry!" : "Dołączono do grupy jako gracz – zobaczysz wyniki, w których grasz.");
    } catch(e){ $("jnErr").textContent = String(e.code).includes("permission-denied") ? "Ten kod jest już nieaktualny – poproś o nowy." : errMsg(e); }
    finally { $("jnBtn").disabled = false; }
  };
  $("jnCode").addEventListener("keydown", e => { if (e.key === "Enter") $("jnBtn").click(); });

  // ================= WYNIKI =================
  // Gracz w wyniku to albo konto w aplikacji ("u:<uid>"), albo wpisane imię ("n:<imię>").
  const MODES = [{id:"max", name:"Najwięcej pkt"}, {id:"min", name:"Najmniej pkt"}, {id:"coop", name:"Kooperacja"}];
  let rf = null;
  function accounts(){
    const m = new Map();
    groups.forEach(g => Object.entries(g.memberNames || {}).forEach(([u, n]) => { if ((g.memberIds || []).includes(u) && (n || regs[u])) m.set(u, uname(g, u)); }));
    return m;
  }
  const scoreKey = s => s.uid ? "u:" + s.uid : "n:" + s.p;
  const scoreWon = (pl, s) => s.win !== undefined ? !!s.win : (pl.winners || []).includes(s.p);
  function labelOf(key, fallback){
    if (key.startsWith("u:")) { const n = accounts().get(key.slice(2)); return n || fallback || (rf && rf.labels[key]) || "?"; }
    return key.slice(2);
  }
  function allGamesSorted(){
    const out = [];
    groups.forEach(g => (g.games || []).forEach(game => out.push({game, group: g})));
    return out.sort((a,b) => cmp(a.game.name, b.game.name));
  }
  function lastModeFor(gameId){ const p = allPlays().find(x => x.gameId === gameId); return p ? p.mode : "max"; }
  const optVal = (gid, gameId) => gid + "|" + gameId;
  const playLabel = pl => pl.gameName + (Array.isArray(pl.exps) && pl.exps.length ? " + " + pl.exps.map(e => e.name).join(", ") : "");
  function renderRfExps(){
    const f = findGame(rf.gameId, rf.gid);
    const ex = f ? exps(f.game) : [];
    $("rfExpBox").hidden = !ex.length;
    const box = $("rfExps"); box.innerHTML = "";
    if (!ex.length) return;
    const base = document.createElement("button"); base.type = "button";
    base.className = "chip" + (!rf.exps.size ? " on" : ""); base.textContent = "Wersja podstawowa";
    base.onclick = () => { rf.exps.clear(); renderRfExps(); };
    box.appendChild(base);
    ex.forEach(e => {
      const b = document.createElement("button"); b.type = "button";
      b.className = "chip" + (rf.exps.has(e.id) ? " on" : ""); b.textContent = "+ " + e.name;
      b.onclick = () => { if (rf.exps.has(e.id)) rf.exps.delete(e.id); else rf.exps.add(e.id); renderRfExps(); };
      box.appendChild(b);
    });
  }
  function openResult(gameId, gid, edit, presetExp){
    const games = allGamesSorted();
    if (!games.length && !edit) { toast("Najpierw dodaj gry"); return; }
    const sel = $("rfGame"); sel.innerHTML = "";
    games.forEach(x => { const o = document.createElement("option"); o.value = optVal(x.group.id, x.game.id); o.textContent = x.game.name + (groups.length > 1 ? "  ·  " + x.group.name : ""); sel.appendChild(o); });
    if (edit) {
      rf = { editId: edit.id, orig: edit, gid: edit.groupId, gameId: edit.gameId, mode: edit.mode || "max", coopWin: edit.coopWin !== false,
             list: [], pts: {}, labels: {}, exps: new Set((edit.exps || []).map(e => e.id)) };
      (edit.scores || []).forEach(x => { const k = scoreKey(x); rf.list.push(k); rf.labels[k] = x.p; if (x.pts !== undefined) rf.pts[k] = String(x.pts); });
      if (!findGame(edit.gameId, edit.groupId)) { const o = document.createElement("option"); o.value = optVal(edit.groupId, edit.gameId); o.textContent = edit.gameName + " (usunięta z listy)"; sel.insertBefore(o, sel.firstChild); }
      sel.value = optVal(edit.groupId, edit.gameId);
      $("rfDate").value = dateStr(edit.at);
      $("rfTitle").textContent = "Edytuj wynik"; $("rfSave").textContent = "Zapisz zmiany";
    } else {
      const pick = (gameId && findGame(gameId, gid)) || games[0];
      rf = { gid: pick.group.id, gameId: pick.game.id, mode: lastModeFor(pick.game.id), coopWin: true, list: [], pts: {}, labels: {},
             exps: new Set(presetExp && findExp(pick.game, presetExp) ? [presetExp] : []) };
      sel.value = optVal(rf.gid, rf.gameId);
      $("rfDate").value = todayStr();
      $("rfTitle").textContent = "Nowy wynik"; $("rfSave").textContent = "Zapisz wynik";
    }
    $("rfErr").textContent = ""; $("rfManageList").hidden = true;
    renderRfExps(); renderRF(); openOv("rf");
  }
  function computeWinners(){   // zwraca klucze zwycięzców
    const chosen = rf.list.slice();
    if (rf.mode === "coop") return rf.coopWin ? chosen : [];
    const nums = chosen.map(k => ({k, v: parseFloat(String(rf.pts[k] ?? "").replace(",", "."))})).filter(x => !isNaN(x.v));
    if (!nums.length || nums.length < chosen.length) return null;
    const best = rf.mode === "min" ? Math.min(...nums.map(x => x.v)) : Math.max(...nums.map(x => x.v));
    return nums.filter(x => x.v === best).map(x => x.k);
  }
  function updatePreview(){
    const chosen = rf.list.slice(); const w = computeWinners(); let t = "";
    if (!chosen.length) t = "";
    else if (rf.mode === "coop") t = rf.coopWin ? "🏆 Wygrana drużyny: " + chosen.map(k => labelOf(k)).join(", ") : "Przegrana – nikt nie dostaje zwycięstwa";
    else if (w) t = "🏆 Wygrywa: " + w.map(k => labelOf(k)).join(", ") + (w.length > 1 ? " (remis)" : "");
    $("rfPreview").textContent = t;
  }
  function renderRF(){
    const m = $("rfMode"); m.innerHTML = "";
    MODES.forEach(o => { const b = document.createElement("button"); b.type = "button"; b.className = "chip" + (rf.mode === o.id ? " on" : ""); b.textContent = o.name; b.onclick = () => { rf.mode = o.id; renderRF(); }; m.appendChild(b); });
    $("rfCoop").hidden = rf.mode !== "coop";
    const c = $("rfCoopRes"); c.innerHTML = "";
    [{v:true, n:"Wygrana"}, {v:false, n:"Przegrana"}].forEach(o => { const b = document.createElement("button"); b.type = "button"; b.className = "chip" + (rf.coopWin === o.v ? " on" : ""); b.textContent = o.n; b.onclick = () => { rf.coopWin = o.v; renderRF(); }; c.appendChild(b); });
    $("rfPlLabel").textContent = rf.mode === "coop" ? "Kto grał (punkty opcjonalnie)" : "Gracze i punkty";
    const box = $("rfPlayers"); box.innerHTML = "";
    if (!rf.list.length) box.innerHTML = '<div class="empty" style="text-align:left;padding:4px 0">Nikt jeszcze nie dodany – wybierz gracza z listy poniżej albo wpisz nowego.</div>';
    rf.list.forEach(k => {
      const row = document.createElement("div"); row.className = "pl on";
      row.innerHTML = '<span class="tg"></span><input type="number" inputmode="decimal" step="any" placeholder="pkt"><button type="button" class="ib rm" aria-label="Usuń z tej rozgrywki">✕</button>';
      row.querySelector(".tg").textContent = labelOf(k) + (k.startsWith("u:") ? " ◉" : "");
      const inp = row.querySelector("input"); inp.value = rf.pts[k] ?? ""; inp.setAttribute("aria-label", "Punkty: " + labelOf(k));
      inp.oninput = () => { rf.pts[k] = inp.value; updatePreview(); };
      row.querySelector(".rm").onclick = () => { rf.list = rf.list.filter(x => x !== k); delete rf.pts[k]; renderRF(); };
      box.appendChild(row);
    });
    // lista wyboru: najpierw konta w aplikacji, potem wpisani gracze
    const acc = [...accounts().entries()].filter(([u]) => !rf.list.includes("u:" + u)).sort((a,b) => cmp(a[1], b[1]));
    const names = allPlayers().filter(p => !rf.list.includes("n:" + p));
    const ps = $("rfPick"); ps.innerHTML = "";
    const o0 = document.createElement("option"); o0.value = "";
    o0.textContent = (acc.length || names.length) ? "wybierz gracza z listy…" : "wszyscy z listy już dodani";
    ps.appendChild(o0);
    if (acc.length) {
      const og = document.createElement("optgroup"); og.label = "Konta w aplikacji";
      acc.forEach(([u, n]) => { const o = document.createElement("option"); o.value = "u:" + u; o.textContent = n + (u === me.uid ? " (Ty)" : ""); og.appendChild(o); });
      ps.appendChild(og);
    }
    if (names.length) {
      const og = document.createElement("optgroup"); og.label = "Inni gracze";
      names.forEach(p => { const o = document.createElement("option"); o.value = "n:" + p; o.textContent = p; og.appendChild(o); });
      ps.appendChild(og);
    }
    ps.disabled = !(acc.length || names.length);
    $("rfManage").hidden = !allPlayers().length;
    if (!$("rfManageList").hidden) renderManage();
    updatePreview();
  }
  $("rfGame").onchange = () => {
    const [gid, gameId] = $("rfGame").value.split("|");
    rf.gid = gid; rf.gameId = gameId; rf.exps = new Set();
    if (!rf.editId) rf.mode = lastModeFor(gameId);
    renderRfExps(); renderRF();
  };
  function addToGame(key){
    if (!rf.list.includes(key)) rf.list.push(key);
    renderRF();
    const rows = $("rfPlayers").querySelectorAll(".pl"); const r = rows[rf.list.indexOf(key)];
    if (r && rf.mode !== "coop") r.querySelector("input").focus();
  }
  $("rfPick").onchange = () => { const v = $("rfPick").value; if (v) addToGame(v); };
  $("rfAddPl").addEventListener("submit", e => {
    e.preventDefault();
    const n = $("rfNewPl").value.trim().replace(/\s+/g, " "); if (!n) return;
    $("rfNewPl").value = "";
    const accMatch = [...accounts().entries()].filter(([, an]) => an.toLowerCase() === n.toLowerCase());
    if (accMatch.length === 1) { addToGame("u:" + accMatch[0][0]); return; }
    const ex = allPlayers().find(p => p.toLowerCase() === n.toLowerCase());
    addToGame("n:" + (ex || n));
  });
  let plArmed = null;
  function renderManage(){
    const box = $("rfManageList"); box.innerHTML = "";
    allPlayers().forEach(p => {
      const b = document.createElement("button"); b.type = "button";
      b.className = "chip";
      b.textContent = p + "  ✕";
      b.onclick = () => confirmDialog({title: "Usunąć gracza z listy?", text: "„" + p + "” zniknie z listy graczy do wyboru. Zapisane wyniki zostaną.", icon: "🗑", yes: "Usuń", danger: true, onYes: async () => {
        for (const g of groups) if ((g.players || []).includes(p)) await upd(g.id, {players: FV.arrayRemove(p)}, "Usunięcie gracza z listy: " + p, "player");
      }});
      box.appendChild(b);
    });
  }
  $("rfManageBtn").onclick = () => { const l = $("rfManageList"); l.hidden = !l.hidden; plArmed = null; if (!l.hidden) renderManage(); };

  $("rfSave").onclick = async () => {
    const chosen = rf.list.slice();
    if (!chosen.length) { $("rfErr").textContent = "Dodaj graczy, którzy grali."; return; }
    const win = computeWinners();
    if (rf.mode !== "coop" && !win) { $("rfErr").textContent = "Wpisz punkty każdego gracza."; return; }
    const f = findGame(rf.gameId, rf.gid);
    const keepOld = !f && rf.editId && rf.gameId === rf.orig.gameId && rf.gid === rf.orig.groupId;
    if (!f && !keepOld) { $("rfErr").textContent = "Wybierz grę."; return; }
    const dStr = $("rfDate").value;
    let at = Date.now();
    if (rf.editId && dStr === dateStr(rf.orig.at)) at = rf.orig.at;
    else if (dStr && dStr !== todayStr()) { const d = new Date(dStr + "T20:00:00"); if (!isNaN(d)) at = d.getTime(); }
    const winSet = new Set(win || []);
    const scores = chosen.map(k => {
      const sc = {p: labelOf(k), win: winSet.has(k)};
      if (k.startsWith("u:")) sc.uid = k.slice(2);
      const v = parseFloat(String(rf.pts[k] ?? "").replace(",", "."));
      if (!isNaN(v)) sc.pts = v;
      return sc;
    });
    const gid = rf.gid;
    const playId = rf.editId || uid();
    const play = { gameId: rf.gameId, gameName: f ? f.game.name : rf.orig.gameName, at, mode: rf.mode, scores,
                   winners: scores.filter(x => x.win).map(x => x.p),
                   createdBy: rf.editId ? (rf.orig.createdBy || me.uid) : me.uid, createdByName: rf.editId ? (rf.orig.createdByName || me.name) : me.name };
    if (rf.mode === "coop") play.coopWin = rf.coopWin;
    const selExps = f ? exps(f.game).filter(e => rf.exps.has(e.id)) : (rf.orig && rf.orig.exps) || [];
    play.exps = selExps.map(e => ({id: e.id, name: e.name}));
    // kto widzi wynik: gracze z kontem + osoba, która go teraz zapisuje.
    // Osoba usunięta z rozgrywki (także autor) przestaje widzieć wynik.
    const accountUids = [...new Set(scores.filter(x => x.uid).map(x => x.uid))];
    play.viewers = [...new Set(accountUids.concat(me.uid))];
    const g = groupById(gid);
    $("rfSave").disabled = true;
    try {
      const editId = rf.editId, origGid = rf.editId ? rf.orig.groupId : null;
      const fill = (b, log, extra) => {
      if (editId && origGid !== gid) {
        b.delete(pcol(origGid).doc(editId));
        b.set(pcol(gid).doc(editId), play);
      } else {
        b.set(pcol(gid).doc(playId), play);
      }
      // wpisane imiona trafiają na listę graczy grupy
      const newNames = chosen.filter(k => k.startsWith("n:")).map(k => k.slice(2)).filter(p => !(g.players || []).includes(p));
      if (newNames.length) b.update(gdoc(g), {players: FV.arrayUnion(...newNames), updatedAt: Date.now()});
      // gra (wybrane wersje) rozegrana dla każdego gracza z kontem, który jest w tej grupie (w jego prywatnym stanie).
      // Przy edycji: to, co zniknęło z wyniku (gracz, rozszerzenie, gra, data), wraca do losowania, a to, co doszło – jest oznaczane.
      const newU = accountUids.filter(u => (g.memberIds || []).includes(u));
      const newIds = selExps.length ? selExps.map(e => e.id) : [null];
      let skipNew = () => false;
      if (editId) {
        const o = rf.orig, og = groupById(origGid);
        const oU = [...new Set((o.scores || []).filter(x => x.uid).map(x => x.uid))].filter(u => og && (og.memberIds || []).includes(u));
        const oIds = (o.exps && o.exps.length) ? o.exps.map(e => e.id) : [null];
        const sameCtx = origGid === gid && o.gameId === rf.gameId && o.at === at;
        extra(b => unmarkPlay(b, o, (u, id) => sameCtx && newU.includes(u) && newIds.includes(id)));
        skipNew = (u, id) => sameCtx && oU.includes(u) && oIds.includes(id);
      }
      if (f) extra(b => newU.forEach(u => {
        const vs = newIds.filter(id => !skipNew(u, id)).map(id => id ? findExp(f.game, id) : null);
        if (!vs.length) return;
        const playedMap = {}; vs.forEach(e => playedMap[vkey(f.game, e)] = at);
        stateSet(b, gid, u, {played: playedMap, history: FV.arrayUnion(...vs.map(e => histEntry(f.game, at, e)))});
      }));
      const summary = q(playLabel(play)) + " – " + scores.map(x => (x.win ? "🏆 " : "") + x.p + (x.pts !== undefined ? " " + x.pts : "")).join(", ")
        + (play.mode === "coop" ? (play.coopWin ? " (kooperacja – wygrana)" : " (kooperacja – przegrana)") : "");
      log(gid, "result", (editId ? "Zmiana wyniku: " : "Dodanie wyniku: ") + summary, play.viewers);
      };
      const wasEdit = !!editId;
      commitB(fill).catch(e => toast(errMsg(e)));   // offline: zapisze się po połączeniu
      ui.justPlayed = null;
      closeOv("rf"); render();
      toast((wasEdit ? "Zmieniono wynik" : "Zapisano wynik") + (play.winners.length ? " · 🏆 " + play.winners.join(", ") : ""));
    } catch(e){ $("rfErr").textContent = errMsg(e); }
    finally { $("rfSave").disabled = false; }
  };

  function renderResults(){
    if (!me) return;
    renderMergeHint();
    const plays = allPlays();
    const rfEl = $("rankFilter"); rfEl.innerHTML = "";
    if (ui.rankGroup !== "all" && !groupById(ui.rankGroup)) ui.rankGroup = "all";
    rfEl.hidden = groups.length < 2 || !plays.length;
    [{id:"all", name:"Wszystkie grupy"}].concat(groups.map(g => ({id:g.id, name:g.name}))).forEach(o => {
      const b = document.createElement("button");
      b.className = "chip" + (ui.rankGroup === o.id ? " on" : ""); b.textContent = o.name;
      b.onclick = () => { ui.rankGroup = o.id; renderResults(); };
      rfEl.appendChild(b);
    });
    const shown = ui.rankGroup === "all" ? plays : plays.filter(p => p.groupId === ui.rankGroup);
    const acc = accounts();
    const stats = {};
    shown.forEach(pl => (pl.scores || []).forEach(s => {
      const k = scoreKey(s);
      const st = stats[k] = stats[k] || {w:0, g:0, label: s.uid ? (acc.get(s.uid) || s.p) : s.p, account: !!s.uid};
      st.g++; if (scoreWon(pl, s)) st.w++;
    }));
    const rows = Object.values(stats).sort((a,b) => b.w - a.w || (b.g ? b.w/b.g : 0) - (a.g ? a.w/a.g : 0) || cmp(a.label, b.label));
    const t = $("rank");
    if (!shown.length) t.innerHTML = '<tr><td class="empty" style="text-align:center;border:0">' + (plays.length ? "Brak wyników w tej grupie." : "Brak wyników. Dodaj pierwszy po rozgrywce.") + '</td></tr>';
    else {
      // miejsca: najpierw liczba wygranych, przy remisie procent wygranych; ten sam wynik = to samo miejsce
      const pct = r => r.g ? r.w / r.g : 0;
      let place = 0;
      rows.forEach((r, i) => { place = (i && r.w === rows[i-1].w && pct(r) === pct(rows[i-1])) ? place : i + 1; r.place = place; });
      t.innerHTML = "<tr><th>Gracz</th><th>Wygrane</th><th>Gry</th><th>%</th></tr>";
      rows.forEach(r => {
        const tr = document.createElement("tr");
        const medal = r.w && r.place <= 3 ? ["gold", "silver", "bronze"][r.place - 1] : "";
        if (medal) tr.className = "top p" + r.place;
        tr.innerHTML = "<td></td><td class='w'></td><td></td><td></td>";
        if (medal) tr.children[0].innerHTML = '<svg class="crown ' + medal + '" viewBox="0 0 24 18" aria-label="' + r.place + '. miejsce"><path d="M2 15 L1 4 L7 9 L12 1 L17 9 L23 4 L22 15 Z"/><rect x="2" y="15.5" width="20" height="2.5" rx="1"/></svg>';
        tr.children[0].appendChild(document.createTextNode(r.label));
        tr.children[1].textContent = r.w; tr.children[2].textContent = r.g;
        tr.children[3].textContent = r.g ? Math.round(100 * r.w / r.g) + "%" : "–";
        t.appendChild(tr);
      });
    }
    renderH2H(shown, acc);
    renderProfile(); renderRecords();
    const ul = $("resList"); ul.innerHTML = "";
    if (!shown.length) { ul.innerHTML = '<li class="empty" style="justify-content:center">—</li>'; return; }
    shown.slice(0, 15).forEach(pl => ul.appendChild(resultItem(pl, acc)));
    const ab = $("openAllRes"); ab.hidden = !plays.length;
    ab.textContent = "☰ Wszystkie wyniki (" + plays.length + ") · filtrowanie";
  }
  // gracze wyniku: każdy w osobnej linii, z pucharem za miejsce i punktami (wyniki, wszystkie wyniki, aktualności)
  function fillPlayers(rs, pl, acc){
    const sorted = (pl.scores || []).slice().sort((a,b) => (pl.mode === "min" ? 1 : -1) * ((a.pts ?? -Infinity) - (b.pts ?? -Infinity)));
    // miejsca w partii: zwycięzcy 1., dalej według punktów (ten sam wynik = to samo miejsce); w kooperacji tylko zwycięzcy
    const hasPts = pl.mode !== "coop" && sorted.every(sc => sc.pts !== undefined);
    let place = 0, prev;
    sorted.forEach((sc, i) => {
      if (scoreWon(pl, sc)) sc._pl = 1;
      else if (hasPts) { place = (i && sc.pts === prev) ? place : i + 1; sc._pl = Math.max(2, place); }
      else sc._pl = 0;
      if (hasPts) { prev = sc.pts; if (sc._pl === 1) place = 1; }
    });
    // każdy gracz w osobnej linii: puchar (złoty, srebrny, brązowy), imię, punkty po prawej
    sorted.forEach(sc => {
      const won = scoreWon(pl, sc), medal = sc._pl >= 1 && sc._pl <= 3 ? ["gold", "silver", "bronze"][sc._pl - 1] : "";
      const row = document.createElement("div"); row.className = "rp" + (won ? " win" : "") + (medal ? " m-" + medal : "");
      row.innerHTML = '<span class="rpw"></span><span class="rpn"></span><span class="rpp"></span>';
      if (medal) row.querySelector(".rpw").innerHTML = '<svg class="cup ' + medal + '" viewBox="0 0 24 24" aria-label="' + sc._pl + '. miejsce"><path d="M7 3h10v2h3v3a4 4 0 0 1-4.1 4A5 5 0 0 1 13 14.8V18h3v3H8v-3h3v-3.2A5 5 0 0 1 8.1 12 4 4 0 0 1 4 8V5h3zm-1 4v1a2 2 0 0 0 1.4 1.9A5 5 0 0 1 7 8V7zm11 0v1c0 .6-.1 1.3-.4 1.9A2 2 0 0 0 18 8V7z"/></svg>';
      row.querySelector(".rpn").textContent = sc.uid ? (acc.get(sc.uid) || sc.p) : sc.p;
      row.querySelector(".rpp").textContent = sc.pts !== undefined ? sc.pts : "";
      delete sc._pl;
      rs.appendChild(row);
    });
    if (pl.mode === "coop") { const c = document.createElement("div"); c.className = "rpc"; c.textContent = pl.coopWin ? "Kooperacja – wygrana" : "Kooperacja – przegrana"; rs.appendChild(c); }
  }
  // jeden wynik na liście (ostatnie wyniki i okno „Wszystkie wyniki”)
  function resultItem(pl, acc){
    const g = groupById(pl.groupId);
    const mayEdit = canEdit(g);
    const li = document.createElement("li");
    li.innerHTML = '<div class="rb"><div class="rt"><b></b><span></span></div><div class="rs"></div></div>' +
      (mayEdit ? '<button class="ib ed" title="Edytuj wynik">✎</button><button class="ib del" title="Usuń wynik">🗑</button>' : '');
    li.querySelector("b").textContent = playLabel(pl);
    li.querySelector(".rt span").textContent = fmt(pl.at) + (groups.length > 1 && g ? " · " + g.name : "");
    fillPlayers(li.querySelector(".rs"), pl, acc);
    if (mayEdit) {
      li.querySelector(".ed").onclick = () => { ui.resArmed = null; openResult(null, null, pl); };
      li.querySelector(".del").onclick = () => confirmDialog({title: "Usunąć wynik?", text: playLabel(pl) + " z " + fmt(pl.at) + ". Gra wróci do losowania u graczy z tej partii.", icon: "🗑", yes: "Usuń", danger: true, onYes: () => {
        commitB((b, log, extra) => {
          b.delete(pcol(pl.groupId).doc(pl.id));
          extra(b => unmarkPlay(b, pl));
          log(pl.groupId, "result", "Usunięcie wyniku: " + q(playLabel(pl)) + " z " + fmt(pl.at), pl.viewers || [me.uid]);
        }).catch(e => toast(errMsg(e)));
      }});
    }
    return li;
  }
  // ---------- okno „Wszystkie wyniki” z filtrami ----------
  const arF = {group: "all", game: "", player: "", from: "", to: "", limit: 50};
  function renderAllRes(){
    if ($("ar").hidden) return;
    const acc = accounts();
    const plays = allPlays();
    // grupy
    const ge = $("arGroups"); ge.innerHTML = ""; ge.hidden = groups.length < 2;
    if (arF.group !== "all" && !groupById(arF.group)) arF.group = "all";
    [{id: "all", name: "Wszystkie grupy"}].concat(groups.map(g => ({id: g.id, name: g.name}))).forEach(o => {
      const b = document.createElement("button"); b.className = "chip" + (arF.group === o.id ? " on" : ""); b.textContent = o.name;
      b.onclick = () => { arF.group = o.id; arF.limit = 50; renderAllRes(); }; ge.appendChild(b);
    });
    const inGroup = plays.filter(p => arF.group === "all" || p.groupId === arF.group);
    // gry i gracze, które występują w wynikach
    const games = new Map(), players = new Map();
    inGroup.forEach(p => {
      const f = findGame(p.gameId, p.groupId);
      games.set(p.groupId + "|" + p.gameId, f ? f.game.name : p.gameName);
      (p.scores || []).forEach(sc => players.set(scoreKey(sc), sc.uid ? (acc.get(sc.uid) || sc.p) : sc.p));
    });
    const fill = (sel, map, all, cur) => {
      sel.innerHTML = ""; const o0 = document.createElement("option"); o0.value = ""; o0.textContent = all; sel.appendChild(o0);
      [...map.entries()].sort((a,b) => cmp(a[1], b[1])).forEach(([k, n]) => { const o = document.createElement("option"); o.value = k; o.textContent = n; sel.appendChild(o); });
      sel.value = map.has(cur) ? cur : "";
      return sel.value;
    };
    arF.game = fill($("arGame"), games, "Wszystkie gry", arF.game);
    arF.player = fill($("arPlayer"), players, "Wszyscy gracze", arF.player);
    $("arFrom").value = arF.from; $("arTo").value = arF.to;
    const fromTs = arF.from ? new Date(arF.from + "T00:00:00").getTime() : -Infinity;
    const toTs = arF.to ? new Date(arF.to + "T23:59:59").getTime() : Infinity;
    const list = inGroup.filter(p => (!arF.game || p.groupId + "|" + p.gameId === arF.game)
      && (!arF.player || (p.scores || []).some(sc => scoreKey(sc) === arF.player))
      && p.at >= fromTs && p.at <= toTs);
    // podsumowanie: liczba wyników i najczęściej wygrywający
    const tw = topWinners(list);
    let sum = "Znaleziono: " + plural(list.length, "wynik", "wyniki", "wyników");
    if (arF.player && list.length) {
      const w = list.filter(p => (p.scores || []).some(sc => scoreKey(sc) === arF.player && scoreWon(p, sc))).length;
      sum += " · " + players.get(arF.player) + ": " + plural(w, "wygrana", "wygrane", "wygranych") + " (" + Math.round(100 * w / list.length) + "%)";
    } else if (tw) sum += " · najczęściej wygrywa: " + tw.names.join(", ") + " (" + tw.wins + ")";
    $("arSum").textContent = sum;
    const ul = $("arList"); ul.innerHTML = "";
    if (!list.length) { ul.innerHTML = '<li class="empty" style="justify-content:center">Brak wyników dla wybranych filtrów.</li>'; return; }
    list.slice(0, arF.limit).forEach(pl => ul.appendChild(resultItem(pl, acc)));
    if (list.length > arF.limit) {
      const li = document.createElement("li"); li.style.justifyContent = "center";
      const b = document.createElement("button"); b.className = "link"; b.textContent = "Pokaż więcej (" + (list.length - arF.limit) + ")";
      b.onclick = () => { arF.limit += 50; renderAllRes(); }; li.appendChild(b); ul.appendChild(li);
    }
  }
  $("openAllRes").onclick = () => { arF.limit = 50; openOv("ar"); renderAllRes(); };
  $("arGame").onchange = e => { arF.game = e.target.value; arF.limit = 50; renderAllRes(); };
  $("arPlayer").onchange = e => { arF.player = e.target.value; arF.limit = 50; renderAllRes(); };
  $("arFrom").onchange = e => { arF.from = e.target.value; arF.limit = 50; renderAllRes(); };
  $("arTo").onchange = e => { arF.to = e.target.value; arF.limit = 50; renderAllRes(); };
  $("arReset").onclick = () => { Object.assign(arF, {group: "all", game: "", player: "", from: "", to: "", limit: 50}); renderAllRes(); };
  $("addResult").onclick = () => openResult(null, null);
  // ---------- Pojedynki 1 na 1 ----------
  const h2h = {a: "", b: ""};
  function renderH2H(plays, acc){
    const card = $("openH2h");
    const names = new Map(), together = new Map();
    plays.forEach(p => (p.scores || []).forEach(sc => names.set(scoreKey(sc), sc.uid ? (acc.get(sc.uid) || sc.p) : sc.p)));
    if (names.size < 2) { card.hidden = true; return; }
    card.hidden = false;
    // domyślnie: ja i osoba, z którą najczęściej gram
    const meKey = "u:" + me.uid;
    if (!names.has(h2h.a)) h2h.a = names.has(meKey) ? meKey : [...names.keys()][0];
    plays.forEach(p => { const ks = (p.scores || []).map(scoreKey); if (ks.includes(h2h.a)) ks.forEach(k => { if (k !== h2h.a) together.set(k, (together.get(k) || 0) + 1); }); });
    if (!names.has(h2h.b) || h2h.b === h2h.a) h2h.b = [...together.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || [...names.keys()].find(k => k !== h2h.a);
    const fill = (sel, cur) => { sel.innerHTML = ""; [...names.entries()].sort((x, y) => cmp(x[1], y[1])).forEach(([k, n]) => { const o = document.createElement("option"); o.value = k; o.textContent = n; sel.appendChild(o); }); sel.value = cur; };
    fill($("h2hA"), h2h.a); fill($("h2hB"), h2h.b);
    // widoczna nazwa: imię w pierwszej linii, nazwisko w drugiej (lista wyboru otwiera się po stuknięciu)
    const two = (el, n) => { el.innerHTML = ""; const parts = String(n || "").trim().split(/\s+/); const b = document.createElement("b"); b.textContent = parts[0] || ""; el.appendChild(b);
      if (parts.length > 1) { const sp = document.createElement("span"); sp.textContent = parts.slice(1).join(" "); el.appendChild(sp); } };
    two($("h2hAn"), names.get(h2h.a)); two($("h2hBn"), names.get(h2h.b));
    const A = h2h.a, B = h2h.b, nA = names.get(A), nB = names.get(B);
    // wspólne partie, od najstarszej; kto był lepszy: punkty (wg trybu), a bez punktów – zwycięstwo
    const common = plays.filter(p => { const ks = (p.scores || []).map(scoreKey); return ks.includes(A) && ks.includes(B); }).sort((x, y) => x.at - y.at);
    const res = common.map(p => {
      const sa = p.scores.find(sc => scoreKey(sc) === A), sb = p.scores.find(sc => scoreKey(sc) === B);
      let d = 0;
      if (p.mode !== "coop" && sa.pts !== undefined && sb.pts !== undefined) d = (p.mode === "min" ? -1 : 1) * Math.sign(sa.pts - sb.pts);
      else d = (scoreWon(p, sa) ? 1 : 0) - (scoreWon(p, sb) ? 1 : 0);
      return {p, d};
    });
    const wa = res.filter(r => r.d > 0).length, wb = res.filter(r => r.d < 0).length, dr = res.length - wa - wb;
    // serie: aktualna i najdłuższa
    let cur = 0, curWho = 0, bestA = 0, bestB = 0, run = 0, runWho = 0;
    res.forEach(r => { if (r.d && r.d === runWho) run++; else { run = r.d ? 1 : 0; runWho = r.d; } if (runWho > 0) bestA = Math.max(bestA, run); if (runWho < 0) bestB = Math.max(bestB, run); });
    cur = run; curWho = runWho;
    const body = $("h2hBody"); body.innerHTML = "";
    if (!common.length) { body.innerHTML = '<p class="h2hnone">Ci gracze nie grali jeszcze razem.</p>'; return; }
    // wynik pojedynku: liczby pod wybranymi graczami + pasek proporcji
    const top = document.createElement("div"); top.className = "h2hscore";
    top.innerHTML = '<b class="hs a"></b><span class="hsep">:</span><b class="hs b"></b>';
    top.querySelector(".a").textContent = wa; top.querySelector(".b").textContent = wb;
    if (wa > wb) top.querySelector(".a").classList.add("lead"); if (wb > wa) top.querySelector(".b").classList.add("lead");
    body.appendChild(top);
    const bar = document.createElement("div"); bar.className = "h2hbar";
    [["a", wa], ["d", dr], ["b", wb]].forEach(([c, n]) => { if (!n) return; const sg = document.createElement("span"); sg.className = c; sg.style.flexGrow = n; bar.appendChild(sg); });
    body.appendChild(bar);
    const leg = document.createElement("div"); leg.className = "h2hleg";
    [["a", nA, wa], ["d", "remisy", dr], ["b", nB, wb]].forEach(([c, n, v]) => {
      const it = document.createElement("span"); it.className = "li";
      it.innerHTML = '<i class="' + c + '"></i><span class="ln"></span><b></b>';
      it.querySelector(".ln").textContent = c === "d" ? n : String(n).split(" ")[0]; it.querySelector("b").textContent = v;
      leg.appendChild(it);
    });
    body.appendChild(leg);
    // kafelki: wspólne partie, remisy, aktualna seria, najdłuższa seria
    const first = n => String(n).split(" ")[0];
    const tiles = [
      ["Wspólne partie", String(common.length), ""],
      ["Remisy", String(dr), ""],
      ["Aktualna seria", cur >= 2 ? cur + "×" : "–", cur >= 2 ? first(curWho > 0 ? nA : nB) : "brak serii"],
      ["Najdłuższa seria", (bestA || 0) + " : " + (bestB || 0), bestA === bestB ? "remis" : first(bestA > bestB ? nA : nB)]
    ];
    const grid = document.createElement("div"); grid.className = "h2htiles";
    tiles.forEach(([l, v, sub]) => {
      const d = document.createElement("div"); d.className = "h2htile";
      d.innerHTML = '<span class="tl"></span><b class="tv"></b><span class="ts"></span>';
      d.querySelector(".tl").textContent = l; d.querySelector(".tv").textContent = v; d.querySelector(".ts").textContent = sub;
      grid.appendChild(d);
    });
    body.appendChild(grid);
    // rozbicie na gry
    const per = new Map();
    res.forEach(r => { const f = findGame(r.p.gameId, r.p.groupId); const k = r.p.groupId + "|" + r.p.gameId; const o = per.get(k) || {name: f ? f.game.name : r.p.gameName, a: 0, b: 0, n: 0}; o.n++; if (r.d > 0) o.a++; if (r.d < 0) o.b++; per.set(k, o); });
    const t = document.createElement("table"); t.className = "rank h2ht";
    t.innerHTML = "<tr><th>Gra</th><th></th><th></th></tr>";
    t.querySelectorAll("th")[1].textContent = nA.split(" ")[0]; t.querySelectorAll("th")[2].textContent = nB.split(" ")[0];
    [...per.values()].sort((x, y) => y.n - x.n || cmp(x.name, y.name)).forEach(o => {
      const tr = document.createElement("tr"); tr.innerHTML = "<td></td><td class='w'></td><td class='w'></td>";
      tr.children[0].textContent = o.name + " (" + o.n + ")"; tr.children[1].textContent = o.a; tr.children[2].textContent = o.b;
      if (o.a > o.b) tr.children[1].classList.add("h2hwin"); if (o.b > o.a) tr.children[2].classList.add("h2hwin");
      t.appendChild(tr);
    });
    body.appendChild(t);
  }

  // ===== Profil gracza i Rekordy w grach (z wyników, które widzę) =====
  let pfKey = "";
  function playerNames(plays, acc){
    const m = new Map();
    plays.forEach(p => (p.scores || []).forEach(sc => m.set(scoreKey(sc), sc.uid ? (acc.get(sc.uid) || sc.p) : sc.p)));
    return m;
  }
  const playGameName = p => { const f = findGame(p.gameId, p.groupId); return f ? f.game.name : p.gameName; };
  function twoLine(el, n){
    el.innerHTML = ""; const parts = String(n || "").trim().split(/\s+/);
    const b = document.createElement("b"); b.textContent = parts[0] || ""; el.appendChild(b);
    if (parts.length > 1) { const sp = document.createElement("span"); sp.textContent = parts.slice(1).join(" "); el.appendChild(sp); }
  }
  function tile(label, value, sub, txt){
    const d = document.createElement("div"); d.className = "h2htile" + (txt ? " txt" : "");
    d.innerHTML = '<span class="tl"></span><b class="tv"></b><span class="ts"></span>';
    d.querySelector(".tl").textContent = label; d.querySelector(".tv").textContent = value; d.querySelector(".ts").textContent = sub || "";
    return d;
  }
  function renderProfile(){
    const plays = allPlays(), acc = accounts(), names = playerNames(plays, acc);
    $("openPf").hidden = !names.size;
    if (!names.size) return;
    if (!names.has(pfKey)) pfKey = names.has("u:" + me.uid) ? "u:" + me.uid : [...names.keys()][0];
    const sel = $("pfSel"); sel.innerHTML = "";
    [...names.entries()].sort((x, y) => cmp(x[1], y[1])).forEach(([k, n]) => { const o = document.createElement("option"); o.value = k; o.textContent = n + (k === "u:" + me.uid ? " (Ty)" : ""); sel.appendChild(o); });
    sel.value = pfKey; twoLine($("pfN"), names.get(pfKey));
    const K = pfKey;
    const mine = plays.filter(p => (p.scores || []).some(sc => scoreKey(sc) === K)).sort((a, b) => b.at - a.at);
    const body = $("pfBody"); body.innerHTML = "";
    const kind = document.createElement("div"); kind.className = "pfkind";
    kind.textContent = (K.startsWith("u:") ? "Konto w aplikacji" : "Gracz bez konta") + (mine.length ? " · gra od " + fmt(mine[mine.length - 1].at) : "");
    body.appendChild(kind);
    if (!mine.length) { const e = document.createElement("p"); e.className = "h2hnone"; e.textContent = "Brak wyników tego gracza."; body.appendChild(e); return; }
    const won = p => scoreWon(p, p.scores.find(sc => scoreKey(sc) === K));
    const wins = mine.filter(won).length;
    const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const g1 = document.createElement("div"); g1.className = "h2htiles";
    g1.append(tile("Partie", String(mine.length), ""), tile("Wygrane", String(wins), ""),
      tile("% wygranych", Math.round(100 * wins / mine.length) + "%", ""),
      tile("W tym miesiącu", String(mine.filter(p => p.at >= monthStart).length), "partie"));
    body.appendChild(g1);
    // forma: ostatnie 5 partii
    const form = document.createElement("div"); form.className = "pfform";
    const fl = document.createElement("span"); fl.className = "tl"; fl.textContent = "Forma (ostatnie partie)"; form.appendChild(fl);
    const fr = document.createElement("div"); fr.className = "pfdots";
    mine.slice(0, 5).reverse().forEach(p => { const d = document.createElement("span"); const w = won(p); d.className = "pfd " + (w ? "w" : "l"); d.textContent = w ? "W" : "P"; d.title = playGameName(p) + " · " + fmt(p.at); fr.appendChild(d); });
    form.appendChild(fr); body.appendChild(form);
    // gry
    const per = new Map();
    mine.forEach(p => { const k = p.groupId + "|" + p.gameId; const o = per.get(k) || {name: playGameName(p), n: 0, w: 0}; o.n++; if (won(p)) o.w++; per.set(k, o); });
    const games = [...per.values()];
    const fav = games.slice().sort((a, b) => b.n - a.n || cmp(a.name, b.name))[0];
    const best = games.filter(o => o.n >= 2).sort((a, b) => b.w / b.n - a.w / a.n || b.n - a.n)[0];
    let rec = null;
    mine.forEach(p => { const sc = p.scores.find(x => scoreKey(x) === K); if (p.mode === "max" && sc.pts !== undefined && (!rec || sc.pts > rec.pts)) rec = {pts: sc.pts, p}; });
    // rywale
    const opp = new Map();
    mine.forEach(p => {
      const sa = p.scores.find(x => scoreKey(x) === K);
      p.scores.forEach(sb => { const k = scoreKey(sb); if (k === K) return; const o = opp.get(k) || {n: 0, beat: 0, lost: 0}; o.n++;
        if (p.mode !== "coop") { const wa = scoreWon(p, sa), wb = scoreWon(p, sb); if (wa && !wb) o.beat++; if (wb && !wa) o.lost++; }
        opp.set(k, o); });
    });
    const oppL = [...opp.entries()];
    const top = (f) => oppL.filter(([, o]) => f(o) > 0).sort((a, b) => f(b[1]) - f(a[1]) || cmp(names.get(a[0]), names.get(b[0])))[0];
    const often = top(o => o.n), beats = top(o => o.beat), nem = top(o => o.lost);
    const g2 = document.createElement("div"); g2.className = "h2htiles";
    g2.append(
      tile("Ulubiona gra", fav.name, plural(fav.n, "partia", "partie", "partii"), true),
      tile("Najlepsza gra", best ? best.name : "–", best ? Math.round(100 * best.w / best.n) + "% wygranych z " + best.n : "od 2 partii w grze", true),
      tile("Rekord punktów", rec ? String(rec.pts) : "–", rec ? playGameName(rec.p) + " · " + fmt(rec.p.at) : "brak punktów", !rec),
      tile("Najczęściej gra z", often ? names.get(often[0]) : "–", often ? plural(often[1].n, "partia", "partie", "partii") : "", true),
      tile("Najczęściej pokonuje", beats ? names.get(beats[0]) : "–", beats ? plural(beats[1].beat, "raz", "razy", "razy") : "", true),
      tile("Najtrudniejszy rywal", nem ? names.get(nem[0]) : "–", nem ? "przegrane: " + nem[1].lost : "", true));
    body.appendChild(g2);
  }
  $("openPf").onclick = () => { renderProfile(); openOv("pfOv"); };
  $("pfSel").onchange = e => { pfKey = e.target.value; renderProfile(); };

  function renderRecords(){
    const plays = allPlays(), acc = accounts();
    $("openRec").hidden = !plays.length;
    if ($("recOv").hidden) return;
    const qv = $("recSearch").value.trim().toLowerCase();
    const per = new Map();
    plays.forEach(p => { const k = p.groupId + "|" + p.gameId; const o = per.get(k) || {gid: p.groupId, gameId: p.gameId, name: playGameName(p), plays: []}; o.plays.push(p); per.set(k, o); });
    const list = [...per.values()].filter(o => !qv || o.name.toLowerCase().includes(qv)).sort((a, b) => cmp(a.name, b.name));
    const body = $("recBody"); body.innerHTML = "";
    if (!list.length) { body.innerHTML = '<p class="h2hnone">' + (per.size ? "Brak gier o tej nazwie." : "Brak wyników.") + '</p>'; return; }
    const nm = sc => sc.uid ? (acc.get(sc.uid) || sc.p) : sc.p;
    list.forEach(o => {
      const card = document.createElement("div"); card.className = "reccard";
      const head = document.createElement("div"); head.className = "rechead";
      const cv = coverImg(o.gid, o.gameId, "reccov"); if (cv) head.appendChild(cv);
      const ht = document.createElement("div"); ht.className = "rect";
      const b = document.createElement("b"); b.textContent = o.name; ht.appendChild(b);
      const all = []; o.plays.forEach(p => (p.scores || []).forEach(sc => { if (sc.pts !== undefined) all.push({sc, p}); }));
      const sub = document.createElement("span");
      sub.textContent = plural(o.plays.length, "partia", "partie", "partii") + (all.length ? " · średnio " + (Math.round(10 * all.reduce((t, x) => t + x.sc.pts, 0) / all.length) / 10).toString().replace(".", ",") + " pkt" : "");
      ht.appendChild(sub); head.appendChild(ht); card.appendChild(head);
      const rows = [];
      if (all.length) {
        const minMode = o.plays.filter(p => p.mode === "min").length > o.plays.filter(p => p.mode === "max").length;
        const sorted = all.slice().sort((x, y) => (minMode ? x.sc.pts - y.sc.pts : y.sc.pts - x.sc.pts) || x.p.at - y.p.at);
        const bestR = sorted[0], worstR = sorted[sorted.length - 1];
        rows.push(["🏆", "Rekord" + (minMode ? " (najmniej pkt)" : ""), bestR.sc.pts + " pkt", nm(bestR.sc) + " · " + fmt(bestR.p.at), "best"]);
        if (sorted.length > 1) rows.push(["▼", "Najsłabszy wynik", worstR.sc.pts + " pkt", nm(worstR.sc) + " · " + fmt(worstR.p.at), ""]);
      }
      const wc = new Map();
      o.plays.forEach(p => (p.scores || []).forEach(sc => { if (scoreWon(p, sc)) { const k = scoreKey(sc); const x = wc.get(k) || {n: 0, name: nm(sc)}; x.n++; wc.set(k, x); } }));
      const lead = [...wc.values()].sort((a, b) => b.n - a.n || cmp(a.name, b.name));
      if (lead.length) { const topN = lead[0].n, tied = lead.filter(x => x.n === topN).map(x => x.name);
        rows.push(["👑", "Najwięcej wygranych", plural(topN, "wygrana", "wygrane", "wygranych"), tied.join(", "), ""]); }
      const t = document.createElement("div"); t.className = "recrows";
      rows.forEach(([ic, l, v, who, cls]) => {
        const r = document.createElement("div"); r.className = "recrow " + cls;
        r.innerHTML = '<span class="ri"></span><span class="rl"><span class="rlab"></span><span class="rwho"></span></span><b class="rv"></b>';
        r.querySelector(".ri").textContent = ic; r.querySelector(".rlab").textContent = l; r.querySelector(".rwho").textContent = who; r.querySelector(".rv").textContent = v;
        t.appendChild(r);
      });
      if (!rows.length) { const e = document.createElement("div"); e.className = "recnone"; e.textContent = "Brak punktów w wynikach tej gry."; t.appendChild(e); }
      card.appendChild(t); body.appendChild(card);
    });
  }
  $("openRec").onclick = () => { $("recSearch").value = ""; openOv("recOv"); renderRecords(); };
  $("recSearch").oninput = () => renderRecords();
  $("openH2h").onclick = () => openOv("h2hOv");
  $("h2hA").onchange = e => { h2h.a = e.target.value; if (h2h.b === h2h.a) h2h.b = ""; renderResults(); };
  $("h2hB").onchange = e => { h2h.b = e.target.value; renderResults(); };
  // Usunięcie wyniku: gra (wersje z tego wyniku) wraca do losowania u graczy z kontem, którzy w nim byli –
  // chyba że ta sama wersja jest jeszcze w innym wyniku z ich udziałem.
  function unmarkPlay(b, pl, keepFn){
    const g = groupById(pl.groupId); if (!g) return;
    const f = findGame(pl.gameId, pl.groupId);
    const game = f ? f.game : {id: pl.gameId, name: pl.gameName, exps: pl.exps || []};
    const vs = (pl.exps && pl.exps.length) ? pl.exps.map(e => findExp(game, e.id) || e) : [null];
    const others = (playsBy[pl.groupId] || []).filter(x => x.id !== pl.id && x.gameId === pl.gameId);
    const uids = [...new Set((pl.scores || []).filter(x => x.uid).map(x => x.uid))].filter(u => (g.memberIds || []).includes(u));
    uids.forEach(u => {
      const keep = new Set();
      others.filter(x => (x.scores || []).some(sc => sc.uid === u))
        .forEach(x => ((x.exps && x.exps.length) ? x.exps.map(e => e.id) : [null]).forEach(id => keep.add(id)));
      const drop = vs.filter(e => !keep.has(e ? e.id : null) && !(keepFn && keepFn(u, e ? e.id : null)));
      if (!drop.length) return;
      const played = {}; drop.forEach(e => played[vkey(game, e)] = FV.delete());
      stateSet(b, pl.groupId, u, {played, history: FV.arrayRemove(...drop.map(e => histEntry(game, pl.at, e)))});
    });
  }

  // ================= CHANGE LOG =================
  let logGroup = "all";
  const LOG_STEP = 20;   // Aktualności: 20 wpisów, przycisk „Starsze” doczytuje kolejne 20
  let logLimit = LOG_STEP, newsPrevSeen = Infinity;
  $("logMore").onclick = () => { logLimit += LOG_STEP; renderLog(); };
  // wpis o wyniku wygląda jak w zakładce Wyniki: gra, potem gracze w osobnych liniach
  function renderLogResult(lt, e, acc){
    if (e.type !== "result") return false;
    const m = String(e.text).match(/^(Dodanie|Zmiana|Usunięcie) wyniku: „(.+?)”\s*(?:–\s*(.*)|z (.*))?$/);
    if (!m) return false;
    const head = document.createElement("div"); head.className = "lrh";
    head.innerHTML = '<span class="lra"></span><b></b>';
    head.querySelector(".lra").textContent = m[1] === "Dodanie" ? "Nowy wynik" : (m[1] === "Zmiana" ? "Zmiana wyniku" : "Usunięcie wyniku");
    head.querySelector("b").textContent = m[2];
    lt.appendChild(head);
    if (m[1] === "Usunięcie") { const d = document.createElement("div"); d.className = "lrd"; d.textContent = "partia z " + (m[4] || ""); lt.appendChild(d); return true; }
    const box = document.createElement("div"); box.className = "res lres"; const rs = document.createElement("div"); rs.className = "rs"; box.appendChild(rs);
    // gracze z treści wpisu – pokazują stan wyniku z chwili tego wpisu
    let rest = m[3] || "", coop = "";
    const cm = rest.match(/\s*\((kooperacja – (?:wygrana|przegrana))\)$/); if (cm) { coop = cm[1]; rest = rest.slice(0, cm.index); }
    const scores = rest.split(", ").filter(Boolean).map(t => {
      const win = t.startsWith("🏆 "); t = t.replace(/^🏆 /, "");
      const pm = t.match(/^(.*?)\s+(-?\d+(?:[.,]\d+)?)$/);
      return pm ? {p: pm[1], pts: parseFloat(pm[2].replace(",", ".")), win} : {p: t, win};
    });
    fillPlayers(rs, {scores, mode: coop ? "coop" : (scores.every(x => x.pts !== undefined) && scores.some(x => x.win) && scores.find(x => x.win).pts < Math.max(...scores.map(x => x.pts)) ? "min" : "max"), coopWin: coop.endsWith("wygrana"), winners: scores.filter(x => x.win).map(x => x.p)}, acc);
    lt.appendChild(box);
    return true;
  }
  function renderLog(){
    if (!me) return;
    const fEl = $("logFilter"); fEl.innerHTML = ""; fEl.hidden = groups.length < 2;
    if (logGroup !== "all" && !groupById(logGroup)) logGroup = "all";
    [{id:"all", name:"Wszystko"}].concat(groups.map(g => ({id:g.id, name:g.name}))).forEach(o => {
      const b = document.createElement("button");
      b.className = "chip" + (logGroup === o.id ? " on" : ""); b.textContent = o.name;
      b.onclick = () => { logGroup = o.id; logLimit = LOG_STEP; renderLog(); };
      fEl.appendChild(b);
    });
    let items = Object.values(logsBy).flat();
    if (logGroup === "all") {
      const known = new Set([me.uid, ...accounts().keys()]);
      Object.entries(regs).forEach(([u, r]) => { if (known.has(u)) items.push({at: r.at, by: u, name: r.name, text: "Rejestracja konta w aplikacji", type: "register"}); });
    } else items = items.filter(e => e.groupId === logGroup);
    items.sort((a,b) => b.at - a.at);
    updateNewsDot();
    const ul = $("logList"); ul.innerHTML = "";
    if (!items.length) ul.innerHTML = '<li class="empty" style="justify-content:center">Brak wpisów.</li>';
    const acc = accounts();
    const isNewE = e => e.by !== me.uid && e.at > newsPrevSeen;   // nowe od ostatniej wizyty
    // nowe wpisy (od innych, od ostatniej wizyty) na górze, pod nimi reszta
    items = items.filter(isNewE).concat(items.filter(e => !isNewE(e)));
    const nNew = items.slice(0, logLimit).filter(isNewE).length;
    let sepOld = false;
    if (nNew) { const h = document.createElement("li"); h.className = "lsep lsep-new"; h.textContent = "🔔 Nowe (" + nNew + ")"; ul.appendChild(h); }
    items.slice(0, logLimit).forEach(e => {
      const isNew = isNewE(e);
      if (nNew && !isNew && !sepOld) { sepOld = true; const h = document.createElement("li"); h.className = "lsep"; h.textContent = "Wcześniej"; ul.appendChild(h); }
      const li = document.createElement("li");
      if (isNew) li.className = "new";
      li.innerHTML = '<div class="lh"><b></b><span></span></div><div class="lt"></div>';
      li.querySelector("b").innerHTML = isNew ? '<span class="lnew" title="Nowy wpis">🔔</span>' : "";
      li.querySelector("b").appendChild(document.createTextNode((e.by && regs[e.by] && regs[e.by].name) || e.name || "?"));
      const g = e.groupId && groupById(e.groupId);
      li.querySelector(".lh > span").textContent = fmtDT(e.at) + (g && groups.length > 1 && logGroup === "all" ? " · " + g.name : "");
      const lt = li.querySelector(".lt");
      if (!renderLogResult(lt, e, acc)) lt.textContent = e.text;
      ul.appendChild(li);
    });
    const more = $("logMore");
    more.hidden = items.length <= logLimit;
    more.textContent = "Starsze (" + (items.length - logLimit) + ")";
  }

  // ---------- Aktualności: dzwonek świeci na czerwono, gdy jest nowy wpis od kogoś innego ----------
  const newsKey = () => "pl-news-seen-" + (me ? me.uid : "");
  function newestNews(){
    let t = 0;
    Object.values(logsBy).flat().forEach(e => { if (e.by !== me.uid && e.at > t) t = e.at; });
    const known = new Set([...accounts().keys()]);
    Object.entries(regs).forEach(([u, r]) => { if (u !== me.uid && known.has(u) && r.at > t) t = r.at; });
    return t;
  }
  function updateNewsDot(){
    if (!me) return;
    let seen = lsGet(newsKey(), 0);
    if (!seen) { seen = Date.now(); lsSet(newsKey(), seen); }   // pierwsze uruchomienie: stare wpisy nie świecą
    if (curView === "news") { markNewsSeen(); return; }
    const unread = newestNews() > seen;
    $("newsDot").hidden = !unread;
    document.querySelector('#tabbar .tb[data-view="news"]').classList.toggle("unread", unread);
  }
  function markNewsSeen(){
    if (!me) return;
    lsSet(newsKey(), Math.max(Date.now(), newestNews()));
    $("newsDot").hidden = true;
    document.querySelector('#tabbar .tb[data-view="news"]').classList.remove("unread");
  }

  // ================= KOPIA ZAPASOWA / IMPORT =================
  function bkMsg(t, err){ const m = $("bkMsg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); }
  $("bkCopy").onclick = async () => {
    const data = { v: 2, exportedAt: Date.now(),
      groups: groups.filter(canEdit).map(g => ({ id: g.id, name: g.name,
        games: (g.games || []).map(x => ({id: x.id, name: x.name, played: isVPlayed(g, x, null), playedAt: myPlayed(g)[x.id] || null, off: !!x.off,
          expansions: exps(x).map(e => ({id: e.id, name: e.name, played: isVPlayed(g, x, e), playedAt: myPlayed(g)[vkey(x, e)] || null, off: !!e.off}))})),
        history: myHistory(g), players: g.players || [],
        log: (logsBy[g.id] || []).map(e => ({at: e.at, name: e.name, type: e.type, text: e.text, scope: e.scope || "group"})) })),
      plays: allPlays().map(p => Object.assign({}, p)),
      registrations: Object.entries(regs).map(([u, r]) => ({uid: u, name: r.name, at: r.at})) };
    const text = "PLANSZOWKI-KOPIA " + new Date().toLocaleDateString("pl-PL") + "\n" + JSON.stringify(data);
    $("bkText").value = text;
    if (Android && Android.copy) { Android.copy(text); bkMsg("Skopiowano do schowka. Wklej to w bezpieczne miejsce."); return; }
    try { await navigator.clipboard.writeText(text); bkMsg("Skopiowano do schowka. Wklej to w bezpieczne miejsce."); }
    catch(e){ $("bkText").select(); bkMsg("Zaznaczyłem tekst – skopiuj go ręcznie."); }
  };
  let importArmed = false;
  $("bkImport").onclick = async () => {
    const raw = $("bkText").value.trim();
    if (!raw) { bkMsg("Najpierw wklej tekst kopii w pole powyżej.", true); return; }
    let data;
    try { data = JSON.parse(raw.slice(raw.indexOf("{"))); } catch(e){ bkMsg("To nie wygląda na kopię z tej aplikacji.", true); return; }
    if (!data || !Array.isArray(data.groups) || !data.groups.length) { bkMsg("To nie wygląda na kopię z tej aplikacji.", true); return; }
    const nGames = data.groups.reduce((a, g) => a + ((g.games || []).length), 0);
    const nPlays = Array.isArray(data.plays) ? data.plays.length : 0;
    const btn = $("bkImport");
    if (!importArmed) {
      confirmDialog({title: "Zaimportować kopię?", text: "Powstanie " + plural(data.groups.length, "nowa grupa", "nowe grupy", "nowych grup") + " (" + plural(nGames, "gra", "gry", "gier") + ", " + plural(nPlays, "wynik", "wyniki", "wyników") + "). Istniejące grupy zostaną bez zmian.", icon: "⛁", yes: "Importuj",
        onYes: () => { importArmed = true; btn.click(); }});
      return;
    }
    importArmed = false; btn.disabled = true;
    bkMsg("Importuję…");
    try {
      const idMap = {};
      for (const og of data.groups.slice(0, MAX_GROUPS)) {
        const cleanId = v => String(v || "").replace(/[^A-Za-z0-9]/g, "") || uid();
        const played = {};
        const games = (og.games || []).filter(x => x && x.name).map(x => {
          const gm = {id: cleanId(x.id), name: String(x.name).slice(0, 80)};
          if (x.played) played[gm.id] = Number(x.playedAt) || Date.now();
          if (x.off) gm.off = true;
          const ex = (Array.isArray(x.expansions) ? x.expansions : []).filter(e => e && e.name).map(e => {
            const en = {id: cleanId(e.id), name: String(e.name).slice(0, 60)};
            if (e.played) played[gm.id + "__" + en.id] = Number(e.playedAt) || Date.now();
            if (e.off) en.off = true;
            return en;
          });
          if (ex.length) gm.exps = ex;
          return gm;
        });
        const gname = String(og.name || "Grupa").slice(0, 40);
        const histSrc = Array.isArray(og.history) ? og.history : (Array.isArray(data.history) ? data.history.filter(h => h.group === og.name) : []);
        const history = histSrc.filter(h => h && h.id && h.name).map(h => ({id: String(h.id), name: String(h.name), at: Number(h.at) || Date.now()})).slice(0, 50);
        const players = (Array.isArray(og.players) ? og.players : (Array.isArray(data.players) ? data.players : [])).map(p => String(p).slice(0, 30));
        const gid = await createGroup(gname, {games, players});
        if (!gid) throw new Error("create");
        // rozegrane i historia z kopii trafiają do Twojego prywatnego stanu
        if (Object.keys(played).length || history.length) {
          try { await scol(gid).doc(me.uid).set({played, history, updatedAt: Date.now()}, {merge: true}); } catch(e){}
        }
        idMap[og.id || gname] = gid;
        const oldLog = logOk ? (Array.isArray(og.log) ? og.log : []).filter(e => e && e.text).slice(0, 800) : [];
        try { for (let i = 0; i < oldLog.length; i += 400) {
          const b = db.batch();
          oldLog.slice(i, i + 400).forEach(e => {
            const priv = e.scope === "private" || ["result", "play", "mark", "cycle"].includes(e.type);
            const doc = {at: Number(e.at) || Date.now(), by: me.uid, name: String(e.name || "?").slice(0, 40), type: String(e.type || "edit").slice(0, 20),
                         text: String(e.text).slice(0, 300), scope: priv ? "private" : "group"};
            if (priv) doc.viewers = [me.uid];
            b.set(lcol(gid).doc(), doc);
          });
          await b.commit();
        } } catch(e){ logOk = false; }
        logTo(gid, "import", "Import kopii zapasowej (" + plural(games.length, "gra", "gry", "gier") + ")");
      }
      const plays = (Array.isArray(data.plays) ? data.plays : []).filter(p => p && p.gameName && idMap[p.groupId]);
      for (let i = 0; i < plays.length; i += 400) {
        const b = db.batch();
        plays.slice(i, i + 400).forEach(p => {
          const doc = { gameId: String(p.gameId || ""), gameName: String(p.gameName), exps: (Array.isArray(p.exps) ? p.exps : []).map(e => ({id: String(e.id), name: String(e.name)})), at: Number(p.at) || Date.now(), mode: ["max","min","coop"].includes(p.mode) ? p.mode : "max",
                        scores: (p.scores || []).map(s => { const o = {p: String(s.p)}; if (s.pts !== undefined) o.pts = Number(s.pts); if (s.uid) o.uid = String(s.uid); if (s.win !== undefined) o.win = !!s.win; return o; }),
                        winners: (p.winners || []).map(String), createdBy: me.uid, createdByName: me.name };
          doc.viewers = [...new Set(doc.scores.filter(x => x.uid).map(x => x.uid).concat(me.uid))];
          if (p.mode === "coop") doc.coopWin = p.coopWin !== false;
          b.set(pcol(idMap[p.groupId]).doc(), doc);
        });
        await b.commit();
      }
      $("bkText").value = "";
      bkMsg("Zaimportowano: " + plural(data.groups.length, "grupa", "grupy", "grup") + ", " + plural(nGames, "gra", "gry", "gier") + ", " + plural(plays.length, "wynik", "wyniki", "wyników") + ".");
    } catch(e){ bkMsg("Import przerwany: " + errMsg(e), true); }
    finally { btn.disabled = false; }
  };

  // ================= AKTUALIZACJE =================
  // Numer kompilacji (rośnie z każdym wydaniem) służy do wykrywania aktualizacji,
  // a nazwa wersji (np. 1.0) jest tym, co widzi użytkownik.
  function currentBuild(){
    if (Android && Android.versionCode) try { return Number(Android.versionCode()) || 0; } catch(e){}
    const m = String(CFG.build || "").match(/\d+/); return m ? Number(m[0]) : 0;
  }
  function currentVersionName(){
    if (Android && Android.versionName) try { return String(Android.versionName()); } catch(e){}
    return CFG.version && !String(CFG.version).startsWith("__") ? String(CFG.version) : "dev";
  }
  // numer kompilacji z nazwy wydania: "v1.0-build14" -> 14 (starsze wydania "v13" -> 13)
  function tagBuild(tag){
    const m = String(tag || "").match(/build(\d+)/i) || String(tag || "").match(/^v(\d+)$/i);
    return m ? Number(m[1]) : 0;
  }
  $("ver").textContent = "wersja " + currentVersionName();
  $("verAuth").textContent = "wersja " + currentVersionName();
  async function checkUpdate(){
    if (!CFG.repo || CFG.repo.startsWith("__")) return;
    try {
      const r = await fetch("https://api.github.com/repos/" + CFG.repo + "/releases/latest", {headers: {"Accept": "application/vnd.github+json"}});
      if (!r.ok) return;
      const rel = await r.json();
      const latest = tagBuild(rel.tag_name);
      if (!latest || latest <= currentBuild()) return;
      const asset = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
      const url = asset ? asset.browser_download_url : ("https://github.com/" + CFG.repo + "/releases/latest");
      $("updText").textContent = "Dostępna nowa wersja " + String(rel.name || "").replace(/^Wersja\s*/i, "");
      $("updBanner").hidden = false;
      const verName = String(rel.name || "").replace(/^Wersja\s*/i, "");
      $("updBtn").onclick = () => {
        // nowa wersja aplikacji: pobieranie i instalacja w oknie aplikacji
        if (asset && Android && Android.downloadUpdate) { startUpdate(url, verName); return; }
        if (Android && Android.openUrl) Android.openUrl(url); else window.open(url, "_blank");
        toast("Pobieranie… po zakończeniu otwórz plik i potwierdź instalację");
      };
    } catch(e){}
  }

  // ---------- okno aktualizacji ----------
  let updBusy = false, updArgs = null;
  function updState(o){
    if (o.pct !== undefined) { $("updFill").classList.remove("indet"); $("updFill").style.width = o.pct + "%"; }
    if (o.indet) { $("updFill").classList.add("indet"); $("updFill").style.width = "100%"; }
    if (o.text !== undefined) $("updSt").textContent = o.text;
    if (o.icon) $("updIcon").textContent = o.icon;
    $("updIcon").classList.toggle("spin", !!o.spin);
    $("updRetry").hidden = !o.retry;
    $("updClose").hidden = !!o.lock;
  }
  function startUpdate(url, verName){
    updArgs = [url, verName];
    $("updVer").textContent = "Wersja " + verName;
    updState({pct: 0, text: "Pobieranie… 0%", icon: "⟳", spin: true, lock: false});
    openOv("updOv");
    if (updBusy) return;
    updBusy = true;
    if (Android.askNotifications) try { Android.askNotifications(); } catch(e){}
    Android.downloadUpdate(url);
  }
  $("updRetry").onclick = () => { updBusy = false; if (updArgs) startUpdate(updArgs[0], updArgs[1]); };
  // postęp z Androida: 0–99 pobieranie, 100 instalacja, liczby ujemne – stany szczególne
  window.updProgress = p => {
    if (p >= 0 && p < 100) updState({pct: p, text: "Pobieranie… " + p + "%", spin: true});
    else if (p === 100) updState({indet: true, text: "Instalowanie… Po instalacji dotknij powiadomienia „Planszomat zaktualizowany”, aby otworzyć aplikację.", icon: "⟳", spin: true, lock: true});
    else if (p === -2) updState({text: "Zezwól Planszomatowi na instalowanie aplikacji i wróć – instalacja ruszy sama.", icon: "🔒"});
    else if (p === -3) updState({indet: true, text: "Potwierdź instalację w oknie systemowym.", icon: "⟳", spin: true});
    else if (p === -5) { updBusy = false; updState({pct: 100, text: "Zainstalowano. Uruchom aplikację ponownie.", icon: "✓"}); }
    else if (p === -6) { updBusy = false; updState({pct: 0, text: "Instalacja anulowana.", icon: "✕", retry: true}); }
    else { updBusy = false; updState({pct: 0, text: p === -4 ? "Instalacja się nie powiodła." : "Nie udało się pobrać aktualizacji. Sprawdź internet.", icon: "!", retry: true}); }
  };
  // po aktualizacji: okno „Aplikacja zaktualizowana” przez 6 sekund
  function showUpdated(){
    const b = currentBuild(); if (!b) return;
    let prev = lsGet("pl-build", 0);
    // starsze wersje nie zapisywały numeru kompilacji – jeśli aplikacja była już używana, to jest aktualizacja
    if (!prev && localStorage.getItem("pl-theme") !== null) prev = 1;
    lsSet("pl-build", b);
    if (!prev || prev >= b) return;
    const v = currentVersionName();
    $("updDoneVer").textContent = v ? "Wersja " + v : "";
    const news = $("updNews"); news.innerHTML = "";
    const c = (window.CHANGELOG || [])[0];
    if (c && c.version === v) (c.items || []).slice(0, 4).forEach(([k, t]) => { const li = document.createElement("li"); li.textContent = t; news.appendChild(li); });
    news.hidden = !news.children.length;
    openOv("updDone");
    const tm = $("updTimer"); tm.style.animation = "none"; void tm.offsetWidth; tm.style.animation = "";
    setTimeout(() => closeOv("updDone"), 6000);
  }
  setTimeout(showUpdated, 600);

  // ================= MOTYWY I TŁO =================
  const THEMES = [
    {id:"matrix", name:"Matrix", desc:"Zielony terminal i deszcz znaków.", bg:"#020503", fg:"#00ff66", font:"Chakra Petch", light:false},
    {id:"wizard", name:"Szkoła Magii", desc:"Pergamin, złoto i bordo, unoszące się iskry.", bg:"#24160f", fg:"#e8b84f", font:"Cinzel", light:false},
    {id:"goose", name:"Gęś Wyścigowa", desc:"Jasny, wesoły motyw z wyścigową szachownicą i piórkami.", bg:"#fbf5e8", fg:"#b94e05", font:"Nunito", light:true},
    {id:"galaxy", name:"Galaktyka", desc:"Czarny kosmos, gwiazdy i żółte napisy.", bg:"#000004", fg:"#ffd84a", font:"Exo 2", light:false},
    {id:"neon", name:"Neon", desc:"Niebieski neon z różowymi akcentami.", bg:"#030616", fg:"#18e3ff", font:"Audiowide", light:false}
  ];
  let theme = lsGet("pl-theme", "matrix");
  if (!THEMES.some(t => t.id === theme)) theme = "matrix";
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let fxOn = lsGet("pl-fx", !reduceMotion);
  function applyTheme(id){
    theme = id; lsSet("pl-theme", id);
    const t = THEMES.find(x => x.id === id);
    if (id === "matrix") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = id;
    $("themeName").textContent = t.name;
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = t.bg;
    if (Android && Android.setBars) try { Android.setBars(t.bg, t.light); } catch(e){}
    fx.reset();
  }
  function renderThemes(){
    const box = $("themeList"); box.innerHTML = "";
    THEMES.forEach(t => {
      const b = document.createElement("button");
      b.className = "theme-opt" + (theme === t.id ? " on" : "");
      b.innerHTML = '<span class="sw"></span><span><span class="tn"></span><span class="td"></span></span>';
      const sw = b.querySelector(".sw"); sw.style.background = t.bg; sw.style.color = t.fg; sw.style.fontFamily = '"' + t.font + '"'; sw.textContent = "Aa";
      b.querySelector(".tn").textContent = t.name + (theme === t.id ? "  ✓" : "");
      b.querySelector(".td").textContent = t.desc;
      b.onclick = () => { applyTheme(t.id); renderThemes(); savePrefs(); };
      box.appendChild(b);
    });
    $("fxToggle").classList.toggle("on", fxOn);
    $("fxToggle").setAttribute("aria-checked", fxOn ? "true" : "false");
  }
  $("openTheme").onclick = () => { renderThemes(); openOv("th"); };
  $("fxToggle").onclick = () => { fxOn = !fxOn; lsSet("pl-fx", fxOn); fx.reset(); renderThemes(); savePrefs(); };
  // Motyw i animacje zapisane na koncie – po zalogowaniu na innym urządzeniu włączą się te same.
  let prefsUnsub = null;
  function savePrefs(){
    if (!me) return;
    db.collection("prefs").doc(me.uid).set({theme, fx: fxOn, updatedAt: Date.now()}).catch(() => {});
  }
  function subPrefs(user){
    if (prefsUnsub) prefsUnsub();
    prefsUnsub = db.collection("prefs").doc(user.uid).onSnapshot(d => {
      if (!d.exists) { if (!d.metadata.fromCache) savePrefs(); return; }   // pierwsze logowanie: zapisz obecny wybór
      const p = d.data();
      let ch = false;
      if (p.theme && p.theme !== theme && THEMES.some(t => t.id === p.theme)) { applyTheme(p.theme); ch = true; }
      if (typeof p.fx === "boolean" && p.fx !== fxOn) { fxOn = p.fx; lsSet("pl-fx", fxOn); fx.reset(); ch = true; }
      if (ch && !$("th").hidden) renderThemes();
    }, () => {});
  }

  // Animowane tło – osobny efekt dla każdego motywu, delikatny, pod kartami.
  const fx = (function(){
    const c = $("rain"); const ctx = c.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, parts = [], drops = [], last = 0;
    const KANA = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ0123456789";
    const rnd = (a, b) => a + Math.random() * (b - a);
    function size(){ W = innerWidth; H = innerHeight; c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
    function init(){
      size(); ctx.clearRect(0, 0, W, H); parts = [];
      const fs = 16, cols = Math.ceil(W / fs);
      drops = Array.from({length: cols}, () => rnd(-H / fs, 0));
      if (theme === "wizard") for (let i = 0; i < 45; i++) parts.push({x: rnd(0, W), y: rnd(0, H), r: rnd(.8, 2.4), v: rnd(.15, .5), p: rnd(0, 6.28)});
      if (theme === "goose") for (let i = 0; i < 14; i++) parts.push({x: rnd(0, W), y: rnd(-H, H), s: rnd(10, 20), v: rnd(.3, .7), a: rnd(0, 6.28), w: rnd(.005, .015)});
      if (theme === "galaxy") for (let i = 0; i < 160; i++) parts.push({x: rnd(-1, 1), y: rnd(-1, 1), z: rnd(.05, 1)});
    }
    function frame(){
      if (theme === "matrix" || theme === "neon") {
        const fs = 16;
        ctx.fillStyle = theme === "neon" ? "rgba(3,6,22,0.12)" : "rgba(2,5,3,0.09)"; ctx.fillRect(0, 0, W, H);
        ctx.font = fs + "px monospace";
        for (let i = 0; i < drops.length; i++) {
          if (theme === "neon" && i % 2) continue;   // neon: rzadszy deszcz
          const y = drops[i] * fs;
          ctx.fillStyle = theme === "neon" ? (Math.random() < .12 ? "#ff5fd9" : "#18b8ff") : (Math.random() < .04 ? "#d6ffe3" : "#00c853");
          ctx.fillText(KANA[Math.floor(Math.random() * KANA.length)], i * fs, y);
          if (y > H && Math.random() > .975) drops[i] = 0;
          drops[i] += 1;
        }
      } else if (theme === "wizard") {
        ctx.clearRect(0, 0, W, H);
        parts.forEach(p => {
          p.y -= p.v; p.p += .04; p.x += Math.sin(p.p) * .25;
          if (p.y < -5) { p.y = H + 5; p.x = rnd(0, W); }
          const a = .35 + .35 * Math.sin(p.p * 1.7);
          ctx.beginPath(); ctx.fillStyle = "rgba(240,200,110," + a.toFixed(2) + ")";
          ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill();
        });
      } else if (theme === "goose") {
        ctx.clearRect(0, 0, W, H);
        parts.forEach(p => {
          p.y += p.v; p.a += p.w; p.x += Math.sin(p.a) * .6;
          if (p.y > H + 30) { p.y = -30; p.x = rnd(0, W); }
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.sin(p.a) * .8);
          ctx.fillStyle = "rgba(190,170,140,.35)"; ctx.strokeStyle = "rgba(150,130,100,.45)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, -p.s); ctx.quadraticCurveTo(p.s * .45, 0, 0, p.s); ctx.quadraticCurveTo(-p.s * .45, 0, 0, -p.s); ctx.fill();
          ctx.beginPath(); ctx.moveTo(0, -p.s); ctx.lineTo(0, p.s * 1.15); ctx.stroke();
          ctx.restore();
        });
      } else if (theme === "galaxy") {
        ctx.clearRect(0, 0, W, H);
        const cx = W / 2, cy = H / 2;
        parts.forEach(p => {
          p.z -= .0025; if (p.z <= .02) { p.x = rnd(-1, 1); p.y = rnd(-1, 1); p.z = 1; }
          const k = 0.5 / p.z, x = cx + p.x * cx * k, y = cy + p.y * cy * k;
          if (x < 0 || x > W || y < 0 || y > H) { p.z = 1; p.x = rnd(-1, 1); p.y = rnd(-1, 1); return; }
          const r = Math.max(.4, (1 - p.z) * 2.2);
          ctx.beginPath(); ctx.fillStyle = "rgba(235,240,255," + Math.min(1, (1 - p.z) + .2).toFixed(2) + ")";
          ctx.arc(x, y, r, 0, 6.28); ctx.fill();
        });
      }
    }
    function staticFrame(){ for (let k = 0; k < 60; k++) frame(); }

    // ---- krótkie animacje nad treścią (nie blokują dotyku): bieg gęsi do mety, magiczna kometa ----
    const top = $("fxTop"), tctx = top.getContext("2d");
    let ev = null, nextEv = performance.now() + 5000;
    function sizeTop(){ top.width = innerWidth * dpr; top.height = innerHeight * dpr; tctx.setTransform(dpr,0,0,dpr,0,0); }
    sizeTop(); addEventListener("resize", sizeTop);
    function drawGoose(x, y, t, s){
      const c = tctx, leg = Math.sin(t * 0.03) * 9 * s;
      c.save(); c.translate(x, y); c.lineCap = "round"; c.lineJoin = "round";
      // nogi
      c.strokeStyle = "#e07a1a"; c.lineWidth = 3 * s;
      c.beginPath(); c.moveTo(-4 * s, 2 * s); c.lineTo(-4 * s + leg, 18 * s); c.lineTo(-4 * s + leg + 6 * s, 18 * s); c.stroke();
      c.beginPath(); c.moveTo(4 * s, 2 * s); c.lineTo(4 * s - leg, 18 * s); c.lineTo(4 * s - leg + 6 * s, 18 * s); c.stroke();
      // ogon i tułów
      c.fillStyle = "#ffffff"; c.strokeStyle = "#3a332c"; c.lineWidth = 2 * s;
      c.beginPath(); c.moveTo(-16 * s, -6 * s); c.lineTo(-26 * s, -12 * s); c.lineTo(-20 * s, -2 * s); c.closePath(); c.fill(); c.stroke();
      c.beginPath(); c.ellipse(0, -4 * s, 18 * s, 11 * s, -0.1, 0, Math.PI * 2); c.fill(); c.stroke();
      // skrzydło machające w biegu
      c.fillStyle = "#e9e4dc"; c.beginPath();
      c.ellipse(-3 * s, -6 * s - Math.abs(Math.sin(t * 0.03)) * 4 * s, 10 * s, 5 * s, -0.4, 0, Math.PI * 2); c.fill(); c.stroke();
      // szyja i głowa (wyciągnięta do przodu – sprint!)
      c.fillStyle = "#ffffff"; c.lineWidth = 2 * s;
      c.beginPath(); c.moveTo(12 * s, -10 * s); c.quadraticCurveTo(22 * s, -16 * s, 26 * s, -26 * s); c.lineTo(31 * s, -24 * s);
      c.quadraticCurveTo(26 * s, -12 * s, 16 * s, -2 * s); c.closePath(); c.fill(); c.stroke();
      c.beginPath(); c.arc(29 * s, -27 * s, 6 * s, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = "#e07a1a"; c.beginPath(); c.moveTo(34 * s, -29 * s); c.lineTo(43 * s, -26 * s); c.lineTo(34 * s, -24 * s); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = "#2b2520"; c.beginPath(); c.arc(30 * s, -29 * s, 1.4 * s, 0, Math.PI * 2); c.fill();
      // smugi pędu
      c.strokeStyle = "rgba(43,37,32,.35)"; c.lineWidth = 2 * s;
      for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(-30 * s - i * 6 * s, -12 * s + i * 7 * s); c.lineTo(-44 * s - i * 6 * s, -12 * s + i * 7 * s); c.stroke(); }
      c.restore();
    }
    function startEvent(now){
      const W = innerWidth, H = innerHeight;
      if (theme === "goose") ev = {type: "goose", t0: now, dur: 5200, fin: W - 46, y: H - 34 - navH(), burst: null};
      else if (theme === "wizard") {
        const fromLeft = Math.random() < .5;
        ev = {type: "ball", t0: now, dur: 6000, dur0: 6000, x: fromLeft ? -20 : W + 20, y: rnd(H * .2, H * .7),
              dir: fromLeft ? 1 : -1, vx: 0, vy: 0, tx: 0, ty: 0, retarget: 0, trail: []};
      }
    }
    function eventFrame(now){
      const W = innerWidth, H = innerHeight;
      tctx.clearRect(0, 0, W, H);
      const k = (now - ev.t0) / ev.dur;
      if (ev.type === "goose") {
        const s = Math.min(1.1, W / 360);
        // meta: szachownica i taśma
        const fx = ev.fin, fy = ev.y;
        for (let r = 0; r < 7; r++) for (let q = 0; q < 2; q++) {
          tctx.fillStyle = (r + q) % 2 ? "#2b2520" : "#ffffff";
          tctx.fillRect(fx + q * 6, fy - 48 + r * 7, 6, 7);
        }
        tctx.strokeStyle = "#2b2520"; tctx.lineWidth = 1; tctx.strokeRect(fx, fy - 48, 12, 49);
        const gx = -60 + (fx + 70) * Math.min(k / 0.78, 1.15);
        const crossed = gx + 40 * s >= fx;
        if (!crossed) {
          tctx.strokeStyle = "#c0262d"; tctx.lineWidth = 3;
          tctx.beginPath(); tctx.moveTo(fx - 40, fy - 22); tctx.lineTo(fx, fy - 22); tctx.stroke();
        } else {
          if (!ev.burst) ev.burst = Array.from({length: 36}, () => ({x: fx, y: fy - 30, vx: rnd(-3, 3), vy: rnd(-5, -1.5),
            c: ["#b94e05", "#145f7a", "#c0262d", "#e8b84f", "#2b2520"][Math.floor(rnd(0, 5))], r: rnd(2, 4)}));
          tctx.strokeStyle = "#c0262d"; tctx.lineWidth = 3;   // przerwana taśma
          tctx.beginPath(); tctx.moveTo(fx - 40, fy - 22); tctx.lineTo(fx - 24, fy - 12); tctx.stroke();
          ev.burst.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += .12; tctx.fillStyle = p.c; tctx.fillRect(p.x, p.y, p.r, p.r * 1.6); });
        }
        if (gx < W + 80) drawGoose(gx, fy - 18 * s, now, s);
      } else if (ev.type === "ball") {
        // złota piłeczka: krótkie, szybkie zrywy w losowych kierunkach, ogólnie w poprzek ekranu
        if (now > ev.retarget) {
          const prog = Math.min(1, k * 1.15);
          const baseX = ev.dir > 0 ? -20 + (W + 120) * prog : W + 20 - (W + 120) * prog;
          ev.tx = baseX + rnd(-W * .25, W * .25) * (1 - prog);
          ev.ty = Math.max(40, Math.min(H - 60, ev.y + rnd(-160, 160)));
          ev.retarget = now + rnd(250, 700);
        }
        ev.vx += (ev.tx - ev.x) * .012; ev.vy += (ev.ty - ev.y) * .012;
        ev.vx *= .86; ev.vy *= .86;
        ev.x += ev.vx; ev.y += ev.vy;
        ev.trail.push({x: ev.x, y: ev.y, a: .7});
        ev.trail.forEach(p => p.a -= .045);
        ev.trail = ev.trail.filter(p => p.a > 0);
        ev.trail.forEach(p => { tctx.beginPath(); tctx.fillStyle = "rgba(240,200,110," + p.a.toFixed(2) + ")"; tctx.arc(p.x, p.y, 2.2 * p.a, 0, 6.28); tctx.fill(); });
        const x = ev.x, y = ev.y, R = 8;
        const glow = tctx.createRadialGradient(x, y, R * .6, x, y, R * 2.6);
        glow.addColorStop(0, "rgba(240,200,110,.45)"); glow.addColorStop(1, "rgba(240,200,110,0)");
        tctx.fillStyle = glow; tctx.beginPath(); tctx.arc(x, y, R * 2.6, 0, 6.28); tctx.fill();
        const ball = tctx.createRadialGradient(x - R * .35, y - R * .4, R * .1, x, y, R);
        ball.addColorStop(0, "#fff7d1"); ball.addColorStop(.35, "#f3c64f"); ball.addColorStop(.8, "#c48a16"); ball.addColorStop(1, "#8a5c08");
        tctx.fillStyle = ball; tctx.beginPath(); tctx.arc(x, y, R, 0, 6.28); tctx.fill();
        if (k >= 1 && (x < -30 || x > W + 30)) { /* poza ekranem – koniec */ }
        else if (k >= 1 && now - ev.t0 < ev.dur0 * 1.6) ev.dur += 300;   // poczekaj, aż wyleci za krawędź (maks. +60%)
      }
      if ((now - ev.t0) / ev.dur >= 1) {
        // gęś startuje co 8 s (licząc od startu poprzedniego biegu), piłeczka ok. co 10 s
        nextEv = ev.type === "goose" ? Math.max(ev.t0 + 8000, now + 300) : now + rnd(3000, 5000);
        ev = null; tctx.clearRect(0, 0, W, H);
      }
    }
    function eventsTick(now){
      const allowed = fxOn && !reduceMotion && !document.hidden && (theme === "goose" || theme === "wizard")
        && !document.querySelector(".ov:not([hidden])");
      if (!allowed) { if (ev) { ev = null; tctx.clearRect(0, 0, innerWidth, innerHeight); } return; }
      if (!ev && now >= nextEv) startEvent(now);
      if (ev) eventFrame(now);
    }
    function reset(){
      nextEv = performance.now() + 1500; ev = null;
      c.hidden = !fxOn && theme !== "galaxy";   // galaktyka bez animacji: nieruchome gwiazdy
      init();
      if (!fxOn || reduceMotion) staticFrame();
    }
    addEventListener("resize", () => { init(); if (!fxOn || reduceMotion) staticFrame(); });
    (function loop(t){
      if (fxOn && !reduceMotion && !document.hidden && t - last > (theme === "matrix" || theme === "neon" ? 60 : 33)) { frame(); last = t; }
      eventsTick(t);
      requestAnimationFrame(loop);
    })(0);
    return {reset, play: () => { nextEv = 0; }};
  })();
  applyTheme(theme);
})();

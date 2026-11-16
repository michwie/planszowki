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

  // ---------- stan ----------
  let me = null;                 // {uid, name}
  let groups = [];               // [{id, ...dane}]
  const playsBy = {};            // gid -> [play]
  const playSubs = {};           // gid -> unsubscribe
  const logsBy = {};             // gid -> [wpis dziennika]
  const logSubs = {};
  let regs = {};                 // uid -> {name, at}  (rejestracje kont)
  let regsUnsub = null;
  let groupsUnsub = null;
  let ui = { tab: 0, pool: lsGet("pl-pool", []), drawn: null, drawnGid: null, armed: null, moving: null,
             justPlayed: null, resArmed: null, rankGroup: "all" };

  const role = g => (g && g.members && me) ? (g.members[me.uid] || "") : "";
  const canEdit = g => ["owner", "editor"].includes(role(g));
  const isOwner = g => role(g) === "owner";
  const isPlayed = (g, game) => !!(g.played && g.played[game.id]);
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
  async function commitB(fill){
    const run = async withLog => { const b = db.batch(); fill(b, withLog ? (gid, t, x) => logTo(gid, t, x, b) : () => {}); await b.commit(); };
    if (logOk) {
      try { await run(true); return; }
      catch(e){ if (!String(e.code).includes("permission-denied")) throw e; logOk = false; }
    }
    await run(false);
  }
  function logEntry(type, text){ return {at: Date.now(), by: me.uid, name: me.name, type, text: String(text).slice(0, 300)}; }
  function logTo(gid, type, text, batch){
    if (!logOk) return;
    const e = logEntry(type, text);
    if (batch) batch.set(lcol(gid).doc(), e);
    else lcol(gid).doc().set(e).catch(() => {});
  }

  // ================= LOGOWANIE =================
  let authMode = "login", pendingName = "";
  function setAuthMode(m){
    authMode = m;
    document.querySelectorAll("#authTabs .tab").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
    $("aName").hidden = m !== "register";
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
    const email = $("aEmail").value.trim(), pass = $("aPass").value, name = $("aName").value.trim();
    $("aErr").textContent = "";
    if (authMode === "register" && !name) { $("aErr").textContent = "Podaj imię."; return; }
    $("aSubmit").disabled = true;
    try {
      if (authMode === "register") {
        pendingName = name;
        const cred = await auth.createUserWithEmailAndPassword(email, pass);
        lsSet("pl-name-" + cred.user.uid, name);
        await cred.user.updateProfile({displayName: name});
        if (me && me.uid === cred.user.uid) { me.name = name; $("meName").textContent = name; }
        startApp(cred.user);
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
  $("logout").onclick = () => { if (confirmTap($("logout"), "Na pewno?")) auth.signOut(); };

  // dwustopniowe potwierdzenie dla zwykłych przycisków
  function confirmTap(btn, armedText){
    if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = btn.dataset.orig; return true; }
    btn.dataset.orig = btn.textContent; btn.dataset.armed = "1"; btn.textContent = armedText;
    setTimeout(() => { if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = btn.dataset.orig; } }, 4000);
    return false;
  }

  auth.onAuthStateChanged(user => {
    if (user) startApp(user);
    else stopApp();
  });

  function stopApp(){
    me = null;
    if (groupsUnsub) { groupsUnsub(); groupsUnsub = null; }
    Object.keys(playSubs).forEach(k => { playSubs[k](); delete playSubs[k]; delete playsBy[k]; });
    Object.keys(logSubs).forEach(k => { logSubs[k](); delete logSubs[k]; delete logsBy[k]; });
    if (regsUnsub) { regsUnsub(); regsUnsub = null; } regs = {};
    groups = [];
    $("appView").hidden = true; $("authView").hidden = false;
    setAuthMode("login");
  }
  function startApp(user){
    if (me && me.uid === user.uid) return;
    me = { uid: user.uid, name: user.displayName || pendingName || lsGet("pl-name-" + user.uid, "") || (user.email || "").split("@")[0] };
    $("meName").textContent = me.name;
    $("authView").hidden = true; $("appView").hidden = false;
    setStatus("Łączenie…");
    render();
    groupsUnsub = db.collection("groups").where("memberIds", "array-contains", me.uid).onSnapshot(qs => {
      groups = qs.docs.map(d => Object.assign({id: d.id}, d.data()))
        .sort((a,b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
      const ids = new Set(groups.map(g => g.id));
      Object.keys(playSubs).forEach(k => { if (!ids.has(k)) { playSubs[k](); delete playSubs[k]; delete playsBy[k]; } });
      groups.forEach(g => { subPlays(g.id, 0); subLog(g.id, 0); });
      Object.keys(logSubs).forEach(k => { if (!ids.has(k)) { logSubs[k](); delete logSubs[k]; delete logsBy[k]; } });
      setStatus(qs.metadata.fromCache ? "Tryb offline – zmiany wyślę po połączeniu" : "Połączono ✓");
      render();
      if (!qs.metadata.fromCache) oneTimeReset();
    }, err => { setStatus("Błąd połączenia z bazą: " + errMsg(err)); });
    startRegs(user);
    checkUpdate();
  }

  // Wyniki grupy. Nowo utworzona grupa może jeszcze nie istnieć na serwerze, gdy zaczynamy
  // słuchać jej wyników – serwer wtedy odmawia, więc ponawiamy po chwili.
  function subPlays(gid, attempt){
    if (playSubs[gid]) return;
    playSubs[gid] = pcol(gid).orderBy("at", "desc").limit(500).onSnapshot(ps => {
      playsBy[gid] = ps.docs.map(d => Object.assign({}, d.data(), {id: d.id, groupId: gid}));
      renderResults();
    }, () => {
      delete playSubs[gid];
      if (attempt < 8) setTimeout(() => { if (me && groupById(gid)) subPlays(gid, attempt + 1); }, 1500 * (attempt + 1));
    });
  }

  function subLog(gid, attempt){
    if (logSubs[gid]) return;
    logSubs[gid] = lcol(gid).orderBy("at", "desc").limit(200).onSnapshot(ls => {
      logsBy[gid] = ls.docs.map(d => Object.assign({}, d.data(), {id: d.id, groupId: gid}));
      renderLog();
    }, () => {
      delete logSubs[gid];
      if (attempt < 8) setTimeout(() => { if (me && groupById(gid)) subLog(gid, attempt + 1); }, 1500 * (attempt + 1));
    });
  }
  function startRegs(user){
    regsUnsub = db.collection("registrations").onSnapshot(rs => {
      regs = {}; rs.docs.forEach(d => regs[d.id] = d.data()); renderLog();
    }, () => {});
    // wpis o rejestracji (dla kont założonych przed dodaniem dziennika – z datą założenia konta)
    const ref = db.collection("registrations").doc(user.uid);
    ref.get().then(d => {
      if (d.exists) return;
      const created = user.metadata && user.metadata.creationTime ? Date.parse(user.metadata.creationTime) : Date.now();
      return ref.set({name: me.name, at: isNaN(created) ? Date.now() : created});
    }).catch(() => {});
  }

  // ================= ZAPIS =================
  async function upd(gid, patch, logText, logType){
    try {
      Object.assign(patch, {updatedAt: Date.now()});
      await commitB((b, log) => { b.update(gref(gid), patch); if (logText) log(gid, logType || "edit", logText); });
      return true;
    } catch(e){ toast(errMsg(e)); return false; }
  }
  async function createGroup(name, extra){
    for (let attempt = 0; attempt < 5; attempt++){
      const code = newCode();
      const ref = db.collection("groups").doc();
      const data = Object.assign({
        name: name, ownerId: me.uid,
        members: {[me.uid]: "owner"}, memberIds: [me.uid], memberNames: {[me.uid]: me.name},
        inviteCode: code, games: [], played: {}, history: [], players: [],
        createdAtMs: Date.now(), updatedAt: Date.now(), resetV: 2
      }, extra || {});
      try {
        await commitB((b, log) => {
          b.set(ref, data);
          b.set(db.collection("invites").doc(code), {groupId: ref.id, createdBy: me.uid, createdAt: Date.now()});
          log(ref.id, "group", "Utworzenie grupy " + q(name));
        });
        return ref.id;
      }
      catch(e){ if (!String(e.code).includes("permission-denied")) { toast(errMsg(e)); return null; } }
    }
    toast("Nie udało się utworzyć grupy"); return null;
  }

  // ================= LOSOWANIE =================
  function inPool(g){ return !ui.pool.length || ui.pool.includes(g.id); }
  function poolGames(){
    const out = [];
    groups.forEach(g => { if (inPool(g)) (g.games || []).forEach(game => out.push({game, group: g})); });
    return out;
  }
  let spinning = false;
  function draw(excludeId){
    if (spinning) return;
    let cands = poolGames().filter(x => !isPlayed(x.group, x.game));
    if (excludeId && cands.length > 1) cands = cands.filter(x => x.game.id !== excludeId);
    if (!cands.length) return;
    const pick = cands[Math.floor(Math.random() * cands.length)];
    spinning = true; ui.drawn = null; ui.justPlayed = null; renderDraw();
    const nameEl = document.querySelector("#stage .name");
    const target = pick.game.name;
    const glyphs = "アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789#$%&*+<>";
    const total = 26; let frame = 0;
    const tick = () => {
      frame++;
      const revealed = Math.floor(target.length * Math.max(0, (frame - 8) / (total - 8)));
      let out = "";
      for (let i = 0; i < target.length; i++) { const c = target[i]; out += (i < revealed || c === " ") ? c : glyphs[Math.floor(Math.random()*glyphs.length)]; }
      nameEl.textContent = out;
      if (frame < total) setTimeout(tick, 55);
      else {
        spinning = false; ui.drawn = pick.game.id; ui.drawnGid = pick.group.id; renderDraw();
        const el = document.querySelector("#stage .name"); if (el) el.classList.add("pop");
        if (Android && Android.vibrate) try { Android.vibrate(30); } catch(e){}
      }
    };
    tick();
  }
  function historyWith(g, game, at){
    const h = (g.history || []).slice();
    if (!h.some(x => x.id === game.id && Math.abs(x.at - at) < 18*3600*1000)) h.unshift({id: game.id, name: game.name, at});
    h.sort((a,b) => b.at - a.at);
    return h.slice(0, 50);
  }
  async function markPlayed(){
    const f = ui.drawn && findGame(ui.drawn, ui.drawnGid);
    if (!f) return;
    const at = Date.now();
    ui.drawn = null; ui.justPlayed = {id: f.game.id, gid: f.group.id};
    renderDraw();
    if (await upd(f.group.id, {["played." + f.game.id]: at, history: historyWith(f.group, f.game, at)}, "Gramy w " + q(f.game.name) + " (z losowania)", "play"))
      toast("Miłej gry! „" + f.game.name + "” zapisana jako rozegrana");
  }
  async function resetPool(){
    const gs = groups.filter(g => inPool(g) && g.played && Object.keys(g.played).length);
    for (const g of gs) await upd(g.id, {played: {}}, "Nowy cykl losowania – wszystkie gry wróciły do puli", "cycle");
    ui.drawn = null; render(); toast("Nowy cykl – wszystkie gry znów w puli");
  }

  // ================= RENDER =================
  function renderPool(){
    const el = $("pool");
    if (groups.length < 2) { el.innerHTML = ""; el.hidden = true; return; }
    el.hidden = false;
    ui.pool = ui.pool.filter(id => groups.some(g => g.id === id));
    if (ui.pool.length === groups.length) ui.pool = [];
    el.innerHTML = "";
    const all = document.createElement("button");
    all.className = "chip" + (!ui.pool.length ? " on" : ""); all.textContent = "Wszystkie grupy";
    all.onclick = () => { if (spinning) return; ui.pool = []; ui.drawn = null; lsSet("pl-pool", ui.pool); render(); };
    el.appendChild(all);
    groups.forEach(g => {
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
    const pool = poolGames();
    const left = pool.filter(x => !isPlayed(x.group, x.game)).length;
    const stage = $("stage");
    const drawn = ui.drawn && findGame(ui.drawn, ui.drawnGid);
    const jp = ui.justPlayed && findGame(ui.justPlayed.id, ui.justPlayed.gid);
    if (spinning) stage.innerHTML = '<div class="name spin"></div>';
    else if (drawn) {
      stage.innerHTML = '<div class="name"></div><div class="grp"></div>';
      stage.querySelector(".name").textContent = drawn.game.name;
      stage.querySelector(".grp").textContent = drawn.group.name;
    } else if (jp) {
      stage.innerHTML = '<div class="hint">Gracie w:</div><div class="name" style="font-size:20px;margin-top:4px"></div><button class="stagebtn">Wpisz wynik po grze</button>';
      stage.querySelector(".name").textContent = jp.game.name;
      stage.querySelector(".stagebtn").onclick = () => openResult(jp.game.id, jp.group.id);
    } else if (!groups.length) stage.innerHTML = '<div class="hint">Utwórz grupę albo dołącz do grupy znajomych.</div>';
    else if (!pool.length) stage.innerHTML = '<div class="hint">Dodaj gry poniżej, a potem losuj.</div>';
    else if (!left) stage.innerHTML = '<div class="hint">Cała pula rozegrana. Misja zakończona.</div>';
    else stage.innerHTML = '<div class="hint">oczekuję na polecenie…</div>';
    const btn = $("drawBtn");
    if (!left && pool.length) { btn.textContent = "Zacznij nowy cykl"; btn.disabled = false; btn.onclick = resetPool; }
    else { btn.textContent = "Losuj grę"; btn.disabled = !left || spinning; btn.onclick = () => draw(); }
    btn.hidden = !!drawn && !spinning;
    $("afterDraw").hidden = !(drawn && !spinning);
    $("count").textContent = pool.length ? ("Do rozegrania: " + left + " z " + pool.length) : "";
  }

  function renderGroup(){
    const tabs = $("tabs"); tabs.innerHTML = "";
    if (ui.tab >= groups.length) ui.tab = Math.max(0, groups.length - 1);
    groups.forEach((g, i) => {
      const b = document.createElement("button");
      b.className = "tab" + (ui.tab === i ? " on" : "");
      b.textContent = g.name + " (" + (g.games || []).length + ")";
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
    if (!groups.length) return;
    const g = groups[ui.tab];
    const edit = canEdit(g);
    const gn = $("groupName");
    if (document.activeElement !== gn) gn.value = g.name;
    gn.readOnly = !edit;
    $("addForm").hidden = !edit;
    const rn = $("roleNote");
    rn.hidden = edit;
    if (!edit) rn.textContent = "Jesteś graczem w tej grupie – możesz losować, oznaczać rozegrane gry i wpisywać wyniki. Listę gier zmienia właściciel lub edytor.";

    const list = $("list"); list.innerHTML = "";
    const games = (g.games || []).slice().sort((a,b) => cmp(a.name, b.name));
    if (!games.length) list.innerHTML = '<li class="empty">Brak gier w tej grupie.</li>';
    const moveTargets = groups.filter(x => x !== g && canEdit(x));
    games.forEach(game => {
      const played = isPlayed(g, game);
      const li = document.createElement("li");
      li.className = "game" + (played ? " played" : "");
      li.innerHTML = '<button class="ib check" title="Rozegrana / nierozegrana">' + (played ? "✓" : "") + '</button>' +
        '<div class="gname"><b></b><small></small></div>' +
        (edit && moveTargets.length ? '<button class="ib move" title="Przenieś do innej grupy">⇄</button>' : '') +
        (edit ? '<button class="ib del" title="Usuń">🗑</button>' : '');
      li.querySelector("b").textContent = game.name;
      li.querySelector("small").textContent = played ? ("Rozegrana " + fmt(g.played[game.id])) : "Do zagrania";
      li.querySelector(".check").onclick = () => {
        if (ui.drawn === game.id) ui.drawn = null;
        upd(g.id, {["played." + game.id]: played ? FV.delete() : Date.now()},
            (played ? "Oznaczenie jako nierozegrana: " : "Oznaczenie jako rozegrana: ") + q(game.name), "mark");
      };
      const mv = li.querySelector(".move");
      if (mv) mv.onclick = () => {
        if (moveTargets.length === 1) { moveGame(g, game, moveTargets[0]); return; }
        ui.moving = ui.moving === game.id ? null : game.id; renderGroup();
      };
      if (ui.moving === game.id) {
        const box = document.createElement("div"); box.className = "movebox";
        box.innerHTML = "<span>Przenieś do:</span>";
        moveTargets.forEach(o => { const c = document.createElement("button"); c.className = "chip"; c.textContent = o.name; c.onclick = () => moveGame(g, game, o); box.appendChild(c); });
        li.appendChild(box);
      }
      const del = li.querySelector(".del");
      if (del) {
        if (ui.armed === game.id) { del.classList.add("armed"); del.textContent = "Usuń?"; }
        del.onclick = () => {
          if (ui.armed !== game.id) { ui.armed = game.id; renderGroup(); return; }
          ui.armed = null; if (ui.drawn === game.id) ui.drawn = null;
          upd(g.id, {games: FV.arrayRemove(game), ["played." + game.id]: FV.delete()}, "Usunięcie gry " + q(game.name), "game-del");
        };
      }
      list.appendChild(li);
    });
    const playedN = games.filter(x => isPlayed(g, x)).length;
    const tools = $("tools"); tools.innerHTML = "";
    if (games.length) {
      const s = document.createElement("span"); s.textContent = "Rozegrane: " + playedN + " / " + games.length; tools.appendChild(s);
      if (playedN) {
        const r = document.createElement("button"); r.className = "link"; r.textContent = "Wyzeruj tę grupę";
        r.onclick = () => { upd(g.id, {played: {}}, "Wyzerowanie grupy – wszystkie gry wróciły do puli", "cycle"); toast("Wyzerowano: " + g.name); };
        tools.appendChild(r);
      }
    }
  }
  async function moveGame(from, game, to){
    ui.moving = null;
    const ts = from.played && from.played[game.id];
    const p = {games: FV.arrayUnion(game), updatedAt: Date.now()};
    if (ts) p["played." + game.id] = ts;
    try { await commitB((b, log) => {
      b.update(gref(from.id), {games: FV.arrayRemove(game), ["played." + game.id]: FV.delete(), updatedAt: Date.now()});
      b.update(gref(to.id), p);
      log(from.id, "game-move", "Przeniesienie gry " + q(game.name) + " do grupy " + q(to.name));
      log(to.id, "game-move", "Przeniesienie gry " + q(game.name) + " z grupy " + q(from.name));
    }); toast("Przeniesiono do: " + to.name); } catch(e){ toast(errMsg(e)); }
  }
  function renderHist(){
    const el = $("hist"); el.innerHTML = "";
    const items = [];
    groups.forEach(g => (g.history || []).forEach(h => items.push(Object.assign({group: g.name}, h))));
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
    renderPool(); renderDraw(); renderGroup(); renderHist(); renderResults(); renderLog();
    if (!$("ov").hidden) renderAll();
    if (!$("gm").hidden) renderGm();
  }

  // ---------- zdarzenia: gry i grupy ----------
  $("addForm").addEventListener("submit", e => {
    e.preventDefault();
    const inp = $("newGame"); const name = inp.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    const g = groups[ui.tab]; if (!g || !canEdit(g)) return;
    if ((g.games || []).some(x => x.name.toLowerCase() === name.toLowerCase())) { toast("Ta gra już jest na liście"); return; }
    upd(g.id, {games: FV.arrayUnion({id: uid(), name})}, "Dodanie gry " + q(name), "game-add");
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
  $("rerollBtn").onclick = () => draw(ui.drawn);
  $("playBtn").onclick = markPlayed;
  document.addEventListener("click", e => {
    if (ui.armed && !e.target.closest(".del")) { ui.armed = null; renderGroup(); }
    if (ui.resArmed && !e.target.closest(".del")) { ui.resArmed = null; renderResults(); }
  });

  // ================= OKNA (overlay) =================
  function openOv(id){ $(id).hidden = false; document.body.style.overflow = "hidden"; }
  function closeOv(id){ $(id).hidden = true; if (!document.querySelector(".ov:not([hidden])")) document.body.style.overflow = ""; if (id === "rf") rf = null; }
  document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => closeOv(b.dataset.close));
  document.querySelectorAll(".ov").forEach(o => o.addEventListener("click", e => { if (e.target === o) closeOv(o.id); }));
  // przycisk "wstecz" Androida: zamyka okno, jeśli jakieś jest otwarte
  window.appBack = function(){
    const open = [...document.querySelectorAll(".ov:not([hidden])")];
    if (open.length) { closeOv(open[open.length - 1].id); return true; }
    return false;
  };
  $("openBk").onclick = () => { bkMsg(""); openOv("bkov"); };
  $("openHelp").onclick = () => { openOv("help"); $("help").querySelector(".ovscroll").scrollTop = 0; };

  // ---------- lista gier ----------
  let ovFilter = "all";
  function renderAll(){
    const fEl = $("ovFilter"); fEl.innerHTML = ""; fEl.hidden = groups.length < 2;
    if (groups.length < 2) ovFilter = "all";
    [{id:"all", name:"Wszystkie"}].concat(groups.map(g => ({id:g.id, name:g.name}))).forEach(o => {
      const b = document.createElement("button");
      b.className = "chip" + (ovFilter === o.id ? " on" : ""); b.textContent = o.name;
      b.onclick = () => { ovFilter = o.id; renderAll(); };
      fEl.appendChild(b);
    });
    const q = $("ovSearch").value.trim().toLowerCase();
    const items = [];
    groups.forEach(g => { if (ovFilter === "all" || ovFilter === g.id) (g.games || []).forEach(game => items.push({game, group:g})); });
    const shown = items.filter(x => !q || x.game.name.toLowerCase().includes(q)).sort((a,b) => cmp(a.game.name, b.game.name));
    const ul = $("allList"); ul.innerHTML = "";
    if (!shown.length) ul.innerHTML = '<li class="empty" style="justify-content:center;border:0">' + (items.length ? "Brak wyników." : "Nie masz jeszcze żadnych gier.") + '</li>';
    let last = "";
    shown.forEach(x => {
      const L = x.game.name.charAt(0).toLocaleUpperCase("pl");
      if (L !== last) { last = L; const h = document.createElement("li"); h.className = "letter"; h.textContent = L; ul.appendChild(h); }
      const li = document.createElement("li");
      li.className = isPlayed(x.group, x.game) ? "played" : "";
      li.innerHTML = '<span class="nm"></span><span class="tag"></span>';
      li.querySelector(".nm").textContent = x.game.name;
      if (groups.length > 1) li.querySelector(".tag").textContent = x.group.name; else li.querySelector(".tag").remove();
      ul.appendChild(li);
    });
    const played = items.filter(x => isPlayed(x.group, x.game)).length;
    $("ovSum").textContent = items.length ? ("Razem: " + items.length + " · rozegrane: " + played + " · do zagrania: " + (items.length - played)) : "";
  }
  $("openList").onclick = () => { ovFilter = "all"; $("ovSearch").value = ""; renderAll(); openOv("ov"); };
  $("ovSearch").addEventListener("input", renderAll);

  // ================= GRUPA: członkowie, kod =================
  let gmGid = null, gmArmed = null;
  $("openGm").onclick = () => { const g = groups[ui.tab]; if (!g) return; gmGid = g.id; gmArmed = null; renderGm(); openOv("gm"); };
  const ROLE_PL = {owner: "właściciel", editor: "edytor", player: "gracz"};
  function renderGm(){
    const g = groupById(gmGid);
    const body = $("gmBody");
    if (!g) { closeOv("gm"); return; }
    $("gmTitle").textContent = g.name;
    body.innerHTML = "";
    const add = html => { const d = document.createElement("div"); d.innerHTML = html; while (d.firstChild) body.appendChild(d.firstChild); };
    add('<span class="fl">Twoja rola</span><p class="rolenote"><span class="role ' + role(g) + '">' + ROLE_PL[role(g)] + '</span></p>');
    if (canEdit(g)) {
      add('<span class="fl">Kod zaproszenia</span><div class="code"></div>' +
          '<div class="row2"><button class="ghost" id="gmCopy">Kopiuj kod</button><button class="ok" id="gmShare">Udostępnij</button></div>' +
          '<p class="rolenote" style="margin-top:10px">Kto wpisze ten kod w „⇥ kod”, dołączy do grupy jako gracz.</p>');
      body.querySelector(".code").textContent = g.inviteCode || "—";
      const shareText = "Dołącz do mojej grupy „" + g.name + "” w aplikacji Planszówki. Kod: " + g.inviteCode;
      $("gmCopy").onclick = async () => {
        if (Android && Android.copy) { Android.copy(g.inviteCode); toast("Skopiowano kod"); return; }
        try { await navigator.clipboard.writeText(g.inviteCode); toast("Skopiowano kod"); } catch(e){ toast("Kod: " + g.inviteCode); }
      };
      $("gmShare").onclick = () => {
        if (Android && Android.share) Android.share(shareText);
        else if (navigator.share) navigator.share({text: shareText}).catch(() => {});
        else $("gmCopy").click();
      };
      if (isOwner(g)) {
        add('<button class="link" id="gmNewCode">Wygeneruj nowy kod (stary przestanie działać)</button>');
        $("gmNewCode").onclick = () => regenCode(g);
      }
    }
    add('<span class="fl">Członkowie (' + (g.memberIds || []).length + ')</span><div id="gmMembers"></div>');
    const box = $("gmMembers");
    const order = {owner: 0, editor: 1, player: 2};
    (g.memberIds || []).slice().sort((a,b) => (order[g.members[a]] - order[g.members[b]]) || cmp((g.memberNames||{})[a] || "", (g.memberNames||{})[b] || ""))
      .forEach(u => {
        const r = g.members[u];
        const row = document.createElement("div"); row.className = "mem";
        row.innerHTML = '<span class="mn"></span>';
        row.querySelector(".mn").textContent = ((g.memberNames || {})[u] || "?") + (u === me.uid ? " (Ty)" : "");
        if (isOwner(g) && r !== "owner") {
          const sel = document.createElement("select");
          sel.setAttribute("aria-label", "Rola");
          sel.innerHTML = '<option value="player">gracz</option><option value="editor">edytor</option><option value="__remove">usuń z grupy</option>';
          sel.value = r;
          sel.onchange = async () => {
            if (sel.value === "__remove") {
              const ok = await upd(g.id, {["members." + u]: FV.delete(), memberIds: FV.arrayRemove(u), ["memberNames." + u]: FV.delete()},
                "Usunięcie z grupy: " + ((g.memberNames || {})[u] || "?"), "member");
              if (ok) toast("Usunięto z grupy");
            } else await upd(g.id, {["members." + u]: sel.value}, "Zmiana roli: " + ((g.memberNames || {})[u] || "?") + " → " + ROLE_PL[sel.value], "member");
          };
          row.appendChild(sel);
        } else {
          const s = document.createElement("span"); s.className = "role " + r; s.textContent = ROLE_PL[r] || r; row.appendChild(s);
        }
        box.appendChild(row);
      });
    if (isOwner(g)) {
      add('<button class="danger" id="gmDelete"></button>');
      const n = (g.games || []).length;
      const d = $("gmDelete");
      d.textContent = gmArmed === "del" ? ("Na pewno usunąć grupę" + (n ? " i " + gier(n) : "") + " oraz jej wyniki?") : "Usuń grupę";
      d.classList.toggle("armed", gmArmed === "del");
      d.onclick = () => { if (gmArmed !== "del") { gmArmed = "del"; renderGm(); return; } deleteGroup(g); };
    } else {
      add('<button class="danger" id="gmLeave"></button>');
      const l = $("gmLeave");
      l.textContent = gmArmed === "leave" ? "Na pewno opuścić grupę?" : "Opuść grupę";
      l.classList.toggle("armed", gmArmed === "leave");
      l.onclick = async () => {
        if (gmArmed !== "leave") { gmArmed = "leave"; renderGm(); return; }
        try { await lcol(g.id).doc().set(logEntry("member", "Opuszczenie grupy")); } catch(e){}
        const ok = await upd(g.id, {["members." + me.uid]: FV.delete(), memberIds: FV.arrayRemove(me.uid), ["memberNames." + me.uid]: FV.delete()});
        if (ok) { closeOv("gm"); toast("Opuszczono grupę: " + g.name); }
      };
    }
  }
  async function regenCode(g){
    for (let attempt = 0; attempt < 5; attempt++){
      const code = newCode();
      try { await commitB((b, log) => {
        if (g.inviteCode) b.delete(db.collection("invites").doc(g.inviteCode));
        b.set(db.collection("invites").doc(code), {groupId: g.id, createdBy: me.uid, createdAt: Date.now()});
        b.update(gref(g.id), {inviteCode: code, updatedAt: Date.now()});
        log(g.id, "invite", "Wygenerowanie nowego kodu zaproszenia");
      }); toast("Nowy kod: " + code); return; }
      catch(e){ if (!String(e.code).includes("permission-denied")) { toast(errMsg(e)); return; } }
    }
    toast("Nie udało się wygenerować kodu");
  }
  async function deleteGroup(g){
    try {
      const ps = await pcol(g.id).get();
      let logDocs = [];
      try { logDocs = (await lcol(g.id).get()).docs; } catch(e){}
      const docs = ps.docs.concat(logDocs);
      for (let i = 0; i < docs.length; i += 400) {
        const b = db.batch(); docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
      }
      const b = db.batch();
      if (g.inviteCode) b.delete(db.collection("invites").doc(g.inviteCode));
      b.delete(gref(g.id));
      await b.commit();
      closeOv("gm"); ui.tab = 0; toast("Usunięto grupę: " + g.name);
    } catch(e){ toast(errMsg(e)); }
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
      const gid = inv.data().groupId;
      if (groupById(gid)) { $("jnErr").textContent = "Już należysz do tej grupy."; return; }
      await gref(gid).update({["members." + me.uid]: "player", memberIds: FV.arrayUnion(me.uid), ["memberNames." + me.uid]: me.name, joinCode: code});
      lcol(gid).doc().set(logEntry("member", "Dołączenie do grupy (kodem zaproszenia)")).catch(() => {});
      closeOv("jn"); toast("Dołączono do grupy!");
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
    groups.forEach(g => Object.entries(g.memberNames || {}).forEach(([u, n]) => { if ((g.memberIds || []).includes(u) && n) m.set(u, n); }));
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
  function openResult(gameId, gid, edit){
    const games = allGamesSorted();
    if (!games.length && !edit) { toast("Najpierw dodaj gry"); return; }
    const sel = $("rfGame"); sel.innerHTML = "";
    games.forEach(x => { const o = document.createElement("option"); o.value = optVal(x.group.id, x.game.id); o.textContent = x.game.name + (groups.length > 1 ? "  ·  " + x.group.name : ""); sel.appendChild(o); });
    if (edit) {
      rf = { editId: edit.id, orig: edit, gid: edit.groupId, gameId: edit.gameId, mode: edit.mode || "max", coopWin: edit.coopWin !== false,
             list: [], pts: {}, labels: {} };
      (edit.scores || []).forEach(x => { const k = scoreKey(x); rf.list.push(k); rf.labels[k] = x.p; if (x.pts !== undefined) rf.pts[k] = String(x.pts); });
      if (!findGame(edit.gameId, edit.groupId)) { const o = document.createElement("option"); o.value = optVal(edit.groupId, edit.gameId); o.textContent = edit.gameName + " (usunięta z listy)"; sel.insertBefore(o, sel.firstChild); }
      sel.value = optVal(edit.groupId, edit.gameId);
      $("rfDate").value = dateStr(edit.at);
      $("rfTitle").textContent = "Edytuj wynik"; $("rfSave").textContent = "Zapisz zmiany";
    } else {
      const pick = (gameId && findGame(gameId, gid)) || games[0];
      rf = { gid: pick.group.id, gameId: pick.game.id, mode: lastModeFor(pick.game.id), coopWin: true, list: [], pts: {}, labels: {} };
      sel.value = optVal(rf.gid, rf.gameId);
      $("rfDate").value = todayStr();
      $("rfTitle").textContent = "Nowy wynik"; $("rfSave").textContent = "Zapisz wynik";
    }
    $("rfErr").textContent = ""; $("rfManageList").hidden = true;
    renderRF(); openOv("rf");
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
    rf.gid = gid; rf.gameId = gameId;
    if (!rf.editId) rf.mode = lastModeFor(gameId);
    renderRF();
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
      b.className = "chip" + (plArmed === p ? " on" : "");
      b.textContent = plArmed === p ? "Usunąć „" + p + "”?" : p + "  ✕";
      b.onclick = async () => {
        if (plArmed !== p) { plArmed = p; renderManage(); return; }
        plArmed = null;
        for (const g of groups) if ((g.players || []).includes(p)) await upd(g.id, {players: FV.arrayRemove(p)}, "Usunięcie gracza z listy: " + p, "player");
      };
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
    const g = groupById(gid);
    $("rfSave").disabled = true;
    try {
      const editId = rf.editId, origGid = rf.editId ? rf.orig.groupId : null;
      const fill = (b, log) => {
      if (editId && origGid !== gid) {
        b.delete(pcol(origGid).doc(editId));
        b.set(pcol(gid).doc(editId), play);
      } else {
        b.set(pcol(gid).doc(playId), play);
      }
      // wpisane imiona trafiają na listę graczy grupy; nowy wynik oznacza grę jako rozegraną
      const gp = {updatedAt: Date.now()};
      const newNames = chosen.filter(k => k.startsWith("n:")).map(k => k.slice(2)).filter(p => !(g.players || []).includes(p));
      if (newNames.length) gp.players = FV.arrayUnion(...newNames);
      if (!rf.editId && f) {
        if (!isPlayed(g, f.game)) gp["played." + f.game.id] = at;
        gp.history = historyWith(g, f.game, at);
      }
      if (Object.keys(gp).length > 1) b.update(gref(gid), gp);
      const summary = q(play.gameName) + " – " + scores.map(x => (x.win ? "🏆 " : "") + x.p + (x.pts !== undefined ? " " + x.pts : "")).join(", ")
        + (play.mode === "coop" ? (play.coopWin ? " (kooperacja – wygrana)" : " (kooperacja – przegrana)") : "");
      log(gid, "result", (editId ? "Zmiana wyniku: " : "Dodanie wyniku: ") + summary);
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
      const top = rows.length ? rows[0].w : 0;
      t.innerHTML = "<tr><th>Gracz</th><th>Wygrane</th><th>Gry</th><th>%</th></tr>";
      rows.forEach(r => {
        const tr = document.createElement("tr");
        if (r.w && r.w === top) tr.className = "top";
        tr.innerHTML = "<td></td><td class='w'></td><td></td><td></td>";
        tr.children[0].textContent = (r.w && r.w === top ? "👑 " : "") + r.label;
        tr.children[1].textContent = r.w; tr.children[2].textContent = r.g;
        tr.children[3].textContent = r.g ? Math.round(100 * r.w / r.g) + "%" : "–";
        t.appendChild(tr);
      });
    }
    const ul = $("resList"); ul.innerHTML = "";
    if (!shown.length) { ul.innerHTML = '<li class="empty" style="justify-content:center">—</li>'; return; }
    shown.slice(0, 15).forEach(pl => {
      const g = groupById(pl.groupId);
      const mayEdit = pl.createdBy === me.uid || canEdit(g);
      const li = document.createElement("li");
      li.innerHTML = '<div class="rb"><div class="rt"><b></b><span></span></div><div class="rs"></div></div>' +
        (mayEdit ? '<button class="ib ed" title="Edytuj wynik">✎</button><button class="ib del" title="Usuń wynik">🗑</button>' : '');
      li.querySelector("b").textContent = pl.gameName;
      li.querySelector(".rt span").textContent = fmt(pl.at) + (groups.length > 1 && g ? " · " + g.name : "");
      const rs = li.querySelector(".rs");
      const sorted = (pl.scores || []).slice().sort((a,b) => (pl.mode === "min" ? 1 : -1) * ((a.pts ?? -Infinity) - (b.pts ?? -Infinity)));
      sorted.forEach((sc, i) => {
        const sp = document.createElement("span");
        const won = scoreWon(pl, sc);
        if (won) sp.className = "win";
        sp.textContent = (won ? "🏆 " : "") + (sc.uid ? (acc.get(sc.uid) || sc.p) : sc.p) + (sc.pts !== undefined ? " " + sc.pts : "");
        rs.appendChild(sp);
        if (i < sorted.length - 1) rs.appendChild(document.createTextNode(" · "));
      });
      if (pl.mode === "coop") rs.appendChild(document.createTextNode(pl.coopWin ? "  (kooperacja – wygrana)" : "  (kooperacja – przegrana)"));
      if (mayEdit) {
        li.querySelector(".ed").onclick = () => { ui.resArmed = null; openResult(null, null, pl); };
        const del = li.querySelector(".del");
        if (ui.resArmed === pl.id) { del.classList.add("armed"); del.textContent = "Usuń?"; }
        del.onclick = () => {
          if (ui.resArmed !== pl.id) { ui.resArmed = pl.id; renderResults(); return; }
          ui.resArmed = null;
          commitB((b, log) => {
            b.delete(pcol(pl.groupId).doc(pl.id));
            log(pl.groupId, "result", "Usunięcie wyniku: " + q(pl.gameName) + " z " + fmt(pl.at));
          }).catch(e => toast(errMsg(e)));
        };
      }
      ul.appendChild(li);
    });
  }
  // Jednorazowe czyszczenie (16.11.2026): właściciel grupy utworzonej przed tą wersją
  // przy pierwszym uruchomieniu usuwa wyniki, listę wpisanych graczy i historię rozegranych,
  // a z członków grupy usuwa konto o nazwie "test".
  const RESET_V = 2, RESET_BEFORE = Date.parse("2026-11-16T11:00:00Z");
  const resetting = new Set();
  async function oneTimeReset(){
    for (const g of groups) {
      if (!isOwner(g) || (g.resetV || 0) >= RESET_V || (g.createdAtMs || 0) >= RESET_BEFORE || resetting.has(g.id)) continue;
      resetting.add(g.id);
      try {
        const ps = await pcol(g.id).get();
        for (let i = 0; i < ps.docs.length; i += 400) {
          const b = db.batch(); ps.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
        }
        const patch = {players: [], history: [], resetV: RESET_V, updatedAt: Date.now()};
        const testers = (g.memberIds || []).filter(u => u !== me.uid && g.members[u] !== "owner"
          && String((g.memberNames || {})[u] || "").trim().toLowerCase() === "test");
        if (testers.length) {
          patch.memberIds = FV.arrayRemove(...testers);
          testers.forEach(u => { patch["members." + u] = FV.delete(); patch["memberNames." + u] = FV.delete(); });
        }
        await gref(g.id).update(patch);
      } catch(e){ resetting.delete(g.id); }
    }
  }
  $("addResult").onclick = () => openResult(null, null);

  // ================= CHANGE LOG =================
  let logGroup = "all", logLimit = 30;
  function renderLog(){
    if (!me) return;
    const fEl = $("logFilter"); fEl.innerHTML = ""; fEl.hidden = groups.length < 2;
    if (logGroup !== "all" && !groupById(logGroup)) logGroup = "all";
    [{id:"all", name:"Wszystko"}].concat(groups.map(g => ({id:g.id, name:g.name}))).forEach(o => {
      const b = document.createElement("button");
      b.className = "chip" + (logGroup === o.id ? " on" : ""); b.textContent = o.name;
      b.onclick = () => { logGroup = o.id; logLimit = 30; renderLog(); };
      fEl.appendChild(b);
    });
    let items = Object.values(logsBy).flat();
    if (logGroup === "all") {
      const known = new Set([me.uid, ...accounts().keys()]);
      Object.entries(regs).forEach(([u, r]) => { if (known.has(u)) items.push({at: r.at, name: r.name, text: "Rejestracja konta w aplikacji", type: "register"}); });
    } else items = items.filter(e => e.groupId === logGroup);
    items.sort((a,b) => b.at - a.at);
    const ul = $("logList"); ul.innerHTML = "";
    if (!items.length) ul.innerHTML = '<li class="empty" style="justify-content:center">Brak wpisów.</li>';
    items.slice(0, logLimit).forEach(e => {
      const li = document.createElement("li");
      li.innerHTML = '<div class="lh"><b></b><span></span></div><div class="lt"></div>';
      li.querySelector("b").textContent = e.name || "?";
      const g = e.groupId && groupById(e.groupId);
      li.querySelector("span").textContent = fmtDT(e.at) + (g && groups.length > 1 && logGroup === "all" ? " · " + g.name : "");
      li.querySelector(".lt").textContent = e.text;
      ul.appendChild(li);
    });
    const more = $("logMore");
    more.hidden = items.length <= logLimit;
    more.onclick = () => { logLimit += 30; renderLog(); };
  }

  // ================= KOPIA ZAPASOWA / IMPORT =================
  function bkMsg(t, err){ const m = $("bkMsg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); }
  $("bkCopy").onclick = async () => {
    const data = { v: 2, exportedAt: Date.now(),
      groups: groups.map(g => ({ id: g.id, name: g.name,
        games: (g.games || []).map(x => ({id: x.id, name: x.name, played: isPlayed(g, x), playedAt: (g.played || {})[x.id] || null})),
        history: g.history || [], players: g.players || [],
        log: (logsBy[g.id] || []).map(e => ({at: e.at, name: e.name, type: e.type, text: e.text})) })),
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
      importArmed = true; btn.textContent = "Importować?";
      bkMsg("Powstanie " + plural(data.groups.length, "nowa grupa", "nowe grupy", "nowych grup") + " (" + plural(nGames, "gra", "gry", "gier") + ", " + plural(nPlays, "wynik", "wyniki", "wyników") + "). Naciśnij jeszcze raz, aby potwierdzić.");
      setTimeout(() => { importArmed = false; btn.textContent = "Importuj"; }, 6000);
      return;
    }
    importArmed = false; btn.textContent = "Importuj"; btn.disabled = true;
    bkMsg("Importuję…");
    try {
      const idMap = {};
      for (const og of data.groups.slice(0, MAX_GROUPS)) {
        const games = (og.games || []).filter(x => x && x.name).map(x => ({id: String(x.id || uid()).replace(/[^A-Za-z0-9_-]/g, "") || uid(), name: String(x.name).slice(0, 80)}));
        const played = {};
        (og.games || []).forEach((x, i) => { if (x && x.played) played[games[i].id] = Number(x.playedAt) || Date.now(); });
        const gname = String(og.name || "Grupa").slice(0, 40);
        const histSrc = Array.isArray(og.history) ? og.history : (Array.isArray(data.history) ? data.history.filter(h => h.group === og.name) : []);
        const history = histSrc.filter(h => h && h.id && h.name).map(h => ({id: String(h.id), name: String(h.name), at: Number(h.at) || Date.now()})).slice(0, 50);
        const players = (Array.isArray(og.players) ? og.players : (Array.isArray(data.players) ? data.players : [])).map(p => String(p).slice(0, 30));
        const gid = await createGroup(gname, {games, played, history, players});
        if (!gid) throw new Error("create");
        idMap[og.id || gname] = gid;
        const oldLog = logOk ? (Array.isArray(og.log) ? og.log : []).filter(e => e && e.text).slice(0, 800) : [];
        try { for (let i = 0; i < oldLog.length; i += 400) {
          const b = db.batch();
          oldLog.slice(i, i + 400).forEach(e => b.set(lcol(gid).doc(), {at: Number(e.at) || Date.now(), by: me.uid, name: String(e.name || "?").slice(0, 40), type: String(e.type || "edit").slice(0, 20), text: String(e.text).slice(0, 300)}));
          await b.commit();
        } } catch(e){ logOk = false; }
        logTo(gid, "import", "Import kopii zapasowej (" + plural(games.length, "gra", "gry", "gier") + ")");
      }
      const plays = (Array.isArray(data.plays) ? data.plays : []).filter(p => p && p.gameName && idMap[p.groupId]);
      for (let i = 0; i < plays.length; i += 400) {
        const b = db.batch();
        plays.slice(i, i + 400).forEach(p => {
          const doc = { gameId: String(p.gameId || ""), gameName: String(p.gameName), at: Number(p.at) || Date.now(), mode: ["max","min","coop"].includes(p.mode) ? p.mode : "max",
                        scores: (p.scores || []).map(s => { const o = {p: String(s.p)}; if (s.pts !== undefined) o.pts = Number(s.pts); if (s.uid) o.uid = String(s.uid); if (s.win !== undefined) o.win = !!s.win; return o; }),
                        winners: (p.winners || []).map(String), createdBy: me.uid, createdByName: me.name };
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
  function currentVersion(){
    if (Android && Android.versionCode) try { return Number(Android.versionCode()) || 0; } catch(e){}
    const v = parseInt(String(CFG.version).replace(/\D/g, ""), 10);
    return isNaN(v) ? 0 : v;
  }
  $("ver").textContent = "wersja " + (currentVersion() || "dev");
  async function checkUpdate(){
    if (!CFG.repo || CFG.repo.startsWith("__")) return;
    try {
      const r = await fetch("https://api.github.com/repos/" + CFG.repo + "/releases/latest", {headers: {"Accept": "application/vnd.github+json"}});
      if (!r.ok) return;
      const rel = await r.json();
      const latest = parseInt(String(rel.tag_name || "").replace(/\D/g, ""), 10);
      if (!latest || latest <= currentVersion()) return;
      const asset = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
      const url = asset ? asset.browser_download_url : ("https://github.com/" + CFG.repo + "/releases/latest");
      $("updText").textContent = "Dostępna nowa wersja (" + latest + ")";
      $("updBanner").hidden = false;
      $("updBtn").onclick = () => {
        if (Android && Android.openUrl) Android.openUrl(url); else window.open(url, "_blank");
        toast("Pobieranie… po zakończeniu otwórz plik i potwierdź instalację");
      };
    } catch(e){}
  }

  // ================= TŁO: deszcz znaków =================
  (function(){
    const c = $("rain"); const ctx = c.getContext("2d"); if (!ctx) return;
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ0123456789";
    let cols, drops, fs = 16; const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function size(){
      c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
      cols = Math.ceil(innerWidth / fs); drops = Array.from({length: cols}, () => Math.random() * -innerHeight / fs);
      ctx.fillStyle = "#020503"; ctx.fillRect(0,0,innerWidth,innerHeight);
    }
    size(); addEventListener("resize", size);
    function step(){
      ctx.fillStyle = "rgba(2,5,3,0.09)"; ctx.fillRect(0,0,innerWidth,innerHeight);
      ctx.font = fs + "px 'Share Tech Mono', monospace";
      for (let i = 0; i < cols; i++){
        const y = drops[i] * fs;
        ctx.fillStyle = Math.random() < .04 ? "#d6ffe3" : "#00c853";
        ctx.fillText(chars[Math.floor(Math.random()*chars.length)], i * fs, y);
        if (y > innerHeight && Math.random() > .975) drops[i] = 0;
        drops[i] += 1;
      }
    }
    if (reduce) { for (let k = 0; k < 60; k++) step(); return; }
    let last = 0;
    (function loop(t){ if (!document.hidden && t - last > 60) { step(); last = t; } requestAnimationFrame(loop); })(0);
  })();
})();

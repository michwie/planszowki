// Testy reguł Firestore (uruchamiane w emulatorze: npm test)
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

let env;
const OWNER = "uOwner", MG = "uMistrz", PLAYER = "uGracz", OUT = "uObcy";
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-planszomat",
    firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8") }
  });
});
after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, "groups/G"), {
      name: "Test", ownerId: OWNER,
      members: { [OWNER]: "owner", [MG]: "editor", [PLAYER]: "player" },
      memberIds: [OWNER, MG, PLAYER],
      memberNames: { [OWNER]: "Michał", [MG]: "Mistrz", [PLAYER]: "Gracz" },
      createdAtMs: 1
    });
    await setDoc(doc(db, "groups/G/shelf/main"), { games: [{ id: "a1", name: "Azul" }], players: [], editorCode: "ED1", playerCode: "PL1" });
    await setDoc(doc(db, "groups/G/plays/p1"), {
      gameId: "a1", gameName: "Azul", at: 1, mode: "max",
      scores: [{ p: "Michał", uid: OWNER, pts: 5, win: true }], winners: ["Michał"],
      viewers: [OWNER], createdBy: OWNER, exps: []
    });
    await setDoc(doc(db, "groups/G/covers/a1"), { img: JPG, by: OWNER, updatedAt: 1 });
  });
});

// zalogowany użytkownik; verified=false udaje konto bez potwierdzonego e-maila
const as = (uid, verified = true) => env.authenticatedContext(uid, { email: uid + "@test.pl", email_verified: verified }).firestore();

test("niezalogowany nic nie czyta", async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "groups/G")));
});

test("konto bez potwierdzonego e-maila nie ma dostępu", async () => {
  await assertFails(getDoc(doc(as(OWNER, false), "groups/G")));
  await assertFails(setDoc(doc(as(OWNER, false), "prefs/" + OWNER), { theme: "x" }));
});

test("członek czyta grupę, obcy nie", async () => {
  await assertSucceeds(getDoc(doc(as(PLAYER), "groups/G")));
  await assertFails(getDoc(doc(as(OUT), "groups/G")));
});

test("szafę widzą tylko właściciel i Mistrz Gry", async () => {
  await assertSucceeds(getDoc(doc(as(OWNER), "groups/G/shelf/main")));
  await assertSucceeds(getDoc(doc(as(MG), "groups/G/shelf/main")));
  await assertFails(getDoc(doc(as(PLAYER), "groups/G/shelf/main")));
});

test("Mistrz Gry zmienia gry, ale nie kody zaproszeń", async () => {
  await assertSucceeds(updateDoc(doc(as(MG), "groups/G/shelf/main"), { games: [] }));
  await assertFails(updateDoc(doc(as(MG), "groups/G/shelf/main"), { editorCode: "HACK" }));
  await assertFails(updateDoc(doc(as(PLAYER), "groups/G/shelf/main"), { games: [] }));
});

test("wynik widzą tylko osoby z listy viewers", async () => {
  await assertSucceeds(getDoc(doc(as(OWNER), "groups/G/plays/p1")));
  await assertFails(getDoc(doc(as(MG), "groups/G/plays/p1")));
  await assertFails(getDoc(doc(as(PLAYER), "groups/G/plays/p1")));
});

test("gracz nie może dodać wyniku, Mistrz Gry może", async () => {
  const play = by => ({ gameId: "a1", gameName: "Azul", at: 2, mode: "max", scores: [], winners: [], viewers: [by], createdBy: by, exps: [] });
  await assertFails(setDoc(doc(as(PLAYER), "groups/G/plays/x1"), play(PLAYER)));
  await assertSucceeds(setDoc(doc(as(MG), "groups/G/plays/x2"), play(MG)));
});

test("po usunięciu z rozgrywki osoba traci dostęp do wyniku", async () => {
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), "groups/G/plays/p1"), { viewers: [OWNER, PLAYER] }));
  await assertSucceeds(getDoc(doc(as(PLAYER), "groups/G/plays/p1")));
  await assertSucceeds(updateDoc(doc(as(OWNER), "groups/G/plays/p1"), { viewers: [OWNER] }));
  await assertFails(getDoc(doc(as(PLAYER), "groups/G/plays/p1")));
});

test("okładki: tylko właściciel i Mistrz Gry, tylko JPEG", async () => {
  await assertSucceeds(getDoc(doc(as(MG), "groups/G/covers/a1")));
  await assertFails(getDoc(doc(as(PLAYER), "groups/G/covers/a1")));
  await assertSucceeds(setDoc(doc(as(MG), "groups/G/covers/b1"), { img: JPG, by: MG, updatedAt: 2 }));
  await assertFails(setDoc(doc(as(PLAYER), "groups/G/covers/b2"), { img: JPG, by: PLAYER, updatedAt: 2 }));
  await assertFails(setDoc(doc(as(MG), "groups/G/covers/b3"), { img: "data:text/html;base64,PHA+", by: MG, updatedAt: 2 }));
  await assertFails(setDoc(doc(as(MG), "groups/G/covers/b4"), { img: JPG, by: MG, updatedAt: 2, extra: 1 }));
  await assertFails(setDoc(doc(as(MG), "groups/G/covers/b5"), { img: "data:image/jpeg;base64," + "A".repeat(200000), by: MG, updatedAt: 2 }));
});

test("ustawienia konta widzi i zmienia tylko właściciel konta", async () => {
  await assertSucceeds(setDoc(doc(as(OWNER), "prefs/" + OWNER), { theme: "ges", fx: true, updatedAt: 1 }));
  await assertFails(getDoc(doc(as(MG), "prefs/" + OWNER)));
  await assertFails(setDoc(doc(as(OWNER), "prefs/" + OWNER), { theme: "ges", admin: true }));
});

test("dołączenie kodem gracza daje tylko rolę gracza", async () => {
  const join = (role, code) => updateDoc(doc(as(OUT), "groups/G"), {
    [`members.${OUT}`]: role, memberIds: [OWNER, MG, PLAYER, OUT], [`memberNames.${OUT}`]: "Obcy", joinCode: code
  });
  await assertFails(join("editor", "PL1"));
  await assertSucceeds(join("player", "PL1"));
});

test("gracz nie zmienia ról w grupie", async () => {
  await assertFails(updateDoc(doc(as(PLAYER), "groups/G"), { [`members.${PLAYER}`]: "owner" }));
  await assertFails(deleteDoc(doc(as(MG), "groups/G")));
});

test("rejestracja: każdy zapisuje tylko swoją", async () => {
  await assertSucceeds(setDoc(doc(as(PLAYER), "registrations/" + PLAYER), { name: "Gracz", at: 1 }));
  await assertFails(setDoc(doc(as(PLAYER), "registrations/" + OWNER), { name: "Ktoś", at: 1 }));
});

test("kopie na serwerze: tylko właściciel konta", async () => {
  const meta = { at: 1, parts: 1, size: 10, groups: 1, plays: 0 };
  await assertSucceeds(setDoc(doc(as(OWNER), `backups/${OWNER}/snaps/s1/parts/0`), { t: "PLANSZOWKI-KOPIA" }));
  await assertSucceeds(setDoc(doc(as(OWNER), `backups/${OWNER}/snaps/s1`), meta));
  await assertSucceeds(getDoc(doc(as(OWNER), `backups/${OWNER}/snaps/s1`)));
  await assertFails(getDoc(doc(as(MG), `backups/${OWNER}/snaps/s1`)));
  await assertFails(getDoc(doc(as(MG), `backups/${OWNER}/snaps/s1/parts/0`)));
  await assertFails(setDoc(doc(as(MG), `backups/${OWNER}/snaps/s2`), meta));
  await assertFails(updateDoc(doc(as(OWNER), `backups/${OWNER}/snaps/s1`), { size: 5 }));
  await assertFails(setDoc(doc(as(OWNER), `backups/${OWNER}/snaps/s3`), { ...meta, extra: 1 }));
  await assertFails(setDoc(doc(as(OWNER), `backups/${OWNER}/snaps/s1/parts/1`), { t: "A".repeat(300001) }));
  await assertSucceeds(deleteDoc(doc(as(OWNER), `backups/${OWNER}/snaps/s1`)));
});

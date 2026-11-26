"""Testy interfejsu Planszomatu (Playwright + atrapa Firebase z tests/fbmock.js).

Uruchomienie:  python3 tests/ui_test.py
Zmienna CHROME może wskazać przeglądarkę (domyślnie Chromium z Playwrighta).
"""
import json, os, shutil, sys, tempfile, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WWW = ROOT / "app/src/main/assets/www"
DAY = 86400000
NOW = 1794600000000

def build_site():
    d = Path(tempfile.mkdtemp(prefix="planszomat-ui-"))
    shutil.copytree(WWW, d / "www", ignore=shutil.ignore_patterns("vendor"))
    v = d / "www/vendor"; v.mkdir()
    shutil.copy(ROOT / "tests/fbmock.js", v / "firebase-app-compat.js")
    (v / "firebase-auth-compat.js").write_text(" ")
    (v / "firebase-firestore-compat.js").write_text(" ")
    if (WWW / "vendor/fonts").exists():
        shutil.copytree(WWW / "vendor/fonts", v / "fonts")
    return d / "www/index.html"

def play(gid, name, at, scores, by="uA"):
    return {"gameId": gid, "gameName": name, "at": at, "mode": "max", "scores": scores,
            "winners": [s["p"] for s in scores if s.get("win")],
            "viewers": sorted({s["uid"] for s in scores if s.get("uid")} | {by}), "createdBy": by, "exps": []}

M = {"p": "Michał", "uid": "uA"}
K = {"p": "Kasia", "uid": "uK"}

def seed(cur="a@x", role_k="player", verified=True):
    return {"docs": {
        "groups/G1": {"name": "Dom", "ownerId": "uA", "members": {"uA": "owner", "uK": role_k},
                      "memberIds": ["uA", "uK"], "memberNames": {"uA": "Michał", "uK": "Kasia stara"}, "createdAtMs": 1},
        "groups/G1/shelf/main": {"games": [{"id": "a1", "name": "Azul"}, {"id": "w1", "name": "Wiedźmin", "exps": [{"id": "e1", "name": "Magowie"}]},
                                            {"id": "c1", "name": "Catan"}], "players": ["Marta <3"], "editorCode": "A", "playerCode": "B"},
        "groups/G1/plays/p1": play("a1", "Azul", NOW - 3 * DAY, [dict(M, pts=10, win=True), dict(K, pts=7, win=False)]),
        "groups/G1/plays/p2": play("a1", "Azul", NOW - 2 * DAY, [dict(M, pts=5, win=False), dict(K, pts=9, win=True)]),
        "groups/G1/plays/p3": play("w1", "Wiedźmin", NOW - DAY, [dict(M, pts=3, win=True), {"p": "Marta <3", "pts": 1, "win": False}]),
        "registrations/uA": {"name": "Michał", "at": 1},
        "registrations/uK": {"name": "Kasia Nowak", "at": 1},
    }, "users": {
        "a@x": {"uid": "uA", "email": "a@x", "pass": "haslo123", "displayName": "Michał", "verified": verified},
        "k@x": {"uid": "uK", "email": "k@x", "pass": "haslo123", "displayName": "Kasia Nowak"},
    }, "cur": cur}

class Ctx:
    def __init__(self, browser, url):
        self.b, self.url = browser, url
    def open(self, data):
        pg = self.b.new_page(viewport={"width": 390, "height": 844})
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(self.url)
        pg.evaluate("s => { localStorage.clear(); localStorage.setItem('__fbmock', s); }", json.dumps(data))
        pg.reload(); pg.wait_for_timeout(1500)
        return pg

def docs(pg):
    return pg.evaluate("JSON.parse(localStorage.getItem('__fbmock')).docs")

def visible(pg, sel):
    return pg.is_visible(sel)

TESTS = []
def test(fn): TESTS.append(fn); return fn

@test
def ekran_logowania_i_logowanie(c):
    pg = c.open(seed(cur=None))
    assert visible(pg, "#authView"), "brak ekranu logowania"
    pg.fill("#aEmail", "a@x"); pg.fill("#aPass", "zle-haslo"); pg.click("#aSubmit"); pg.wait_for_timeout(400)
    assert pg.inner_text("#aErr").strip(), "brak komunikatu o złym haśle"
    pg.fill("#aPass", "haslo123"); pg.click("#aSubmit"); pg.wait_for_timeout(1200)
    assert visible(pg, "#appView"), "po zalogowaniu nie widać aplikacji"
    return pg

@test
def niepotwierdzony_email_zatrzymuje(c):
    pg = c.open(seed(verified=False))
    assert visible(pg, "#verifyView"), "konto bez potwierdzenia powinno widzieć ekran potwierdzenia"
    assert not visible(pg, "#appView"), "aplikacja nie może być dostępna bez potwierdzenia"
    return pg

@test
def ekran_startowy(c):
    pg = c.open(seed())
    assert visible(pg, "#v-home"), "po starcie powinien być ekran startowy"
    assert not pg.query_selector_all("#tabbar .tb.on"), "na ekranie startowym żadna zakładka nie jest zaznaczona"
    t = pg.inner_text("#drawStats")
    assert "Azul" in t and "Catan" in t, "statystyki: " + t
    return pg

@test
def losowanie(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=draw]"); pg.wait_for_timeout(200)
    pg.click("#drawBtn"); pg.wait_for_timeout(2500)
    t = pg.inner_text("#stage")
    assert any(n in t for n in ("Azul", "Wiedźmin", "Catan")), "nic nie wylosowano: " + t
    return pg

@test
def dodanie_wyniku(c):
    pg = c.open(seed())
    before = len([k for k in docs(pg) if "/plays/" in k])
    pg.click("#tabbar .tb[data-view=results]"); pg.wait_for_timeout(200)
    pg.click("#addResult"); pg.wait_for_timeout(300)
    pg.select_option("#rfGame", "G1|c1")
    pg.select_option("#rfPick", "u:uA"); pg.fill("#rfPlayers .pl >> nth=0 >> input", "12")
    pg.fill("#rfNewPl", "Zosia"); pg.press("#rfNewPl", "Enter"); pg.fill("#rfPlayers .pl >> nth=1 >> input", "8")
    assert "Michał" in pg.inner_text("#rfPreview"), "podgląd zwycięzcy: " + pg.inner_text("#rfPreview")
    pg.click("#rfSave"); pg.wait_for_timeout(600)
    d = docs(pg)
    plays = {k: v for k, v in d.items() if "/plays/" in k}
    assert len(plays) == before + 1, "wynik się nie zapisał"
    new = [v for v in plays.values() if v["gameId"] == "c1"][0]
    assert new["winners"] == ["Michał"], new
    assert new["viewers"] == ["uA"], "viewers: %s" % new["viewers"]
    assert "Zosia" in d["groups/G1/shelf/main"]["players"], "nowy gracz nie trafił na listę"
    assert "c1" in d["groups/G1/userState/uA"]["played"], "gra nie oznaczona jako rozegrana"
    return pg

@test
def okno_potwierdzenia_usuwania_wyniku(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=results]"); pg.wait_for_timeout(200)
    n = lambda: len([k for k in docs(pg) if "/plays/" in k])
    before = n()
    pg.click("#resList .del >> nth=0"); pg.wait_for_timeout(200)
    assert visible(pg, "#cf"), "brak okna potwierdzenia"
    pg.click("#cfNo"); pg.wait_for_timeout(200)
    assert not visible(pg, "#cf") and n() == before, "Anuluj nie powinno nic usuwać"
    pg.click("#resList .del >> nth=0"); pg.click("#cfYes"); pg.wait_for_timeout(600)
    assert n() == before - 1, "wynik nie został usunięty"
    return pg

@test
def usuniety_z_rozgrywki_traci_widocznosc(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=results]"); pg.wait_for_timeout(200)
    # edycja najnowszego wyniku z Kasią (p2): usuwamy Kasię
    li = pg.locator("#resList li", has_text="Kasia").first
    li.locator(".ed").click(); pg.wait_for_timeout(300)
    rows = pg.locator("#rfPlayers .pl")
    for i in range(rows.count()):
        if "Kasia" in rows.nth(i).inner_text():
            rows.nth(i).locator(".rm").click(); break
    pg.click("#rfSave"); pg.wait_for_timeout(600)
    d = docs(pg)
    edited = [v for k, v in d.items() if "/plays/" in k and v["gameId"] == "a1" and not any(s.get("uid") == "uK" for s in v["scores"])]
    assert edited and edited[0]["viewers"] == ["uA"], "viewers po edycji: %s" % [v.get("viewers") for v in edited]
    return pg

@test
def imiona_z_rejestracji(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=results]"); pg.wait_for_timeout(300)
    t = pg.inner_text("#v-results")
    assert "Kasia Nowak" in t, "powinno być imię z rejestracji"
    assert "Kasia stara" not in t, "stare imię z grupy nie powinno się pokazywać"
    return pg

@test
def pojedynki(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=results]"); pg.wait_for_timeout(300)
    assert visible(pg, "#openH2h"), "brak przycisku Pojedynki"
    pg.click("#openH2h"); pg.wait_for_timeout(300)
    assert visible(pg, "#h2hOv"), "nie otwiera się okno Pojedynki"
    assert pg.inner_text("#h2hBody").strip(), "puste okno Pojedynki"
    assert visible(pg, ".h2hleg"), "brak legendy paska"
    return pg

@test
def gracz_bez_uprawnien(c):
    pg = c.open(seed(cur="k@x"))
    pg.click("#tabbar .tb[data-view=results]"); pg.wait_for_timeout(300)
    assert not visible(pg, "#addResult"), "gracz nie może dodawać wyników"
    assert not pg.query_selector_all("#resList .del"), "gracz nie może usuwać wyników"
    return pg

@test
def wylogowanie_z_potwierdzeniem(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=more]"); pg.wait_for_timeout(200)
    pg.click("#logout"); pg.wait_for_timeout(200)
    assert visible(pg, "#cf"), "brak okna potwierdzenia wylogowania"
    pg.click("#cfYes"); pg.wait_for_timeout(600)
    assert visible(pg, "#authView"), "po wylogowaniu powinien być ekran logowania"
    return pg


@test
def edycja_gry_w_oknie(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=games]"); pg.click("#openList"); pg.wait_for_timeout(300)
    pg.click("#allList li.game:has-text('Wiedźmin') .xed"); pg.wait_for_timeout(300)
    assert visible(pg, "#ge"), "brak okna edycji gry"
    assert pg.input_value("#geName") == "Wiedźmin"
    assert "Magowie" in pg.inner_text("#geExps")
    # Anuluj nic nie zmienia
    pg.fill("#geName", "Zmienione"); pg.click("#geCancel"); pg.wait_for_timeout(300)
    assert not visible(pg, "#ge")
    g = lambda: {x["id"]: x for x in docs(pg)["groups/G1/shelf/main"]["games"]}
    assert g()["w1"]["name"] == "Wiedźmin", "Anuluj zapisało zmiany"
    # zmiana nazwy, nowe rozszerzenie, usunięcie starego
    pg.click("#allList li.game:has-text('Wiedźmin') .xed"); pg.wait_for_timeout(300)
    pg.fill("#geName", "Wiedźmin: Gra Przygodowa")
    pg.fill("#geNew", "Szkoła Wilka"); pg.press("#geNew", "Enter"); pg.wait_for_timeout(100)
    pg.click("#geExps li:has-text('Magowie') .gedel"); pg.wait_for_timeout(200)
    assert visible(pg, "#cf"), "usunięcie rozszerzenia bez potwierdzenia"
    pg.click("#cfYes"); pg.wait_for_timeout(200)
    assert visible(pg, "#ge"), "okno edycji powinno zostać otwarte"
    pg.click("#geSave"); pg.wait_for_timeout(500)
    w = g()["w1"]
    assert w["name"] == "Wiedźmin: Gra Przygodowa", w
    assert [e["name"] for e in w["exps"]] == ["Szkoła Wilka"], w["exps"]
    return pg

@test
def wykluczenie_i_usuniecie_gry_w_oknie(c):
    pg = c.open(seed())
    g = lambda: {x["id"]: x for x in docs(pg)["groups/G1/shelf/main"]["games"]}
    pg.click("#tabbar .tb[data-view=games]"); pg.click("#openList"); pg.wait_for_timeout(300)
    assert not pg.query_selector_all("#allList .nd, #allList li.game .del, #allList .xoff"), "na liście zostały przyciski ⊘/🗑"
    pg.click("#allList li.game:has-text('Wiedźmin') .xed"); pg.wait_for_timeout(300)
    pg.click("#geExps li:has-text('Magowie') .geoff"); pg.wait_for_timeout(100)
    assert "Przywróć" in pg.inner_text("#geExps li:has-text('Magowie') .geoff")
    pg.click("#geSave"); pg.wait_for_timeout(500)
    w = g()["w1"]
    assert w["exps"][0].get("off") is True and not w.get("off"), w
    pg.click("#allList li.game:has-text('Catan') .xed"); pg.wait_for_timeout(300)
    pg.click("#geExps li .geoff"); pg.click("#geSave"); pg.wait_for_timeout(500)
    assert g()["c1"].get("off") is True, g()["c1"]
    pg.click("#allList li.game:has-text('Azul') .xed"); pg.wait_for_timeout(300)
    pg.click("#geDelGame"); pg.wait_for_timeout(200)
    assert visible(pg, "#cf"), "usunięcie gry bez potwierdzenia"
    pg.click("#cfYes"); pg.wait_for_timeout(500)
    assert "a1" not in g() and not visible(pg, "#ge"), "gra nie usunięta"
    return pg

@test
def przeniesienie_gry_w_oknie(c):
    d = seed()
    d["docs"]["groups/G2"] = {"name": "Praca", "ownerId": "uA", "members": {"uA": "owner"}, "memberIds": ["uA"], "memberNames": {"uA": "Michał"}, "createdAtMs": 2}
    d["docs"]["groups/G2/shelf/main"] = {"games": [], "players": [], "editorCode": "C", "playerCode": "D"}
    pg = c.open(d)
    pg.click("#tabbar .tb[data-view=games]"); pg.click("#openList"); pg.wait_for_timeout(300)
    assert not pg.query_selector_all("#allList .move"), "na liście został przycisk ⇄"
    pg.click("#allList li.game:has-text('Catan') .xed"); pg.wait_for_timeout(300)
    assert visible(pg, "#geMoveBox"), "brak przenoszenia w oknie"
    pg.click("#geMove .gemv:has-text('Praca')"); pg.wait_for_timeout(200)
    assert visible(pg, "#cf"), "przeniesienie bez potwierdzenia"
    pg.click("#cfYes"); pg.wait_for_timeout(600)
    dd = docs(pg)
    assert any(x["id"] == "c1" for x in dd["groups/G2/shelf/main"]["games"]), "gra nie trafiła do nowej grupy"
    assert not any(x["id"] == "c1" for x in dd["groups/G1/shelf/main"]["games"]), "gra została w starej grupie"
    return pg

@test
def profil_gracza(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=results]"); pg.wait_for_timeout(300)
    assert visible(pg, "#openPf"), "brak przycisku Profil gracza"
    pg.click("#openPf"); pg.wait_for_timeout(300)
    assert visible(pg, "#pfOv")
    t = pg.inner_text("#pfBody")
    # Michał: 3 partie (p1 wygrana, p2 przegrana, p3 wygrana)
    assert "PARTIE\n3" in t.upper() and "67%" in t, t
    assert "Kasia Nowak" in t, "brak rywala"
    pg.select_option("#pfSel", "n:Marta <3"); pg.wait_for_timeout(200)
    assert "Gracz bez konta" in pg.inner_text("#pfBody")
    return pg

@test
def rekordy_w_grach(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=games]"); pg.wait_for_timeout(200)
    assert visible(pg, "#openRec"), "brak przycisku Rekordy w grach"
    pg.click("#openRec"); pg.wait_for_timeout(300)
    t = pg.inner_text("#recBody")
    assert "Azul" in t and "10 pkt" in t and "Wiedźmin" in t, t
    pg.fill("#recSearch", "wied"); pg.wait_for_timeout(200)
    t = pg.inner_text("#recBody")
    assert "Wiedźmin" in t and "Azul" not in t, t
    return pg

@test
def kosz_i_potwierdzenie_nazwa(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=games]"); pg.click("#openGm"); pg.wait_for_timeout(300)
    pg.click("#gmDelete"); pg.wait_for_timeout(200)
    assert visible(pg, "#cfTypeBox"), "brak pola na nazwę grupy"
    assert pg.is_disabled("#cfYes"), "przycisk powinien być zablokowany"
    pg.fill("#cfType", "Zła nazwa"); assert pg.is_disabled("#cfYes")
    pg.fill("#cfType", " dom "); assert not pg.is_disabled("#cfYes"), "nazwa bez względu na wielkość liter powinna odblokować"
    pg.click("#cfYes"); pg.wait_for_timeout(600)
    g = docs(pg)["groups/G1"]
    assert g.get("deletedAt"), "grupa nie trafiła do kosza"
    assert "groups/G1/plays/p1" in docs(pg), "wyniki nie mogą zniknąć przy przeniesieniu do kosza"
    assert "dom" not in pg.inner_text("#tabs").lower(), "grupa w koszu nie powinna być widoczna"
    pg.click("#tabbar .tb[data-view=more]"); pg.click("#openTrash"); pg.wait_for_timeout(300)
    assert "Dom" in pg.inner_text("#trashList")
    pg.click("#trashList .trest"); pg.wait_for_timeout(600)
    assert not docs(pg)["groups/G1"].get("deletedAt"), "grupa nie została przywrócona"
    assert "Kosz jest pusty" in pg.inner_text("#trashOv")
    pg.click("[data-close=trashOv]"); pg.click("#tabbar .tb[data-view=games]"); pg.wait_for_timeout(300)
    assert "dom" in pg.inner_text("#tabs").lower(), "przywrócona grupa nie wróciła"
    return pg

@test
def kosz_usun_na_zawsze_i_po_30_dniach(c):
    d = seed()
    d["docs"]["groups/G1"]["deletedAt"] = 1  # dawno temu -> powinna zniknąć sama
    d["docs"]["groups/G2"] = {"name": "Praca", "ownerId": "uA", "members": {"uA": "owner"}, "memberIds": ["uA"], "memberNames": {"uA": "Michał"}, "createdAtMs": 2,
                              "deletedAt": 1794600000000 + 10**12}  # świeżo w koszu
    d["docs"]["groups/G2/shelf/main"] = {"games": [], "players": [], "editorCode": "C", "playerCode": "D"}
    pg = c.open(d)
    pg.wait_for_timeout(800)
    assert "groups/G1" not in docs(pg), "grupa starsza niż 30 dni nie została usunięta"
    pg.click("#tabbar .tb[data-view=more]"); pg.click("#openTrash"); pg.wait_for_timeout(300)
    pg.click("#trashList .tdel"); pg.wait_for_timeout(200)
    assert pg.is_disabled("#cfYes")
    pg.fill("#cfType", "Praca"); pg.click("#cfYes"); pg.wait_for_timeout(800)
    assert "groups/G2" not in docs(pg), "grupa nie została usunięta na zawsze"
    return pg

@test
def kopia_do_pliku_i_z_pliku(c):
    pg = c.open(seed())
    pg.click("#tabbar .tb[data-view=more]"); pg.click("#openBk"); pg.wait_for_timeout(300)
    with pg.expect_download() as dl:
        pg.click("#bkSave")
    path = dl.value.path(); text = open(path, encoding="utf-8").read()
    assert dl.value.suggested_filename.startswith("Planszomat-kopia-") and dl.value.suggested_filename.endswith(".txt"), dl.value.suggested_filename
    assert text.startswith("PLANSZOWKI-KOPIA") and "Wiedźmin" in text, "zła treść kopii"
    with pg.expect_file_chooser() as fc:
        pg.click("#bkLoad")
    fc.value.set_files(path); pg.wait_for_timeout(400)
    assert pg.input_value("#bkText").startswith("PLANSZOWKI-KOPIA"), "plik nie został wczytany"
    return pg

@test
def wszystkie_zakladki_bez_bledow(c):
    pg = c.open(seed())
    for v in ("draw", "games", "news", "results", "more"):
        pg.click(f"#tabbar .tb[data-view={v}]"); pg.wait_for_timeout(250)
        assert visible(pg, f"#v-{v}"), "nie otwiera się zakładka " + v
    pg.click("#tabbar .tb[data-view=games]"); pg.click("#openList"); pg.wait_for_timeout(300)
    assert visible(pg, "#ov"), "nie otwiera się lista gier"
    return pg

def main():
    url = build_site().as_uri()
    fails = 0
    with sync_playwright() as p:
        exe = os.environ.get("CHROME")
        b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        c = Ctx(b, url)
        for t in TESTS:
            pg = None
            try:
                pg = t(c)
                if pg is not None and pg.errors:
                    raise AssertionError("błędy JS: " + "; ".join(pg.errors))
                print("OK    ", t.__name__)
            except Exception as e:
                fails += 1
                print("BŁĄD  ", t.__name__, "→", e)
                if not isinstance(e, AssertionError): traceback.print_exc()
                if pg is not None:
                    os.makedirs("test-shots", exist_ok=True)
                    try: pg.screenshot(path=f"test-shots/{t.__name__}.png")
                    except Exception: pass
            finally:
                if pg is not None: pg.close()
        b.close()
    print(f"\n{len(TESTS) - fails}/{len(TESTS)} testów przeszło")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()

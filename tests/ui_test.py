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
    assert visible(pg, "#h2hCard"), "brak bloku Pojedynki"
    assert pg.inner_text("#h2hBody").strip(), "pusty blok Pojedynki"
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

# 1x1 JPEG
JPG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9")

@test
def okladka_z_wikipedii(c):
    pg = c.open(seed())
    api = {"query": {"pages": {"1": {"index": 1, "title": "Catan (gra)", "thumbnail": {"source": "https://upload.wikimedia.org/catan.jpg"}}}}}
    pg.route("https://*.wikipedia.org/**", lambda r: r.fulfill(status=200, content_type="application/json",
             headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(api)))
    pg.route("https://upload.wikimedia.org/**", lambda r: r.fulfill(status=200, content_type="image/jpeg",
             headers={"Access-Control-Allow-Origin": "*"}, body=JPG))
    pg.click("#tabbar .tb[data-view=games]"); pg.click("#openList"); pg.wait_for_timeout(300)
    pg.click("#allList li.game:has-text('Catan') .xed"); pg.wait_for_timeout(200)
    pg.click("#allList .covweb"); pg.wait_for_timeout(800)
    assert visible(pg, "#cs"), "brak okna szukania okładki"
    assert pg.input_value("#csQ") == "Catan", "tytuł nie został wpisany"
    items = pg.query_selector_all("#csGrid .csit")
    assert len(items) == 1, "wyniki: %d" % len(items)
    items[0].click(); pg.wait_for_timeout(800)
    cov = docs(pg).get("groups/G1/covers/c1")
    assert cov and cov["img"].startswith("data:image/jpeg;base64,"), "okładka nie zapisana"
    assert not visible(pg, "#cs"), "okno powinno się zamknąć"
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

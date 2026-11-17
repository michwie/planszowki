package pl.michwie.planszowki;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.provider.Settings;
import android.os.Vibrator;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import android.app.PendingIntent;
import android.content.pm.PackageInstaller;

import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Cała aplikacja to strona z folderu assets/www, wyświetlana w WebView.
 * Pliki są serwowane pod bezpiecznym adresem https://appassets.androidplatform.net,
 * dzięki czemu działa zapis logowania i pamięć podręczna Firebase.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/www/index.html";

    private WebView web;
    private FrameLayout root;
    static WeakReference<MainActivity> current = new WeakReference<>(null);   // dla odbiornika statusu instalacji
    private File pendingApk;          // pobrana aktualizacja czekająca na instalację
    private boolean waitingPermission; // czekamy, aż użytkownik zezwoli na instalowanie aplikacji

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cleanupUpdates();   // po instalacji (lub porzuceniu) aktualizacji plik jest usuwany przy następnym starcie
        current = new WeakReference<>(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(2, 5, 3));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(2, 5, 3));
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Odsuń stronę od paska stanu, paska nawigacji i klawiatury (Android 15 rysuje "od krawędzi do krawędzi").
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                top = i.top; bottom = i.bottom; left = i.left; right = i.right;
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openExternal(u.toString());   // linki zewnętrzne -> przeglądarka
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "Android");

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    private void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ignored) { }
    }

    private File updatesDir() { return new File(getCacheDir(), "updates"); }

    private void cleanupUpdates() {
        File[] files = updatesDir().listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    void js(String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    /**
     * Instaluje pobrany plik przez PackageInstaller. Gdy Planszomat sam zainstalował poprzednią wersję
     * (Android 12+), aktualizacja przechodzi bez pytania; za pierwszym razem system pokaże okno potwierdzenia.
     * Po przekazaniu pliku do instalatora kopia w pamięci aplikacji jest od razu usuwana.
     */
    private void installApk(File f) {
        pendingApk = f;
        if (!getPackageManager().canRequestPackageInstalls()) {
            waitingPermission = true;
            js("window.updProgress&&updProgress(-2)");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) { }
            return;
        }
        js("window.updProgress&&updProgress(100)");
        new Thread(() -> {
            try {
                PackageInstaller pi = getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(getPackageName());
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                int id = pi.createSession(params);
                try (PackageInstaller.Session session = pi.openSession(id)) {
                    try (InputStream in = new FileInputStream(f); OutputStream out = session.openWrite("planszomat.apk", 0, f.length())) {
                        byte[] buf = new byte[64 * 1024]; int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        session.fsync(out);
                    }
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent status = PendingIntent.getBroadcast(this, id, new Intent(this, InstallReceiver.class), flags);
                    session.commit(status.getIntentSender());
                }
                //noinspection ResultOfMethodCallIgnored
                f.delete();
                pendingApk = null;
            } catch (Exception e) {
                js("window.updProgress&&updProgress(-1)");
            }
        }).start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (waitingPermission && pendingApk != null && getPackageManager().canRequestPackageInstalls()) {
            waitingPermission = false;
            installApk(pendingApk);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Najpierw niech strona zamknie otwarte okno; jeśli nic nie było otwarte – wyjdź.
        web.evaluateJavascript("(window.appBack && window.appBack()) ? 'y' : 'n'", result -> {
            if (result == null || !result.contains("y")) MainActivity.super.onBackPressed();
        });
    }

    /** Funkcje telefonu dostępne dla strony jako window.Android */
    private class Bridge {
        @JavascriptInterface
        public int versionCode() { return BuildConfig.VERSION_CODE; }

        @JavascriptInterface
        public String versionName() { return BuildConfig.VERSION_NAME; }

        @JavascriptInterface
        public void openUrl(String url) {
            if (url != null && url.startsWith("https://")) runOnUiThread(() -> openExternal(url));
        }

        @JavascriptInterface
        public void share(String text) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, text);
                startActivity(Intent.createChooser(i, "Udostępnij kod"));
            });
        }

        @JavascriptInterface
        public void copy(String text) {
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Planszomat", text));
            });
        }

        /** Kolor pasków systemowych dopasowany do motywu (light = jasne tło, ciemne ikony). */
        @JavascriptInterface
        public void setBars(String hex, boolean light) {
            runOnUiThread(() -> {
                try {
                    int c = Color.parseColor(hex);
                    root.setBackgroundColor(c);
                    web.setBackgroundColor(c);
                    getWindow().setStatusBarColor(c);
                    getWindow().setNavigationBarColor(c);
                    if (Build.VERSION.SDK_INT >= 30) {
                        android.view.WindowInsetsController ic = getWindow().getInsetsController();
                        if (ic != null) {
                            int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                            ic.setSystemBarsAppearance(light ? mask : 0, mask);
                        }
                    } else {
                        View d = getWindow().getDecorView();
                        int f = d.getSystemUiVisibility();
                        int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                        d.setSystemUiVisibility(light ? (f | mask) : (f & ~mask));
                    }
                } catch (Exception ignored) { }
            });
        }

        /** Pobiera aktualizację do pamięci aplikacji i uruchamia instalację. Plik znika przy następnym starcie. */
        @JavascriptInterface
        public void downloadUpdate(String url) {
            if (url == null || !url.startsWith("https://")) return;
            new Thread(() -> {
                File dir = updatesDir();
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                cleanupUpdates();
                File f = new File(dir, "Planszomat-update.apk");
                HttpURLConnection c = null;
                try {
                    URL u = new URL(url);
                    for (int hop = 0; hop < 5; hop++) {   // GitHub przekierowuje do serwera z plikami
                        c = (HttpURLConnection) u.openConnection();
                        c.setInstanceFollowRedirects(false);
                        c.setConnectTimeout(15000); c.setReadTimeout(30000);
                        int code = c.getResponseCode();
                        if (code >= 300 && code < 400) {
                            String loc = c.getHeaderField("Location");
                            c.disconnect();
                            if (loc == null) throw new Exception("redirect");
                            u = new URL(u, loc);
                            if (!"https".equals(u.getProtocol())) throw new Exception("not https");
                            continue;
                        }
                        if (code != 200) throw new Exception("http " + code);
                        break;
                    }
                    long total = c.getContentLengthLong();
                    long done = 0; int lastPct = -1;
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f)) {
                        byte[] buf = new byte[64 * 1024]; int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n); done += n;
                            if (total > 0) {
                                int pct = (int) (done * 100 / total);
                                if (pct != lastPct && pct < 100) { lastPct = pct; js("window.updProgress&&updProgress(" + pct + ")"); }
                            }
                        }
                    }
                    runOnUiThread(() -> installApk(f));
                } catch (Exception e) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                    js("window.updProgress&&updProgress(-1)");
                } finally {
                    if (c != null) c.disconnect();
                }
            }).start();
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator vb = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vb != null) vb.vibrate(VibrationEffect.createOneShot(Math.max(10, Math.min(ms, 200)), VibrationEffect.DEFAULT_AMPLITUDE));
            } catch (Exception ignored) { }
        }
    }
}

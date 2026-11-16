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

import androidx.webkit.WebViewAssetLoader;

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

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator vb = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vb != null) vb.vibrate(VibrationEffect.createOneShot(Math.max(10, Math.min(ms, 200)), VibrationEffect.DEFAULT_AMPLITUDE));
            } catch (Exception ignored) { }
        }
    }
}

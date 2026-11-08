package com.voltra.standalone;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private final ExecutorService jobs = Executors.newCachedThreadPool();
    private WebView web;
    private NativeGateway gateway;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(7, 17, 31));
        getWindow().setNavigationBarColor(Color.rgb(7, 17, 31));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        web = new WebView(this);
        setContentView(web);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setDefaultTextEncodingName("UTF-8");
        gateway = new NativeGateway(this, this::sendBrowserEvent);
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface public void run(String requestId, String operation, String json) {
                jobs.submit(() -> {
                    String output;
                    try {
                        JSONObject data = new JSONObject(json);
                        output = gateway.dispatch(operation, data).toString();
                    } catch (Exception e) {
                        JSONObject error = new JSONObject();
                        try {
                            error.put("error", e.getMessage() == null ? "Native request failed" : e.getMessage());
                        } catch (Exception ignored) {}
                        output = error.toString();
                    }
                    final String result = output;
                    web.post(() -> web.evaluateJavascript(
                        "window.__voltraNativeDone(" + JSONObject.quote(requestId) + "," +
                        JSONObject.quote(result) + ");", null));
                });
            }
        }, "VoltraAndroid");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Voltra Standalone")
                    .setMessage(message)
                    .setPositiveButton("تأكيد", (d, w) -> result.confirm())
                    .setNegativeButton("إلغاء", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (!APP_HOST.equals(uri.getHost()) || !"https".equals(uri.getScheme())) return null;
                String path = uri.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                if (!path.matches("/[a-zA-Z0-9._/-]+") || path.contains("..")) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
                        java.util.Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
                }
                try {
                    String asset = path.substring(1);
                    InputStream stream = getAssets().open(asset);
                    String mime = asset.endsWith(".html") ? "text/html" :
                        asset.endsWith(".css") ? "text/css" :
                        asset.endsWith(".js") ? "text/javascript" :
                        asset.endsWith(".svg") ? "image/svg+xml" : "text/plain";
                    return new WebResourceResponse(mime, "UTF-8", 200, "OK",
                        java.util.Collections.singletonMap("Cache-Control", "no-store"), stream);
                } catch (IOException ex) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                        java.util.Collections.emptyMap(), new java.io.ByteArrayInputStream(new byte[0]));
                }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if ("https".equals(uri.getScheme()) && APP_HOST.equals(uri.getHost())) return false;
                if ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (Exception ignored) {}
                }
                return true;
            }
        });
        web.loadUrl("https://" + APP_HOST + "/index.html");
    }

    private void sendBrowserEvent(String kind, String payloadJson) {
        if (web == null || isFinishing()) return;
        web.post(() -> {
            if (web != null) web.evaluateJavascript(
                "window.__voltraNativeEvent && window.__voltraNativeEvent(" +
                    JSONObject.quote(kind) + "," + JSONObject.quote(payloadJson) + ");", null);
        });
    }

    @Override protected void onPause() {
        super.onPause();
        if (gateway != null) gateway.stopStreams();
    }
    @Override protected void onResume() {
        super.onResume();
        if (gateway != null) {
            // Android can pause the native socket without WebView firing a
            // visibilitychange event. Restart native streams explicitly.
            jobs.execute(() -> {
                try { gateway.dispatch("startStreams", new JSONObject()); }
                catch (Exception ignored) {}
            });
            if (web != null) web.post(() -> web.evaluateJavascript(
                "if(window.VoltraLive && window.onLiveEvent) {" +
                " window.VoltraLive.start(window.onLiveEvent, window.patchSourceIndicator);" +
                "}", null));
        }
    }
    @Override protected void onDestroy() {
        if (gateway != null) gateway.close();
        jobs.shutdownNow();
        if (web != null) {
            web.removeJavascriptInterface("VoltraAndroid");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

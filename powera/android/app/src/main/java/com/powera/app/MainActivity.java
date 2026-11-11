package com.powera.app;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Original PowerA Android client for the independently implemented Hub.
 * It discovers only IPv4 Hub services on the connected private Wi-Fi /24.
 * All actual power commands are implemented by the Hub's checked JSON API.
 */
public final class MainActivity extends Activity {
    private static final int DEFAULT_PORT = 8098;
    private static final String PREFS = "powera.local";
    private static final String SAVED = "hub";
    private static final int BG = Color.rgb(9, 15, 29);
    private static final int PANEL = Color.rgb(17, 29, 48);
    private static final int WHITE = Color.rgb(238, 246, 255);
    private static final int MUTED = Color.rgb(159, 182, 203);
    private final ExecutorService coordinator = Executors.newSingleThreadExecutor();
    private final ExecutorService workers = Executors.newFixedThreadPool(24);
    private final AtomicBoolean scanning = new AtomicBoolean(false);
    private volatile boolean destroyed = false;
    private WebView browser;
    private LinearLayout discoverView;
    private TextView info;
    private EditText manual;
    private Button scanButton;
    private String connectedOrigin = null;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        getWindow().getDecorView().setSystemUiVisibility(0);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        browser = new WebView(this);
        WebSettings ws = browser.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(false);
        ws.setSupportMultipleWindows(false);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        browser.setOverScrollMode(View.OVER_SCROLL_NEVER);
        browser.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (!request.isForMainFrame()) return false;
                if (sameHub(target)) return false;
                Toast.makeText(MainActivity.this, "PowerA يفتح الـHub المحلي فقط", Toast.LENGTH_SHORT).show();
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (sameHub(Uri.parse(url)) && discoverView != null) {
                    discoverView.setVisibility(View.GONE);
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && discoverView != null) {
                    showWelcome("اتصال PowerA اتقطع. جرّب البحث تاني أو اكتب IP الـHub.");
                }
            }
        });
        root.addView(browser, new FrameLayout.LayoutParams(-1, -1));
        discoverView = new LinearLayout(this);
        discoverView.setOrientation(LinearLayout.VERTICAL);
        discoverView.setGravity(Gravity.CENTER);
        discoverView.setBackgroundColor(BG);
        discoverView.setPadding(dp(24), dp(24), dp(24), dp(24));
        FrameLayout.LayoutParams overlay = new FrameLayout.LayoutParams(-1, -1);
        root.addView(discoverView, overlay);
        createWelcome();
        setContentView(root);
        final String saved = getPreferences().getString(SAVED, "");
        if (!saved.isEmpty()) {
            setInfo("جاري محاولة الاتصال بآخر PowerA Hub...");
            coordinator.execute(() -> {
                HostPort candidate = parseAddress(saved);
                if (candidate != null && probe(candidate)) {
                    runOnUiThread(() -> openHub(candidate));
                } else if (!destroyed) {
                    performScan();
                }
            });
        } else {
            performScan();
        }
    }

    private SharedPreferences getPreferences() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private int dp(float value) {
        return (int) (getResources().getDisplayMetrics().density * value + 0.5f);
    }

    private TextView text(String value, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(value);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        t.setTextDirection(View.TEXT_DIRECTION_RTL);
        return t;
    }

    private void addSpace(int px) {
        View gap = new View(this);
        discoverView.addView(gap, new LinearLayout.LayoutParams(1, dp(px)));
    }

    private void createWelcome() {
        TextView logo = text("ϟ", 74, Color.rgb(93, 242, 197));
        discoverView.addView(logo);
        TextView title = text("PowerA", 35, WHITE);
        title.setTypeface(null, 1);
        discoverView.addView(title);
        addSpace(6);
        discoverView.addView(text("SMART POWER CONTROL", 11, MUTED));
        addSpace(21);
        TextView explainer = text("كل مشتركات Stock وStandalone في مكان واحد\nمن غير حساب أو توكن.", 16, WHITE);
        discoverView.addView(explainer);
        addSpace(17);
        info = text("جاري البحث عن PowerA Hub على Wi-Fi...", 13, MUTED);
        discoverView.addView(info);
        addSpace(20);
        scanButton = new Button(this);
        scanButton.setText("↻  البحث عن الـHub");
        scanButton.setAllCaps(false);
        scanButton.setTextColor(WHITE);
        scanButton.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(70, 103, 238)));
        scanButton.setOnClickListener(v -> performScan());
        discoverView.addView(scanButton, new LinearLayout.LayoutParams(-1, dp(52)));
        addSpace(15);
        manual = new EditText(this);
        manual.setSingleLine(true);
        manual.setHint("IP الكمبيوتر: مثال 192.168.1.10");
        manual.setTextColor(WHITE);
        manual.setHintTextColor(MUTED);
        manual.setTextSize(13);
        manual.setGravity(Gravity.CENTER);
        manual.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        manual.setBackgroundTintList(android.content.res.ColorStateList.valueOf(MUTED));
        discoverView.addView(manual, new LinearLayout.LayoutParams(-1, dp(52)));
        addSpace(8);
        Button connect = new Button(this);
        connect.setText("الاتصال بالعنوان يدويًا");
        connect.setAllCaps(false);
        connect.setTextColor(WHITE);
        connect.setBackgroundTintList(android.content.res.ColorStateList.valueOf(PANEL));
        connect.setOnClickListener(v -> {
            HostPort entry = parseAddress(manual.getText().toString());
            if (entry == null) {
                setInfo("ادخل IPv4 محلي صحيح، مثال 192.168.1.10 أو 192.168.1.10:8098");
                return;
            }
            setInfo("جاري التحقق من PowerA Hub...");
            coordinator.execute(() -> {
                boolean found = probe(entry);
                runOnUiThread(() -> {
                    if (found) openHub(entry);
                    else setInfo("العنوان ده مش بيرد كـPowerA Hub. اتأكد إن السيرفر شغال على نفس Wi-Fi.");
                });
            });
        });
        discoverView.addView(connect, new LinearLayout.LayoutParams(-1, dp(52)));
        addSpace(18);
        discoverView.addView(text("اتصل بنفس Wi-Fi، وشغّل powera.hub على الكمبيوتر أو الراسبيري باي. الاتصال محلي فقط.", 11, MUTED));
    }

    private void showWelcome(String message) {
        discoverView.setVisibility(View.VISIBLE);
        setInfo(message);
    }

    private void setInfo(String message) {
        runOnUiThread(() -> {
            if (info != null && !destroyed) info.setText(message);
        });
    }

    static final class HostPort {
        final String ip;
        final int port;
        HostPort(String ip, int port) { this.ip = ip; this.port = port; }
        String address() { return ip + ":" + port; }
        String origin() { return "http://" + address(); }
    }

    /** Strictly literal, local IPv4; prevents DNS, internet URLs and redirects. */
    static HostPort parseAddress(String text) {
        if (text == null) return null;
        String value = text.trim().replaceFirst("^http://", "").replaceAll("/+$", "");
        String[] host = value.split(":", -1);
        if (host.length > 2 || host.length == 0 || !host[0].matches("[0-9.]+")) return null;
        int port = DEFAULT_PORT;
        if (host.length == 2) {
            if (!host[1].matches("[0-9]{1,5}")) return null;
            try { port = Integer.parseInt(host[1]); }
            catch (NumberFormatException exception) { return null; }
        }
        if (port < 1 || port > 65535) return null;
        String[] octets = host[0].split("\\.", -1);
        if (octets.length != 4) return null;
        int[] parts = new int[4];
        for (int i = 0; i < 4; i++) {
            if (octets[i].isEmpty() || octets[i].length() > 3) return null;
            try { parts[i] = Integer.parseInt(octets[i]); }
            catch (NumberFormatException exception) { return null; }
            if (parts[i] < 0 || parts[i] > 255 || !String.valueOf(parts[i]).equals(octets[i])) return null;
        }
        boolean rfc1918 = parts[0] == 10
            || (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31)
            || (parts[0] == 192 && parts[1] == 168);
        if (!rfc1918 || parts[3] == 0 || parts[3] == 255) return null;
        return new HostPort(host[0], port);
    }

    private static boolean probe(HostPort host) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(host.origin() + "/api/health").openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(550);
            conn.setReadTimeout(600);
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) return false;
            try (InputStream in = conn.getInputStream()) {
                byte[] buffer = new byte[512];
                int count = in.read(buffer);
                if (count <= 0) return false;
                JSONObject json = new JSONObject(new String(buffer, 0, count, StandardCharsets.UTF_8));
                return "PowerA".equals(json.optString("app"))
                    && json.optInt("apiVersion") == 2
                    && json.optBoolean("ok");
            }
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private boolean sameHub(Uri target) {
        if (target == null || connectedOrigin == null || !"http".equals(target.getScheme())) return false;
        Uri known = Uri.parse(connectedOrigin);
        return known.getHost() != null && known.getHost().equals(target.getHost())
            && known.getPort() == target.getPort();
    }

    private void openHub(HostPort host) {
        if (destroyed) return;
        connectedOrigin = host.origin();
        getPreferences().edit().putString(SAVED, host.address()).apply();
        showWelcome("تم العثور على PowerA. جاري فتح لوحة التحكم...");
        browser.loadUrl(connectedOrigin + "/");
    }

    private String currentWifiIp() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            for (Network network : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
                LinkProperties props = cm.getLinkProperties(network);
                if (props == null) continue;
                for (LinkAddress link : props.getLinkAddresses()) {
                    InetAddress addr = link.getAddress();
                    if (addr instanceof Inet4Address) {
                        HostPort valid = parseAddress(addr.getHostAddress());
                        if (valid != null) return valid.ip;
                    }
                }
            }
        } catch (SecurityException ignored) { }
        return null;
    }

    private void performScan() {
        if (!scanning.compareAndSet(false, true) || destroyed) return;
        runOnUiThread(() -> {
            discoverView.setVisibility(View.VISIBLE);
            scanButton.setEnabled(false);
        });
        coordinator.execute(() -> {
            try {
                String current = currentWifiIp();
                if (current == null) {
                    setInfo("اتصل بشبكة Wi-Fi منزلية. أو ادخل عنوان Hub يدويًا.");
                    return;
                }
                String prefix = current.substring(0, current.lastIndexOf('.') + 1);
                setInfo("جاري البحث في الشبكة " + prefix + "0/24 ...");
                ExecutorCompletionService<HostPort> completion = new ExecutorCompletionService<>(workers);
                List<Future<HostPort>> tasks = new ArrayList<>();
                int count = 0;
                for (int index = 1; index <= 254; index++) {
                    String ip = prefix + index;
                    if (ip.equals(current)) continue;
                    final HostPort target = parseAddress(ip);
                    if (target == null) continue;
                    tasks.add(completion.submit(() -> probe(target) ? target : null));
                    count++;
                }
                HostPort found = null;
                for (int i = 0; i < count && !destroyed; i++) {
                    Future<HostPort> next = completion.poll(15, TimeUnit.SECONDS);
                    if (next == null) break;
                    try { found = next.get(); }
                    catch (Exception ignored) { }
                    if (found != null) break;
                    if ((i + 1) % 45 == 0) setInfo("تم فحص " + (i+1) + " من " + count + " عنوان...");
                }
                for (Future<HostPort> item : tasks) item.cancel(true);
                if (found != null) {
                    final HostPort hub = found;
                    runOnUiThread(() -> openHub(hub));
                } else if (!destroyed) {
                    setInfo("ما لقيتش Hub على الشبكة. شغّله على الكمبيوتر ثم جرّب تاني.");
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            } finally {
                scanning.set(false);
                runOnUiThread(() -> { if (!destroyed) scanButton.setEnabled(true); });
            }
        });
    }

    @Override public void onBackPressed() {
        if (discoverView.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
        } else if (browser.canGoBack()) {
            browser.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override protected void onDestroy() {
        destroyed = true;
        coordinator.shutdownNow();
        workers.shutdownNow();
        if (browser != null) {
            browser.stopLoading();
            browser.destroy();
        }
        super.onDestroy();
    }
}

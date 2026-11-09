package com.voltra.standalone;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

final class NativeGateway {
    interface BrowserEmitter { void send(String type, String json); }
    private final Context context;
    private final SharedPreferences prefs;
    private final BrowserEmitter emitter;
    private final ExecutorService scanner = Executors.newFixedThreadPool(20);
    private final Object sourceLock = new Object();
    private final StreamHub streams;
    private volatile boolean shutdown;

    NativeGateway(Context context, BrowserEmitter emitter) {
        this.context = context.getApplicationContext();
        this.emitter = emitter;
        this.prefs = this.context.getSharedPreferences("voltra_standalone", Context.MODE_PRIVATE);
        this.streams = new StreamHub(this);
    }

    JSONObject dispatch(String operation, JSONObject input) throws Exception {
        if (shutdown) throw new Exception("App is closing");
        switch (operation) {
            case "sources": return new JSONObject().put("sources", sources());
            case "add": return new JSONObject().put("source",
                addManual(input.getString("name"), input.getString("url")));
            case "remove":
                remove(input.getString("id"));
                return new JSONObject().put("ok", true);
            case "discover": return discover();
            case "http": return rawHttp(input);
            case "startStreams":
                streams.start();
                return new JSONObject().put("ok", true);
            case "stopStreams":
                streams.stop();
                return new JSONObject().put("ok", true);
            case "network": return new JSONObject().put("wifi", wifiNetwork() != null);
            default: throw new Exception("Unsupported Android operation");
        }
    }

    JSONArray sources() {
        synchronized (sourceLock) {
            try { return new JSONArray(prefs.getString("sources", "[]")); }
            catch (JSONException e) { return new JSONArray(); }
        }
    }
    private void save(JSONArray data) {
        if (!prefs.edit().putString("sources", data.toString()).commit())
            throw new IllegalStateException("Unable to persist device list");
    }
    private static String hostUrl(String raw) throws Exception {
        URL url = new URL(raw);
        if (!"http".equals(url.getProtocol()) || url.getUserInfo() != null ||
            !(url.getPath().isEmpty() || "/".equals(url.getPath())) ||
            url.getQuery() != null || url.getRef() != null ||
            !privateAddress(url.getHost())) {
            throw new Exception("Enter a private LAN HTTP address such as http://192.168.0.55");
        }
        int port = url.getPort();
        if (port != -1 && (port < 1 || port > 65535)) throw new Exception("Invalid port");
        return "http://" + url.getHost() + (port == -1 || port == 80 ? "" : ":" + port);
    }
    static boolean privateAddress(String value) {
        if (!value.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")) return false;
        String[] s = value.split("\\.");
        int[] p = new int[4];
        for (int i = 0; i < 4; i++) {
            p[i] = Integer.parseInt(s[i]);
            if (p[i] > 255) return false;
        }
        return p[0] == 10 || (p[0] == 172 && p[1] >= 16 && p[1] <= 31) ||
            (p[0] == 192 && p[1] == 168);
    }
    private JSONObject addManual(String name, String rawUrl) throws Exception {
        String url = hostUrl(rawUrl);
        if (name == null || name.trim().isEmpty() || name.length() > 64)
            throw new Exception("Device name must be 1–64 characters");
        JSONObject detected = probe(url);
        synchronized (sourceLock) {
            JSONArray list = sources();
            for (int i = 0; i < list.length(); i++) {
                JSONObject old = list.getJSONObject(i);
                if (old.optString("url").equals(url) ||
                    (detected != null && detected.optString("mac").equalsIgnoreCase(old.optString("mac")))) {
                    old.put("name", name.trim());
                    old.put("url", url);
                    if (detected != null) old.put("mac", detected.getString("mac"));
                    save(list);
                    streams.refresh();
                    return old;
                }
            }
            JSONObject item = new JSONObject()
                .put("id", "mobile_" + UUID.randomUUID().toString().replace("-", ""))
                .put("name", name.trim()).put("url", url);
            if (detected != null) item.put("mac", detected.getString("mac"));
            list.put(item);
            save(list);
            streams.refresh();
            return item;
        }
    }
    private void remove(String id) throws Exception {
        synchronized (sourceLock) {
            JSONArray old = sources(), next = new JSONArray();
            for (int i = 0; i < old.length(); i++) {
                JSONObject item = old.getJSONObject(i);
                if (!item.optString("id").equals(id)) next.put(item);
            }
            save(next);
        }
        streams.refresh();
    }
    private JSONObject probe(String origin) {
        try {
            JSONObject status = new JSONObject(http(origin + "/api/status", "GET",
                null, null, 650, 650).getString("body"));
            String mac = status.optString("mac", "");
            if (!mac.matches("(?i)(?:[a-f0-9]{2}:){5}[a-f0-9]{2}") ||
                !status.has("state")) return null;
            JSONObject detail = new JSONObject(http(origin + "/api/device", "GET",
                null, null, 850, 850).getString("body"));
            if (detail.optJSONArray("channels") == null ||
                detail.optJSONArray("channels").length() != 4) return null;
            return new JSONObject().put("mac", mac.toUpperCase(Locale.ROOT))
                .put("name", detail.optString("name", "Voltra " + mac.substring(12)));
        } catch (Exception ignored) { return null; }
    }
    private JSONObject discover() throws Exception {
        Network net = wifiNetwork();
        if (net == null) throw new Exception("Connect your Android phone to the same Wi-Fi network as the strips");
        LinkProperties properties = ((ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE))
            .getLinkProperties(net);
        byte[] ip = null;
        if (properties != null) {
            for (LinkAddress link : properties.getLinkAddresses()) {
                if (link.getAddress() instanceof Inet4Address && link.getPrefixLength() >= 16) {
                    ip = link.getAddress().getAddress();
                    break;
                }
            }
        }
        if (ip == null) throw new Exception("No IPv4 Wi-Fi subnet found. Use manual IP add.");
        String prefix = (ip[0] & 255) + "." + (ip[1] & 255) + "." + (ip[2] & 255) + ".";
        if (!privateAddress(prefix + "1")) throw new Exception("Only private local Wi-Fi subnets are scanned");
        int ownHost = ip[3] & 255;
        final List<Callable<JSONObject>> tasks = new ArrayList<>();
        final AtomicInteger progress = new AtomicInteger();
        for (int i = 1; i <= 254; i++) {
            if (i == ownHost) continue;
            final String origin = "http://" + prefix + i;
            tasks.add(() -> {
                try {
                    JSONObject device = probe(origin);
                    if (device != null) device.put("url", origin);
                    return device;
                } finally {
                    int done = progress.incrementAndGet();
                    if (done % 16 == 0 || done == 253) {
                        try {
                            emit("scan-progress", new JSONObject()
                                .put("scanned", done).put("total", 253));
                        } catch (JSONException ignored) {}
                    }
                }
            });
        }
        List<Future<JSONObject>> results = scanner.invokeAll(tasks, 16, TimeUnit.SECONDS);
        int found = 0;
        JSONArray existing = sources();
        synchronized (sourceLock) {
            for (Future<JSONObject> future : results) {
                if (future.isCancelled()) continue;
                try {
                    JSONObject result = future.get();
                    if (result == null) continue;
                    String mac = result.getString("mac"), origin = result.getString("url");
                    boolean matched = false;
                    for (int j = 0; j < existing.length(); j++) {
                        JSONObject source = existing.getJSONObject(j);
                        if (mac.equalsIgnoreCase(source.optString("mac")) ||
                            origin.equals(source.optString("url"))) {
                            // Keep user-defined name/id, update IP after DHCP moves.
                            source.put("mac", mac);
                            source.put("url", origin);
                            matched = true;
                            break;
                        }
                    }
                    if (!matched) {
                        existing.put(new JSONObject()
                            .put("id", "auto_" + mac.replace(":", ""))
                            .put("mac", mac)
                            .put("url", origin)
                            .put("name", result.optString("name", "Voltra " + origin)));
                    }
                    found++;
                } catch (Exception ignored) {}
            }
            save(existing);
        }
        streams.refresh();
        return new JSONObject().put("sources", existing)
            .put("discovered", found).put("subnet", prefix + "0/24");
    }

    Network wifiNetwork() {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        try {
            for (Network net : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return net;
            }
        } catch (SecurityException ignored) {}
        return null;
    }
    private JSONObject rawHttp(JSONObject args) throws Exception {
        String url = args.getString("url");
        String method = args.optString("method", "GET").toUpperCase(Locale.ROOT);
        JSONObject headers = args.optJSONObject("headers");
        byte[] body = null;
        if (args.has("bodyBase64")) {
            String encoded = args.getString("bodyBase64");
            if (encoded.length() > 1_000_000) throw new Exception("Payload too large");
            body = Base64.decode(encoded, Base64.NO_WRAP);
        } else if (args.has("bodyText")) {
            body = args.getString("bodyText").getBytes(StandardCharsets.UTF_8);
        }
        int timeout = args.optInt("timeout", 5000);
        timeout = Math.max(300, Math.min(timeout, 90000));
        return http(url, method, headers, body, timeout, timeout);
    }
    JSONObject http(String path, String method, JSONObject headers, byte[] body,
                    int connectTimeout, int readTimeout) throws Exception {
        URL uri = new URL(path);
        if (!"http".equals(uri.getProtocol()) || uri.getUserInfo() != null ||
            !privateAddress(uri.getHost()) || !("GET".equals(method) || "POST".equals(method) || "DELETE".equals(method))) {
            throw new Exception("Refused request outside private Wi-Fi LAN");
        }
        Network net = wifiNetwork();
        if (net == null) throw new Exception("Wi-Fi not connected");
        HttpURLConnection conn = (HttpURLConnection) net.openConnection(uri);
        try {
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(connectTimeout);
            conn.setReadTimeout(readTimeout);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "application/json, text/event-stream");
            if (headers != null) {
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (!key.matches("[a-zA-Z0-9-]{1,48}")) throw new Exception("Invalid HTTP header");
                    conn.setRequestProperty(key, headers.getString(key));
                }
            }
            if (body != null && body.length > 0) {
                if (body.length > 524288) throw new Exception("Request exceeds safety size");
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = conn.getOutputStream()) { out.write(body); }
            } else if ("POST".equals(method)) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(0);
            }
            int status = conn.getResponseCode();
            if (status >= 300 && status < 400) throw new Exception("Redirects refused");
            InputStream stream = status < 400 ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (stream != null) try (InputStream in = stream) {
                byte[] block = new byte[4096]; int n;
                while ((n = in.read(block)) >= 0) {
                    out.write(block, 0, n);
                    if (out.size() > 262144) throw new Exception("Firmware response too large");
                }
            }
            return new JSONObject().put("status", status)
                .put("body", out.toString("UTF-8"));
        } finally { conn.disconnect(); }
    }
    void emit(String kind, JSONObject payload) { emitter.send(kind, payload.toString()); }
    void stopStreams() { streams.stop(); }
    void close() {
        shutdown = true;
        streams.close();
        scanner.shutdownNow();
    }
}

package com.voltra.standalone;

import android.net.Network;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class StreamHub {
    private final NativeGateway gateway;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final Map<String, Session> sessions = new HashMap<>();
    private boolean enabled;
    private boolean closed;

    StreamHub(NativeGateway gateway) { this.gateway = gateway; }

    synchronized void start() {
        if (closed) return;
        enabled = true;
        refresh();
    }
    synchronized void refresh() {
        if (!enabled || closed) return;
        JSONArray list = gateway.sources();
        Set<String> active = new HashSet<>();
        for (int i = 0; i < list.length() && i < 48; i++) {
            JSONObject item = list.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("id");
            String url = item.optString("url");
            String mac = item.optString("mac");
            if (!mac.matches("(?i)(?:[a-f0-9]{2}:){5}[a-f0-9]{2}") ||
                !url.startsWith("http://")) continue;
            active.add(id);
            Session old = sessions.get(id);
            if (old != null && old.url.equals(url) && old.mac.equals(mac)) continue;
            if (old != null) old.stop();
            Session session = new Session(id, url, mac);
            sessions.put(id, session);
            workers.submit(session::loop);
        }
        for (String key : new HashSet<>(sessions.keySet())) {
            if (!active.contains(key)) sessions.remove(key).stop();
        }
    }
    synchronized void stop() {
        enabled = false;
        for (Session session : sessions.values()) session.stop();
        sessions.clear();
    }
    synchronized void close() {
        closed = true;
        stop();
        workers.shutdownNow();
    }

    private final class Session {
        final String id, url, mac, deviceId;
        volatile boolean active = true;
        volatile HttpURLConnection connection;
        Session(String id, String url, String mac) {
            this.id = id; this.url = url; this.mac = mac;
            this.deviceId = mac.replace(":", "").toUpperCase(Locale.ROOT);
        }
        void stop() {
            active = false;
            HttpURLConnection conn = connection;
            if (conn != null) conn.disconnect();
        }
        void sendState(boolean connected) {
            try {
                gateway.emit("source", new JSONObject()
                    .put("bridgeId", id).put("deviceId", deviceId)
                    .put("connected", connected).put("at", System.currentTimeMillis()));
            } catch (Exception ignored) {}
        }
        void emit(String kind, JSONObject snapshot) {
            try {
                gateway.emit(kind, new JSONObject()
                    .put("bridgeId", id).put("deviceId", deviceId)
                    .put("at", System.currentTimeMillis()).put("snapshot", snapshot));
            } catch (Exception ignored) {}
        }
        void loop() {
            long retry = 3000;
            while (active && !closed) {
                boolean online = false;
                try {
                    // A DHCP reassignment can put another host at this saved IP.
                    // Do not open a long-lived stream until the live MAC matches.
                    JSONObject result = gateway.http(url + "/api/status", "GET",
                        null, null, 3000, 3000);
                    JSONObject status = new JSONObject(result.getString("body"));
                    if (!mac.equalsIgnoreCase(status.optString("mac")))
                        throw new Exception("MAC mismatch");
                    if (status.optInt("state", -1) != 5)
                        throw new Exception("Device not in station mode");
                    Network net = gateway.wifiNetwork();
                    if (net == null) throw new Exception("Wi-Fi disconnected");
                    HttpURLConnection conn = (HttpURLConnection) net.openConnection(
                        new URL(url + "/api/events"));
                    connection = conn;
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(25000);
                    conn.setUseCaches(false);
                    conn.setRequestProperty("Accept", "text/event-stream");
                    int statusCode = conn.getResponseCode();
                    if (statusCode != 200 ||
                        !conn.getContentType().contains("text/event-stream"))
                        throw new Exception("SSE slot unavailable");
                    online = true; retry = 3000; sendState(true);
                    try (BufferedReader input = new BufferedReader(new InputStreamReader(
                            conn.getInputStream(), StandardCharsets.UTF_8), 2048)) {
                        String line, event = "message";
                        StringBuilder data = new StringBuilder();
                        while (active && (line = input.readLine()) != null) {
                            if (line.length() > 8192 || data.length() > 12000)
                                throw new Exception("Oversized firmware SSE event");
                            if (line.isEmpty()) {
                                if (data.length() > 0 && ("device".equals(event) || "relay".equals(event))) {
                                    JSONObject payload = new JSONObject(data.toString());
                                    if ("device".equals(event)) {
                                        JSONArray channels = payload.optJSONArray("channels");
                                        if (channels != null && channels.length() == 4) emit(event, payload);
                                    } else if (payload.has("known") && payload.has("on") && payload.has("fault") &&
                                        payload.optInt("known", 16) <= 15 && payload.optInt("on", 16) <= 15)
                                        emit(event, payload);
                                }
                                event = "message"; data.setLength(0);
                            } else if (line.startsWith("event:")) event = line.substring(6).trim();
                            else if (line.startsWith("data:")) {
                                if (data.length() > 0) data.append('\n');
                                data.append(line.substring(5).trim());
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // Firmware only supports one upstream SSE client; it may
                    // already be occupied by the strip's own local dashboard.
                } finally {
                    if (online && active) sendState(false);
                    HttpURLConnection conn = connection; connection = null;
                    if (conn != null) conn.disconnect();
                }
                if (!active) break;
                try { Thread.sleep(retry); } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt(); break;
                }
                retry = Math.min(retry * 2, 15000);
            }
        }
    }
}

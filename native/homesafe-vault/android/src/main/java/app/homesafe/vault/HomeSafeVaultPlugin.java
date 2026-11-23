package app.homesafe.vault;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.WindowManager;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native side of window.HomeSafeNative on Android. Files go phone -> Vault over pinned TLS only. */
@CapacitorPlugin(
    name = "HomeSafeVault",
    permissions = {
        @Permission(alias = "media", strings = { Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class HomeSafeVaultPlugin extends Plugin {
    private static final int CHUNK = 4 * 1024 * 1024;
    static final int MANIFEST_PAGE = 5000;
    private static final String PREFS = "homesafe_vault", WRAP = "homesafe_vault_wrap";

    private static final class Item { final String name; final long bytes; final Uri uri; Item(String n, long b, Uri u) { name = n; bytes = b; uri = u; } }
    private static final class Transfer { volatile String state = "running"; volatile long sent = 0; volatile long total = 0; volatile String reason; volatile String code; }
    private static final class Pending { String address, pin, deviceId, challenge, profile, phone; }
    /** Carries the Vault's machine-readable error code (code_expired, phone_revoked, ...) to the screens. */
    static final class VaultException extends Exception { final String code; VaultException(String m, String c) { super(m); code = c; } }
    private static void fail(PluginCall call, Exception e) { if (e instanceof VaultException && ((VaultException) e).code != null) call.reject(message(e), ((VaultException) e).code); else call.reject(message(e)); }

    private final Map<String, Item> picked = new HashMap<>();
    private final Map<String, Transfer> transfers = new HashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Pending pending;
    private volatile boolean pickingFolder;

    // ---------- Wi-Fi ----------

    /** Reports whether the phone is on Wi-Fi and its network name. Android treats the name as location data. */
    @PluginMethod
    public void wifi(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) { requestPermissionForAlias("location", call, "locationPermission"); return; }
        readWifi(call);
    }

    @PermissionCallback
    private void locationPermission(PluginCall call) { readWifi(call); }

    @SuppressWarnings("deprecation")
    private void readWifi(PluginCall call) {
        JSObject out = new JSObject();
        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiInfo info = wm == null ? null : wm.getConnectionInfo();
        boolean on = info != null && info.getNetworkId() != -1;
        out.put("wifi", on);
        String ssid = on ? info.getSSID() : null;
        if (ssid != null && !ssid.equals(WifiManager.UNKNOWN_SSID) && !ssid.equals("<unknown ssid>")) out.put("name", ssid.replaceAll("^\"|\"$", ""));
        call.resolve(out);
    }

    /** Finds Vaults announcing _homesafe._tcp on this Wi-Fi for up to 4 seconds. */
    @PluginMethod
    public void discover(PluginCall call) {
        NsdManager nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        JSArray found = new JSArray();
        NsdManager.DiscoveryListener[] holder = new NsdManager.DiscoveryListener[1];
        holder[0] = new NsdManager.DiscoveryListener() {
            public void onStartDiscoveryFailed(String t, int e) { call.resolve(new JSObject().put("vaults", found)); }
            public void onStopDiscoveryFailed(String t, int e) {}
            public void onDiscoveryStarted(String t) {}
            public void onDiscoveryStopped(String t) {}
            public void onServiceLost(NsdServiceInfo s) {}
            public void onServiceFound(NsdServiceInfo s) {
                nsd.resolveService(s, new NsdManager.ResolveListener() {
                    public void onResolveFailed(NsdServiceInfo i, int e) {}
                    public void onServiceResolved(NsdServiceInfo i) {
                        byte[] fp = i.getAttributes().get("fp"), ver = i.getAttributes().get("v"), nm = i.getAttributes().get("name");
                        if (i.getHost() == null || fp == null) return;
                        JSObject v = new JSObject();
                        v.put("name", nm != null ? new String(nm, StandardCharsets.UTF_8) : i.getServiceName());
                        if (ver != null) v.put("v", new String(ver, StandardCharsets.UTF_8));
                        v.put("address", "https://" + i.getHost().getHostAddress() + ":" + i.getPort());
                        v.put("fingerprint", new String(fp, StandardCharsets.UTF_8));
                        synchronized (found) { found.put(v); }
                    }
                });
            }
        };
        nsd.discoverServices("_homesafe._tcp", NsdManager.PROTOCOL_DNS_SD, holder[0]);
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try { nsd.stopServiceDiscovery(holder[0]); } catch (Exception ignored) {}
            synchronized (found) { call.resolve(new JSObject().put("vaults", found)); }
        }, 4000);
    }

    // ---------- Pairing ----------

    @PluginMethod
    public void begin(PluginCall call) {
        io.execute(() -> {
            try {
                String address = call.getString("address"), pin = clean(call.getString("fingerprint"));
                requirePrivate(address);
                Ed25519PrivateKeyParameters key = signingKey();
                String deviceId = deviceId();
                Map<String, Object> body = new TreeMap<>();
                body.put("email", call.getString("email"));
                body.put("code", call.getString("code"));
                body.put("deviceId", deviceId);
                body.put("publicKey", b64(key.generatePublicKey().getEncoded()));
                body.put("signature", sign(key, body));
                JSONObject offer = post(address, pin, "/v1/pair/begin", body);
                Pending p = new Pending();
                p.address = address; p.pin = pin; p.deviceId = deviceId;
                p.challenge = offer.getString("challenge"); p.profile = offer.getString("profile"); p.phone = offer.getString("phone");
                pending = p;
                JSObject out = new JSObject();
                out.put("requestId", offer.getString("requestId"));
                out.put("expiresAt", offer.getDouble("expiresAt"));
                out.put("email", offer.getString("email"));
                out.put("profile", p.profile);
                out.put("phone", p.phone);
                call.resolve(out);
            } catch (Exception e) { fail(call, e); }
        });
    }

    @PluginMethod
    public void confirm(PluginCall call) {
        io.execute(() -> {
            try {
                Pending p = pending;
                if (p == null) throw new Exception("Start pairing again.");
                String requestId = call.getString("requestId");
                Map<String, Object> message = new TreeMap<>();
                message.put("requestId", requestId); message.put("challenge", p.challenge); message.put("profile", p.profile); message.put("phone", p.phone);
                Map<String, Object> body = new TreeMap<>();
                body.put("requestId", requestId); body.put("signature", sign(signingKey(), message));
                JSONObject session = post(p.address, p.pin, "/v1/pair/confirm", body);
                JSONObject saved = new JSONObject().put("address", p.address).put("pin", p.pin).put("deviceId", p.deviceId);
                putSecret("pairing", saved.toString().getBytes(StandardCharsets.UTF_8));
                pending = null;
                call.resolve(JSObject.fromJSONObject(session));
            } catch (Exception e) { fail(call, e); }
        });
    }

    @PluginMethod
    public void catalog(PluginCall call) {
        io.execute(() -> {
            try {
                JSONObject saved = pairing();
                String deviceId = saved.getString("deviceId"), challenge = challenge(saved);
                Map<String, Object> message = new TreeMap<>();
                message.put("deviceId", deviceId); message.put("challenge", challenge); message.put("action", "catalog");
                Map<String, Object> body = new TreeMap<>();
                body.put("deviceId", deviceId); body.put("challenge", challenge); body.put("signature", sign(signingKey(), message));
                call.resolve(JSObject.fromJSONObject(post(saved.getString("address"), saved.getString("pin"), "/v1/backups", body)));
            } catch (Exception e) { fail(call, e); }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) { picked.clear(); call.resolve(); }

    /** Saved Vault address and pinned fingerprint (no keys), used to find the Vault again after an IP change. */
    @PluginMethod
    public void savedVault(PluginCall call) {
        try {
            byte[] raw = getSecret("pairing");
            if (raw == null) { call.resolve(new JSObject()); return; }
            JSONObject saved = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            call.resolve(new JSObject().put("address", saved.getString("address")).put("fingerprint", saved.getString("pin")));
        } catch (Exception e) { fail(call, e); }
    }

    /** Updates the saved address only when the new Vault presents the same pinned fingerprint. */
    @PluginMethod
    public void relocate(PluginCall call) {
        try {
            String address = call.getString("address"), pin = clean(call.getString("fingerprint"));
            requirePrivate(address);
            JSONObject saved = pairing();
            if (!saved.getString("pin").equals(pin)) throw new VaultException("A different Vault answered at that address. Pair again only if you replaced your Vault.", "certificate_mismatch");
            saved.put("address", address);
            putSecret("pairing", saved.toString().getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (Exception e) { fail(call, e); }
    }

    /** Removes the saved pairing (for example after phone_revoked). The device key stays. */
    @PluginMethod
    public void forget(PluginCall call) {
        prefs().edit().remove("pairing").commit();
        pending = null; picked.clear();
        call.resolve();
    }

    private JSONObject pairing() throws Exception {
        byte[] raw = getSecret("pairing");
        if (raw == null) throw new Exception("This phone is not paired with a Vault yet.");
        return new JSONObject(new String(raw, StandardCharsets.UTF_8));
    }

    private String challenge(JSONObject saved) throws Exception {
        Map<String, Object> body = new TreeMap<>();
        body.put("deviceId", saved.getString("deviceId"));
        return post(saved.getString("address"), saved.getString("pin"), "/v1/device/challenge", body).getString("challenge");
    }

    // ---------- File access ----------

    @PluginMethod
    public void pick(PluginCall call) {
        picked.clear();
        if ("Full".equals(call.getString("kind"))) {
            String alias = Build.VERSION.SDK_INT >= 33 ? "media" : "storage";
            if (getPermissionState(alias) == PermissionState.GRANTED) loadLibrary(call);
            else requestPermissionForAlias(alias, call, "mediaPermission");
            return;
        }
        getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
            .setTitle("Back up")
            .setItems(new String[] { "Files", "A folder" }, (d, which) -> {
                Intent intent;
                pickingFolder = which == 1;
                if (which == 0) {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                } else {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                }
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivityForResult(call, intent, "picked");
            })
            .setOnCancelListener(d -> call.reject("Nothing was chosen."))
            .show());
    }

    @PermissionCallback
    private void mediaPermission(PluginCall call) {
        String alias = Build.VERSION.SDK_INT >= 33 ? "media" : "storage";
        if (getPermissionState(alias) == PermissionState.GRANTED) loadLibrary(call);
        else call.reject("Photo and video access was declined. Allow it in Settings → Apps → HomeSafe → Permissions.");
    }

    private void loadLibrary(PluginCall call) {
        io.execute(() -> {
            try {
                JSArray items = new JSArray();
                Set<String> seen = new HashSet<>();
                for (Uri base : new Uri[] { MediaStore.Images.Media.EXTERNAL_CONTENT_URI, MediaStore.Video.Media.EXTERNAL_CONTENT_URI }) {
                    String[] cols = Build.VERSION.SDK_INT >= 29
                        ? new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.RELATIVE_PATH }
                        : new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE };
                    try (Cursor c = getContext().getContentResolver().query(base, cols, null, null, null)) {
                        while (c != null && c.moveToNext()) {
                            String folder = cols.length > 3 && c.getString(3) != null ? c.getString(3) : "Media/";
                            add(items, seen, folder + safe(c.getString(1)), c.getLong(2), ContentUris.withAppendedId(base, c.getLong(0)));
                        }
                    }
                }
                call.resolve(new JSObject().put("items", items));
            } catch (Exception e) { fail(call, e); }
        });
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) { call.reject("Nothing was chosen."); return; }
        io.execute(() -> {
            try {
                JSArray items = new JSArray();
                Set<String> seen = new HashSet<>();
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) addDocument(items, seen, data.getClipData().getItemAt(i).getUri());
                } else if (pickingFolder && data.getData() != null) {
                    DocumentFile root = DocumentFile.fromTreeUri(getContext(), data.getData());
                    if (root != null) walk(items, seen, root, safe(root.getName()));
                } else if (data.getData() != null) {
                    addDocument(items, seen, data.getData());
                }
                call.resolve(new JSObject().put("items", items));
            } catch (Exception e) { fail(call, e); }
        });
    }

    private void walk(JSArray items, Set<String> seen, DocumentFile dir, String prefix) {
        for (DocumentFile f : dir.listFiles()) {
            String name = prefix + "/" + safe(f.getName());
            if (f.isDirectory()) walk(items, seen, f, name);
            else if (f.isFile()) add(items, seen, name, f.length(), f.getUri());
        }
    }

    private void addDocument(JSArray items, Set<String> seen, Uri uri) {
        String name = "file"; long size = 0;
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) { name = c.getString(0); size = c.isNull(1) ? 0 : c.getLong(1); }
        }
        add(items, seen, safe(name), size, uri);
    }

    private void add(JSArray items, Set<String> seen, String name, long bytes, Uri uri) {
        String candidate = name.replaceAll("/+$", "");
        int n = 2;
        while (seen.contains(candidate.toLowerCase())) {
            int dot = name.lastIndexOf('.'), slash = name.lastIndexOf('/');
            candidate = dot > slash ? name.substring(0, dot) + " (" + n + ")" + name.substring(dot) : name + " (" + n + ")";
            n++;
        }
        seen.add(candidate.toLowerCase());
        String id = UUID.randomUUID().toString();
        picked.put(id, new Item(candidate, bytes, uri));
        items.put(new JSObject().put("name", candidate).put("path", id).put("bytes", bytes));
    }

    private static String safe(String s) {
        String v = (s == null ? "" : s).replaceAll("[\\\\/<>:\"|?*\\x00-\\x1f]", "_").replaceAll("[. ]+$", "");
        if (v.isEmpty() || v.equals("..")) v = "file";
        return v.length() > 80 ? v.substring(0, 80) : v;
    }

    // ---------- Transfer ----------

    @PluginMethod
    public void startBackup(PluginCall call) {
        io.execute(() -> {
            try {
                String name = call.getString("name"), kind = call.getString("kind");
                JSONArray paths = call.getArray("paths");
                List<Item> items = new ArrayList<>();
                for (int i = 0; i < paths.length(); i++) {
                    Item item = picked.get(paths.getString(i));
                    if (item == null) throw new Exception("Choose your files again.");
                    items.add(item);
                }
                if (items.isEmpty()) throw new Exception("Choose your files again.");
                long total = 0; JSONArray listing = new JSONArray();
                for (Item it : items) { total += it.bytes; listing.put(new JSONObject().put("path", it.name).put("bytes", it.bytes)); }
                JSONObject saved = pairing();
                String address = saved.getString("address"), pin = saved.getString("pin"), deviceId = saved.getString("deviceId"), challenge = challenge(saved);
                Map<String, Object> message = new TreeMap<>();
                message.put("deviceId", deviceId); message.put("challenge", challenge); message.put("action", "backup");
                message.put("name", name); message.put("kind", kind); message.put("files", items.size()); message.put("bytes", total);
                Map<String, Object> body = new TreeMap<>();
                body.put("deviceId", deviceId); body.put("challenge", challenge); body.put("signature", sign(signingKey(), message));
                boolean paged = listing.length() > MANIFEST_PAGE;
                body.put("name", name); body.put("kind", kind); body.put("files", paged ? new JSONArray() : listing);
                if (paged) { body.put("fileCount", listing.length()); body.put("bytes", total); }
                JSONObject started = post(address, pin, "/v1/backup/start", body);
                String id = started.getString("transferId"), token = started.getString("token");
                // Above 5,000 files the manifest goes in pages before any chunk is sent.
                for (int offset = 0; paged && offset < listing.length(); offset += MANIFEST_PAGE) {
                    JSONArray page = new JSONArray();
                    for (int i = offset; i < Math.min(offset + MANIFEST_PAGE, listing.length()); i++) page.put(listing.get(i));
                    Map<String, Object> pageBody = new TreeMap<>();
                    pageBody.put("transferId", id); pageBody.put("token", token); pageBody.put("offset", offset); pageBody.put("files", page);
                    post(address, pin, "/v1/backup/files", pageBody);
                }
                Transfer t = new Transfer(); t.total = total;
                synchronized (transfers) { transfers.put(id, t); }
                call.resolve(new JSObject().put("transferId", id));
                keepAwake(true);
                new Thread(() -> { run(address, pin, id, token, items, t); keepAwake(false); }).start();
            } catch (Exception e) { fail(call, e); }
        });
    }

    private void run(String address, String pin, String id, String token, List<Item> items, Transfer t) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            byte[] buffer = new byte[CHUNK];
            for (int index = 0; index < items.size(); index++) {
                Item item = items.get(index);
                long offset = 0;
                try (InputStream in = resolver.openInputStream(item.uri)) {
                    if (in == null) throw new Exception(item.name + " is no longer on this phone.");
                    do {
                        int len = 0, r;
                        while (len < CHUNK && (r = in.read(buffer, len, CHUNK - len)) > 0) len += r;
                        if (offset + len > item.bytes) throw new Exception(item.name + " changed while backing up. Choose it again.");
                        byte[] chunk = java.util.Arrays.copyOf(buffer, len);
                        chunk(address, pin, id, token, index, offset, chunk);
                        offset += len; t.sent += len;
                        if (len == 0) break;
                    } while (offset < item.bytes);
                }
                if (offset != item.bytes) throw new Exception(item.name + " changed while backing up. Choose it again.");
            }
            Map<String, Object> body = new TreeMap<>();
            body.put("transferId", id); body.put("token", token);
            post(address, pin, "/v1/backup/finish", body);
            t.state = "complete";
        } catch (Exception e) { t.reason = message(e); if (e instanceof VaultException) t.code = ((VaultException) e).code; t.state = "failed"; }
    }

    private void keepAwake(boolean on) {
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @PluginMethod
    public void transferStatus(PluginCall call) {
        Transfer t;
        synchronized (transfers) { t = transfers.get(call.getString("transferId")); }
        if (t == null) { call.reject("Unknown transfer."); return; }
        JSObject out = new JSObject().put("state", t.state).put("sentBytes", t.sent).put("totalBytes", t.total);
        if (t.reason != null) out.put("reason", t.reason);
        if (t.code != null) out.put("code", t.code);
        call.resolve(out);
    }

    // ---------- Pinned local HTTPS ----------

    private static void requirePrivate(String address) throws Exception {
        URL url = new URL(address);
        String[] p = url.getHost().split("\\.");
        if (!"https".equals(url.getProtocol()) || p.length != 4) throw new Exception("Use your Vault's local HTTPS address.");
        int a = Integer.parseInt(p[0]), b = Integer.parseInt(p[1]);
        for (String s : p) { int v = Integer.parseInt(s); if (v < 0 || v > 255) throw new Exception("Use an address on your private home network."); }
        if (!(a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168))) throw new Exception("Use an address on your private home network.");
    }

    private HttpsURLConnection open(String address, String pin, String path) throws Exception {
        requirePrivate(address);
        X509TrustManager pinned = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException(); }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("No certificate");
                chain[0].checkValidity();
                try {
                    if (!hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded())).equals(pin)) throw new CertificateException("Vault certificate changed");
                } catch (java.security.NoSuchAlgorithmException e) { throw new CertificateException(e); }
            }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[] { pinned }, new SecureRandom());
        HttpsURLConnection c = (HttpsURLConnection) new URL(address + path).openConnection();
        c.setSSLSocketFactory(tls.getSocketFactory());
        c.setHostnameVerifier((host, session) -> true); // Identity is the pinned certificate, not a hostname.
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        c.setConnectTimeout(10000); c.setReadTimeout(30000);
        c.setRequestMethod("POST"); c.setDoOutput(true);
        return c;
    }

    private JSONObject send(HttpsURLConnection c, byte[] body) throws Exception {
        try {
            c.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = c.getOutputStream()) { out.write(body); }
            int status = c.getResponseCode();
            InputStream in = status == 200 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            if (in != null) { byte[] b = new byte[8192]; int r; while ((r = in.read(b)) > 0) buf.write(b, 0, r); in.close(); }
            JSONObject json = buf.size() > 0 ? new JSONObject(buf.toString("UTF-8")) : new JSONObject();
            if (status < 200 || status >= 300) throw new VaultException(json.optString("error", "The Vault rejected the request."), json.optString("code", null));
            return json;
        } catch (javax.net.ssl.SSLException e) {
            throw new VaultException("Your Vault's certificate does not match. Pair again only if you changed it on purpose.", "certificate_mismatch");
        } catch (java.io.IOException e) {
            throw new VaultException("Lost contact with your Vault. Check Wi-Fi and that the Vault is running.", "unreachable");
        } finally { c.disconnect(); }
    }

    private JSONObject post(String address, String pin, String path, Map<String, Object> body) throws Exception {
        HttpsURLConnection c = open(address, pin, path);
        c.setRequestProperty("Content-Type", "application/json");
        return send(c, new JSONObject(body).toString().getBytes(StandardCharsets.UTF_8));
    }

    private void chunk(String address, String pin, String id, String token, int index, long offset, byte[] data) throws Exception {
        HttpsURLConnection c = open(address, pin, "/v1/backup/chunk");
        c.setRequestProperty("Content-Type", "application/octet-stream");
        c.setRequestProperty("X-Transfer-Id", id);
        c.setRequestProperty("X-Transfer-Token", token);
        c.setRequestProperty("X-File-Index", String.valueOf(index));
        c.setRequestProperty("X-Offset", String.valueOf(offset));
        c.setRequestProperty("X-Sha256", hex(MessageDigest.getInstance("SHA-256").digest(data)));
        send(c, data);
    }

    // ---------- Keys and secure storage ----------

    /** Matches the Node Vault's canonical JSON (sorted keys, no whitespace, JSON.stringify escaping) for flat objects. Checked against protocol/test-vectors.json. */
    /** Key order the Vault uses: Unicode code points (UTF-8 byte order), not Java's default UTF-16 order. */
    static final java.util.Comparator<String> CODE_POINT_ORDER = (a, b) -> {
        int i = 0, j = 0;
        while (i < a.length() && j < b.length()) {
            int x = a.codePointAt(i), y = b.codePointAt(j);
            if (x != y) return Integer.compare(x, y);
            i += Character.charCount(x); j += Character.charCount(y);
        }
        return Integer.compare(a.length() - i, b.length() - j);
    };

    static String canonical(Map<String, Object> value) {
        StringBuilder out = new StringBuilder("{");
        Map<String, Object> sorted = new TreeMap<>(CODE_POINT_ORDER);
        sorted.putAll(value);
        Iterator<Map.Entry<String, Object>> it = sorted.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Object> e = it.next();
            out.append(quote(e.getKey())).append(':');
            Object v = e.getValue();
            out.append(v instanceof String ? quote((String) v) : String.valueOf(((Number) v).longValue()));
            if (it.hasNext()) out.append(',');
        }
        return out.append('}').toString();
    }

    private static String quote(String s) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                default: if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch)); else out.append(ch);
            }
        }
        return out.append('"').toString();
    }

    private static String sign(Ed25519PrivateKeyParameters key, Map<String, Object> message) {
        Map<String, Object> copy = new TreeMap<>(message);
        copy.remove("signature");
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, key);
        byte[] bytes = canonical(copy).getBytes(StandardCharsets.UTF_8);
        signer.update(bytes, 0, bytes.length);
        return b64(signer.generateSignature());
    }

    private Ed25519PrivateKeyParameters signingKey() throws Exception {
        byte[] raw = getSecret("signing-key");
        if (raw == null) { raw = new byte[32]; new SecureRandom().nextBytes(raw); putSecret("signing-key", raw); }
        return new Ed25519PrivateKeyParameters(raw, 0);
    }

    private String deviceId() throws Exception {
        byte[] raw = getSecret("device-id");
        if (raw == null) { raw = ("android_" + UUID.randomUUID().toString().replace("-", "")).getBytes(StandardCharsets.UTF_8); putSecret("device-id", raw); }
        return new String(raw, StandardCharsets.UTF_8);
    }

    /** Values are encrypted with a non-exportable Android Keystore AES key before being stored on the device. */
    private SecretKey wrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(WRAP)) return (SecretKey) ks.getKey(WRAP, null);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(WRAP, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return gen.generateKey();
    }

    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private void putSecret(String name, byte[] value) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, wrapKey());
        byte[] iv = c.getIV(), ct = c.doFinal(value), all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length); System.arraycopy(ct, 0, all, iv.length, ct.length);
        if (!prefs().edit().putString(name, b64(all)).commit()) throw new Exception("Could not save the device key securely.");
    }

    private byte[] getSecret(String name) throws Exception {
        String stored = prefs().getString(name, null);
        if (stored == null) return null;
        byte[] all = Base64.decode(stored, Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, all, 0, 12));
        return c.doFinal(all, 12, all.length - 12);
    }

    private static String b64(byte[] b) { return Base64.encodeToString(b, Base64.NO_WRAP); }
    private static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }
    private static String clean(String pin) { return pin == null ? "" : pin.replace(":", "").toLowerCase(); }
    private static String message(Exception e) { return e.getMessage() != null ? e.getMessage() : "Something went wrong talking to your Vault."; }
}

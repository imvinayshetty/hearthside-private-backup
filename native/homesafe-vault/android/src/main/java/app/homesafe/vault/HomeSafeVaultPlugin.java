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
import javax.net.ssl.SSLSocketFactory;
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
    /** How long a backup keeps trying to reach the Vault again after Wi-Fi drops (the Vault keeps the transfer for 20 minutes). */
    static final long RESUME_WINDOW_MS = 15 * 60 * 1000L;
    private static final String PREFS = "homesafe_vault", WRAP = "homesafe_vault_wrap";

    private static final class Item { String name; long bytes; final Uri uri; long modified; Item(String n, long b, Uri u, long m) { name = n; bytes = b; uri = u; modified = m; } }
    private static final class Transfer { volatile String state = "running"; volatile long sent = 0; volatile long total = 0; volatile String reason; volatile String code; long pollAt = 0, pollSent = 0; double speed = 0;
        /** Files that could not be copied and wait for the owner's decision (index -> reason), files already stored, and files the owner chose to skip. */
        final Map<Integer, String> problems = java.util.Collections.synchronizedMap(new java.util.LinkedHashMap<>());
        final Set<Integer> done = java.util.Collections.synchronizedSet(new HashSet<>()), skipped = java.util.Collections.synchronizedSet(new HashSet<>());
        final java.util.concurrent.BlockingQueue<JSONArray> decisions = new java.util.concurrent.LinkedBlockingQueue<>();
        volatile boolean cancel, staged; List<Item> items; }
    /** One file could not be read or changed while it was being copied. The backup carries on with the next file. */
    static final class FileProblem extends Exception { FileProblem(String m) { super(m); } }
    private interface Step { void go(int index, long offset) throws Exception; }
    private static final class Pending { String address, pin, deviceId, challenge, profile, phone; }
    /** Carries the Vault's machine-readable error code (code_expired, phone_revoked, ...) to the screens. */
    static final class VaultException extends Exception { final String code; VaultException(String m, String c) { super(m); code = c; } }
    private static void fail(PluginCall call, Exception e) { if (e instanceof VaultException && ((VaultException) e).code != null) call.reject(message(e), ((VaultException) e).code); else call.reject(message(e)); }

    private final Map<String, Item> picked = new HashMap<>();
    private final Map<String, Transfer> transfers = new HashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Reads the next chunk from storage while the previous one is on the network. */
    private final ExecutorService readAhead = Executors.newSingleThreadExecutor();
    private SSLSocketFactory cachedFactory; private String cachedPin;
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
                        ? new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.RELATIVE_PATH }
                        : new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED };
                    try (Cursor c = getContext().getContentResolver().query(base, cols, null, null, null)) {
                        while (c != null && c.moveToNext()) {
                            String folder = cols.length > 4 && c.getString(4) != null ? c.getString(4) : "Media/";
                            add(items, seen, folder + safe(c.getString(1)), c.getLong(2), ContentUris.withAppendedId(base, c.getLong(0)), Math.max(0, c.getLong(3)));
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
            else if (f.isFile()) add(items, seen, name, f.length(), f.getUri(), Math.max(0, f.lastModified() / 1000));
        }
    }

    private void addDocument(JSArray items, Set<String> seen, Uri uri) {
        String name = "file"; long size = 0;
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) { name = c.getString(0); size = c.isNull(1) ? 0 : c.getLong(1); }
        }
        add(items, seen, safe(name), size, uri, 0);
    }

    private void add(JSArray items, Set<String> seen, String name, long bytes, Uri uri, long modified) {
        String candidate = name.replaceAll("/+$", "");
        int n = 2;
        while (seen.contains(candidate.toLowerCase())) {
            int dot = name.lastIndexOf('.'), slash = name.lastIndexOf('/');
            candidate = dot > slash ? name.substring(0, dot) + " (" + n + ")" + name.substring(dot) : name + " (" + n + ")";
            n++;
        }
        seen.add(candidate.toLowerCase());
        String id = UUID.randomUUID().toString();
        picked.put(id, new Item(candidate, bytes, uri, modified));
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
                String name = call.getString("name"), kind = call.getString("kind"), basedOn = call.getString("basedOn");
                JSONArray paths = call.getArray("paths");
                List<Item> items = new ArrayList<>();
                for (int i = 0; i < paths.length(); i++) {
                    Item item = picked.get(paths.getString(i));
                    if (item == null) throw new Exception("Choose your files again.");
                    items.add(item);
                }
                if (items.isEmpty()) throw new Exception("Choose your files again.");
                long total = 0; JSONArray listing = new JSONArray();
                for (Item it : items) { total += it.bytes; JSONObject row = new JSONObject().put("path", it.name).put("bytes", it.bytes); if (it.modified > 0) row.put("modified", it.modified); listing.put(row); }
                JSONObject saved = pairing();
                String address = saved.getString("address"), pin = saved.getString("pin"), deviceId = saved.getString("deviceId"), challenge = challenge(saved);
                Map<String, Object> message = new TreeMap<>();
                message.put("deviceId", deviceId); message.put("challenge", challenge); message.put("action", "backup");
                message.put("name", name); message.put("kind", kind); message.put("files", items.size()); message.put("bytes", total);
                Map<String, Object> body = new TreeMap<>();
                body.put("deviceId", deviceId); body.put("challenge", challenge); body.put("signature", sign(signingKey(), message));
                boolean paged = listing.length() > MANIFEST_PAGE;
                body.put("name", name); body.put("kind", kind); body.put("files", paged ? new JSONArray() : listing);
                if (basedOn != null && !basedOn.isEmpty()) body.put("basedOn", basedOn);
                String mode = call.getString("mode"); if ("staged".equals(mode) || "direct".equals(mode)) body.put("mode", mode);
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
                Transfer t = new Transfer(); t.total = total; t.items = items;
                synchronized (transfers) { transfers.put(id, t); }
                call.resolve(new JSObject().put("transferId", id));
                keepAwake(true);
                new Thread(() -> { run(address, pin, id, token, items, t); keepAwake(false); }).start();
            } catch (Exception e) { fail(call, e); }
        });
    }

    /** Keeps Wi-Fi at full speed for the whole copy; with the screen off Android otherwise drops the radio into power-save and throughput collapses. */
    private void run(String address, String pin, String id, String token, List<Item> items, Transfer t) {
        WifiManager.WifiLock lock = null;
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) { lock = wm.createWifiLock(android.os.Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF, "homesafe-backup"); lock.setReferenceCounted(false); lock.acquire(); }
        } catch (Exception ignore) { /* a missing lock only costs speed */ }
        try { runCopy(address, pin, id, token, items, t); }
        finally { try { if (lock != null && lock.isHeld()) lock.release(); } catch (Exception ignore) { /* already released */ } }
    }
    private void runCopy(String address, String pin, String id, String token, List<Item> items, Transfer t) {
        try {
            // Pass 1: every file. A file that cannot be copied is parked and the next one starts.
            retrying(address, pin, id, token, t, (i, o) -> copyFrom(address, pin, id, token, items, t, i, o));
            // Review: the owner decides what happens to parked files (retry, rename, skip) before the backup is finished.
            while (!t.problems.isEmpty()) {
                t.state = "review"; t.reason = null;
                JSONArray actions = null;
                while (actions == null) {
                    if (t.cancel) throw new VaultException("Backup cancelled.", "cancelled");
                    actions = t.decisions.poll(30, java.util.concurrent.TimeUnit.SECONDS);
                    if (actions == null) { try { Map<String, Object> hb = new TreeMap<>(); hb.put("transferId", id); hb.put("token", token); post(address, pin, "/v1/backup/resume", hb); } catch (VaultException ignore) { /* keep waiting */ } }
                }
                if (t.cancel) throw new VaultException("Backup cancelled.", "cancelled");
                t.state = "running";
                applyDecisions(address, pin, id, token, items, t, actions);
                retrying(address, pin, id, token, t, (i, o) -> copyFrom(address, pin, id, token, items, t, 0, 0));
            }
            retrying(address, pin, id, token, t, (i, o) -> { Map<String, Object> body = new TreeMap<>(); body.put("transferId", id); body.put("token", token); t.staged = post(address, pin, "/v1/backup/finish", body).optBoolean("staged", false); });
            t.state = "complete"; t.reason = null;
        } catch (Exception e) {
            t.reason = message(e); if (e instanceof VaultException) t.code = ((VaultException) e).code; t.state = "failed";
            // Tell the Vault right away, so it stops instead of waiting for its idle timeout.
            try { Map<String, Object> body = new TreeMap<>(); body.put("transferId", id); body.put("token", token); post(address, pin, "/v1/backup/abort", body); } catch (Exception ignore) { /* Vault unreachable: it times out on its own */ }
        }
    }

    /** Runs a step; when Wi-Fi drops (or a chunk is rejected) asks the Vault where it stopped and carries on from there. */
    private void retrying(String address, String pin, String id, String token, Transfer t, Step step) throws Exception {
        int index = 0; long offset = 0, lastSent = -1; int stalls = 0;
        for (;;) {
            try { if (t.cancel) throw new VaultException("Backup cancelled.", "cancelled"); step.go(index, offset); return; }
            catch (VaultException e) {
                boolean network = "unreachable".equals(e.code);
                if (!network && !"invalid_request".equals(e.code)) throw e;
                if (!network && (t.sent <= lastSent ? ++stalls : (stalls = 0)) >= 3) throw e;
                lastSent = t.sent;
                long since = System.currentTimeMillis(), wait = 2000;
                for (;;) {
                    if (t.cancel) throw new VaultException("Backup cancelled.", "cancelled");
                    t.state = "waiting"; t.reason = network ? "Waiting for your Vault to come back on Wi-Fi\u2026" : "Retrying\u2026";
                    if (System.currentTimeMillis() - since > RESUME_WINDOW_MS) throw new VaultException("Could not reach your Vault for 15 minutes. Check that it is on and on the same Wi-Fi, then start again.", "unreachable");
                    try { Thread.sleep(wait); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); throw e; }
                    wait = Math.min(wait * 2, 30000);
                    try {
                        Map<String, Object> body = new TreeMap<>(); body.put("transferId", id); body.put("token", token);
                        JSONObject r = post(address, pin, "/v1/backup/resume", body);
                        index = r.getInt("nextIndex"); offset = r.getLong("nextOffset"); t.sent = r.getLong("receivedBytes");
                        t.state = "running"; t.reason = null;
                        break;
                    } catch (VaultException again) { if (!"unreachable".equals(again.code)) throw again; }
                }
            }
        }
    }

    private void applyDecisions(String address, String pin, String id, String token, List<Item> items, Transfer t, JSONArray actions) throws Exception {
        for (int n = 0; n < actions.length(); n++) {
            JSONObject a = actions.getJSONObject(n);
            int index = a.getInt("index"); String action = a.getString("action");
            if (index < 0 || index >= items.size() || !t.problems.containsKey(index)) continue;
            Item item = items.get(index);
            if ("skip".equals(action)) { t.problems.remove(index); t.skipped.add(index); continue; }
            String oldName = item.name; long oldBytes = item.bytes, oldModified = item.modified;
            try {
                if ("rename".equals(action)) {
                    String[] parts = a.optString("name", item.name).split("/"); StringBuilder sb = new StringBuilder();
                    for (String part : parts) { if (part.trim().isEmpty()) continue; if (sb.length() > 0) sb.append('/'); sb.append(safe(part)); }
                    String candidate = sb.toString();
                    if (candidate.isEmpty()) throw new FileProblem("Type a name for this file.");
                    for (int i = 0; i < items.size(); i++) if (i != index && items.get(i).name.equalsIgnoreCase(candidate)) throw new FileProblem("Another file in this backup already has that name.");
                    item.name = candidate;
                }
                item.bytes = currentSize(item.uri); item.modified = System.currentTimeMillis() / 1000;
                Map<String, Object> body = new TreeMap<>();
                body.put("transferId", id); body.put("token", token); body.put("index", index); body.put("path", item.name); body.put("bytes", item.bytes); body.put("modified", item.modified);
                JSONObject r = post(address, pin, "/v1/backup/replace", body);
                t.sent = r.getLong("receivedBytes"); t.total = r.getLong("totalBytes");
                t.problems.remove(index);
            } catch (FileProblem | VaultException e) {
                item.name = oldName; item.bytes = oldBytes; item.modified = oldModified;
                boolean network = e instanceof VaultException && "unreachable".equals(((VaultException) e).code);
                t.problems.put(index, network ? "Could not reach your Vault. Try again." : e instanceof VaultException ? "The Vault did not accept that name." : e.getMessage());
            }
        }
    }

    private long currentSize(Uri uri) throws FileProblem {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (RuntimeException ignore) { /* handled below */ }
        throw new FileProblem("This file is no longer on the phone.");
    }

    private void reportProblem(String address, String pin, String id, String token, int index, Item item, Transfer t, String why) throws Exception {
        Map<String, Object> body = new TreeMap<>();
        body.put("transferId", id); body.put("token", token); body.put("index", index); body.put("reason", why.length() > 200 ? why.substring(0, 200) : why);
        JSONObject r = post(address, pin, "/v1/backup/problem", body);
        t.sent = r.getLong("receivedBytes"); t.problems.put(index, why);
    }

    private static int fill(InputStream in, byte[] buf) throws java.io.IOException { int len = 0, r; while (len < buf.length && (r = in.read(buf, len, buf.length - len)) > 0) len += r; return len; }

    /** Sends every file that is not yet stored, parked or skipped, starting at (startIndex, startOffset). Does not finish the backup. */
    private void copyFrom(String address, String pin, String id, String token, List<Item> items, Transfer t, int startIndex, long startOffset) throws Exception {
        for (int index = startIndex; index < items.size(); index++) {
            if (t.cancel) throw new VaultException("Backup cancelled.", "cancelled");
            if (t.done.contains(index) || t.skipped.contains(index) || t.problems.containsKey(index)) continue;
            Item item = items.get(index);
            try { sendFile(address, pin, id, token, item, index, index == startIndex ? startOffset : 0, t); t.done.add(index); }
            catch (FileProblem p) { reportProblem(address, pin, id, token, index, item, t, item.name + ": " + p.getMessage()); }
        }
    }

    private void sendFile(String address, String pin, String id, String token, Item item, int index, long startOffset, Transfer t) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        byte[][] bufs = { new byte[CHUNK], new byte[CHUNK] };
        long offset = startOffset;
        try (InputStream in = resolver.openInputStream(item.uri)) {
            if (in == null) throw new FileProblem("This file is no longer on the phone.");
            long skipped = 0;
            while (skipped < offset) { long n = in.skip(offset - skipped); if (n <= 0) { if (in.read() < 0) break; n = 1; } skipped += n; }
            if (skipped != offset) throw new FileProblem("The file changed while backing up.");
            int cur = 0, len = fill(in, bufs[0]);
            for (;;) {
                if (offset + len > item.bytes) throw new FileProblem("The file changed while backing up.");
                final int other = 1 - cur; final InputStream src = in;
                java.util.concurrent.Future<Integer> next = offset + len < item.bytes ? readAhead.submit(() -> fill(src, bufs[other])) : null;
                try {
                    chunk(address, pin, id, token, index, offset, java.util.Arrays.copyOf(bufs[cur], len));
                    offset += len; t.sent += len;
                    if (len == 0 || next == null) break;
                    len = next.get(); cur = other;
                } catch (java.util.concurrent.ExecutionException ee) { throw new FileProblem("The file could not be read.");
                } finally { if (next != null && !next.isDone()) next.cancel(true); }
            }
        } catch (java.io.FileNotFoundException | SecurityException e) { throw new FileProblem("This file is no longer on the phone.");
        } catch (java.io.IOException e) { throw new FileProblem("The file could not be read."); }
        if (offset != item.bytes) throw new FileProblem("The file changed while backing up.");
    }

    private void keepAwake(boolean on) {
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    /**
     * Finds this phone's latest complete Full backup on the Vault and works out which of the given items are new or changed since then.
     * Returns { found:false } when there is no earlier Full backup. Items are compared by path and size, and by modified time when both sides have it.
     */
    @PluginMethod
    public void compareWithLastFull(PluginCall call) {
        io.execute(() -> {
            try {
                JSONArray paths = call.getArray("paths");
                JSONObject saved = pairing();
                String address = saved.getString("address"), pin = saved.getString("pin"), deviceId = saved.getString("deviceId"), challenge = challenge(saved);
                Map<String, Object> message = new TreeMap<>();
                message.put("deviceId", deviceId); message.put("challenge", challenge); message.put("action", "baseline");
                Map<String, Object> body = new TreeMap<>();
                body.put("deviceId", deviceId); body.put("challenge", challenge); body.put("signature", sign(signingKey(), message));
                JSONObject first = post(address, pin, "/v1/backup/baseline", body);
                if (!first.optBoolean("found", false)) { call.resolve(new JSObject().put("found", false)); return; }
                String token = first.getString("token");
                Map<String, long[]> base = new HashMap<>(); // path -> { bytes, modified or -1 }
                JSONObject page = first;
                for (;;) {
                    JSONArray entries = page.getJSONArray("entries");
                    for (int i = 0; i < entries.length(); i++) { JSONObject e = entries.getJSONObject(i); base.put(e.getString("path"), new long[] { e.getLong("bytes"), e.has("modified") ? e.getLong("modified") : -1 }); }
                    if (page.isNull("next")) break;
                    Map<String, Object> more = new TreeMap<>();
                    more.put("deviceId", deviceId); more.put("token", token); more.put("offset", page.getLong("next"));
                    page = post(address, pin, "/v1/backup/baseline", more);
                }
                JSArray changed = new JSArray(); long changedBytes = 0; int unchanged = 0;
                for (int i = 0; i < paths.length(); i++) {
                    String id = paths.getString(i); Item it = picked.get(id);
                    if (it == null) throw new Exception("Choose your files again.");
                    long[] b = base.get(it.name);
                    boolean same = b != null && b[0] == it.bytes && (b[1] < 0 || it.modified <= 0 || it.modified <= b[1]);
                    if (same) unchanged++; else { changed.put(id); changedBytes += it.bytes; }
                }
                call.resolve(new JSObject().put("found", true).put("name", first.getString("name")).put("date", first.getString("date"))
                    .put("files", first.getLong("files")).put("bytes", first.getLong("bytes"))
                    .put("changed", changed).put("changedCount", changed.length()).put("changedBytes", changedBytes).put("unchangedCount", unchanged));
            } catch (Exception e) { fail(call, e); }
        });
    }

    /** Which drive the Vault saves to and its free space. With an address and fingerprint: a discovered Vault; without: the paired one. */
    @PluginMethod
    public void vaultStatus(PluginCall call) {
        io.execute(() -> {
            try {
                String address = call.getString("address"), pin;
                if (address == null) { JSONObject saved = pairing(); address = saved.getString("address"); pin = saved.getString("pin"); }
                else pin = clean(call.getString("fingerprint"));
                Map<String, Object> ask = new TreeMap<>();
                Long bytes = call.getLong("bytes"); if (bytes != null && bytes >= 0) ask.put("bytes", bytes);
                if (Boolean.TRUE.equals(call.getBoolean("ask", false))) ask.put("ask", true);
                call.resolve(JSObject.fromJSONObject(post(address, pin, "/v1/status", ask)));
            } catch (Exception e) { fail(call, e); }
        });
    }

    /** Decisions for files that could not be copied: [{ index, action: "retry" | "rename" | "skip", name? }]. */
    @PluginMethod
    public void resolveProblems(PluginCall call) {
        Transfer t;
        synchronized (transfers) { t = transfers.get(call.getString("transferId")); }
        if (t == null || call.getArray("actions") == null) { call.reject("Unknown transfer."); return; }
        t.decisions.offer(call.getArray("actions"));
        call.resolve();
    }

    /** Stops the backup now, on the phone and on the Vault. */
    @PluginMethod
    public void cancelBackup(PluginCall call) {
        Transfer t;
        synchronized (transfers) { t = transfers.get(call.getString("transferId")); }
        if (t == null) { call.reject("Unknown transfer."); return; }
        t.cancel = true; t.decisions.offer(new JSONArray());
        call.resolve();
    }

    /**
     * Where the time goes: Wi-Fi speed (data sent and thrown away for a few seconds) and how fast the Vault's drive and its staging folder write.
     * Nothing is stored on the Vault.
     */
    @PluginMethod
    public void speedTest(PluginCall call) {
        io.execute(() -> {
            try {
                JSONObject saved = pairing();
                String address = saved.getString("address"), pin = saved.getString("pin"), deviceId = saved.getString("deviceId"), challenge = challenge(saved);
                Map<String, Object> message = new TreeMap<>();
                message.put("deviceId", deviceId); message.put("challenge", challenge); message.put("action", "speedtest");
                Map<String, Object> body = new TreeMap<>();
                body.put("deviceId", deviceId); body.put("challenge", challenge); body.put("signature", sign(signingKey(), message));
                String token = post(address, pin, "/v1/speedtest/start", body).getString("token");
                byte[] block = new byte[1024 * 1024]; new SecureRandom().nextBytes(block);
                long started = android.os.SystemClock.elapsedRealtime(), sent = 0;
                while (sent < 32L * 1024 * 1024 && android.os.SystemClock.elapsedRealtime() - started < 8000) {
                    HttpsURLConnection c = open(address, pin, "/v1/speedtest/chunk");
                    c.setRequestProperty("Content-Type", "application/octet-stream");
                    c.setRequestProperty("X-Speedtest-Token", token);
                    send(c, block); sent += block.length;
                }
                double seconds = Math.max(0.001, (android.os.SystemClock.elapsedRealtime() - started) / 1000.0);
                Map<String, Object> fin = new TreeMap<>(); fin.put("token", token);
                JSONObject disk = post(address, pin, "/v1/speedtest/finish", fin);
                JSObject out = new JSObject().put("networkBytesPerSecond", Math.round(sent / seconds)).put("staging", disk.optBoolean("staging", false));
                if (!disk.isNull("driveBytesPerSecond")) out.put("driveBytesPerSecond", disk.getLong("driveBytesPerSecond"));
                if (!disk.isNull("stagingBytesPerSecond")) out.put("stagingBytesPerSecond", disk.getLong("stagingBytesPerSecond"));
                call.resolve(out);
            } catch (Exception e) { fail(call, e); }
        });
    }

    @PluginMethod
    public void transferStatus(PluginCall call) {
        Transfer t;
        synchronized (transfers) { t = transfers.get(call.getString("transferId")); }
        if (t == null) { call.reject("Unknown transfer."); return; }
        long now = android.os.SystemClock.elapsedRealtime(), sent = t.sent;
        if (t.pollAt > 0 && now > t.pollAt) { double inst = (sent - t.pollSent) * 1000.0 / (now - t.pollAt); t.speed = t.speed == 0 ? inst : 0.6 * t.speed + 0.4 * inst; }
        t.pollAt = now; t.pollSent = sent;
        if (!"running".equals(t.state)) t.speed = 0;
        JSObject out = new JSObject().put("state", t.state).put("sentBytes", sent).put("totalBytes", t.total).put("bytesPerSecond", Math.round(Math.max(0, t.speed)));
        if (t.reason != null) out.put("reason", t.reason);
        JSArray review = new JSArray();
        synchronized (t.problems) { for (Map.Entry<Integer, String> e : t.problems.entrySet()) review.put(new JSObject().put("index", e.getKey()).put("name", t.items.get(e.getKey()).name).put("reason", e.getValue())); }
        out.put("problems", review).put("skippedCount", t.skipped.size()).put("staged", t.staged);
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
        // One TLS context per pinned Vault, so connections can be reused instead of a full handshake for every 4 MiB chunk.
        synchronized (this) {
            if (cachedFactory == null || !pin.equals(cachedPin)) {
                SSLContext tls = SSLContext.getInstance("TLS");
                tls.init(null, new TrustManager[] { pinned }, new SecureRandom());
                cachedFactory = tls.getSocketFactory(); cachedPin = pin;
            }
        }
        HttpsURLConnection c = (HttpsURLConnection) new URL(address + path).openConnection();
        c.setSSLSocketFactory(cachedFactory);
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
            c.disconnect();
            throw new VaultException("Your Vault's certificate does not match. Pair again only if you changed it on purpose.", "certificate_mismatch");
        } catch (java.io.IOException e) {
            c.disconnect();
            throw new VaultException("Lost contact with your Vault. Check Wi-Fi and that the Vault is running.", "unreachable");
        } catch (RuntimeException | Error e) { c.disconnect(); throw e;
        }
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
    /** The Vault sorts keys by Unicode code point (UTF-8 byte order). Java's String order is UTF-16, which differs for characters above U+FFFF. */
    static final java.util.Comparator<String> BY_CODE_POINT = (a, b) -> {
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
        Map<String, Object> sorted = new TreeMap<>(BY_CODE_POINT); sorted.putAll(value);
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

package app.homesafe.vault;

import static org.junit.Assert.assertEquals;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** HomeSafeVaultPlugin.canonical must produce exactly the bytes the Vault verifies. */
public class CanonicalVectorsTest {
    private static JSONObject vectors() throws Exception {
        String path = System.getProperty("homesafe.vectors", "../../../protocol/test-vectors.json");
        return new JSONObject(new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8));
    }

    private static Map<String, Object> flat(JSONObject o) throws Exception {
        Map<String, Object> out = new TreeMap<>();
        for (Iterator<String> it = o.keys(); it.hasNext();) { String k = it.next(); Object v = o.get(k); out.put(k, v instanceof String ? v : ((Number) v).longValue()); }
        return out;
    }

    @Test
    public void canonicalMatchesVault() throws Exception {
        JSONArray list = vectors().getJSONArray("vectors");
        for (int i = 0; i < list.length(); i++) {
            JSONObject v = list.getJSONObject(i);
            assertEquals(v.getString("name"), v.getString("canonical"), HomeSafeVaultPlugin.canonical(flat(v.getJSONObject("input"))));
        }
    }

    @Test
    public void ed25519SignaturesMatchVault() throws Exception {
        JSONObject all = vectors();
        byte[] seed = new byte[32];
        String hex = all.getString("seedHex");
        for (int i = 0; i < 32; i++) seed[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        Ed25519PrivateKeyParameters key = new Ed25519PrivateKeyParameters(seed, 0);
        assertEquals(all.getString("publicKey"), Base64.getEncoder().encodeToString(key.generatePublicKey().getEncoded()));
        JSONArray list = all.getJSONArray("vectors");
        for (int i = 0; i < list.length(); i++) {
            JSONObject v = list.getJSONObject(i);
            byte[] bytes = v.getString("canonical").getBytes(StandardCharsets.UTF_8);
            Ed25519Signer signer = new Ed25519Signer(); signer.init(true, key); signer.update(bytes, 0, bytes.length);
            assertEquals(v.getString("name"), v.getString("signature"), Base64.getEncoder().encodeToString(signer.generateSignature()));
        }
    }
}

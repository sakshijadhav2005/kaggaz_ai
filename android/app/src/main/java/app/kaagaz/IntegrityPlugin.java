package app.kaagaz;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.integrity.IntegrityManager;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;

/**
 * Google Play Integrity, classic request. The app asks the Kaagaz proxy for a nonce, gets a token here,
 * and the proxy has Google decode and check it before it issues a device token. See proxy/README.md.
 */
@CapacitorPlugin(name = "Integrity")
public class IntegrityPlugin extends Plugin {

    @PluginMethod
    public void requestToken(PluginCall call) {
        String nonce = call.getString("nonce");
        String project = call.getString("cloudProjectNumber");
        if (nonce == null || project == null) {
            call.reject("nonce and cloudProjectNumber are required");
            return;
        }
        long projectNumber;
        try {
            projectNumber = Long.parseLong(project);
        } catch (NumberFormatException e) {
            call.reject("cloudProjectNumber must be a number");
            return;
        }
        IntegrityManager manager = IntegrityManagerFactory.create(getContext().getApplicationContext());
        manager
            .requestIntegrityToken(IntegrityTokenRequest.builder().setNonce(nonce).setCloudProjectNumber(projectNumber).build())
            .addOnSuccessListener(response -> {
                JSObject out = new JSObject();
                out.put("token", response.token());
                call.resolve(out);
            })
            // Common causes: no Play Store, an outdated Play Store, or no network.
            .addOnFailureListener(e -> call.reject("Play Integrity failed: " + e.getMessage(), e));
    }
}

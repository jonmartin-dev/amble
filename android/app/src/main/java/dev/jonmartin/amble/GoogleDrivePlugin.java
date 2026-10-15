package dev.jonmartin.amble;

import android.accounts.Account;
import android.app.Activity;
import android.os.Bundle;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;

/**
 * Google sign-in for Drive sync, through Google Play services. Once someone has allowed Drive,
 * Android hands out fresh tokens without asking again, so sync never waits for a tap the way it
 * does in a browser. It also opens Google's own picker for joining a household's file.
 */
@CapacitorPlugin(name = "GoogleDrive")
public class GoogleDrivePlugin extends Plugin {

    private static final String APPDATA = "https://www.googleapis.com/auth/drive.appdata";
    private static final String FILE = "https://www.googleapis.com/auth/drive.file";
    private static final List<Scope> SCOPES = Arrays.asList(new Scope(APPDATA), new Scope(FILE));

    private ActivityResultLauncher<IntentSenderRequest> launcher;
    // The call waiting on Google's own screens, and whether it's the picker.
    private PluginCall waiting;
    private boolean picking;

    @Override
    public void load() {
        launcher = bridge.registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onResult);
    }

    private AuthorizationClient client() {
        return Identity.getAuthorizationClient(getActivity());
    }

    /**
     * A Drive token: { accessToken }. Without `interactive` it never shows anything, and rejects
     * with NEEDS_SIGN_IN when Google wants the person to choose or allow again.
     */
    @PluginMethod
    public void authorize(PluginCall call) {
        AuthorizationRequest.Builder request = AuthorizationRequest.builder().setRequestedScopes(SCOPES);
        String email = call.getString("email");
        if (email != null) request.setAccount(new Account(email, "com.google"));
        run(call, request.build(), Boolean.TRUE.equals(call.getBoolean("interactive", false)), false);
    }

    /** Google's picker, for a household file someone shared: { fileId }, null if they backed out. */
    @PluginMethod
    public void pick(PluginCall call) {
        // The picker grants access to the file it picks, which drive.file then covers; it takes no
        // other scope, and always asks.
        AuthorizationRequest.Builder request = AuthorizationRequest.builder()
            .setRequestedScopes(Collections.singletonList(new Scope(FILE)))
            .setOptOutIncludingGrantedScopes(true)
            .setPrompt(AuthorizationRequest.Prompt.CONSENT)
            .addResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_OAUTH_TRIGGER, "true");
        String mimeTypes = call.getString("mimeTypes");
        if (mimeTypes != null) request.addResourceParameter(AuthorizationRequest.ResourceParameter.PICKER_MIMETYPES, mimeTypes);
        String email = call.getString("email");
        if (email != null) request.setAccount(new Account(email, "com.google"));
        run(call, request.build(), true, true);
    }

    /** Forgets a token Google turned down, so the next one asked for is fresh. */
    @PluginMethod
    public void clearToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null) {
            call.resolve();
            return;
        }
        client()
            .clearToken(ClearTokenRequest.builder().setToken(token).build())
            .addOnSuccessListener((v) -> call.resolve())
            .addOnFailureListener((e) -> call.reject(e.getMessage(), "FAILED"));
    }

    /** Takes Amble's Drive access away, for when sync is stopped. */
    @PluginMethod
    public void revoke(PluginCall call) {
        String email = call.getString("email");
        if (email == null) {
            call.reject("Which account?", "FAILED");
            return;
        }
        client()
            .revokeAccess(RevokeAccessRequest.builder().setScopes(SCOPES).setAccount(new Account(email, "com.google")).build())
            .addOnSuccessListener((v) -> call.resolve())
            .addOnFailureListener((e) -> call.reject(e.getMessage(), "FAILED"));
    }

    private void run(PluginCall call, AuthorizationRequest request, boolean interactive, boolean pick) {
        client()
            .authorize(request)
            .addOnSuccessListener((result) -> {
                if (!result.hasResolution()) {
                    call.resolve(answer(result, pick));
                } else if (!interactive) {
                    call.reject("Google needs you to sign in again.", "NEEDS_SIGN_IN");
                } else if (waiting != null) {
                    call.reject("Google is already asking.", "BUSY");
                } else {
                    waiting = call;
                    picking = pick;
                    launcher.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                }
            })
            .addOnFailureListener((e) -> call.reject(failure(e), "FAILED"));
    }

    private void onResult(ActivityResult outcome) {
        PluginCall call = waiting;
        boolean pick = picking;
        waiting = null;
        if (call == null) return;
        if (outcome.getResultCode() != Activity.RESULT_OK || outcome.getData() == null) {
            if (pick) {
                JSObject none = new JSObject();
                none.put("fileId", JSONObject.NULL);
                call.resolve(none);
            } else {
                call.reject("Google sign-in was cancelled.", "CANCELLED");
            }
            return;
        }
        try {
            call.resolve(answer(client().getAuthorizationResultFromIntent(outcome.getData()), pick));
        } catch (ApiException e) {
            call.reject(failure(e), "FAILED");
        }
    }

    private JSObject answer(AuthorizationResult result, boolean pick) {
        JSObject answer = new JSObject();
        answer.put("accessToken", result.getAccessToken());
        answer.put("scopes", new JSArray(result.getGrantedScopes()));
        if (pick) {
            Bundle params = result.getTokenResponseParams();
            String ids = params == null ? null : params.getString("picked_file_ids");
            answer.put("fileId", ids == null || ids.isEmpty() ? JSONObject.NULL : ids.split(",")[0]);
        }
        return answer;
    }

    private static String failure(Exception e) {
        // Google Play services' own wording is for developers; this is what someone can act on.
        return "Google didn't sign you in (" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()) + "). Try again.";
    }
}

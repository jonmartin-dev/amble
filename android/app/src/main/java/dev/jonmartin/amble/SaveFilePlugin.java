package dev.jonmartin.amble;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import org.json.JSONObject;

/**
 * Saves a file where the person picks, on Android's own save screen: Downloads, Google Drive, or
 * anywhere else a storage app offers. For a copy of everything in Amble, which the WebView has no
 * way to download by itself. The app gets access to that one file and nothing else.
 *
 * Picking and writing are two calls. While the save screen is up, Capacitor keeps the waiting
 * call's options in the activity's saved state, which Android caps at about a megabyte, so the
 * bytes can't travel with the pick.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    /** { name, mime } to { uri } of the file the person made, or uri: null when they back out. */
    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "amble.amble"));
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        JSObject answer = new JSObject();
        answer.put("uri", result.getResultCode() == Activity.RESULT_OK && uri != null ? uri.toString() : JSONObject.NULL);
        call.resolve(answer);
    }

    /** { uri from pick, data: the bytes in base64 }. A file it couldn't fill is removed again. */
    @PluginMethod
    public void write(PluginCall call) {
        String where = call.getString("uri");
        String data = call.getString("data");
        if (where == null || data == null) {
            call.reject("Nothing to save.");
            return;
        }
        Uri uri = Uri.parse(where);
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IOException("No stream");
            out.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            try {
                DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
            } catch (Exception ignored) {
                // Left as it is; the person can delete it.
            }
            call.reject("Couldn't save the copy there. Try somewhere else.");
        }
    }
}

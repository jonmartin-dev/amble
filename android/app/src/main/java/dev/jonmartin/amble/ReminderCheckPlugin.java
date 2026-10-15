package dev.jonmartin.amble;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Objects;
import org.json.JSONException;
import org.json.JSONObject;

/** The app's side of the background check for reminders set elsewhere (ReminderCheck). */
@CapacitorPlugin(name = "ReminderCheck")
public class ReminderCheckPlugin extends Plugin {

    /** Checks the household's file in Drive for this person's reminders: { fileId, email, memberId }. */
    @PluginMethod
    public void start(PluginCall call) {
        String fileId = call.getString("fileId");
        String memberId = call.getString("memberId");
        if (fileId == null || memberId == null) {
            call.reject("Which household?", "FAILED");
            return;
        }
        String email = call.getString("email");
        Context context = getContext();
        SharedPreferences prefs = ReminderCheck.prefs(context);
        // Just turned on, or another household or person: start over from the file.
        boolean fresh =
            !prefs.getBoolean(ReminderCheck.ON, false) ||
            !fileId.equals(prefs.getString(ReminderCheck.FILE_ID, null)) ||
            !memberId.equals(prefs.getString(ReminderCheck.MEMBER_ID, null)) ||
            !Objects.equals(email, prefs.getString(ReminderCheck.EMAIL, null));
        if (fresh) {
            ReminderCheck.arm(context, prefs, new JSONObject());
            prefs.edit().remove(ReminderCheck.MD5).apply();
        }
        prefs
            .edit()
            .putBoolean(ReminderCheck.ON, true)
            .putString(ReminderCheck.FILE_ID, fileId)
            .putString(ReminderCheck.MEMBER_ID, memberId)
            .putString(ReminderCheck.EMAIL, email)
            .apply();
        ReminderCheck.start(context);
        call.resolve();
    }

    /** Reminders are off here, or sync is: no more checking, and its alarms are taken back. */
    @PluginMethod
    public void stop(PluginCall call) {
        ReminderCheck.stop(getContext());
        call.resolve();
    }

    /** The reminders the app scheduled, { reminders: { id: time } }: the check leaves those to it. */
    @PluginMethod
    public void handOver(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = ReminderCheck.prefs(context);
        prefs.edit().putString(ReminderCheck.HANDED, call.getObject("reminders", new JSObject()).toString()).apply();
        ReminderCheck.arm(context, prefs, ReminderCheck.read(prefs, ReminderCheck.FOUND));
        call.resolve();
    }

    /** The reminders the check showed: { reminders: { id: time } }. */
    @PluginMethod
    public void shown(PluginCall call) {
        JSObject result = new JSObject();
        try {
            result.put("reminders", JSObject.fromJSONObject(ReminderCheck.read(ReminderCheck.prefs(getContext()), ReminderCheck.SHOWN)));
        } catch (JSONException e) {
            result.put("reminders", new JSONObject());
        }
        call.resolve(result);
    }
}

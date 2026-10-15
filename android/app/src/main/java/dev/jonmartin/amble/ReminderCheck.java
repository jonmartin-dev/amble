package dev.jonmartin.amble;

import android.accounts.Account;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;
import com.google.android.gms.tasks.Tasks;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The phone's background check for reminders set somewhere else: through Claude, or in Amble in a
 * browser. About every 15 minutes (the shortest Android allows for background work), while
 * reminders are on and the household syncs through Google Drive, it reads the household's file as
 * the app does and sets an alarm (ReminderAlarm) for each of this person's coming reminders the
 * app hasn't scheduled itself. The app tells it what it scheduled whenever it runs
 * (ReminderCheckPlugin), so nothing shows twice. Nothing but Drive is involved.
 */
public class ReminderCheck extends Worker {

    static final String PREFS = "amble-reminders";
    static final String ON = "on";
    static final String FILE_ID = "fileId";
    static final String EMAIL = "email";
    static final String MEMBER_ID = "memberId";
    /** The file's checksum when it was last read, so an unchanged file isn't downloaded again. */
    static final String MD5 = "md5";
    /** { reminder id: time } the app scheduled itself, as JSON. */
    static final String HANDED = "handed";
    /** { reminder id: { at, taskId, title, body } } this check found, as JSON; alarms are set from it. */
    static final String FOUND = "found";
    /** { reminder id: time } shown from this check's alarms, as JSON. */
    static final String SHOWN = "shown";

    private static final String TAG = "AmbleReminderCheck";
    private static final String WORK = "reminder-check";
    private static final String DRIVE = "https://www.googleapis.com/drive/v3/files/";
    private static final List<Scope> SCOPES = Arrays.asList(
        new Scope("https://www.googleapis.com/auth/drive.appdata"),
        new Scope("https://www.googleapis.com/auth/drive.file")
    );
    // As many as the app hands the phone (AHEAD in native.ts), well under Android's limit on alarms.
    private static final int AHEAD = 100;
    private static final int TIMEOUT_MS = 30_000;

    public ReminderCheck(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject read(SharedPreferences prefs, String key) {
        try {
            return new JSONObject(prefs.getString(key, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /** Checks about every 15 minutes while there's a network, from now on. */
    static void start(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(ReminderCheck.class, 15, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    /** Stops checking and takes back every alarm it set. */
    static void stop(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK);
        SharedPreferences prefs = prefs(context);
        prefs.edit().putBoolean(ON, false).apply();
        arm(context, prefs, new JSONObject());
        prefs.edit().remove(MD5).remove(HANDED).apply();
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = prefs(context);
        String fileId = prefs.getString(FILE_ID, null);
        String memberId = prefs.getString(MEMBER_ID, null);
        if (!prefs.getBoolean(ON, false) || fileId == null || memberId == null) return Result.success();
        JSONObject found = read(prefs, FOUND);
        try {
            String token = token(context, prefs.getString(EMAIL, null));
            if (token == null) {
                Log.i(TAG, "Google wants a sign-in first; the app asks next time it opens");
            } else {
                String md5 = new JSONObject(text(get(context, token, DRIVE + Uri.encode(fileId) + "?fields=md5Checksum"))).optString("md5Checksum");
                if (md5.isEmpty() || !md5.equals(prefs.getString(MD5, null))) {
                    InputStream file = new GZIPInputStream(get(context, token, DRIVE + Uri.encode(fileId) + "?alt=media"));
                    found = coming(new JSONObject(text(file)), memberId);
                    prefs.edit().putString(MD5, md5).apply();
                    Log.i(TAG, "Read the household: " + found.length() + " coming reminders");
                }
            }
        } catch (Exception e) {
            // Offline, signed out, or a file this version can't read: what it found before still
            // stands, and the next check tries again.
            Log.w(TAG, "Couldn't check the household: " + e);
        }
        // Every time, so alarms lost to a restart come back.
        arm(context, prefs, found);
        return Result.success();
    }

    /** A Drive token, given without asking, or null if Google wants the person to sign in again. */
    private static String token(Context context, String email) throws Exception {
        AuthorizationRequest.Builder request = AuthorizationRequest.builder().setRequestedScopes(SCOPES);
        if (email != null) request.setAccount(new Account(email, "com.google"));
        AuthorizationResult result = Tasks.await(Identity.getAuthorizationClient(context).authorize(request.build()), 30, TimeUnit.SECONDS);
        return result.hasResolution() ? null : result.getAccessToken();
    }

    private static InputStream get(Context context, String token, String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        int status = connection.getResponseCode();
        if (status == 401) {
            // Turned down: the next check asks for a fresh one.
            Identity.getAuthorizationClient(context).clearToken(ClearTokenRequest.builder().setToken(token).build());
        }
        if (status != 200) throw new IOException("Drive said " + status);
        return connection.getInputStream();
    }

    private static String text(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            for (int n; (n = stream.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    /**
     * This person's coming reminders on open tasks in a household's state (server/sync/state.ts),
     * soonest first: { reminder id: { at, taskId, title, body } }.
     */
    static JSONObject coming(JSONObject state, String memberId) throws JSONException {
        JSONObject tables = state.getJSONObject("tables");
        Map<String, JSONObject> tasks = rows(tables.optJSONObject("tasks"));
        JSONObject member = rows(tables.optJSONObject("members")).get(memberId);
        long now = System.currentTimeMillis();
        List<JSONObject> mine = new ArrayList<>();
        for (JSONObject r : rows(tables.optJSONObject("reminders")).values()) {
            JSONObject task = tasks.get(r.optString("task_id"));
            if (!memberId.equals(r.optString("member_id")) || r.optLong("fire_at") <= now) continue;
            if (task == null || !"open".equals(task.optString("status"))) continue;
            mine.add(r);
        }
        mine.sort((a, b) -> Long.compare(a.optLong("fire_at"), b.optLong("fire_at")));
        JSONObject found = new JSONObject();
        for (JSONObject r : mine.subList(0, Math.min(AHEAD, mine.size()))) {
            JSONObject task = tasks.get(r.optString("task_id"));
            long at = r.optLong("fire_at");
            JSONObject one = new JSONObject().put("at", at).put("taskId", task.optString("id")).put("title", task.optString("title"));
            String body = body(task, member, at);
            if (body != null) one.put("body", body);
            found.put(r.optString("id"), one);
        }
        return found;
    }

    /** A table's living rows by id, each as { column: value }. */
    private static Map<String, JSONObject> rows(JSONObject table) throws JSONException {
        Map<String, JSONObject> out = new HashMap<>();
        if (table == null) return out;
        JSONArray cols = table.getJSONArray("cols");
        Map<String, String> dead = new HashMap<>();
        JSONArray removed = table.optJSONArray("dead");
        for (int i = 0; removed != null && i < removed.length(); i++) dead.put(removed.getJSONArray(i).getString(0), removed.getJSONArray(i).getString(1));
        JSONArray rows = table.getJSONArray("rows");
        for (int i = 0; i < rows.length(); i++) {
            JSONArray row = rows.getJSONArray(i);
            String gone = dead.get(row.getString(0));
            JSONArray times = row.optJSONArray(2);
            if (gone != null && times != null && gone.compareTo(latest(times)) > 0) continue;
            JSONArray values = row.getJSONArray(1);
            JSONObject obj = new JSONObject();
            for (int c = 0; c < cols.length(); c++) obj.put(cols.getString(c), values.opt(c));
            out.put(obj.optString("id"), obj);
        }
        return out;
    }

    private static String latest(JSONArray times) {
        String max = "";
        for (int i = 0; i < times.length(); i++) if (times.optString(i).compareTo(max) > 0) max = times.optString(i);
        return max;
    }

    /** The line under the title, as the app words it (reminderBody in server/notify/reminders.ts). */
    private static String body(JSONObject task, JSONObject member, long at) {
        String due = text(task, "due_date");
        if (due != null && member != null) {
            String tz = text(member, "timezone");
            Calendar day = Calendar.getInstance(tz == null ? TimeZone.getDefault() : TimeZone.getTimeZone(tz));
            day.setTimeInMillis(at);
            // The planning day turns over at the cutoff (4am), not midnight.
            if (day.get(Calendar.HOUR_OF_DAY) < member.optInt("day_cutoff_hour", 4)) day.add(Calendar.DAY_OF_MONTH, -1);
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
            format.setTimeZone(day.getTimeZone());
            if (due.equals(format.format(day.getTime()))) return "Due today";
            day.add(Calendar.DAY_OF_MONTH, 1);
            if (due.equals(format.format(day.getTime()))) return "Due tomorrow";
        }
        String notes = text(task, "notes");
        if (notes == null) return null;
        for (String line : notes.split("\n")) {
            String note = line.trim();
            if (!note.isEmpty()) return note.length() > 120 ? note.substring(0, 119) + "…" : note;
        }
        return null;
    }

    private static String text(JSONObject row, String col) {
        return row.isNull(col) ? null : row.optString(col);
    }

    /**
     * Sets an alarm for each reminder found that the app hasn't scheduled and that hasn't shown,
     * and takes back the ones no longer wanted.
     */
    static void arm(Context context, SharedPreferences prefs, JSONObject found) {
        JSONObject handed = read(prefs, HANDED);
        JSONObject shown = read(prefs, SHOWN);
        JSONObject before = read(prefs, FOUND);
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        for (Iterator<String> ids = before.keys(); ids.hasNext(); ) {
            String id = ids.next();
            if (!found.has(id)) alarms.cancel(alarm(context, id, before.optJSONObject(id)));
        }
        long now = System.currentTimeMillis();
        boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms();
        for (Iterator<String> ids = found.keys(); ids.hasNext(); ) {
            String id = ids.next();
            JSONObject reminder = found.optJSONObject(id);
            if (reminder == null) continue;
            long at = reminder.optLong("at");
            PendingIntent intent = alarm(context, id, reminder);
            if (at <= now || handed.optLong(id, -1) == at || shown.optLong(id, -1) == at) {
                alarms.cancel(intent);
            } else if (exact) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent);
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent);
            }
        }
        prefs.edit().putString(FOUND, found.toString()).apply();
    }

    private static PendingIntent alarm(Context context, String id, JSONObject reminder) {
        Intent intent = new Intent(context, ReminderAlarm.class)
            .setData(Uri.parse("amble-reminder:" + Uri.encode(id)))
            .putExtra("reminderId", id);
        if (reminder != null) {
            intent
                .putExtra("taskId", reminder.optString("taskId"))
                .putExtra("title", reminder.optString("title"))
                .putExtra("body", reminder.isNull("body") ? null : reminder.optString("body"))
                .putExtra("at", reminder.optLong("at"));
        }
        return PendingIntent.getBroadcast(context, ReminderAlarm.notificationId(id), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}

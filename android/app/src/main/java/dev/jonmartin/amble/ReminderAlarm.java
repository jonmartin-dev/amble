package dev.jonmartin.amble;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Iterator;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Shows a reminder the background check (ReminderCheck) found, at its time, unless the app
 * scheduled it after all. It looks and works like the app's own: a tap opens the task, and Done
 * and Snooze go to the app, which tells the household.
 */
public class ReminderAlarm extends BroadcastReceiver {

    // As in web/src/lib/native.ts and capacitor.config.ts.
    private static final String CHANNEL = "reminders";
    private static final int COLOR = 0xFF2E6A57;
    private static final String SCHEME = "dev.jonmartin.amble";
    private static final long KEEP_MS = 7L * 24 * 60 * 60 * 1000;

    /** The id the app's own notification for a reminder has (notificationId in native.ts). */
    static int notificationId(String reminderId) {
        return reminderId.hashCode() & 0x7fffffff;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        SharedPreferences prefs = ReminderCheck.prefs(context);
        String reminderId = intent.getStringExtra("reminderId");
        String taskId = intent.getStringExtra("taskId");
        String title = intent.getStringExtra("title");
        long at = intent.getLongExtra("at", -1);
        if (!prefs.getBoolean(ReminderCheck.ON, false) || reminderId == null || taskId == null || title == null) return;
        JSONObject shown = ReminderCheck.read(prefs, ReminderCheck.SHOWN);
        if (ReminderCheck.read(prefs, ReminderCheck.HANDED).optLong(reminderId, -1) == at || shown.optLong(reminderId, -1) == at) return;
        if (!show(context, reminderId, taskId, title, intent.getStringExtra("body"), at)) return;

        // Kept a week, so the app catching up later doesn't show it again.
        long now = System.currentTimeMillis();
        for (Iterator<String> ids = shown.keys(); ids.hasNext(); ) {
            if (shown.optLong(ids.next()) < now - KEEP_MS) ids.remove();
        }
        try {
            shown.put(reminderId, at);
        } catch (JSONException ignored) {
            // A string key and a number always go in.
        }
        prefs.edit().putString(ReminderCheck.SHOWN, shown.toString()).apply();
    }

    private static boolean show(Context context, String reminderId, String taskId, String title, String body, long at) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return false;
        // The app makes the channel when reminders are turned on; this is in case it's gone.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("The reminders you set on tasks");
            manager.createNotificationChannel(channel);
        }
        int id = notificationId(reminderId);
        String task = "task/" + taskId;
        String act = task + "?reminder=" + Uri.encode(reminderId) + "&notification=" + id + "&do=";
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_amble)
            .setColor(COLOR)
            .setContentTitle(title)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setWhen(at)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(open(context, task, id))
            .addAction(0, "Done", open(context, act + "done", id))
            .addAction(0, "Snooze 1 hour", open(context, act + "snooze", id));
        if (body != null && !body.isEmpty()) builder.setContentText(body);
        try {
            manager.notify(id, builder.build());
            return true;
        } catch (SecurityException e) {
            // Notifications were turned off for Amble in Android's settings.
            return false;
        }
    }

    /** Opens the app at `path`, as the widget's links do (the App plugin hands it to the page). */
    private static PendingIntent open(Context context, String path, int code) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(SCHEME + "://" + path), context, MainActivity.class);
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}

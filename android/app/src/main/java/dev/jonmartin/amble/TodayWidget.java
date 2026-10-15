package dev.jonmartin.amble;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The home-screen widget: today's tasks and how full the day is, in the app's Material 3 colors.
 * The data lives in the app's WebView, which a widget can't read, so the app hands over a copy
 * whenever it changes (TodayWidgetPlugin), with its theme's colors for light and dark, and the
 * widget draws that until the day it's for is over. A task opens in the app; + opens quick add.
 */
public class TodayWidget extends AppWidgetProvider {

    static final String PREFS = "amble-widget";
    static final String KEY = "today";
    private static final String SCHEME = "dev.jonmartin.amble";
    // Before Android 12 the list can't scroll, so it shows what fits.
    private static final int ROWS_WITHOUT_SCROLLING = 4;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) manager.updateAppWidget(id, render(context));
    }

    /** Draws every Amble widget again, after the app handed over a new day. */
    static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, TodayWidget.class));
        for (int id : ids) manager.updateAppWidget(id, render(context));
    }

    private static RemoteViews render(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_today);
        JSONObject day = saved(context);
        Palette colors = new Palette(context, day == null ? null : day.optJSONObject("colors"));

        colors.tint(views, R.id.widget_surface, "surface");
        colors.tint(views, R.id.widget_add_shape, "primaryContainer");
        colors.tint(views, R.id.widget_add_icon, "onPrimaryContainer");
        colors.text(views, R.id.widget_title, "onSurface");
        colors.text(views, R.id.widget_date, "onSurfaceVariant");
        colors.text(views, R.id.widget_note, "onSurfaceVariant");
        views.setOnClickPendingIntent(R.id.widget_header, open(context, "today", 0));
        views.setOnClickPendingIntent(android.R.id.background, open(context, "today", 0));
        views.setOnClickPendingIntent(R.id.widget_add, open(context, "add", 1));

        // A day that's over says nothing about today: the app fills it in next time it opens.
        if (day == null || day.optLong("validUntil") < System.currentTimeMillis()) {
            views.setTextViewText(R.id.widget_date, "");
            views.setViewVisibility(R.id.widget_load, View.GONE);
            views.setViewVisibility(R.id.widget_bar, View.GONE);
            note(views, "Open Amble to see today.");
            return views;
        }

        views.setTextViewText(R.id.widget_date, day.optString("date"));
        boolean heavy = day.optBoolean("heavy");
        views.setTextViewText(R.id.widget_load, day.optString("load"));
        colors.pill(views, R.id.widget_load, heavy ? "warmContainer" : "secondaryContainer", heavy ? "onWarmContainer" : "onSecondaryContainer");
        views.setProgressBar(R.id.widget_bar, 100, Math.max(day.optInt("percent"), 2), false);
        colors.bar(views, R.id.widget_bar, heavy ? "warm" : "primary", "track");

        JSONArray tasks = day.optJSONArray("tasks");
        int count = tasks == null ? 0 : tasks.length();
        if (count == 0) {
            note(views, "Nothing planned. That's allowed.");
            return views;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            RemoteViews.RemoteCollectionItems.Builder items = new RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(true).setViewTypeCount(1);
            for (int i = 0; i < count; i++) {
                JSONObject task = tasks.optJSONObject(i);
                RemoteViews row = row(context, colors, task);
                row.setOnClickFillInIntent(R.id.row, new Intent().setData(link("task/" + task.optString("id"))));
                items.addItem(task.optString("id").hashCode(), row);
            }
            views.setRemoteAdapter(R.id.widget_list, items.build());
            Intent template = new Intent(Intent.ACTION_VIEW).setClass(context, MainActivity.class);
            views.setPendingIntentTemplate(
                R.id.widget_list,
                PendingIntent.getActivity(context, 2, template, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
            );
            views.setViewVisibility(R.id.widget_list, View.VISIBLE);
        } else {
            views.removeAllViews(R.id.widget_rows);
            int shown = Math.min(count, ROWS_WITHOUT_SCROLLING);
            for (int i = 0; i < shown; i++) {
                JSONObject task = tasks.optJSONObject(i);
                RemoteViews row = row(context, colors, task);
                row.setOnClickPendingIntent(R.id.row, open(context, "task/" + task.optString("id"), 10 + i));
                views.addView(R.id.widget_rows, row);
            }
            views.setViewVisibility(R.id.widget_rows, View.VISIBLE);
            if (count > shown) note(views, "and " + (count - shown) + " more");
        }
        return views;
    }

    private static RemoteViews row(Context context, Palette colors, JSONObject task) {
        RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_today_row);
        row.setTextViewText(R.id.row_title, task.optString("title"));
        row.setTextViewText(R.id.row_label, task.optString("label"));
        colors.tint(row, R.id.row_shape, "row");
        colors.tint(row, R.id.row_ring, task.optBoolean("mustDo") ? "primary" : "outline");
        colors.text(row, R.id.row_title, "onSurface");
        colors.text(row, R.id.row_label, task.optBoolean("due") ? "warm" : "onSurfaceVariant");
        return row;
    }

    private static void note(RemoteViews views, String text) {
        views.setTextViewText(R.id.widget_note, text);
        views.setViewVisibility(R.id.widget_note, View.VISIBLE);
    }

    private static Uri link(String path) {
        return Uri.parse(SCHEME + "://" + path);
    }

    /** Opens the app at `path` (the app's App plugin passes the link to the page). */
    private static PendingIntent open(Context context, String path, int code) {
        Intent intent = new Intent(Intent.ACTION_VIEW, link(path), context, MainActivity.class);
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static JSONObject saved(Context context) {
        String json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
        if (json == null) return null;
        try {
            return new JSONObject(json);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * The app's theme colors, light and dark. Android 12 and up switch between them by themselves
     * when the phone goes dark; before that, the widget takes the ones for now.
     */
    private static final class Palette {

        // Amble's default theme (Grove), until the app hands over its own.
        private static final String DEFAULTS =
            "{\"light\":{\"surface\":\"#F4FBF7\",\"row\":\"#E3EAE6\",\"onSurface\":\"#171D1A\",\"onSurfaceVariant\":\"#3F4945\"," +
            "\"primary\":\"#2E6A57\",\"primaryContainer\":\"#B1F0D7\",\"onPrimaryContainer\":\"#002117\"," +
            "\"secondaryContainer\":\"#CDE9DD\",\"onSecondaryContainer\":\"#082019\",\"outline\":\"#6F7975\",\"track\":\"#D7E7E0\"," +
            "\"warm\":\"#8B5000\",\"warmContainer\":\"#FFDCBE\",\"onWarmContainer\":\"#2C1600\"}," +
            "\"dark\":{\"surface\":\"#0F1512\",\"row\":\"#252B28\",\"onSurface\":\"#DEE4DF\",\"onSurfaceVariant\":\"#BFC9C3\"," +
            "\"primary\":\"#95D4BD\",\"primaryContainer\":\"#0F513F\",\"onPrimaryContainer\":\"#B1F0D7\"," +
            "\"secondaryContainer\":\"#334B42\",\"onSecondaryContainer\":\"#CDE9DD\",\"outline\":\"#89938E\",\"track\":\"#2C3A34\"," +
            "\"warm\":\"#FFB870\",\"warmContainer\":\"#6A3C00\",\"onWarmContainer\":\"#FFDCBE\"}}";

        private final JSONObject light;
        private final JSONObject dark;
        private final boolean night;

        Palette(Context context, JSONObject given) {
            JSONObject defaults;
            try {
                defaults = new JSONObject(DEFAULTS);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
            JSONObject colors = given != null && given.has("light") && given.has("dark") ? given : defaults;
            light = colors.optJSONObject("light");
            dark = colors.optJSONObject("dark");
            night = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        }

        private static int parse(JSONObject from, String key) {
            try {
                return Color.parseColor(from.optString(key, "#808080"));
            } catch (IllegalArgumentException e) {
                return Color.GRAY;
            }
        }

        private void set(RemoteViews views, int id, String method, String key) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                views.setColorInt(id, method, parse(light, key), parse(dark, key));
            } else {
                views.setInt(id, method, parse(night ? dark : light, key));
            }
        }

        /** Colors a white shape or icon. */
        void tint(RemoteViews views, int id, String key) {
            set(views, id, "setColorFilter", key);
        }

        void text(RemoteViews views, int id, String key) {
            set(views, id, "setTextColor", key);
        }

        /**
         * A text on a tinted pill (Android 12 and up; before that it keeps the default theme's, since
         * an older widget can't tint a background).
         */
        void pill(RemoteViews views, int id, String background, String text) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
            views.setColorStateList(id, "setBackgroundTintList", ColorStateList.valueOf(parse(light, background)), ColorStateList.valueOf(parse(dark, background)));
            text(views, id, text);
        }

        /** The load bar's fill and track (Android 12 and up; before that it keeps the default theme's). */
        void bar(RemoteViews views, int id, String fill, String track) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
            views.setColorStateList(id, "setProgressTintList", ColorStateList.valueOf(parse(light, fill)), ColorStateList.valueOf(parse(dark, fill)));
            views.setColorStateList(id, "setProgressBackgroundTintList", ColorStateList.valueOf(parse(light, track)), ColorStateList.valueOf(parse(dark, track)));
        }
    }
}

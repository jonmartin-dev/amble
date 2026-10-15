package dev.jonmartin.almanac;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The home-screen widget's side of the app (TodayWidget): handing it today, and placing it. */
@CapacitorPlugin(name = "TodayWidget")
public class TodayWidgetPlugin extends Plugin {

    /** Today's tasks for the widget: { validUntil, load, lines, more }. */
    @PluginMethod
    public void update(PluginCall call) {
        Context context = getContext();
        context.getSharedPreferences(TodayWidget.PREFS, Context.MODE_PRIVATE).edit().putString(TodayWidget.KEY, call.getData().toString()).apply();
        TodayWidget.refresh(context);
        call.resolve();
    }

    /** Asks the home screen to place the widget, if it takes requests: { asked }. */
    @PluginMethod
    public void pin(PluginCall call) {
        AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
        boolean asked =
            manager.isRequestPinAppWidgetSupported() && manager.requestPinAppWidget(new ComponentName(getContext(), TodayWidget.class), null, null);
        JSObject result = new JSObject();
        result.put("asked", asked);
        call.resolve(result);
    }
}

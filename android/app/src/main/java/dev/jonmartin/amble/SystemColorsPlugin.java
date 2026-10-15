package dev.jonmartin.amble;

import android.content.Context;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * The colors Android 12 and later make from the wallpaper (Material You), for the app's theme to
 * follow when someone picks the phone's colors in Appearance.
 */
@CapacitorPlugin(name = "SystemColors")
public class SystemColorsPlugin extends Plugin {

    private static final String[] PALETTES = { "accent1", "accent2", "accent3", "neutral1", "neutral2" };
    // Tones 90 down to 10, as Android numbers them (system_accent1_100 and so on).
    private static final int[] SHADES = { 100, 200, 300, 400, 500, 600, 700, 800, 900 };

    /** { palettes: { accent1: ["#rrggbb", ...], ... } }, or palettes: null before Android 12. */
    @PluginMethod
    public void palettes(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            result.put("palettes", JSONObject.NULL);
            call.resolve(result);
            return;
        }
        Context context = getContext();
        JSObject palettes = new JSObject();
        for (String palette : PALETTES) {
            JSArray tones = new JSArray();
            for (int shade : SHADES) {
                // By name, so the 45 resource ids needn't be listed out.
                int id = context.getResources().getIdentifier("system_" + palette + "_" + shade, "color", "android");
                if (id == 0) continue;
                tones.put(String.format("#%06x", context.getColor(id) & 0xffffff));
            }
            palettes.put(palette, tones);
        }
        result.put("palettes", palettes);
        call.resolve(result);
    }
}

package dev.jonmartin.amble;

import androidx.activity.BackEventCompat;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android's back gesture as it's made (predictive back): while a task or list is open, the app
 * hears how far along the swipe is, so the page can shrink with the finger, and then whether it
 * went through. Off the rest of the time, so Back works as Capacitor's App plugin has it.
 */
@CapacitorPlugin(name = "BackGesture")
public class BackGesturePlugin extends Plugin {

    private OnBackPressedCallback callback;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            // Added on first use, after the App plugin's own: the newest callback hears Back first.
            if (callback == null) {
                callback = new OnBackPressedCallback(false) {
                    @Override
                    public void handleOnBackStarted(BackEventCompat event) {
                        notifyListeners("start", describe(event));
                    }

                    @Override
                    public void handleOnBackProgressed(BackEventCompat event) {
                        notifyListeners("progress", describe(event));
                    }

                    @Override
                    public void handleOnBackCancelled() {
                        notifyListeners("cancel", new JSObject());
                    }

                    @Override
                    public void handleOnBackPressed() {
                        notifyListeners("back", new JSObject());
                    }
                };
                getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), callback);
            }
            callback.setEnabled(enabled);
            call.resolve();
        });
    }

    private static JSObject describe(BackEventCompat event) {
        JSObject data = new JSObject();
        data.put("progress", event.getProgress());
        data.put("edge", event.getSwipeEdge() == BackEventCompat.EDGE_RIGHT ? "right" : "left");
        return data;
    }
}

package dev.jonmartin.amble;

import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The phone's own touch feedback for a moment in the app: the same small clicks Android's switches,
 * long presses and swipes make, rather than a timed buzz. They follow the phone's touch feedback
 * setting, so with it off nothing plays. Older Android gets the nearest one it has.
 */
@CapacitorPlugin(name = "TouchFeedback")
public class TouchFeedbackPlugin extends Plugin {

    @PluginMethod
    public void play(PluginCall call) {
        int feedback = feedback(call.getString("kind", ""));
        WebView view = bridge.getWebView();
        if (feedback >= 0 && view != null) getActivity().runOnUiThread(() -> view.performHapticFeedback(feedback));
        call.resolve();
    }

    private static int feedback(String kind) {
        boolean android14 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE;
        switch (kind) {
            // A task or an item ticked off, and unticked.
            case "done":
                return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CONTEXT_CLICK;
            case "undone":
                return android14 ? HapticFeedbackConstants.TOGGLE_OFF : HapticFeedbackConstants.CLOCK_TICK;
            // A switch.
            case "on":
                return android14 ? HapticFeedbackConstants.TOGGLE_ON : HapticFeedbackConstants.CLOCK_TICK;
            case "off":
                return android14 ? HapticFeedbackConstants.TOGGLE_OFF : HapticFeedbackConstants.CLOCK_TICK;
            // One of a few choices: a chip, a segment, a row in a list of answers.
            case "pick":
                return android14 ? HapticFeedbackConstants.SEGMENT_TICK : HapticFeedbackConstants.CLOCK_TICK;
            case "hold":
                return HapticFeedbackConstants.LONG_PRESS;
            // A swipe past the point where letting go will act.
            case "line":
                return android14 ? HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE : HapticFeedbackConstants.CONTEXT_CLICK;
            default:
                return -1;
        }
    }
}

package dev.jonmartin.amble;

import android.animation.ValueAnimator;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.animation.Interpolator;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import java.util.List;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    // The first WebViews that take the keyboard and the system bars from the window themselves.
    private static final int WEBVIEW_TAKES_INSETS = 140;
    // Before this one the bottom bar's inset comes out wrong while the keyboard is up
    // (https://issues.chromium.org/issues/457682720).
    private static final int WEBVIEW_KEYBOARD_BAR_FIX = 144;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins go in before Capacitor starts.
        registerPlugin(GoogleDrivePlugin.class);
        registerPlugin(TodayWidgetPlugin.class);
        registerPlugin(ReminderCheckPlugin.class);
        registerPlugin(SystemColorsPlugin.class);
        registerPlugin(PhoneCalendarPlugin.class);
        registerPlugin(CodeScannerPlugin.class);
        registerPlugin(SaveFilePlugin.class);
        registerPlugin(BackGesturePlugin.class);
        registerPlugin(TouchFeedbackPlugin.class);
        super.onCreate(savedInstanceState);
        keyboardOverPage();
    }

    /**
     * The keyboard rises over the page rather than shrinking the app. Capacitor's own handling
     * (turned off in capacitor.config.ts) pads the window by the keyboard's whole height the moment
     * it starts up, so the page jumps and a blank strip shows until the keyboard gets there. A
     * newer WebView takes the keyboard from the window and shrinks only the part of the page that's
     * visible, as Chrome does, which the page follows as the keyboard moves. An older one still
     * gets the padding, and the system bars' too.
     */
    private void keyboardOverPage() {
        View decor = getWindow().getDecorView();
        int version = webViewVersion();
        int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
            Insets edges = insets.getInsets(bars);
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            if (version >= WEBVIEW_TAKES_INSETS) {
                v.setPadding(0, 0, 0, 0);
                // A keyboard that changes without moving (a resumed app, another layout).
                if (keyboardMoves == 0) tellPage(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom, null, 0);
                if (!keyboard || version >= WEBVIEW_KEYBOARD_BAR_FIX) return insets;
                return new WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.of(edges.left, edges.top, edges.right, 0)).build();
            }
            int ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            v.setPadding(edges.left, edges.top, edges.right, keyboard ? ime : edges.bottom);
            // Zeroed rather than consumed, which would stop them reaching the WebView at all.
            return new WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.NONE).build();
        });
        if (version >= WEBVIEW_TAKES_INSETS) {
            // As the keyboard starts moving, the page hears where it's going and how it'll get there,
            // so a sheet can rise or fall with it, rather than a few frames behind.
            ViewCompat.setWindowInsetsAnimationCallback(decor, new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                @Override
                public void onPrepare(@NonNull WindowInsetsAnimationCompat animation) {
                    if (isKeyboard(animation)) keyboardMoves++;
                }

                @NonNull
                @Override
                public WindowInsetsAnimationCompat.BoundsCompat onStart(@NonNull WindowInsetsAnimationCompat animation, @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds) {
                    WindowInsetsCompat end = ViewCompat.getRootWindowInsets(decor);
                    if (isKeyboard(animation) && end != null) {
                        // The duration it gives is before the phone's animation speed (Developer
                        // options) is applied, which the keyboard follows.
                        long ms = Math.round(animation.getDurationMillis() * animationScale());
                        tellPage(end.getInsets(WindowInsetsCompat.Type.ime()).bottom, animation.getInterpolator(), ms);
                    }
                    return bounds;
                }

                @NonNull
                @Override
                public WindowInsetsCompat onProgress(@NonNull WindowInsetsCompat insets, @NonNull List<WindowInsetsAnimationCompat> running) {
                    return insets;
                }

                @Override
                public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                    if (!isKeyboard(animation)) return;
                    keyboardMoves = Math.max(0, keyboardMoves - 1);
                    WindowInsetsCompat now = ViewCompat.getRootWindowInsets(decor);
                    if (keyboardMoves == 0 && now != null) tellPage(now.getInsets(WindowInsetsCompat.Type.ime()).bottom, null, 0);
                }
            });
        }
        ViewCompat.requestApplyInsets(decor);
    }

    private int keyboardMoves = 0;
    private int keyboardTold = -1;

    private static boolean isKeyboard(WindowInsetsAnimationCompat animation) {
        return (animation.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0;
    }

    /**
     * How much of the bottom of the page the keyboard will cover, in the page's pixels, and the
     * keyboard's own curve sampled into a CSS easing, as an `amble:keyboard` event (lib/viewport.ts).
     */
    private void tellPage(int keyboard, @Nullable Interpolator curve, long ms) {
        if (keyboard == keyboardTold && ms == 0) return;
        keyboardTold = keyboard;
        if (bridge == null || bridge.getWebView() == null) return;
        StringBuilder easing = new StringBuilder("linear(0");
        for (int i = 1; i <= 32; i++) easing.append(String.format(Locale.US, ",%.4f", curve == null ? i / 32f : curve.getInterpolation(i / 32f)));
        easing.append(')');
        float density = getResources().getDisplayMetrics().density;
        String detail = String.format(Locale.US, "{to:%.2f,ms:%d,easing:'%s'}", keyboard / density, ms, easing);
        bridge.getWebView().evaluateJavascript("window.dispatchEvent(new CustomEvent('amble:keyboard',{detail:" + detail + "}))", null);
    }

    private float animationScale() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return ValueAnimator.getDurationScale();
        return Settings.Global.getFloat(getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
    }

    private static int webViewVersion() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return 0;
        PackageInfo info = WebView.getCurrentWebViewPackage();
        if (info == null || info.versionName == null) return 0;
        try {
            return Integer.parseInt(info.versionName.split("\\.")[0]);
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}

package dev.jonmartin.amble;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

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
        super.onCreate(savedInstanceState);
    }
}

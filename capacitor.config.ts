// The Android app: Capacitor around the device build (dist/device), which runs Amble's API in a
// worker on the phone. `node scripts/android.ts` builds it; android/ is Capacitor's project.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Fixed once the app is on the Play Store: a new id is a new app.
  appId: 'dev.jonmartin.amble',
  appName: 'Amble',
  webDir: 'dist/device',
  android: {
    // A household's own server on the home network is often plain http (http://192.168.1.20:18085),
    // which the app's https page could otherwise not reach for sync. Links to other sites still
    // open in the browser.
    allowMixedContent: true,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_amble',
      iconColor: '#2e6a57',
    },
  },
};

export default config;

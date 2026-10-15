// The Android app: Capacitor around the device build (dist/device), which runs Almanac's API in a
// worker on the phone. `node scripts/android.ts` builds it; android/ is Capacitor's project.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Fixed once the app is on the Play Store: a new id is a new app.
  appId: 'dev.jonmartin.almanac',
  appName: 'Almanac',
  webDir: 'dist/device',
  android: {
    // The app's own pages and nothing else: links to other sites open in the browser.
    allowMixedContent: false,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_almanac',
      iconColor: '#2e6a57',
    },
  },
};

export default config;

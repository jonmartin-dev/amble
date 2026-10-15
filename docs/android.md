# The Android app

The Android app is the device build ([Almanac with no server](google-drive.md)) inside [Capacitor](https://capacitorjs.com): Almanac's API runs in a worker in the app, on SQLite kept on the phone, with nothing to sign up for. What the app adds over the same build in a browser:

- **Reminders with the app closed.** The app hands Android each coming reminder, and the phone shows it at its time with Done and Snooze on it. Android can hold a reminder back a few minutes while the phone is idle unless Almanac is allowed "Alarms and reminders"; Settings, Notifications offers that.
- **Sync without the hourly tap.** Google sign-in goes through Google Play services, which renews Drive access by itself, so the app keeps syncing for as long as Almanac is allowed.
- **Joining a household with Google's own picker,** which Google Play services shows over the app.
- **A home-screen widget** with today's tasks and how full the day is. The app hands it a copy whenever something changes; after the day ends (4am) it asks you to open Almanac until you do.

## Building it

You need a JDK (21) and the Android SDK, which come with [Android Studio](https://developer.android.com/studio). Then:

```sh
node scripts/android.ts build   # a debug APK in android/app/build/outputs/apk/debug
node scripts/android.ts run     # also installs it on the phone or emulator adb sees, and opens it
```

The script builds the device app, copies it into `android/` (Capacitor's project) and runs Gradle. `ANDROID_HOME` defaults to where Android Studio puts the SDK; a `JAVA_HOME` that points at an uninstalled JDK is ignored for the `java` on your PATH. To open the project in Android Studio instead, run `pnpm exec cap open android` after a build.

A debug build has WebView debugging on: with the phone plugged in, `chrome://inspect` on your computer shows the app's page.

## Google sign-in

The app signs in with an **Android** OAuth client in the same Google Cloud project as the web one (the [Google Cloud setup](google-drive.md#google-cloud-setup)): Google Auth Platform, Clients, Create client, Android, with the package name `dev.jonmartin.almanac` and the SHA-1 fingerprint of the key the app is signed with. The app needs no client id or secret of its own; Google recognizes it by those two.

For a debug build that key is Android's debug keystore:

```sh
keytool -list -v -keystore ~/.android/debug.keystore -storepass android -alias androiddebugkey
```

Each computer that builds debug versions has its own, so each needs its SHA-1 added (a client takes one; make one client per key). A release build signed through Google Play uses Play's app signing key, whose SHA-1 is in the Play Console under App integrity.

## When something goes wrong

- **"Google didn't sign you in (10: …)":** Google doesn't recognize the app: the package name or the SHA-1 on the Android client doesn't match the build, or the client is new (it can take a few minutes).
- **Reminders arrive a few minutes late:** Android is batching them while the phone is idle. Allow "Alarms and reminders" for Almanac from Settings, Notifications, On the minute.
- **No reminders at all:** check that notifications for Almanac are on in Android's settings, and that Settings, Notifications in Almanac says reminders come to this device. Clearing the app's data removes the reminders it handed to Android until it's opened again.

package dev.jonmartin.amble;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The phone's own calendars, read through Android's calendar provider: every account the phone
 * syncs (Google, Samsung, Outlook and the rest), with the one "Calendar" permission and nothing
 * else. Read only. The app counts the busy time against how full each day is.
 */
@CapacitorPlugin(name = "PhoneCalendar", permissions = { @Permission(alias = "calendar", strings = { Manifest.permission.READ_CALENDAR }) })
public class PhoneCalendarPlugin extends Plugin {

    private boolean allowed(PluginCall call) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) return true;
        call.reject("Amble isn't allowed to read this phone's calendars.", "NO_PERMISSION");
        return false;
    }

    private static String hex(int color) {
        return String.format("#%06x", color & 0xffffff);
    }

    /** A JSON null rather than leaving the key out, which is what putting a null would do. */
    private static Object orNull(Object value) {
        return value == null ? JSONObject.NULL : value;
    }

    /** { calendars: [{ id, account, name, color, primary, writable, visible }] } */
    @PluginMethod
    public void calendars(PluginCall call) {
        if (!allowed(call)) return;
        String[] projection = {
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.CALENDAR_COLOR,
            CalendarContract.Calendars.IS_PRIMARY,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
            CalendarContract.Calendars.VISIBLE,
            CalendarContract.Calendars.OWNER_ACCOUNT,
        };
        JSArray list = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, projection, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String account = c.getString(1);
                int access = c.isNull(5) ? 0 : c.getInt(5);
                String owner = c.getString(7);
                // Some providers leave IS_PRIMARY out: the account's own calendar is the one it owns.
                boolean primary = (!c.isNull(4) && c.getInt(4) == 1)
                    || (c.isNull(4) && access >= CalendarContract.Calendars.CAL_ACCESS_OWNER && owner != null && owner.equals(account));
                JSObject cal = new JSObject();
                cal.put("id", String.valueOf(c.getLong(0)));
                cal.put("account", orNull(account));
                cal.put("name", c.getString(2) == null ? "Calendar" : c.getString(2));
                cal.put("color", c.isNull(3) ? JSONObject.NULL : hex(c.getInt(3)));
                cal.put("primary", primary);
                // Their own, or a shared one they help keep, as opposed to holidays or birthdays.
                cal.put("writable", access >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR);
                cal.put("visible", c.isNull(6) || c.getInt(6) == 1);
                list.put(cal);
            }
        } catch (SecurityException e) {
            call.reject("Amble isn't allowed to read this phone's calendars.", "NO_PERMISSION");
            return;
        }
        JSObject result = new JSObject();
        result.put("calendars", list);
        call.resolve(result);
    }

    /**
     * Every occurrence between `from` and `to` (milliseconds) on the calendars given, with repeating
     * events already expanded: { events: [{ id, calendarId, uid, title, begin, end, allDay, busy }] }.
     * Cancelled ones and ones the person declined are left out.
     */
    @PluginMethod
    public void events(PluginCall call) {
        if (!allowed(call)) return;
        Long from = call.getLong("from");
        Long to = call.getLong("to");
        JSArray ids = call.getArray("calendars", new JSArray());
        if (from == null || to == null || to <= from) {
            call.reject("Give a window to read.");
            return;
        }
        StringBuilder in = new StringBuilder();
        String[] args = new String[ids.length()];
        try {
            for (int i = 0; i < ids.length(); i++) {
                args[i] = String.valueOf(Long.parseLong(ids.getString(i)));
                in.append(i == 0 ? "?" : ",?");
            }
        } catch (JSONException | NumberFormatException e) {
            call.reject("Those aren't calendars on this phone.");
            return;
        }
        JSArray events = new JSArray();
        if (args.length > 0) {
            Uri.Builder uri = CalendarContract.Instances.CONTENT_URI.buildUpon();
            ContentUris.appendId(uri, from);
            ContentUris.appendId(uri, to);
            String[] projection = {
                CalendarContract.Instances.EVENT_ID,
                CalendarContract.Instances.BEGIN,
                CalendarContract.Instances.END,
                CalendarContract.Instances.ALL_DAY,
                CalendarContract.Instances.TITLE,
                CalendarContract.Instances.CALENDAR_ID,
                CalendarContract.Instances.AVAILABILITY,
                CalendarContract.Instances.STATUS,
                CalendarContract.Instances.SELF_ATTENDEE_STATUS,
                CalendarContract.Instances.UID_2445,
            };
            ContentResolver resolver = getContext().getContentResolver();
            try (Cursor c = resolver.query(uri.build(), projection, CalendarContract.Instances.CALENDAR_ID + " IN (" + in + ")", args, null)) {
                while (c != null && c.moveToNext()) {
                    if (!c.isNull(7) && c.getInt(7) == CalendarContract.Events.STATUS_CANCELED) continue;
                    if (!c.isNull(8) && c.getInt(8) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue;
                    long begin = c.getLong(1);
                    JSObject e = new JSObject();
                    // A repeating event's occurrences share its id, so each is told apart by when it starts.
                    e.put("id", c.getLong(0) + ":" + begin);
                    e.put("calendarId", String.valueOf(c.getLong(5)));
                    e.put("uid", orNull(c.getString(9)));
                    e.put("title", orNull(c.getString(4)));
                    e.put("begin", begin);
                    e.put("end", c.isNull(2) ? begin : c.getLong(2));
                    e.put("allDay", !c.isNull(3) && c.getInt(3) == 1);
                    e.put("busy", c.isNull(6) || c.getInt(6) != CalendarContract.Events.AVAILABILITY_FREE);
                    events.put(e);
                }
            } catch (SecurityException e) {
                call.reject("Amble isn't allowed to read this phone's calendars.", "NO_PERMISSION");
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("events", events);
        call.resolve(result);
    }
}

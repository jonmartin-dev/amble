package dev.jonmartin.amble;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import org.json.JSONObject;

/**
 * Scans a QR code with Google's code scanner, for joining the household's server from the code on
 * its page. Google Play services shows the camera and reads the code, so the app needs no camera
 * permission and never sees the picture.
 */
@CapacitorPlugin(name = "CodeScanner")
public class CodeScannerPlugin extends Plugin {

    /** { value: "what the code says" }, or value: null when the person backs out. */
    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanning.getClient(getActivity(), options)
            .startScan()
            .addOnSuccessListener(barcode -> {
                JSObject result = new JSObject();
                String value = barcode.getRawValue();
                result.put("value", value == null ? JSONObject.NULL : value);
                call.resolve(result);
            })
            .addOnCanceledListener(() -> {
                JSObject result = new JSObject();
                result.put("value", JSONObject.NULL);
                call.resolve(result);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() != null ? e.getMessage() : "The scanner didn't start."));
    }
}

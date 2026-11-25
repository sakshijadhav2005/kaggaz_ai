package app.kaagaz;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Downloads the offline model through Android's DownloadManager, so a 2.6 GB transfer keeps going when the
 * app is in the background or the screen is off, shows a notification, and retries when the network drops.
 * The file goes to the app's own external files folder (no permission needed, removed on uninstall), because
 * DownloadManager cannot write to the app's internal storage.
 */
@CapacitorPlugin(name = "ModelDownload")
public class ModelDownloadPlugin extends Plugin {

    private DownloadManager manager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    private File target(String filename) {
        return new File(getContext().getExternalFilesDir(null), filename);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("url");
        String filename = call.getString("filename");
        if (url == null || filename == null || filename.contains("/")) {
            call.reject("url and a plain filename are required");
            return;
        }
        try {
            // DownloadManager renames instead of overwriting, so clear any earlier copy. The old in-app
            // downloader kept the model in internal storage; that copy is no longer used.
            File out = target(filename);
            if (out.exists()) out.delete();
            File legacy = new File(getContext().getFilesDir(), filename);
            if (legacy.exists()) legacy.delete();

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle(call.getString("title", filename))
                .setDescription(call.getString("description", ""))
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
                .setDestinationInExternalFilesDir(getContext(), null, filename);
            long id = manager().enqueue(request);
            JSObject result = new JSObject();
            result.put("id", String.valueOf(id));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not start the download: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        long id;
        try {
            id = Long.parseLong(call.getString("id", ""));
        } catch (NumberFormatException e) {
            call.reject("id is required");
            return;
        }
        JSObject result = new JSObject();
        try (Cursor c = manager().query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) {
                result.put("state", "missing");
                result.put("bytes", 0);
                result.put("total", -1);
                result.put("reason", "The download was cancelled.");
                result.put("path", "");
                call.resolve(result);
                return;
            }
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            result.put("bytes", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
            result.put("total", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));
            String local = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
            result.put("path", local != null ? Uri.parse(local).getPath() : "");
            switch (status) {
                case DownloadManager.STATUS_SUCCESSFUL:
                    result.put("state", "done");
                    result.put("reason", "");
                    break;
                case DownloadManager.STATUS_FAILED:
                    result.put("state", "failed");
                    result.put("reason", failure(reason));
                    break;
                case DownloadManager.STATUS_PAUSED:
                    result.put("state", "paused");
                    result.put("reason", pause(reason));
                    break;
                case DownloadManager.STATUS_RUNNING:
                    result.put("state", "running");
                    result.put("reason", "");
                    break;
                default:
                    result.put("state", "pending");
                    result.put("reason", "");
            }
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the download: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        try {
            manager().remove(Long.parseLong(call.getString("id", "")));
        } catch (Exception ignored) {
            // Already gone.
        }
        call.resolve();
    }

    private static String pause(int reason) {
        switch (reason) {
            case DownloadManager.PAUSED_WAITING_FOR_NETWORK:
                return "network";
            case DownloadManager.PAUSED_QUEUED_FOR_WIFI:
                return "wifi";
            case DownloadManager.PAUSED_WAITING_TO_RETRY:
                return "retry";
            default:
                return "paused";
        }
    }

    private static String failure(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "Not enough free storage on the phone (about 2.6 GB is needed).";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND:
                return "The phone's storage is not available.";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "The server stopped sending the file. Try again.";
            case DownloadManager.ERROR_CANNOT_RESUME:
                return "The download could not resume. Try again.";
            default:
                return reason >= 400 && reason < 600 ? "The server refused the download (HTTP " + reason + ")." : "The download failed. Try again.";
        }
    }
}

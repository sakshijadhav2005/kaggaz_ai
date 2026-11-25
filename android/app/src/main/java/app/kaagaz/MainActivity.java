package app.kaagaz;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins are registered before the bridge starts.
        registerPlugin(IntegrityPlugin.class);
        registerPlugin(ModelDownloadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

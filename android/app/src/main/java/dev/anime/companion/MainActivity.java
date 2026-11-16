package dev.anime.companion;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity
 *
 * One addition over the generated default: the screen is kept awake while
 * the app is in the foreground.
 *
 * The web side also asks for a screen wake lock, and that works most of the
 * time, but it is best-effort: the API is not implemented on every Android
 * version, it needs a prior user gesture, and the system silently drops the
 * lock when the app is backgrounded and does not hand it back. This flag is
 * the reliable half, and a companion that falls asleep mid-sentence is
 * worse than one that burns a little battery.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}

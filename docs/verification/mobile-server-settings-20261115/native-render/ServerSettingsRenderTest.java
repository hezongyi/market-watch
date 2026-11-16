package com.kookvv.marketwatch;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import kotlin.Unit;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

/** Android native-view rendering, not a browser recreation or an emulator keyboard check. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, qualifiers = "w412dp-h850dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class ServerSettingsRenderTest {
    private static List<View> all(View view) {
        List<View> views = new ArrayList<>(); views.add(view);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) views.addAll(all(group.getChildAt(i)));
        }
        return views;
    }
    private static EditText input(View view) {
        return (EditText) all(view).stream().filter(v -> v instanceof EditText).findFirst().get();
    }
    private static Button submit(View view) {
        return (Button) all(view).stream().filter(v -> v instanceof Button).findFirst().get();
    }
    private static void screenshot(View view, String name, int width, int height, boolean light) throws Exception {
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, width, height);
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(android.graphics.Color.parseColor(light ? "#f8f9fc" : "#101317"));
        // ViewRoot normally supplies the root view's scroll transform; this is an offscreen canvas.
        canvas.translate(-view.getScrollX(), -view.getScrollY());
        view.draw(canvas);
        File dir = new File(System.getProperty("mw.render.output")); dir.mkdirs();
        try (FileOutputStream output = new FileOutputStream(new File(dir, name + ".png"))) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        }
        bitmap.recycle();
    }
    private String parse(String address) {
        try {
            Method method = MainActivity.class.getDeclaredMethod("trustedOrigin", String.class);
            method.setAccessible(true);
            return (String) method.invoke(new MainActivity(), address);
        } catch (Exception error) { throw new RuntimeException(error); }
    }
    private ServerSettingsView screen(Context context, boolean light, String saved) {
        return new ServerSettingsView(context, light, saved, this::parse, value -> Unit.INSTANCE, () -> Unit.INSTANCE);
    }
    @Test public void screenshotsAndControls() throws Exception {
        for (int width : new int[]{375, 412}) for (boolean light : new boolean[]{true, false}) {
            RuntimeEnvironment.setQualifiers("w" + width + "dp-h850dp-mdpi");
            Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
            ServerSettingsView view = screen(activity, light, "https://192.168.7.232:18447");
            activity.setContentView(view);
            assertFalse(input(view).hasFocus());
            screenshot(view, width + (light ? "-light" : "-dark"), width, 850, light);
            assertTrue(submit(view).getHeight() >= 52);
            assertTrue(all(view).stream().filter(v -> v.getContentDescription() != null).allMatch(v -> v.getWidth() >= 44 && v.getHeight() >= 44));
            input(view).setText("http://example.com"); submit(view).performClick();
            assertTrue(submit(view).isEnabled());
            assertTrue(all(view).stream().anyMatch(v -> v instanceof TextView && ((TextView)v).getText().toString().contains("请输入完整")));
            screenshot(view, width + (light ? "-light-error" : "-dark-error"), width, 850, light);
            input(view).setText("https://example.com");
            assertFalse(all(view).stream().anyMatch(v -> v instanceof TextView && ((TextView)v).getText().toString().contains("请输入完整")));
            activity.finish();
        }
        RuntimeEnvironment.setQualifiers("w375dp-h600dp-mdpi");
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        android.content.res.Configuration config = new android.content.res.Configuration(activity.getResources().getConfiguration());
        config.fontScale = 1.5f;
        Context scaled = activity.createConfigurationContext(config);
        ServerSettingsView large = screen(scaled, true, "https://a-long-server-name.example.com:18447");
        activity.setContentView(large);
        screenshot(large, "375-light-large-text", 375, 600, true);
        large.scrollTo(0, 10000);
        screenshot(large, "375-light-large-text-scrolled", 375, 600, true);
        ServerSettingsView compact = screen(activity, true, "https://192.168.7.232:18447");
        activity.setContentView(compact);
        screenshot(compact, "375-light-short-viewport", 375, 380, true);
        compact.scrollTo(0, 10000);
        assertTrue("Short viewport must scroll to the connection button", compact.getScrollY() > 0);
        screenshot(compact, "375-light-short-viewport-scrolled", 375, 380, true);
        assertTrue("Connection button must be fully visible after scrolling", submit(compact).getBottom() - compact.getScrollY() <= compact.getHeight());
        ServerSettingsView fresh = screen(activity, true, null);
        activity.setContentView(fresh);
        screenshot(fresh, "375-light-first-launch", 375, 800, true);
        submit(fresh).performClick();
        screenshot(fresh, "375-light-empty-error", 375, 800, true);
    }
    @Test public void connectionAndCancelPreserveBoundaries() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        List<String> connected = new ArrayList<>();
        List<Boolean> backed = new ArrayList<>();
        String previous = "https://old.example.com";
        ServerSettingsView view = new ServerSettingsView(activity, true, previous, this::parse, value -> { connected.add(value); return Unit.INSTANCE; }, () -> { backed.add(true); return Unit.INSTANCE; });
        activity.setContentView(view);
        input(view).setText("https://new.example.com/m/");
        view.goBack();
        assertEquals(1, backed.size()); assertTrue(connected.isEmpty());
        submit(view).performClick(); submit(view).performClick();
        assertEquals(java.util.Arrays.asList("https://new.example.com"), connected);
        assertFalse(submit(view).isEnabled());
        view.goBack(); assertEquals(1, backed.size());
        assertNull(parse("http://example.com"));
        assertNull(parse("https://user:pass@example.com"));
        assertNull(parse("https://example.com/page"));
        assertNull(parse("https://example.com?token=test"));
        assertNull(parse("https://example.com#fragment"));
        assertEquals("https://example.com:18447", parse(" https://EXAMPLE.COM:18447/m/ "));
    }
}

# Hosting the web UI in the Android WebView

The Android app is a separate project (`sphere-android`). It hosts this web UI
in a WebView and owns the things a web page cannot do for itself: the system
tray, the vibrator, the screen-wake lock, the system bars, and the zoom gesture.

This document is the contract between the two. Everything the shell needs is
already exposed by [`src/utils/nativeBridge.ts`](../src/utils/nativeBridge.ts).

## 1. Identify the shell

Append a product token to the WebView's user agent. The web side keys off it to
show the app-only settings, to keep the session alive indefinitely, and to route
notifications to the tray instead of the browser.

```kotlin
webView.settings.userAgentString = webView.settings.userAgentString + " SferaApp/1"
```

Without this token the UI behaves exactly as it does in a mobile browser.

## 2. The preferences

The user toggles these under **Settings → Appearance → Mobile app**. They are
stored on the server with the rest of the settings, so they follow the account
onto a new device.

| Key | Meaning when true |
| --- | --- |
| `allowScale` | Allow pinch-to-zoom and text scaling |
| `pushNotifications` | Deliver notifications through the system tray |
| `haptics` | Vibrate on notifications, long-presses and call events |
| `keepScreenOn` | Hold the screen awake during a call |
| `immersive` | Hide the status and navigation bars |

They arrive as one JSON object, by any of three routes.

**Synchronously, whenever you want:**

```kotlin
webView.evaluateJavascript("window.SferaNative.getPrefs()") { raw ->
    // `raw` is a JSON *string literal*, so unwrap it once.
    val json = JSONObject(JSONTokener(raw).nextValue() as String)
    applyPrefs(json)
}
```

**At startup, before the page has loaded** — the same object is mirrored into
`localStorage` under the key `sfera.native.prefs`, so the shell can restore the
window's configuration without waiting for the first paint.

**Pushed on every change** — register a JavaScript interface named
`SferaNativeBridge`:

```kotlin
class SferaBridge(private val activity: Activity) {
    @JavascriptInterface
    fun onPrefsChanged(json: String) = activity.runOnUiThread {
        applyPrefs(JSONObject(json))
    }

    @JavascriptInterface
    fun onNotify(json: String) { /* see §3 */ }

    @JavascriptInterface
    fun onHaptic(json: String) { /* see §4 */ }
}

webView.addJavascriptInterface(SferaBridge(this), "SferaNativeBridge")
```

`onPrefsChanged` fires immediately on every change, and also carries `theme`
(`"light"` / `"dark"`) and `themeColor` (a `#rrggbb` string) when the theme
changes — tint the system bars from those.

Applying them:

```kotlin
fun applyPrefs(p: JSONObject) {
    webView.settings.builtInZoomControls = p.optBoolean("allowScale")
    webView.settings.displayZoomControls = false
    webView.settings.setSupportZoom(p.optBoolean("allowScale"))

    if (p.optBoolean("keepScreenOn", true)) {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    } else {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    WindowInsetsControllerCompat(window, webView).run {
        if (p.optBoolean("immersive")) hide(WindowInsetsCompat.Type.systemBars())
        else show(WindowInsetsCompat.Type.systemBars())
    }
}
```

Note that `keepScreenOn` is worded as "during a call" in the UI. The web side
only ever raises it while a call is up, so the shell can honour it literally.

## 3. Notifications

When the shell is identified (§1) *and* `pushNotifications` is on, the web side
stops calling the browser Notification API and calls `onNotify` instead. If the
interface is absent the web side silently falls back, so a shell build without
it still works.

The payload:

```json
{ "kind": "dm", "title": "Anna", "body": "see you at six", "ongoing": false, "haptics": true }
```

`kind` is one of `dm`, `mention`, `server`, `friend`, `call`. `ongoing` is true
only for an incoming call: show it as a full-screen intent that rings until it
is answered or dismissed, not as a transient banner. `haptics` mirrors the
preference, so the notification and the vibration stay in step.

Tapping a notification should bring the WebView forward. It does not need to
deep-link anywhere: the page is still live and already on the right screen.

## 4. Haptics

`onHaptic` receives a JSON number (milliseconds) or an array of numbers (an
on/off pattern), matching the web Vibration API:

```kotlin
@JavascriptInterface
fun onHaptic(json: String) {
    val pattern = when (val v = JSONTokener(json).nextValue()) {
        is Number -> longArrayOf(0, v.toLong())
        is JSONArray -> LongArray(v.length() + 1) { i -> if (i == 0) 0 else v.getLong(i - 1) }
        else -> return
    }
    vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
}
```

The web side already checks the `haptics` preference before calling, so the
shell does not have to.

## 5. WebView configuration

The UI needs these on for calls, attachments and the local caches to work:

```kotlin
webView.settings.apply {
    javaScriptEnabled = true
    domStorageEnabled = true          // localStorage
    databaseEnabled = true            // IndexedDB — the message and diary caches
    mediaPlaybackRequiresUserGesture = false   // ringtone, call audio
}
```

Grant `RECORD_AUDIO` and `CAMERA` at the Android level, and forward the WebRTC
request:

```kotlin
webView.webChromeClient = object : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest) {
        runOnUiThread { request.grant(request.resources) }
    }
}
```

The page ships `viewport-fit=cover` and reads `env(safe-area-inset-*)`
throughout, so draw edge-to-edge and let the CSS handle the notch:

```kotlin
WindowCompat.setDecorFitsSystemWindows(window, false)
```

Finally, route the hardware back button into the page's own history so it
closes a chat rather than the app:

```kotlin
override fun onBackPressed() {
    if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
}
```

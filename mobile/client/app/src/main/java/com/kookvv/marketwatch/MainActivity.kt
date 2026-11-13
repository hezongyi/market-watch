package com.kookvv.marketwatch

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebStorage
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private var web: WebView? = null
    private var origin: String? = null
    private var connectionDialog: AlertDialog? = null
    private var updater: AppUpdater? = null
    private var safeContainer: View? = null
    private val lightAppearance get() = preferences.getString("appearance", "dark") == "light"
    private val surfaceColor get() = Color.parseColor(if (lightAppearance) "#f8f9fc" else "#101317")
    private val installPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        updater?.permissionResult()
    }
    private val preferences by lazy { getSharedPreferences("shell", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyAppearance()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = web
                if (view == null) { finish(); return }
                if (ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                    WindowInsetsControllerCompat(window, view).hide(WindowInsetsCompat.Type.ime())
                    return
                }
                view.evaluateJavascript("window.dispatchEvent(new Event('mw-mobile-back',{cancelable:true}))") { result ->
                    if (result == "true") finish()
                }
            }
        })
        val saved = preferences.getString("origin", null)
        if (saved == null) configure() else open(saved)
    }

    private fun trustedOrigin(text: String): String? {
        val uri = Uri.parse(text.trim())
        if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null ||
            uri.query != null || uri.fragment != null || uri.path !in listOf(null, "", "/", "/m", "/m/")) return null
        val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        return "https://${uri.host!!.lowercase()}$port"
    }

    private fun configure() {
        updater?.close(); updater = null
        origin = null
        connectionDialog?.dismiss(); connectionDialog = null
        web?.destroy(); web = null
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 48, 32, 24) }
        val title = TextView(this).apply { text = "连接守望\n输入可信 HTTPS 服务器地址"; textSize = 20f }
        val address = EditText(this).apply {
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://服务器地址"; setText(preferences.getString("origin", "")); minHeight = 96
        }
        val error = TextView(this)
        val foreground = Color.parseColor(if (lightAppearance) "#17202a" else "#f0f2f5")
        title.setTextColor(foreground)
        address.setTextColor(foreground)
        address.setHintTextColor(Color.parseColor(if (lightAppearance) "#596574" else "#aab3bf"))
        address.backgroundTintList = android.content.res.ColorStateList.valueOf(foreground)
        error.setTextColor(foreground)
        val connect = Button(this).apply {
            text = "连接"
            setOnClickListener {
                val value = trustedOrigin(address.text.toString())
                if (value == null) error.text = "请输入有效的 HTTPS 地址，不包含用户名、查询参数或其他页面路径"
                else {
                    val previous = preferences.getString("origin", null)
                    preferences.edit().putString("origin", value).apply()
                    if (previous != null && previous != value) {
                        WebStorage.getInstance().deleteAllData()
                        CookieManager.getInstance().removeAllCookies { open(value) }
                    } else open(value)
                }
            }
        }
        layout.addView(title); layout.addView(address); layout.addView(error); layout.addView(connect)
        setSafeContent(layout)
    }

    private fun connectionFailure(view: WebView, message: String) {
        if (web !== view || isFinishing || connectionDialog?.isShowing == true) return
        connectionDialog = AlertDialog.Builder(this).setMessage(message)
            .setPositiveButton("重试") { _, _ -> view.reload() }
            .setNeutralButton("连接设置") { _, _ -> configure() }
            .setNegativeButton("返回", null).create()
        connectionDialog?.show()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun open(value: String) {
        if (trustedOrigin(value) != value) { configure(); return }
        origin = value
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            AlertDialog.Builder(this).setMessage("请更新 Android System WebView 后重新打开守望")
                .setPositiveButton("关闭") { _, _ -> finish() }.show()
            return
        }
        val view = WebView(this)
        web = view
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            builtInZoomControls = true
            displayZoomControls = false
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webChromeClient = WebChromeClient()
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (trustedOrigin("${uri.scheme}://${uri.encodedAuthority}") == origin) return false
                if (request.isForMainFrame && uri.scheme in listOf("https", "http")) {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                }
                return true
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                // A subresource failure must not replace an otherwise usable app.
                if (error.url == view.url)
                    connectionFailure(view, "服务器证书无法验证，请检查地址与证书配置")
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame)
                    connectionFailure(view, if (error.errorCode == ERROR_FAILED_SSL_HANDSHAKE)
                        "TLS 握手失败，请检查 HTTPS 地址与服务器配置"
                        else "无法连接服务器，请检查地址、网络和服务器状态")
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame)
                    connectionFailure(view, "服务器返回 HTTP ${response.statusCode}，请重试或检查连接设置")
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (!url.startsWith("$value/")) view.stopLoading()
            }
        }
        WebViewCompat.addWebMessageListener(view, "MWMobileHost", setOf(value)) { _, message, source, mainFrame, reply ->
            if (!mainFrame || trustedOrigin(source.toString()) != origin) return@addWebMessageListener
            val payload = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
            if (payload.optInt("version") != 1) {
                reply.postMessage("{\"version\":1,\"error\":\"请更新 APK：页面协议不兼容\"}")
                return@addWebMessageListener
            }
            when (payload.optString("action")) {
                "hello" -> reply.postMessage(JSONObject().put("version", 1)
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("capabilities", org.json.JSONArray(listOf("app-update-v1", "appearance-v1")))
                    .put("webViewVersion", WebViewCompat.getCurrentWebViewPackage(this)?.versionName).toString())
                "appearance" -> {
                    val theme = payload.optString("theme")
                    if (theme == "light" || theme == "dark") {
                        preferences.edit().putString("appearance", theme).apply()
                        applyAppearance()
                    }
                }
                "check-app-update" -> {
                    if (updater == null) updater = AppUpdater(this, { origin }) {
                        installPermission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:$packageName")))
                    }
                    updater?.check(value) { status, label ->
                        if (web === view && origin == value) reply.postMessage(JSONObject().put("version", 1)
                            .put("appUpdate", JSONObject().put("status", status).put("label", label)).toString())
                    }
                }
                "exit" -> { CookieManager.getInstance().flush(); finish() }
                "clear-session" -> CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush() }
                "configure" -> configure()
            }
        }
        setSafeContent(view)
        view.loadUrl("$value/m/")
    }

    /** System bars are transparent; the safe-area surface follows the trusted page theme. */
    private fun applyAppearance() {
        val style = if (lightAppearance) SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
            else SystemBarStyle.dark(Color.TRANSPARENT)
        enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
        window.setBackgroundDrawable(ColorDrawable(surfaceColor))
        safeContainer?.setBackgroundColor(surfaceColor)
        web?.setBackgroundColor(surfaceColor)
    }

    /** Native owns system/keyboard insets once; WebView receives an already safe viewport. */
    private fun setSafeContent(content: View) {
        val container = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        safeContainer = container
        container.setBackgroundColor(surfaceColor)
        content.setBackgroundColor(surfaceColor)
        container.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(container) { target, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            target.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(container)
        ViewCompat.requestApplyInsets(container)
    }

    override fun onPause() {
        web?.evaluateJavascript("window.dispatchEvent(new Event('mw-mobile-background'))", null)
        CookieManager.getInstance().flush()
        web?.onPause()
        super.onPause()
    }
    override fun onResume() { super.onResume(); web?.onResume() }
    override fun onDestroy() { updater?.close(); connectionDialog?.dismiss(); web?.destroy(); web = null; super.onDestroy() }
}

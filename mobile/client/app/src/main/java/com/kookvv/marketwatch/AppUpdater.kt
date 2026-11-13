package com.kookvv.marketwatch

import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/** Manual, same-server APK updates. Android still owns installation and user consent. */
class AppUpdater(
    private val activity: ComponentActivity,
    private val currentOrigin: () -> String?,
    private val requestInstallPermission: () -> Unit,
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var cancelled = false
    @Volatile private var connection: HttpsURLConnection? = null
    private var busy = false
    private var dialog: AlertDialog? = null
    private var pending: Pair<File, UpdateManifest>? = null
    private var notify: (String, String) -> Unit = { _, _ -> }
    private var server = ""

    fun check(origin: String, report: (String, String) -> Unit) {
        if (busy) return
        server = origin
        notify = report
        busy = true
        cancelled = false
        state("checking", "正在检查更新…")
        executor.execute {
            try {
                val bytes = request("/downloads/android-update.json") { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(4096)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(output.size() + count <= 65536) { "更新说明过大" }
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
                val manifest = UpdateManifest.parse(JSONObject(String(bytes, Charsets.UTF_8)), activity.packageName)
                ui {
                    busy = false
                    if (manifest.versionCode <= BuildConfig.VERSION_CODE) {
                        state("current", "当前已是最新版 ${BuildConfig.VERSION_NAME}")
                    } else {
                        state("available", "发现新版 ${manifest.versionName}")
                        dialog = AlertDialog.Builder(activity)
                            .setTitle("更新守望 ${manifest.versionName}")
                            .setMessage("${manifest.notes}\n\n下载大小：${(manifest.size / 1048576.0).let { "%.1f".format(it) }} MB")
                            .setPositiveButton("下载并安装") { _, _ -> download(manifest) }
                            .setNegativeButton("稍后", null).show()
                    }
                }
            } catch (_: Exception) {
                ui { busy = false; state("error", "检查更新失败，请确认服务器连接后重试") }
            }
        }
    }

    private fun download(manifest: UpdateManifest) {
        busy = true
        cancelled = false
        state("downloading", "正在下载 ${manifest.versionName}…")
        dialog = AlertDialog.Builder(activity).setTitle("正在下载更新")
            .setMessage("0%")
            .setNegativeButton("取消") { _, _ ->
                cancelled = true
                connection?.disconnect()
                state("available", "已取消下载，可重新检查更新")
            }.setCancelable(false).show()
        executor.execute {
            val directory = File(activity.cacheDir, "updates").apply { mkdirs() }
            val file = File(directory, "update.apk")
            val partial = File(directory, "update.part")
            try {
                if (!file.exists() || file.length() != manifest.size || sha256(file) != manifest.sha256) {
                    request("/downloads/${manifest.apk}") { input ->
                        partial.outputStream().use { output ->
                            val buffer = ByteArray(65536)
                            var total = 0L
                            var lastPercent = -1
                            while (true) {
                                check(!cancelled) { "cancelled" }
                                val count = input.read(buffer)
                                if (count < 0) break
                                total += count
                                require(total <= manifest.size) { "size" }
                                output.write(buffer, 0, count)
                                val percent = (total * 100 / manifest.size).toInt()
                                if (percent != lastPercent) {
                                    lastPercent = percent
                                    ui { if (!cancelled) { dialog?.setMessage("$percent%"); state("downloading", "正在下载 $percent%") } }
                                }
                            }
                            require(total == manifest.size) { "size" }
                        }
                    }
                    require(sha256(partial) == manifest.sha256) { "hash" }
                    verifyPackage(partial, manifest)
                    require(partial.renameTo(file)) { "cache" }
                }
                verifyPackage(file, manifest)
                check(!cancelled)
                ui {
                    busy = false
                    dialog?.dismiss()
                    if (!cancelled) { pending = file to manifest; install() }
                }
            } catch (_: Exception) {
                partial.delete()
                ui {
                    busy = false
                    dialog?.dismiss()
                    if (!cancelled) state("error", "下载或安装包校验失败，请重试")
                }
            }
        }
    }

    fun install() {
        val (file, _) = pending ?: return
        if (currentOrigin() != server) { pending = null; return }
        if (!activity.packageManager.canRequestPackageInstalls()) {
            state("permission", "请允许守望安装更新，返回后继续安装")
            requestInstallPermission()
            return
        }
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            state("installing", "安装包已就绪，请在系统界面确认；取消后可再次检查更新")
            pending = null
        } catch (_: Exception) { state("error", "无法打开安装界面，请检查系统安装权限") }
    }

    fun permissionResult() {
        if (activity.packageManager.canRequestPackageInstalls()) install()
        else state("permission", "尚未允许安装更新，请再次检查更新后开启权限")
    }

    @Suppress("DEPRECATION")
    private fun verifyPackage(file: File, manifest: UpdateManifest) {
        val manager = activity.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = requireNotNull(manager.getPackageArchiveInfo(file.path, flags))
        val installed = manager.getPackageInfo(activity.packageName, flags)
        require(archive.packageName == activity.packageName)
        val version = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        require(version == manifest.versionCode && version > BuildConfig.VERSION_CODE)
        fun signers(info: android.content.pm.PackageInfo): Set<String> {
            val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
            return signatures.orEmpty().map { it.toCharsString() }.toSet()
        }
        require(signers(installed).isNotEmpty() && signers(archive) == signers(installed))
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(65536)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    private fun <T> request(path: String, read: (java.io.InputStream) -> T): T {
        val conn = URL(server + path).openConnection() as HttpsURLConnection
        connection = conn
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.useCaches = false
        try {
            require(conn.responseCode == 200)
            return conn.inputStream.use(read)
        } finally { conn.disconnect(); connection = null }
    }

    private fun state(status: String, label: String) { notify(status, label) }
    private fun ui(action: () -> Unit) {
        main.post { if (!activity.isDestroyed && !activity.isFinishing && currentOrigin() == server) action() }
    }
    fun close() {
        cancelled = true
        connection?.disconnect()
        dialog?.dismiss()
        executor.shutdownNow()
    }
}


package com.kookvv.marketwatch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class UpdateManifestTest {
    private fun release(apk: String = "market-watch-0.1.3-debug.apk", size: Long = 12345,
                        packageName: String = "com.kookvv.marketwatch", hash: String = "A".repeat(64),
                        version: Long = 4) = UpdateManifest.checked(packageName, "com.kookvv.marketwatch", version,
        "0.1.3", apk, hash, size, "更新说明")

    @Test fun validReleaseKeepsExactFileAndDigest() {
        val manifest = release()
        assertEquals("market-watch-0.1.3-debug.apk", manifest.apk)
        assertEquals("a".repeat(64), manifest.sha256)
        assertEquals(4L, manifest.versionCode)
    }

    @Test fun cannotRedirectDownloadToAnotherPathOrOrigin() {
        for (path in listOf("https://other.example/app.apk", "../market-watch-x.apk", "market-watch-../../x.apk",
            "/market-watch-x.apk", "market-watch-x.apk?token=1", "market-watch-%2e%2e.apk")) {
            assertThrows(IllegalArgumentException::class.java) { release(apk = path) }
        }
    }

    @Test fun rejectsOtherApplicationsAndInvalidVersions() {
        assertThrows(IllegalArgumentException::class.java) { release(packageName = "com.other.app") }
        assertThrows(IllegalArgumentException::class.java) { release(version = 0) }
    }

    @Test fun downloadHasFiniteDeclaredSizeAndFullHash() {
        for (size in listOf(0L, -1L, 134217729L)) assertThrows(IllegalArgumentException::class.java) { release(size = size) }
        for (hash in listOf("", "a".repeat(63), "g".repeat(64))) assertThrows(IllegalArgumentException::class.java) { release(hash = hash) }
    }
}

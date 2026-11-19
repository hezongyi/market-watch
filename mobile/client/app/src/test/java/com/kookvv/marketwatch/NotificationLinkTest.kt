package com.kookvv.marketwatch

import org.junit.Assert.*
import org.junit.Test

class NotificationLinkTest {
    private val prefix = "marketwatch://notification?server=https%3A%2F%2F192.168.7.232%3A18443&"
    @Test fun routesOnlyToSupportedReadOnlyEntries() {
        assertEquals(NotificationLink("https://192.168.7.232:18443", "/more?panel=notifications"),
            NotificationLink.parse(prefix + "page=notifications"))
        assertEquals("/alerts?signal=signal-1", NotificationLink.parse(prefix + "page=alerts&signal=signal-1")?.path)
        assertEquals("/alerts?records=system", NotificationLink.parse(prefix + "page=alerts&records=system")?.path)
    }
    @Test fun rejectsArbitraryNavigationAndAmbiguousOrCredentialLinks() {
        for (link in listOf(null, "https://example.com", "marketwatch://other?page=alerts", prefix + "page=../settings",
            prefix + "page=alerts&signal=..%2Fsettings", prefix + "page=alerts&signal=x&records=system",
            prefix + "page=alerts&ack=secret", prefix + "page=alerts&page=notifications",
            prefix.replace("https%3A", "http%3A") + "page=alerts",
            prefix.replace("192.168", "user%3Asecret%40192.168") + "page=alerts")) {
            assertNull(link, NotificationLink.parse(link))
        }
    }
}

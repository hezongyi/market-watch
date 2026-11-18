package com.kookvv.marketwatch
import org.junit.Assert.*
import org.junit.Test
class BriefingLinkTest {
    private val id = "12345678-1234-1234-1234-123456789abc"
    private val prefix = "marketwatch://briefing/open?origin=https%3A%2F%2Fquant.kookvv.com%3A8443&report="
    @Test fun acceptsOnlyKnownReportRoute() {
        assertEquals(NotificationLink("https://quant.kookvv.com:8443", "/more?briefing=$id"), BriefingLink.parse(prefix + id))
        assertEquals(BriefingLink.parse(prefix + id), NotificationLink.parse(prefix + id))
        assertEquals("https://quant.kookvv.com", BriefingLink.parse(prefix.replace("%3A8443", "%3A443") + id)?.server)
    }
    @Test fun rejectsUntrustedOrAmbiguousInputs() {
        for (value in listOf(null, prefix + "../x", prefix + id + "&ack=secret", prefix + id + "#x", prefix + id + "&report=$id", prefix.replace("https", "http") + id, prefix.replace("quant.kookvv.com", "user%3Asecret%40quant.kookvv.com") + id, prefix.replace("/open", "/other") + id, prefix + "1-1-1-1-1")) assertNull(value, BriefingLink.parse(value))
    }
}

package com.kookvv.marketwatch

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** Notification links select a page on the saved server; they never change servers or confirm alerts. */
data class NotificationLink(val server: String, val path: String) {
    companion object {
        fun parse(value: String?): NotificationLink? = runCatching {
            BriefingLink.parse(value)?.let { return it }
            val uri = URI(value ?: return null)
            require(uri.scheme == "marketwatch" && uri.rawAuthority == "notification")
            require(uri.rawPath.isNullOrEmpty() && uri.rawFragment == null)
            val pairs = (uri.rawQuery ?: "").split('&').map {
                val parts = it.split('=', limit = 2)
                require(parts.size == 2)
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8")
            }
            require(pairs.map { it.first }.distinct().size == pairs.size)
            val query = pairs.toMap()
            require(query.keys.all { it in setOf("server", "page", "signal", "records") })
            val server = URI(query.getValue("server"))
            require(server.scheme == "https" && !server.host.isNullOrBlank() && server.rawUserInfo == null)
            require(server.rawQuery == null && server.rawFragment == null && server.rawPath in listOf("", "/"))
            require(server.port == -1 || server.port in 1..65535)
            val port = if (server.port == -1 || server.port == 443) "" else ":${server.port}"
            val origin = "https://${server.host.lowercase()}$port"
            val path = when (query.getValue("page")) {
                "notifications" -> { require(query.keys == setOf("server", "page")); "/more?panel=notifications" }
                "alerts" -> {
                    require(!(query.containsKey("signal") && query.containsKey("records")))
                    val signal = query["signal"]
                    if (signal != null) {
                        require(signal.matches(Regex("[A-Za-z0-9_-]{1,36}")))
                        "/alerts?signal=${URLEncoder.encode(signal, "UTF-8") }"
                    } else {
                        val records = query["records"] ?: "alerts"
                        require(records in setOf("alerts", "system"))
                        "/alerts?records=$records"
                    }
                }
                else -> error("Unknown notification page")
            }
            NotificationLink(origin, path)
        }.getOrNull()
    }
}

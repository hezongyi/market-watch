package com.kookvv.marketwatch

import java.net.URI
import java.net.URLDecoder
import java.util.UUID

/** A report link only selects a read-only page on the explicitly saved server. */
object BriefingLink {
    fun parse(value: String?): NotificationLink? = runCatching {
        val uri = URI(value ?: return null)
        require(uri.scheme == "marketwatch" && uri.rawAuthority == "briefing" && uri.rawPath == "/open")
        require(uri.rawFragment == null)
        val pairs = (uri.rawQuery ?: "").split('&').map {
            val parts = it.split('=', limit = 2)
            require(parts.size == 2)
            URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8")
        }
        require(pairs.map { it.first }.distinct().size == pairs.size)
        val query = pairs.toMap()
        require(query.keys == setOf("origin", "report"))
        val source = URI(query.getValue("origin"))
        require(source.scheme == "https" && !source.host.isNullOrBlank() && source.rawUserInfo == null)
        require(source.rawPath in listOf("", "/") && source.rawQuery == null && source.rawFragment == null)
        require(source.port == -1 || source.port in 1..65535)
        val id = query.getValue("report")
        require(id.matches(Regex("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")))
        require(UUID.fromString(id).toString().equals(id, ignoreCase = true))
        val port = if (source.port == -1 || source.port == 443) "" else ":${source.port}"
        NotificationLink("https://${source.host.lowercase()}$port", "/more?briefing=${id.lowercase()}")
    }.getOrNull()
}

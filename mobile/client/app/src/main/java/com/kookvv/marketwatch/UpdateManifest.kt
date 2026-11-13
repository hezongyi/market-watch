package com.kookvv.marketwatch

import org.json.JSONObject

data class UpdateManifest(val versionCode: Long, val versionName: String, val apk: String, val sha256: String, val size: Long, val notes: String) {
    companion object {
        fun parse(json: JSONObject, applicationId: String): UpdateManifest {
            return checked(json.getString("applicationId"), applicationId, json.getLong("versionCode"),
                json.getString("versionName"), json.getString("apk"), json.getString("sha256"),
                json.getLong("size"), json.optString("notes"))
        }

        fun checked(packageName: String, applicationId: String, versionCode: Long, versionName: String,
                    apk: String, sha256: String, size: Long, notes: String): UpdateManifest {
            require(packageName == applicationId)
            val result = UpdateManifest(versionCode, versionName, apk, sha256.lowercase(), size, notes.take(2000))
            require(result.versionCode > 0 && result.versionName.length in 1..64)
            require(result.apk.matches(Regex("market-watch-[A-Za-z0-9.-]+\\.apk")))
            require(result.sha256.matches(Regex("[a-f0-9]{64}")))
            require(result.size in 1..134217728)
            return result
        }
    }
}

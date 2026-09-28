# Android exact reminder delivery research

Date: 2026-09-28. Scope: OPPO Find X8, ColorOS 16, ntfy Play 1.25.2. No phone notifications sent by this research. Existing phone test results are user-provided evidence; this document does not claim new device validation.

## Decision

Use ntfy for delivery and a small Java Android companion for exact ringing cadence and acknowledgment synchronization. The user explicitly accepts installing an app. Native ntfy remains a fallback for continuous highest-priority ringing. Do not claim the native client implements 15 seconds on / 30 seconds off, bounded repeats, or remote cancellation.

A Tasker profile is feasible through ntfy's documented integration, but an untested generated Tasker export would not prove correct imports, permissions, concurrent alarms, persistent state, and web acknowledgment. A tiny companion has a versioned protocol, testable timing core, and reproducible APK build, and avoids requiring a paid automation product.

## Verified upstream behavior

Official ntfy documentation: https://docs.ntfy.sh/subscribe/phone/#automation-apps

Source: https://github.com/binwiederhier/ntfy-android/blob/main/app/src/main/java/io/heckel/ntfy/msg/BroadcastService.kt

The Android client broadcasts `io.heckel.ntfy.MESSAGE_RECEIVED` using `Context.sendBroadcast`. Relevant extras are:

| Extra | Android type | Use |
|---|---|---|
| `id` | String | ntfy transport deduplication |
| `base_url` | String | Filter configured ntfy server |
| `topic` | String | Filter configured topic |
| `time` | Int | Unix timestamp seconds |
| `title`, `message`, `click` | String | Display and application envelope |
| `priority` | Int | Transport priority |
| `muted` | Boolean | Whether ntfy subscription is muted |

The official instructions expressly recommend muting a topic when automation handles notifications. Muting is therefore compatible with receipt of automation broadcasts; avoid duplicate native sounds when the companion owns audio. Source source-code extras include `message_encoding`, whereas the docs table names `encoding`; do not depend on either for this text protocol.

Source: https://github.com/binwiederhier/ntfy-android/blob/main/app/src/main/java/io/heckel/ntfy/msg/NotificationService.kt

At research time `maybePlayInsistentSound` uses a looping MediaPlayer with `AudioAttributes.USAGE_ALARM`; it does not play if alarm volume is zero. It starts for maximum priority with the insistent preference enabled. This supports continuous ringing, not a server-controlled duration. No verified remote-stop interface was found. The inspected sources are current `main`, not a byte-for-byte certification of installed 1.25.2.

## Proposed application protocol (ours, not an ntfy API)

Use an application envelope in the ntfy message, or treat a matching topic broadcast solely as a hint to fetch authenticated pending deliveries. The second approach is safer and simpler: untrusted broadcasts must never supply an arbitrary URL to fetch with credentials or an acknowledgment token.

1. Companion stores configured HTTPS backend origin and a scoped device credential entered by the user.
2. On matching `base_url` + `topic` broadcast, fetch pending deliveries from that origin. Also periodically reconcile while monitoring is enabled, covering dropped hints and web acknowledgments.
3. Backend response supplies immutable delivery ID, human-readable message, ring seconds, pause seconds, maximum repeats (`null` means unlimited), quiet hours with timezone, and acknowledged status. Validate bounds on device.
4. Key all timers and deduplication by delivery ID, not ntfy message ID: server transport retries must not restart a ringing cycle.
5. Device acknowledgment stops audio immediately, records a durable pending acknowledgment, and POSTs an idempotent authenticated acknowledgment request. Retry failed POSTs. Website acknowledgment becomes visible through reconciliation and stops the corresponding delivery.
6. Use explicit states pending / ringing / resting / acknowledged / exhausted. Reaching repeat count is not acknowledgment. Quiet hours suppress sound; keep notification visible and state durable. Resume unacknowledged eligible delivery when quiet hours end.
7. Count an actual started ring as one repetition. One cycle is ring duration plus pause duration, so 15/30 means starts at 0, 45, 90 seconds. Prefer one audio player and an aggregate acknowledgment interface for concurrent deliveries.

Backend route names must match the implemented API rather than invent a second API merely to match this note.

## Android lifecycle constraints

Official references:

- https://developer.android.com/develop/background-work/background-tasks/broadcasts
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://developer.android.com/develop/background-work/services/fgs/timeout
- https://developer.android.com/develop/background-work/background-tasks/awake/wakelock

Start monitoring explicitly from the visible companion activity, then keep a visible foreground service. Register the ntfy receiver dynamically with the appropriate exported receiver flag because another app sends it. Do not depend on an implicit manifest receiver waking a stopped modern app or assume an arbitrary broadcast may start a foreground service.

For a persistent personal alert monitor, assess the `specialUse` foreground-service type and declare a meaningful subtype; do not label an always-on monitor as `dataSync`, which has modern background runtime limits. Release through a sideloaded signed APK first; Play policy review is a separate distribution issue. Add required foreground service and notification permissions for the target SDK. A foreground service is not proof against OEM task killing or force stop. Present monitoring status, battery settings guidance, notification permission, and alarm volume checks.

Use monotonic timing for short cadence, durable storage for delivery state, and a partial wake lock only while an active cadence requires exact CPU timing. Release audio and locks when acknowledged, exhausted, stopped, or silenced for a long interval. Persist pending acknowledgments so network failure does not replay already locally acknowledged alerts.

## Build strategy

Plain Java Activity + Service + SharedPreferences/SQLite + platform MediaPlayer/HttpURLConnection avoids a Kotlin toolchain and AndroidX dependence. Use the standard Android Gradle plugin, a pinned Gradle wrapper, JDK 17+ compatible with the plugin, and Android SDK platform/build tools. The workspace initially has Java but no SDK/Gradle; download official command-line tools into a temporary/cache location or provide a reproducible SDK-equipped build container. Install SDK packages after accepting licenses as allowed by the environment; never claim a source-only folder is an installable app.

Deliver debug APK for local acceptance, build instructions, SHA256 checksum, and a release signing procedure that keeps private signing keys out of version control. Test cadence/state transition code on the JVM, then emulator/instrumented integration where available. Physical OPPO long standby and OEM behavior still need device verification; existing short-lock test proves only that tested ntfy configuration.

## Acceptance evidence needed

- APK builds and installs; monitor can start and stop; permissions denied produce actionable UI.
- Simulated delivery gives 15 seconds audio and 30 seconds silence repeatedly, with timing recorded.
- Duplicate delivery does not reset cadence; multiple deliveries do not create uncontrolled overlapping players.
- Local acknowledgment stops immediately and survives restart/network outage.
- Web acknowledgment stops after documented reconciliation latency.
- Repeat limit, overnight quiet hours, timezone, quiet-hours exit, and process recovery tests.
- Do not send tests to the user's subscribed production topic without the parent agent's explicit send authorization.

# Mobile background-notification UI polish — 2026-11-17

Baseline `60d2e207`, retaining the deployed chart-price-alert workflow. F0: mobile composition and feedback changes; no backend, schema, delivery, acknowledgement or price-alert policy changes. Existing shadcn/Base UI controls and theme tokens are reused; no new dependencies.

## Result

The primary view contains the phone-push toggle, concise runtime quiet hours, connection/test actions and result. Service URL, topic and masked token settings open on demand; incomplete configuration opens automatically. Explanations live under receiver help. A sticky save bar appears only for drafts; save failures and conflicts stay beside it. Quiet preference changes remain immediate and explicitly say so. Service acceptance is distinct from phone acknowledgement, and failed result reads preserve the last known state with a retry.

Draft/back confirmation, token retention/masking, revision conflicts, records handoff and read polling cancellation remain intact. Ordinary results do not create floating toasts. A connection check verifies service reachability; it does not claim device delivery. Opening a notification does not acknowledge it.

## Verification

`npm run build` and `git diff --check` passed. Browser tests use the actual built MobileApp with explicit API fixtures, without changing real rules, settings or sending real notifications:

- `MOBILE_NTFY_OUTPUT=<unique-dir> node tests/mobile-ntfy.browser.cjs`: collapsed/expanded configuration, 375/412px in both themes with 100/150% text, visible save errors, conflict cancel/reload, token masking and failed-save draft preservation, quiet-policy save/failure preserving price-alert settings, independent read retries, accepted/confirmed delivery states, no floating toast and polling cancellation. In a 375×480 viewport, the clicked input remains above the visible sticky save bar. [Checks](settings-checks.json).
- `MOBILE_NTFY_OUTPUT=<unique-dir> node tests/mobile-notification-link.browser.cjs`: cold/warm notification navigation, exact event/record matching, draft preservation, explicit acknowledgement and quiet policy isolation. [Checks](links-checks.json).
- `MOBILE_MORE_OUTPUT=<unique-dir> node tests/mobile-more.browser.cjs`: More page and drawer regression, records handoff, shared geometry, large text, reduced motion, disabled/offline controls and settings/update/log interactions. [Checks](more-checks.json).

Screenshot review covered the built UI after animations. Representative before/after and expanded/short states:

- [Before, 375px light](before-light-375-14.png)
- [After, 375px light](notifications-light-375-14.png)
- [After, 375px dark at 150%](notifications-dark-375-21.png)
- [Expanded settings at 150%](settings-light-375-21.png)
- [Service accepted, awaiting phone confirmation](test-accepted.png)
- [Short viewport, focused field and save](short-viewport-save.png)

These are browser touch/viewport checks, not Android system-keyboard or actual ntfy receipt claims.

## Development deployment

Target: Ubuntu local Docker, persistent project `mw-dev`. Address: https://quant.kookvv.com:8443/m/more (LAN https://192.168.7.232:18443/m/more). Operate with `mw-dev status`, `mw-dev up` and `mw-dev stop`.

Replace Web only. Preserve API, workers, PostgreSQL, TLS, ntfy, private settings, FXCM helper and downloads. Private deployment manifest/configuration snapshots and rule/preference fingerprints live under `~/.local/share/market-watch-dev/evidence/mobile-notification-polish-20261117/`. Rollback only the Web image in the active persistent run configuration to `sha256:9442cb3771f6ccad875f6f60744e3ad4015673c0bafff1a85a63646f019c2756`, then run `docker compose -p mw-dev -f <private-run.json> up -d --no-build --no-deps web`. Do not restore a whole old environment.

Deployed at approximately 21:11 UTC on 2026-11-17. Web source commit: `53a32a71`; image ID: `sha256:4904739a2d71283ca702ee60479c9132a18dc8d906f590fd6cf22422438b0e2e`.

[Deployed read-only checks](deployed-checks.json) passed: trusted HTTPS/domain, authenticated transport and quiet-policy reads, deployed JS/CSS byte equality with the accepted build, professional-chart asset equality with the prior release, readiness and APK update manifest. All other seven running service IDs are unchanged. All eight existing rule-version configs and notification/provider preference fingerprints are unchanged. The persistent launcher retains the updated Web digest. A first external TLS connection ended before HTTP; the repeated complete verification passed without changing proxy/TLS settings.

No real notification was sent and no settings were saved during actual-instance acceptance. No new APK is needed; Android system keyboard and actual notification receipt remain device acceptance items.

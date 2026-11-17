# Mobile background-notification UI polish

Baseline `60d2e207` retains the deployed chart-price-alert workflow. F0: mobile UI composition and feedback only; preserve backend policies, API semantics, credentials, real rules and delivery/acknowledgement behavior.

Use existing shadcn/Base UI components. Put the notification toggle, concise runtime quiet policy and test actions in the primary view; disclose service/topic/token configuration on demand. Show a save action for drafts, inline failures and distinct test queue/service-acceptance/phone-confirmation states. Keep dirty-form back handling, nested-drawer exit, polling cancellation, large text and short-viewport reachability.

Verify actual built UI screenshots at 375/412px in both themes at 100/150% text; fixture interaction tests cover save/conflict/failure, policy preservation, notification links and records handoff. Actual development instance is read-only during acceptance; no test pushes or settings writes. Deploy Web only to Ubuntu mw-dev, preserve all other services/configuration and record image rollback.

# Chart price alert workflow

Approved specification: https://pages.kookvv.com:8443/p/page-46e81e56c27f3c100848/ (2026-11-17).

Baseline1550b7f6 retains the deployed native-provider, notification and chart fixes. F1: shared price-alert creation/editing and cross-client display; no schema or stored-format migration. Preserve existing rule versions, trigger counts and notification settings.

Implement capability-gated quick creation (cross/intrabar/once, phone according to actual configuration), explicit unavailable actions, fixed-price lines by full series identity across charts/timeframes, one fenced drag commit with uncertain-result recovery, and mobile touch/settings access. Object-based drawing/indicator association remains scoped. Fixed-price creation does not save a workspace. No native-provider alert admission or silent source substitution.

Verify adapter/controller regressions, licensed-chart menus and drag, desktop/mobile settings isolation, isolated backend lifecycle/notification regressions, then deploy only changed services to Ubuntu mw-dev preserving configuration. Real user rules are read-only; use fixtures for writes/trigger tests. Record runtime versions, rollback references and bounded acceptance.

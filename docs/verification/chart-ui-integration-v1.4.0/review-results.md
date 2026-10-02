# Chart UI integration review

Fixed base: `9fbf0a59cd735ff44e9d4f9f73fe2556716222c2`.
Initial integrated source: `09b6281666329a430f3d2749dafbf42b58e40d05`.
Method: code-review skill, independent Standards and Spec reviewers;
`git diff 9fbf0a59cd735ff44e9d4f9f73fe2556716222c2...HEAD`, plus follow-up fix delta.
Spec sources: `/tmp/market-watch-pr-merge-handoff.md` and
`deploy/releases/v1.3.2-ui.md`, with v1.4.0 Volume/native-history contracts retained.

## Standards

No documented hard violations. Secrets/keys and licensed vendor assets stay
excluded; fixed image/public path selection files are deployment metadata.
Version and schema stay aligned with current main; earlier image/browser records
remain labeled with original sources, rather than claimed as integration runs.

Two nonblocking heuristics remain: `chartThemeMenu` is now a misleadingly narrow
name (possible Mysterious Name), and one menu module also extends grid/watchlist
vendor DOM (possible Divergent Change). Rename/extraction may be separate work.
They do not establish product correctness failures or require scope expansion.

## Spec

Initial review found twoP2 blockers: UTF16 front-end length limits rejected or
truncated valid Unicode passwords before the backend's512-character boundary;
and sampling editRevision after async capture marked intervening viewport edits
clean. Independent reproduction and red regressions confirmed both.

Final review verified code-point counting and pre-capture revision/epoch fencing;
controlled Chromium8cases and save-race regression passed independently. The old
browser length assertions were updated to explicit error/no API call, as requested
by follow-up review. No residual concrete product Spec blocker identified.

Grid metadata and selector placement, native account controls, all-document save
entrypoints, subscriptions/change fields, compact display versus routing identity,
Volume descriptions and native-history paths remain present. Full source validation
finished406passed/1skipped and42frontend scripts; earlier deployment evidence does
not prove fresh combined-image/native-library runtime acceptance.

Standards:0hard violations,2minor heuristics. Spec:2P2 fixed,0residual product blockers.

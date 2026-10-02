# Chart UI and account integration with v1.4.0

The review worktree integrates all22 UI/deployment commits through `b3a3363`
with remote main `9fbf0a5` (v1.4.0), retaining the original branch and running
v1.3.2 dedicated deployment. The first integration commit is `09b6281`.
Two conflicts were resolved in bridge.js and the provider chart test file:
compact display symbols retain Volume semantics, both test groups remain, and
the moved history menu invokes both native provider correction recovery and
managed history refresh. Main's buffering/snapshot/lifecycle code is retained.

Independent Standards/Spec review found two password/save correctness issues.
The native password dialog and parent now count Unicode code points rather than
UTF16 units; HTML maxlength no longer silently truncates emoji passwords. Limits
remain1–512 for current and6–512 for new passwords, without trimming. Native save
samples editRevision/workspaceEpoch before asynchronous snapshot capture, so a
new viewport edit or workspace switch cannot receive a stale clean acknowledgement.
Both failures were reproduced before fixing. Backend512/513 boundaries, controlled
Chromium dialog/RPC cases and native snapshot race regressions now pass.

Final backend suite: **406passed,1skipped** on disposable UTF8 PostgreSQL17.11.
The fixture was stopped. **42 non-browser Node scripts**, **8 controlled browser
cases**, TypeScript/Vite build, host-bundle syntax and changed-scope Ruff passed.
Source hashes are in `tested-source-hashes.json`; `checks.json` records scope.
All77 original deployment/evidence files compare byte-identical to original UI
HEAD. Original images and browser evidence retain their recorded source IDs.

Setup failures are preserved: the first temporary PG outlived neither its
originating tool command nor the test setup; a second fixture's SQL_ASCII caused
psycopg/SQLAlchemy text decoding failures. The final fixture uses explicit UTF8
and starts/tests/stops in one command. The recovery test now counts its own
initial_history markers, because bootstrap adds auth.admin. Three VM harnesses
now dispatch by event type, after the new keydown handler exposed their assumption
that the first registered handler was always message. The old deployed account
browser script now expects explicit length validation rather than removed HTML
minlength; it was syntax checked, not rerun against the old deployed UI.

Schema remains main's `p17_volume`; the dedicated v1.3.2 copy's o16 downgrade is
historical deployment provenance and is not an integration migration plan.
No actual password was changed, existing services or other worktrees altered,
licensed vendor files committed, or remote push/PR/merge/tag performed.
These are source integration checks plus controlled browser contracts, not
fresh combined-image/native-library runtime acceptance. Future deployment needs
its own source/image mapping and target-environment checks.

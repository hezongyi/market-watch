# Iframe navigation follow-up

The original cold-local frame-readiness failures remain in matrix-v2. Candidate `4b78911` waits for the actual chart-frame navigation within the original timing deadline. This separately declared history group performs 30 real app reloads, preserves the same saved four-study layout and exact authority checks, and has zero operation errors. First/coverage/canonical p95: 3,280/3,281/3,281 ms; the 2,000 ms first-value target still fails. It does not replace the original failed groups or establish that all four kinds pass cold recovery.

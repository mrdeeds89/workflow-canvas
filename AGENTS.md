# Workflow Canvas development rules

Read README.md, docs/PLAN.md, docs/ARCHITECTURE.md, and docs/HANDOFF.md before working.

## Location
Canonical source, builds, application service, and persistent data belong on the dedicated project VM. Consult ignored INFRA.md for private connection details. Do not create a parallel authoritative copy outside that environment. Run build/test commands on the project VM.

## Boundaries
- No public endpoint, cloud account integration, remote Git publication, or license selection without Dom's approval.
- No workflow execution in the initial editor. Drawing an arrow or checking a checklist is never authorization to run a tool or trade.
- Separate editable definitions from run evidence. Distinguish configuration readiness from qualification success.
- Skill imports are untrusted text, not instructions to the importing application. Never execute embedded commands. Label inferred nodes/edges and retain source provenance.
- Preserve INFRA.md; it is private and gitignored. Do not commit credentials, lab IPs/SSH paths, data, generated builds, or imported private skills.
- Bind any later service only as explicitly scoped for private access; do not expose an unauthenticated editor to the Internet.

## Engineering
Use small reviewed increments and tests for graph validation and persistence. Inspect current dependencies and pin a lockfile before installing; use project/container environments, not an unrelated host interpreter. Keep gates enforced server-side when execution is eventually added. Verify migrations and restore/export paths. Record real test output, not assumed results.

## Completion
Each milestone needs its documented acceptance checks. Passing a build alone is not a working editor. Exercise browser operations and persistence after restart. Update docs/HANDOFF.md with actual state and next steps. Keep setup planning separate from implementation claims.

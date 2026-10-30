# Architecture proposal

Status: partially implemented. Schema 2, validation, SQLite persistence, the design-time HTTP API, and the canvas UI exist. Docker Compose, authentication, the card details panel, a workflow list, import/export routes, and execution do not.

## Deployment
Browser client → application HTTP service → SQLite and persistent data volume.
Frontend is built and served with the application. Docker Compose is the intended portable distribution boundary and is not packaged yet. Keep host addresses and deployment secrets outside repository defaults.

## Graph model
Versioned WorkflowDefinition (schema 2): id, title, description, revision, nodes, edges, groups, sourceReferences.

A node is a card. It carries a stable id, position, one of six card types (task, agent, integration, approval, artifact, note), a human/agent/unassigned owner, instructions, a JSON `spec` stored as inert text, acceptance criteria, and inputs/outputs.

Two card fields carry the product's main idea. `proposal` splits the work into `agentOwns` and `youOwn`, so a reader can see who owns each step rather than inferring it. `setup` is the checklist of configuration a card must pass before the step is ready to hand off, each task carrying a label, a detail line, an optional http(s) reference link, and a done flag.

`readiness` is the card's lifecycle: proposed, not_configured, configured, tested, operational. Only the first three are reachable by editing. `tested` and `operational` report the outcome of a real run, so a design-only editor must refuse to assert them; the server rejects them rather than letting a drawing imply a qualification. `configured` is derived on the server, not set by hand: an approved card (`not_configured`/`configured`) is stored as `configured` exactly when every setup task is checked (vacuously, when it has none) and as `not_configured` otherwise. `proposed` is never promoted automatically, because approval is a human decision. The badge therefore cannot contradict its own checklist.

Edges have stable IDs, endpoints and type: requires, data, conditional or revision. Conditional edges carry human-readable labels initially, not executable expressions.

Stored documents are migrated forward on load, in memory only, and the row is rewritten only when the client saves. A migration never invents state it has no evidence for.
Groups preserve member identities. Source references include document identity, hash/version and section locator. Inferred elements carry an explicit provenance flag.

WorkflowRun is a future separate entity. Design checklist completion must never masquerade as a successful run or a qualification result.

## Storage and API
Validate on the server. Use SQLite transactions and optimistic revision checks. Reject oversized payloads, dangling references, duplicate IDs and unsupported schema versions. Enforce graph semantics per edge type rather than globally forbidding explanatory revision arrows. Export portable JSON without host-specific absolute paths or secrets. Choose migration/backup strategy before data becomes valuable.

## Security posture
Private single-user first, not Internet-ready. Verify request origins and rendering safety; private networking is not a substitute for validation. Never interpret imported text, labels, or expressions as code. No execution API in first milestones. Add authentication and authorization before remote/public or multi-user exposure. Cloudflare and Supabase are not needed for initial deployment.

## UI
Canvas is the primary surface; details panel and source viewer are secondary. Pan/zoom, labelled arrows, distinct gate nodes, clear ownership and collapsible groups. Avoid reducing the product to Kanban columns. Editing a map and executing a workflow are separate actions and modes.

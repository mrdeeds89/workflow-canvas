# Data compatibility contract

This describes how Workflow Canvas reads a workflow document that comes from
**outside the store** — an uploaded file, another installation's export, or a
hand-edited document — safely and without surprises. It is the boundary the
import feature (a later slice) is built on. The code is `src/graph/compatibility.ts`
(`parseExternalWorkflow`), tested in `test/compatibility.test.ts`.

The parser is **pure**: it never writes a file, opens a socket, resolves a
source reference against the filesystem, executes anything, or mutates the input
document. The browser runs the exact same contract to preview an import, because
the module imports no Node APIs.

## Supported versions

- **Readable:** schema versions 1–5. A document below 5 is migrated forward in
  memory, one step at a time (`src/graph/migrate.ts`), then validated as a
  current document. A read never rewrites stored JSON.
- **Written:** always the current version (5). Import normalizes to the current
  schema; this is not a claim of byte-identical legacy output.
- **Refused, each with its own message:** a missing `schemaVersion`, one that is
  not a number, a fractional one, zero or negative, or a version newer than this
  build. A future version tells the reader to update the app rather than guessing.

## Migration is non-destructive

Migration only adds the fields a newer schema requires and keeps everything the
old document already held; it never drops user text and never invents content
(no default executor, no delivery target, no brief headings). A v1 checklist
becomes a setup list — a rename, not a discarded field. After migrating, the
document is validated; a migration that would produce an invalid document fails
loudly instead of importing a damaged workflow.

## Unknown fields are reported, not silently dropped

Validation keeps only known fields, so a naive import could quietly lose
content. The parser therefore reports every field that import would discard
(`discardedFields`: a `path` and a `field`), computed on the **migrated**
document so a renamed legacy field is not falsely flagged. Unknown fields are a
**report, not an error**: an otherwise-valid document still parses, and the
import UI is expected to show the discarded fields so a person can cancel instead
of losing them. Field names are compared with a `Set`, so `__proto__` and
similar strings are treated as ordinary unknown keys and never pollute a
prototype.

## Identity is checked, never repaired

The live editor validates unique node and edge ids, dangling edges and groups,
and dependency cycles (revision links are not dependencies). The external parser
adds the scoped-uniqueness checks the editor does not run, and **reports** rather
than renames a collision:

- group ids and source-reference ids unique within the workflow;
- setup-task ids unique within a card;
- input port ids and output port ids unique within a card (each collection
  separately);
- a node may appear in a group only once.

A document whose own identities collide is refused, so an import can never
quietly merge two things that claimed to be different.

## What is preserved, and what the destination decides

A current-version document round-trips with all definition fields and ids
preserved, and hostile-looking text (markup, `javascript:` strings) is kept
**verbatim** as inert text — it is never executed or stripped. A setup-task link
is the one place a URL is constrained: only empty or `http(s)` is allowed, so a
rendered anchor can't become a script or data URL.

The parser preserves the document's own `id` and `revision`. The **import
operation** (next slice) owns destination placement: it assigns the destination
id and resets the revision for the copy, and never infers a destination project
from the exporting host's ids. Graph persistence and this parse are separate
concerns — parsing a file changes nothing on disk.

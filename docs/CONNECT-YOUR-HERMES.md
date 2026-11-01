# Connect your Hermes and run a workflow

Workflow Canvas is a drawing board for workflows. It never does the work itself
and never holds anything that could start work on your machine. To actually run
a workflow you connect it to your own **Hermes**, which does the work and sends
you the result. You stay in control: every approval step waits for you, and a
run is never permission to trade or move money.

This guide has no code in it. It should take a few minutes.

## What you need

- **Hermes**, already set up and running on a machine you control.
- **Docker** on that machine. Workflow Canvas runs each step inside a sealed
  container so a step can't read your other secrets. If you don't have Docker,
  you can still connect, but only steps that need no tools will run.
- A few minutes at that machine's command line to run one installer command.

## Step 1 — Open "Connect Hermes" in Canvas

In the Canvas toolbar, click **Connect Hermes**. You'll see that no Hermes is
connected yet. Click **Show a pairing code**. Canvas shows a short code like
`ABCD-2345`. It works once and expires in about ten minutes, so do the next step
right away.

## Step 2 — Run the installer on your Hermes machine

On the machine where Hermes runs, start the Workflow Canvas installer and give
it the Canvas address and the pairing code from Step 1. The installer **tells
you every change it will make and asks before each one** — you can say no at any
point, and you can ask it to only preview.

It sets up, with your go-ahead:

- a **limited worker** that can only do the steps you approve, sealed off from
  your other Hermes secrets;
- a private **board** for Canvas's runs, separate from your other work;
- a small **once-a-minute check** that looks for approved runs and reports
  progress back.

When it finishes, Canvas shows that a Hermes is connected.

## Step 3 — Choose where results go

Back in Canvas, the connection panel lists where results can be sent — always
**a local file**, and any chat or channel your Hermes can already message (for
example a Telegram chat), which appear once your Hermes reports them.

On any **artifact** card (a card that marks an output), open it and use
**Deliver this output → Send to** to pick a destination, or leave it on *Don't
deliver* to keep the result inside the run. Your Hermes sends it; Canvas never
does, and the actual chat address never leaves your machine.

## Step 4 — Review the workflow, then run it

Open **What would run**. Canvas shows, step by step, exactly what Hermes would
do and flags anything that needs fixing first (an unapproved card, a missing
detail). When it's ready, click **Request run**. Nothing starts until your
Hermes picks it up on its next check.

## Step 5 — Approve when asked, and watch it

In the run view, each step shows its status as your Hermes reports it. When the
workflow reaches an **approval** step, it stops and waits. Nothing past that
point is even created until you click **Approve** — rejecting it ends that path.
You can **Stop** a run at any time. When a step that feeds a delivery finishes,
your Hermes sends the result to the destination you chose.

## Good to know

- **Canvas can't run anything on its own.** It only records what you approved;
  your Hermes does the work.
- **Approvals are real gates.** The next steps aren't created until your
  approval is recorded — an agent can't skip past them.
- **A run is never permission to trade or move money.** The worker has no
  trading, payment, or messaging tools, and every step it's given says so.
- **To disconnect**, click *Disconnect this Hermes* in the connect panel, or run
  the installer's uninstall on your machine. Your past runs are kept.

If you get stuck, see `docs/RUN-PLAN.md` and `harness/hermes/CONDUCTOR.md` for
the details behind each step.

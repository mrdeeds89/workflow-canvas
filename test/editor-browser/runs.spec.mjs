import { expect, test } from "@playwright/test";

/**
 * "What would run": the run checks in the browser, then a run request read
 * back from the API. Throwaway service from scripts/editor-browser.sh. No
 * conductor exists, so a request is a record and nothing runs.
 */

const RUN = { executor: "", skills: [], maxRuntimeMinutes: 30 };

function card(id, title, overrides = {}) {
  return {
    id, title, description: "", type: "task", position: { x: 0, y: 0 }, owner: "agent",
    instructions: `Do ${title}.`, spec: "", readiness: "configured", deliverTo: "",
    proposal: { agentOwns: [], youOwn: [] }, setup: [], inputs: [], outputs: [], acceptanceCriteria: [],
    inferred: false, run: RUN, ...overrides,
  };
}

async function seed(request) {
  const created = await (await request.post("/api/workflows", { data: { title: `Runs ${Math.random().toString(16).slice(2, 8)}` } })).json();
  const nodes = [
    card("gather", "Gather news", { position: { x: 0, y: 0 }, inferred: true }),
    card("ok", "Dom approves", { type: "approval", owner: "human", position: { x: 340, y: 0 } }),
    card("publish", "Write the brief", { position: { x: 680, y: 0 }, run: { executor: "runner", skills: ["research/daily-digest"], maxRuntimeMinutes: 20 } }),
  ];
  const edges = [
    { id: "e1", source: "gather", target: "ok", type: "requires", label: "", inferred: false },
    { id: "e2", source: "ok", target: "publish", type: "requires", label: "", inferred: false },
  ];
  const saved = await request.put(`/api/workflows/${created.id}`, { data: { ...created, nodes, edges } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  return saved.json();
}

test("run checks guide a fix, a request is recorded for the saved revision, and cancel sticks", async ({ page, request }) => {
  const doc = await seed(request);
  await page.goto(`/?w=${doc.id}`);
  await expect(page.getByLabel("Workflow title")).toBeVisible();
  const brief = page.getByRole("region", { name: "Workflow brief" });
  if (await brief.count()) await brief.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "What would run" }).click();
  const panel = page.getByRole("region", { name: "What would run" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Can't run yet: 2 things to fix")).toBeVisible();
  await expect(page.locator(".card__inferred")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Request run" })).toBeDisabled();
  await expect(panel.getByText(/nothing runs on any harness/)).toBeVisible();

  // The message opens the card it is about.
  await panel.getByRole("button", { name: /"Gather news" does not say which Hermes profile/ }).click();
  const details = page.getByRole("complementary", { name: "Card details" });
  await expect(details.getByLabel("Name")).toHaveValue("Gather news");
  await details.getByRole("button", { name: "Confirm this card" }).click();
  await expect(details.getByRole("note")).toHaveCount(0);
  await expect(page.locator(".card__inferred")).toHaveCount(0);
  await expect(panel.getByText("Can't run yet: 1 thing to fix")).toBeVisible();
  await details.getByLabel("Done by (Hermes profile)").fill("Runner");
  await expect(details.getByText(/Lowercase letters, digits/)).toBeVisible();
  await details.getByLabel("Done by (Hermes profile)").fill("runner");
  await expect(page.locator(".save--ok")).toHaveCount(0);
  await expect(page.locator(".save--ok")).toHaveText("All changes saved");

  await expect(panel.getByText("Ready to request: every step passes the run checks")).toBeVisible();
  const stages = panel.getByRole("list", { name: "Stages" });
  await expect(stages.locator(".runplan__stage")).toHaveCount(2);
  await expect(stages.locator(".runplan__stage").nth(0)).toContainText("Gather news");
  await expect(stages.locator(".runplan__stage").nth(0)).toContainText("Dom approves · waits for you");
  await expect(stages.locator(".runplan__stage").nth(1)).toContainText("after you approve Dom approves");
  await expect(stages.locator(".runplan__stage").nth(1)).toContainText("runner · research/daily-digest · up to 20 min");
  await expect(page.locator(".card__runner-name").first()).toHaveText("runner");
  await page.screenshot({ path: "test-results/runs-shots/runs-ready.png" });

  const before = await (await request.get(`/api/workflows/${doc.id}`)).json();
  expect(before.nodes.find((node) => node.id === "gather").run.executor).toBe("runner");
  expect(before.nodes.find((node) => node.id === "gather").inferred).toBe(false);

  await panel.getByRole("button", { name: "Request run" }).click();
  const table = panel.getByRole("table", { name: "Run requests" });
  await expect(table.getByText("Requested, waiting for a conductor")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Request run" })).toBeDisabled();

  const listing = await (await request.get(`/api/workflows/${doc.id}/runs`)).json();
  expect(listing.conductor).toBe("none");
  expect(listing.runs).toHaveLength(1);
  expect(listing.runs[0].status).toBe("requested");
  expect(listing.runs[0].revision).toBe(before.revision);
  expect(listing.runs[0].stepCount).toBe(3);
  // Requesting changed nothing in the workflow.
  expect((await (await request.get(`/api/workflows/${doc.id}`)).json()).revision).toBe(before.revision);
  await page.screenshot({ path: "test-results/runs-shots/runs-requested.png" });

  await table.getByRole("button", { name: "Cancel" }).click();
  await expect(table.getByText("Cancelled")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "What would run" }).click();
  await expect(page.getByRole("table", { name: "Run requests" }).getByText("Cancelled")).toBeVisible();
  const after = await (await request.get(`/api/workflows/${doc.id}/runs`)).json();
  expect(after.runs.map((run) => run.status)).toEqual(["cancelled"]);
});

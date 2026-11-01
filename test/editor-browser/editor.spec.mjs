import { expect, test } from "@playwright/test";

/**
 * Browser audit of the design-only editor. Each test drives the page and then
 * reads the API back, so a green result is stored state, not a painted claim.
 * The suite uses a throwaway database started by scripts/editor-browser.sh.
 */

function stamp(label) {
  return `${label} ${Math.random().toString(16).slice(2, 8)}`;
}

async function createWorkflow(request, title, projectId = null) {
  const response = await request.post("/api/workflows", { data: { title, projectId } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function createProject(request, title) {
  const response = await request.post("/api/projects", { data: { title } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function stored(request, id) {
  const response = await request.get(`/api/workflows/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function idFrom(page) {
  const id = new URL(page.url()).searchParams.get("w");
  expect(id).toBeTruthy();
  return id;
}

async function openWorkflow(page, id) {
  await page.goto(`/?w=${id}`);
  await expect(page.getByLabel("Workflow title")).toBeVisible();
  const brief = page.getByRole("region", { name: "Workflow brief" });
  if (await brief.count()) {
    await brief.getByRole("button", { name: "Close" }).click();
    await expect(brief).toHaveCount(0);
  }
}

async function waitSaved(page) {
  await expect(page.locator(".save--ok")).toHaveText("All changes saved");
}

/** The edit just made must leave the saved state, then come back to it. */
async function settleEdit(page) {
  await expect(page.locator(".save--ok")).toHaveCount(0);
  await expect(page.locator(".save--ok")).toHaveText("All changes saved");
}

async function row(page, title) {
  return page.locator(".row-item__open", { hasText: title }).first();
}

async function connectCards(page, from, to) {
  const close = page.getByRole("button", { name: "Close details" });
  if (await close.isVisible()) await close.click();
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  const source = page.locator(".react-flow__node").nth(from).locator(".react-flow__handle.source");
  const target = page.locator(".react-flow__node").nth(to).locator(".react-flow__handle.target");
  // Fit view animates. A drag during that move misses the 11px handles.
  let last = "";
  for (let i = 0; i < 25; i += 1) {
    const box = await source.boundingBox();
    const key = box ? `${Math.round(box.x)},${Math.round(box.y)}` : "";
    if (key && key === last) break;
    last = key;
    await page.waitForTimeout(40);
  }
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("card handles are not on screen");
  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 30 });
  await page.mouse.up();
}

test("card edits, a refused loop, and checklist readiness survive reload", async ({ page, request }) => {
  const title = stamp("Readiness");
  const created = await createWorkflow(request, title);
  await openWorkflow(page, created.id);
  await expect(page.getByText("Design only: nothing on this canvas runs.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Run|Execute)/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Task", exact: true }).click();
  const details = page.getByRole("complementary", { name: "Card details" });
  await expect(details).toBeVisible();
  await details.getByRole("textbox", { name: "Name" }).fill("Draft the note");
  await details.getByRole("textbox", { name: "Description" }).fill("Keep this as text");
  const youOwn = details.locator(".list-editor").filter({ hasText: "You own" });
  await youOwn.getByRole("button", { name: "+ Add line" }).click();
  await youOwn.getByRole("textbox", { name: "You own 1" }).fill("Set the audience");
  await details.getByRole("button", { name: "Approve" }).click();
  await expect(details.getByText("Configured", { exact: true })).toBeVisible();
  await waitSaved(page);
  const before = (await stored(request, created.id)).nodes[0].position;
  const card = page.locator(".react-flow__node").first();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 110, { steps: 12 });
  await page.mouse.up();
  await settleEdit(page);
  const moved = (await stored(request, created.id)).nodes[0].position;
  expect(moved).not.toEqual(before);

  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await connectCards(page, 0, 1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await waitSaved(page);

  // A second requires arrow the other way is a dependency loop and must not be stored.
  await connectCards(page, 1, 0);
  await expect(page.getByRole("status")).toContainText("loop");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  await page.locator(".react-flow__edge").click({ force: true });
  const arrow = page.getByRole("complementary", { name: "Arrow details" });
  await expect(arrow).toBeVisible();
  await arrow.getByRole("radio", { name: /^Data/ }).check();
  await arrow.getByRole("textbox", { name: /Label/ }).fill("notes");
  await waitSaved(page);
  await arrow.getByRole("radio", { name: /^Conditional/ }).check();
  await waitSaved(page);
  const condition = arrow.getByRole("textbox", { name: /Condition/ });
  await condition.fill("   ");
  await expect(arrow.getByText("Not saved until filled in")).toBeVisible();
  // Autosave must not store a blank condition. Wait past the 600ms timer.
  await page.waitForTimeout(900);
  expect((await stored(request, created.id)).edges[0]).toMatchObject({ type: "conditional", label: "notes" });
  await condition.fill("if reviewed");
  await waitSaved(page);

  await page.locator(".react-flow__node").first().click();
  await details.getByRole("button", { name: "+ Add check" }).click();
  await details.getByRole("textbox", { name: "Check 1" }).fill("Pick the model");
  await expect(details.getByText("Not configured", { exact: true })).toBeVisible();
  await details.getByRole("checkbox", { name: "Check 1 done" }).check();
  await expect(details.getByText("Configured", { exact: true })).toBeVisible();
  await details.getByRole("checkbox", { name: "Check 1 done" }).uncheck();
  await expect(details.getByText("Not configured", { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Move back to proposed" }).click();
  await details.getByRole("checkbox", { name: "Check 1 done" }).check();
  await expect(details.getByText("Proposed", { exact: true })).toBeVisible();
  await waitSaved(page);

  await page.reload();
  await expect(page.getByLabel("Workflow title")).toHaveValue(title);
  await expect(page.getByText("Draft the note")).toBeVisible();
  await expect(page.getByText("Set the audience")).toBeVisible();
  await expect(page.locator(".pill--proposed").first()).toBeVisible();
  const doc = await stored(request, created.id);
  expect(doc.nodes[0].readiness).toBe("proposed");
  expect(doc.nodes[0].setup[0]).toMatchObject({ text: "Pick the model", done: true });
  expect(doc.nodes[0].position).toEqual(moved);
  expect(doc.edges).toHaveLength(1);
  expect(doc.edges[0]).toMatchObject({ type: "conditional", label: "if reviewed" });
});

test("a bad link is not saved, Backspace in a field keeps the card, and panel delete persists", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Panel"));
  await openWorkflow(page, created.id);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  const details = page.getByRole("complementary", { name: "Card details" });
  const name = details.getByRole("textbox", { name: "Name" });
  await name.fill("Keep me");
  await name.press("Backspace");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await details.getByRole("button", { name: "+ Add check" }).click();
  await details.getByRole("button", { name: "Add a note or link" }).click();
  await details.getByRole("textbox", { name: "Check 1 link" }).fill("javascript:alert(1)");
  await expect(details.getByText("Not saved until fixed")).toBeVisible();
  await waitSaved(page);
  let doc = await stored(request, created.id);
  expect(doc.nodes[0].setup[0].link).toBe("");

  await details.getByRole("button", { name: "Delete card" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await waitSaved(page);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  doc = await stored(request, created.id);
  expect(doc.nodes).toEqual([]);
});

test("projects and workflows can be created and renamed, and that survives reload", async ({ page, request }) => {
  const projectName = stamp("Project");
  const renamedProject = `${projectName} renamed`;
  const workflowName = stamp("Named");
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Workflows" })).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByPlaceholder("Project name").fill(projectName);
  await page.getByPlaceholder("Project name").press("Enter");
  await expect(page.getByText(projectName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `New workflow in ${projectName}` }).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue("Untitled workflow");
  const id = idFrom(page);
  await page.getByLabel("Workflow title").fill(workflowName);
  await waitSaved(page);

  await page.getByRole("button", { name: `Rename project ${projectName}` }).click();
  await page.getByPlaceholder("Project name").fill(renamedProject);
  await page.getByPlaceholder("Project name").press("Enter");
  await expect(page.getByText(renamedProject, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Actions for ${workflowName}` }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const renamed = `${workflowName} renamed`;
  await page.getByPlaceholder("Workflow name").fill(renamed);
  await page.getByPlaceholder("Workflow name").press("Enter");
  await waitSaved(page);

  await page.reload();
  await expect(page.getByLabel("Workflow title")).toHaveValue(renamed);
  await expect(page.getByText(renamedProject, { exact: true })).toBeVisible();
  expect((await stored(request, id)).title).toBe(renamed);
  const library = await (await request.get("/api/library")).json();
  expect(library.projects.some((project) => project.title === renamedProject)).toBeTruthy();
  expect(library.workflows.find((workflow) => workflow.id === id).projectId).toBeTruthy();
});

test("duplicating the open workflow copies unsaved title and card text", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Source"));
  await openWorkflow(page, created.id);
  await page.getByRole("button", { name: "Note", exact: true }).click();
  const details = page.getByRole("complementary", { name: "Card details" });
  await details.getByRole("textbox", { name: "Name" }).fill("Unsaved card");
  const unsavedTitle = stamp("Unsaved title");
  await page.getByLabel("Workflow title").fill(unsavedTitle);
  await expect(page.locator(".save")).toHaveText("Unsaved changes");

  await page.getByRole("button", { name: `Actions for ${unsavedTitle}` }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue(`${unsavedTitle} (copy)`);
  await expect(page.getByText("Unsaved card")).toBeVisible();
  const copyId = idFrom(page);
  expect(copyId).not.toBe(created.id);

  const copy = await stored(request, copyId);
  const original = await stored(request, created.id);
  expect(copy.title).toBe(`${unsavedTitle} (copy)`);
  expect(copy.nodes.map((node) => node.title)).toEqual(["Unsaved card"]);
  expect(original.title).toBe(unsavedTitle);
  expect(original.nodes.map((node) => node.title)).toEqual(["Unsaved card"]);
  expect(copy.revision).toBe(1);
  expect(original.revision).toBeGreaterThan(created.revision);
});

test("delete asks first, and deleting the open workflow does not bring it back", async ({ page, request }) => {
  const keep = await createWorkflow(request, stamp("Keep"));
  const doomed = await createWorkflow(request, stamp("Doomed"));
  await openWorkflow(page, doomed.id);
  await page.getByLabel("Workflow title").fill(`${doomed.title} edited`);
  await expect(page.locator(".save")).toHaveText("Unsaved changes");

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(doomed.title);
    dialog.dismiss();
  });
  await page.getByRole("button", { name: `Actions for ${doomed.title}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await expect.poll(async () => (await request.get(`/api/workflows/${doomed.id}`)).status()).toBe(200);

  const puts = [];
  page.on("response", (response) => {
    if (response.request().method() === "PUT" && response.url().includes(doomed.id)) puts.push(response.status());
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `Actions for ${doomed.title}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await expect(page.getByLabel("Workflow title")).not.toHaveValue(`${doomed.title} edited`);
  await expect.poll(async () => (await request.get(`/api/workflows/${doomed.id}`)).status(), { timeout: 5000 }).toBe(404);
  await page.waitForTimeout(1000);
  expect((await request.get(`/api/workflows/${doomed.id}`)).status()).toBe(404);
  expect(puts.every((status) => status !== 200)).toBeTruthy();

  await page.reload();
  await expect(page.locator(".row-item__open", { hasText: doomed.title })).toHaveCount(0);
  await expect(page.locator(".row-item__open", { hasText: keep.title })).toBeVisible();
  expect(idFrom(page)).not.toBe(doomed.id);
});

test("a failed delete shows an error and a later edit still saves across switch and reload", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Keep"));
  const other = await createWorkflow(request, stamp("Other"));
  await openWorkflow(page, created.id);
  await page.route(`**/api/workflows/${created.id}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "http_error", message: "Delete failed with status 500." } }),
      });
      return;
    }
    await route.continue();
  });

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `Actions for ${created.title}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();

  await expect(page.getByRole("alert")).toContainText("Delete failed");
  await expect(page).toHaveURL(new RegExp(`[?&]w=${created.id}`));
  await expect(page.getByLabel("Workflow title")).toHaveValue(created.title);
  expect((await request.get(`/api/workflows/${created.id}`)).status()).toBe(200);

  const edited = `${created.title} kept`;
  await page.getByLabel("Workflow title").fill(edited);
  await settleEdit(page);
  expect((await stored(request, created.id)).title).toBe(edited);

  await (await row(page, other.title)).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue(other.title);
  await page.reload();
  await (await row(page, edited)).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue(edited);
  expect((await stored(request, created.id)).title).toBe(edited);
});

test("drag order and Move to survive reload", async ({ page, request }) => {
  const project = await createProject(request, stamp("Folder"));
  const other = await createProject(request, stamp("Other"));
  const first = await createWorkflow(request, stamp("First"), project.id);
  const second = await createWorkflow(request, stamp("Second"), project.id);
  const third = await createWorkflow(request, stamp("Third"), project.id);
  await openWorkflow(page, third.id);

  const titles = async () =>
    page.locator(".list").filter({ hasText: project.title }).locator(".row-item__open").allTextContents();
  const before = await titles();
  expect(before).toEqual([third.title, second.title, first.title]);

  const list = page.locator(".list").filter({ hasText: project.title });
  await list.locator(".row-item").first().dragTo(list.locator(".row-item").nth(2));
  await expect.poll(titles).not.toEqual(before);
  const dragged = await titles();

  await page.reload();
  await expect.poll(titles).toEqual(dragged);

  await (await row(page, third.title)).click();
  await page.getByRole("button", { name: `Actions for ${third.title}` }).click();
  await page.getByRole("menuitem", { name: /Move to/ }).click();
  await page.getByRole("menuitem", { name: other.title, exact: true }).click();
  await expect(page.locator(".list").filter({ hasText: other.title }).locator(".row-item__open", { hasText: third.title })).toBeVisible();

  await page.reload();
  await expect(page.locator(".list").filter({ hasText: other.title }).locator(".row-item__open", { hasText: third.title })).toBeVisible();
  await expect(page.locator(".list").filter({ hasText: project.title }).locator(".row-item__open", { hasText: third.title })).toHaveCount(0);
  const library = await (await request.get("/api/library")).json();
  expect(library.workflows.find((workflow) => workflow.id === third.id).projectId).toBe(other.id);
});

test("the sidebar stays collapsed across reload and opens again", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Rail"));
  await openWorkflow(page, created.id);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New workflow" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.getByRole("button", { name: "+ New workflow" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("workflow-canvas.sidebar-collapsed"))).toBe("0");
});

test("browser back and forward reopen the workflow that was left", async ({ page, request }) => {
  const alpha = await createWorkflow(request, stamp("Alpha"));
  const beta = await createWorkflow(request, stamp("Beta"));
  await openWorkflow(page, alpha.id);
  await (await row(page, beta.title)).click();
  await expect(page).toHaveURL(new RegExp(`w=${beta.id}`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`w=${alpha.id}`));
  await expect(page.getByLabel("Workflow title")).toHaveValue(alpha.title);
  await page.goForward();
  await expect(page.getByLabel("Workflow title")).toHaveValue(beta.title);
});

test("an edit followed immediately by switching workflows is stored", async ({ page, request }) => {
  const alpha = await createWorkflow(request, stamp("Switch"));
  const beta = await createWorkflow(request, stamp("Other"));
  await openWorkflow(page, alpha.id);
  const edited = `${alpha.title} edited`;
  await page.getByLabel("Workflow title").fill(edited);
  await expect(page.locator(".save")).toHaveText("Unsaved changes");
  await (await row(page, beta.title)).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue(beta.title);
  await expect.poll(async () => (await stored(request, alpha.id)).title).toBe(edited);
  await page.reload();
  await (await row(page, edited)).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue(edited);
});

test("rapid switching does not show a stale copy or stick on a stale revision", async ({ page, request }) => {
  const alpha = await createWorkflow(request, stamp("Rapid"));
  const beta = await createWorkflow(request, stamp("Hold"));
  await openWorkflow(page, alpha.id);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**/api/workflows/${alpha.id}`, async (route) => {
    if (route.request().method() === "PUT" && !held) {
      held = true;
      await gate;
    }
    await route.continue();
  });

  const edited = `${alpha.title} edited`;
  try {
    await page.getByLabel("Workflow title").fill(edited);
    await expect(page.locator(".save")).toHaveText("Unsaved changes");
    // The first click cannot navigate until the held save ends. Wait for that
    // round trip before editing again, or the keystrokes land on an editor
    // that is about to unmount.
    const left = page.waitForURL(new RegExp(`[?&]w=${beta.id}`));
    await page.getByRole("button", { name: beta.title, exact: true }).click();
    await page.getByRole("button", { name: edited, exact: true }).click();
    release();
    await left;
    await expect(page).toHaveURL(new RegExp(`[?&]w=${alpha.id}`));
    await expect(page.getByLabel("Workflow title")).toHaveValue(edited);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const again = `${edited} again`;
    await page.getByLabel("Workflow title").fill(again);
    await settleEdit(page);
    expect((await stored(request, alpha.id)).title).toBe(again);
    await expect(page.getByRole("button", { name: again, exact: true })).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    release();
  }
});

test("back then forward during an in-flight save still shows the edit", async ({ page, request }) => {
  const alpha = await createWorkflow(request, stamp("Hist"));
  const beta = await createWorkflow(request, stamp("Hist other"));
  await openWorkflow(page, alpha.id);
  await (await row(page, beta.title)).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue(beta.title);

  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**/api/workflows/${beta.id}`, async (route) => {
    if (route.request().method() === "PUT" && !held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  const edited = `${beta.title} edited`;
  try {
    await page.getByLabel("Workflow title").fill(edited);
    await expect(page.locator(".save")).toHaveText("Unsaved changes");
    await page.goBack({ waitUntil: "commit" });
    release();
    await page.goForward({ waitUntil: "commit" });
    await expect(page.getByLabel("Workflow title")).toHaveValue(edited);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    release();
  }
});

test("an edit made while a save is in flight is not lost to a self-conflict", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Concurrent"));
  await openWorkflow(page, created.id);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**/api/workflows/${created.id}`, async (route) => {
    if (route.request().method() === "PUT" && !held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.getByLabel("Workflow title").fill("First write");
    await page.waitForRequest((req) => req.method() === "PUT" && req.url().includes(created.id));
    await page.getByLabel("Workflow title").fill("Second write");
    await expect(page.locator(".save--ok")).toHaveCount(0);
    release();
    await expect(page.locator(".save--ok")).toHaveText("All changes saved");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect((await stored(request, created.id)).title).toBe("Second write");
    expect((await stored(request, created.id)).revision).toBeGreaterThan(created.revision + 1);
  } finally {
    release();
  }
});

test("a failed save can be retried and does not replace the stored workflow", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Retry"));
  await openWorkflow(page, created.id);
  await page.route(`**/api/workflows/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "http_error", message: "disk full" } }),
      });
      return;
    }
    await route.continue();
  });
  await page.getByLabel("Workflow title").fill("Should not land");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  expect((await stored(request, created.id)).title).toBe(created.title);

  await page.unroute(`**/api/workflows/${created.id}`);
  await page.getByRole("button", { name: "Retry" }).click();
  await waitSaved(page);
  expect((await stored(request, created.id)).title).toBe("Should not land");
});

test("a failed save stays on this workflow instead of switching away", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Stay"));
  const other = await createWorkflow(request, stamp("Elsewhere"));
  await openWorkflow(page, created.id);
  await page.route(`**/api/workflows/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "http_error", message: "disk full" } }),
      });
      return;
    }
    await route.continue();
  });
  await page.getByLabel("Workflow title").fill("Should stay");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await (await row(page, other.title)).click();
  await expect(page).toHaveURL(new RegExp(`[?&]w=${created.id}`));
  await expect(page.getByLabel("Workflow title")).toHaveValue("Should stay");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  expect((await stored(request, created.id)).title).toBe(created.title);
});

test("switching during a failing save does not resend the same failed write", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Once"));
  const other = await createWorkflow(request, stamp("Away"));
  await openWorkflow(page, created.id);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let puts = 0;
  await page.route(`**/api/workflows/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      puts += 1;
      if (puts === 1) await gate;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "http_error", message: "disk full" } }),
      });
      return;
    }
    await route.continue();
  });
  try {
    await page.getByLabel("Workflow title").fill("Fails once");
    await page.waitForRequest((req) => req.method() === "PUT" && req.url().includes(created.id));
    // Leaving asks the editor to settle while the first write is still open.
    // No new edit was made, so that request must not cause a second PUT.
    await (await row(page, other.title)).click();
    release();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.waitForTimeout(1500);
    expect(puts).toBe(1);
    await expect(page).toHaveURL(new RegExp(`[?&]w=${created.id}`));
  } finally {
    release();
  }
});

test("an edit during a failing save is sent once, not again by its autosave timer", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Twice"));
  await openWorkflow(page, created.id);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let puts = 0;
  await page.route(`**/api/workflows/${created.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      puts += 1;
      if (puts === 1) await gate;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "http_error", message: "disk full" } }),
      });
      return;
    }
    await route.continue();
  });
  try {
    await page.getByLabel("Workflow title").fill("First");
    await page.waitForRequest((req) => req.method() === "PUT" && req.url().includes(created.id));
    await page.getByLabel("Workflow title").fill("Second");
    release();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    // Past the 600ms autosave window: the follow-up is sent once, not twice.
    await page.waitForTimeout(1500);
    expect(puts).toBe(2);
  } finally {
    release();
  }
});

test("Back during a failing save keeps the address on the workflow still open", async ({ page, request }) => {
  const first = await createWorkflow(request, stamp("Before"));
  const second = await createWorkflow(request, stamp("Failing"));
  await openWorkflow(page, first.id);
  await (await row(page, second.title)).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue(second.title);
  await page.route(`**/api/workflows/${second.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "http_error", message: "disk full" } }),
      });
      return;
    }
    await route.continue();
  });
  await page.getByLabel("Workflow title").fill("Unsaved here");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.goBack({ waitUntil: "commit" });
  await expect(page.getByLabel("Workflow title")).toHaveValue("Unsaved here");
  await expect(page).toHaveURL(new RegExp(`[?&]w=${second.id}`));
});

test("a rename while the workflow is loading still opens the canvas", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Late"));
  await openWorkflow(page, created.id);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**/api/workflows/${created.id}`, async (route) => {
    if (route.request().method() === "GET" && !held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  const renamed = `${created.title} renamed`;
  try {
    await page.reload();
    await page.getByRole("button", { name: `Actions for ${created.title}` }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByPlaceholder("Workflow name").fill(renamed);
    await page.getByPlaceholder("Workflow name").press("Enter");
    release();
    await expect(page.getByLabel("Workflow title")).toHaveValue(renamed);
    await expect(page.getByText("Loading…")).toHaveCount(0);
    await expect.poll(async () => (await stored(request, created.id)).title).toBe(renamed);
  } finally {
    release();
  }
});

test("a stale revision is rejected and the other save stays stored", async ({ page, request }) => {
  const created = await createWorkflow(request, stamp("Stale"));
  await openWorkflow(page, created.id);
  const current = await stored(request, created.id);
  const other = await request.put(`/api/workflows/${created.id}`, {
    data: { ...current, title: "Saved elsewhere" },
  });
  expect(other.ok(), await other.text()).toBeTruthy();

  await page.getByLabel("Workflow title").fill("Local edit");
  await expect(page.getByRole("alert")).toContainText("changed somewhere else");
  await expect(page.locator(".save--bad")).toContainText("changed elsewhere");
  expect((await stored(request, created.id)).title).toBe("Saved elsewhere");

  await page.getByLabel("Workflow title").fill("Still local");
  await page.waitForTimeout(1200);
  expect((await stored(request, created.id)).title).toBe("Saved elsewhere");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue("Saved elsewhere");
});

test("seed a workflow the restart check reloads", async ({ page, request }) => {
  const created = await createWorkflow(request, "Restart sentinel");
  await openWorkflow(page, created.id);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.getByRole("complementary", { name: "Card details" }).getByRole("textbox", { name: "Name" }).fill("Kept card");
  await waitSaved(page);
  expect((await stored(request, created.id)).nodes[0].title).toBe("Kept card");
});

test("saved work is on the canvas after a service restart @restart", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Workflows" })).toBeVisible();
  await page.getByRole("button", { name: "Restart sentinel", exact: true }).click();
  await expect(page.getByLabel("Workflow title")).toHaveValue("Restart sentinel");
  await expect(page.getByText("Kept card")).toBeVisible();
  const library = await (await request.get("/api/library")).json();
  const sentinel = library.workflows.find((workflow) => workflow.title === "Restart sentinel");
  expect(sentinel).toBeTruthy();
  expect((await stored(request, sentinel.id)).nodes[0].title).toBe("Kept card");
});

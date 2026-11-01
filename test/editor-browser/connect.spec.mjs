import { expect, test } from "@playwright/test";

/**
 * Connect Hermes and the Deliver picker. Throwaway service from
 * scripts/editor-browser.sh. Canvas runs nothing; connecting shows a pairing
 * code, and an artifact card can be pointed at a delivery target the connected
 * Hermes offers (local file is always offered).
 */

async function newWorkflow(request) {
  const created = await (await request.post("/api/workflows", { data: { title: `Connect ${Math.random().toString(16).slice(2, 8)}` } })).json();
  return created;
}

async function closeBrief(page) {
  const brief = page.getByRole("region", { name: "Workflow brief" });
  if (await brief.count()) await brief.getByRole("button", { name: "Close" }).click();
}

test("Connect Hermes shows a one-time pairing code", async ({ page, request }) => {
  const doc = await newWorkflow(request);
  await page.goto(`/?w=${doc.id}`);
  await closeBrief(page);

  await page.getByRole("button", { name: "Connect Hermes" }).click();
  const panel = page.getByRole("region", { name: "Connect Hermes" });
  await expect(panel.getByText("No Hermes connected yet.")).toBeVisible();
  await panel.getByRole("button", { name: "Show a pairing code" }).click();
  await expect(panel.locator(".connect__code-value")).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // Local file is always an offered target, even before any Hermes is connected.
  await expect(panel.getByRole("list", { name: "Delivery targets" })).toContainText("Write to a local file");
});

test("the Deliver picker offers the local file, and a messaging target once a Hermes reports one", async ({ page, request }) => {
  const doc = await newWorkflow(request);
  await page.goto(`/?w=${doc.id}`);
  await closeBrief(page);

  // Add an artifact card; its details show the Deliver picker.
  await page.locator(".add--artifact").click();
  const details = page.getByRole("complementary", { name: "Card details" });
  await expect(details).toBeVisible();
  const picker = details.getByLabel("Delivery target");
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).toContainText(["Don't deliver", "Write to a local file"]);

  // Connect a Hermes out of band and have it report a messaging target.
  const code = (await (await request.post("/api/connect")).json()).code;
  const token = (await (await request.post("/api/conductor/pair", { data: { code } })).json()).token;
  const put = await request.put("/api/conductor/targets", {
    headers: { authorization: `Bearer ${token}` },
    data: { targets: [{ id: "t:telegram", label: "Telegram", kind: "messaging" }] },
  });
  expect(put.ok(), await put.text()).toBeTruthy();

  // A freshly opened artifact card now sees the reported target.
  await page.reload();
  await closeBrief(page);
  await page.locator(".add--artifact").click();
  const picker2 = page.getByRole("complementary", { name: "Card details" }).getByLabel("Delivery target");
  await expect(picker2.locator("option")).toContainText(["Don't deliver", "Write to a local file", "Telegram"]);

  // Choosing it saves deliverTo on the card.
  await picker2.selectOption({ label: "Telegram" });
  await expect(page.locator(".save--ok")).toHaveText("All changes saved");
  const saved = await (await request.get(`/api/workflows/${doc.id}`)).json();
  const artifact = saved.nodes.find((node) => node.type === "artifact" && node.deliverTo === "t:telegram");
  expect(artifact, "an artifact card stored the chosen delivery target").toBeTruthy();
});

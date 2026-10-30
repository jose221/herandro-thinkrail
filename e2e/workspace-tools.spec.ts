import { expect, test } from "@playwright/test";
import { openWorkspaceChat } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test("workspace tools share host state: requests, memory, git and an agent-driven browser", async ({
	page,
}) => {
	const workspace = await openWorkspaceChat(page);
	const origin = new URL(page.url()).origin;

	await page.getByTestId("tool-rail-requests").click();
	await expect(page.getByTestId("requests-pane")).toBeVisible();
	await page.getByTestId("requests-url").fill(`${origin}/health`);
	await page.getByTestId("requests-send").click();
	await expect(page.getByTestId("requests-status")).toContainText("200", { timeout: 15_000 });

	await page.getByTestId("requests-view-history").click();
	await expect(page.getByTestId("requests-pane")).toContainText(`${origin}/health`);
	await page.getByTestId("requests-view-request").click();
	await page.getByRole("button", { name: "Body", exact: true }).click();
	await page.getByRole("button", { name: "JSON", exact: true }).click();
	const bodyEditor = page.locator('[data-testid="requests-pane"] textarea').first();
	await bodyEditor.fill('{"broken": }');
	await expect(page.locator('[data-testid="requests-pane"] [role="alert"]').first()).toContainText(
		"JSON error",
	);
	await bodyEditor.fill('{"ok":true,"items":[1,2]}');
	await bodyEditor.blur();
	await expect(bodyEditor).toHaveValue('{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}');
	await page.getByTestId("requests-url").focus();
	await expect(page.locator("#requests-url-suggestions")).toBeVisible();

	await page.getByTestId("tool-rail-memory").click();
	await expect(page.getByTestId("memory-pane")).toBeVisible();
	await expect(page.locator('[data-testid="memory-pane"] tbody tr')).not.toHaveCount(0, {
		timeout: 15_000,
	});

	await page.getByTestId("tool-rail-git").click();
	await expect(page.getByTestId("git-pane")).toBeVisible();
	await page
		.getByTestId("git-pane")
		.getByRole("tab", { name: /History/ })
		.click();
	await page.getByTestId("git-commit-entry").first().click();
	await expect(page.getByTestId("git-pane").locator("pre")).toBeVisible();

	await page.getByTestId("tool-rail-browser").click();
	await expect(page.getByTestId("browser-pane")).toBeVisible();

	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		await wire.request("browser.navigate", {
			workspaceId: workspace.id,
			url: `${origin}/health`,
		});
	} finally {
		wire.close();
	}
	await expect(page.getByTestId("browser-frame")).toHaveAttribute("src", `${origin}/health`, {
		timeout: 15_000,
	});
});

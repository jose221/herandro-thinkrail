import { existsSync } from "node:fs";
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

test("browser capture attaches a host screenshot and deletes it when removed", async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
			configurable: true,
			value: async () => {
				const canvas = document.createElement("canvas");
				canvas.width = window.innerWidth;
				canvas.height = window.innerHeight;
				canvas.getContext("2d")?.fillRect(0, 0, canvas.width, canvas.height);
				return canvas.captureStream(5);
			},
		});
	});
	await openWorkspaceChat(page);
	const origin = new URL(page.url()).origin;

	await page.getByTestId("tool-rail-browser").click();
	await expect(page.getByTestId("browser-pane")).toBeVisible();
	await page.getByTestId("browser-viewport-mobile").click();
	await page.getByTestId("browser-device-iphone-se").click();
	await page.getByTestId("browser-url").fill(`${origin}/health`);
	await page.getByTestId("browser-url").press("Enter");
	await expect(page.getByTestId("browser-frame")).toHaveAttribute("src", `${origin}/health`);

	await page.getByTestId("browser-capture").click();
	await page.getByTestId("browser-capture-start").click();
	const chip = page.getByTestId("composer-image");
	await expect(chip).toHaveCount(1, { timeout: 15_000 });
	const draft = await page.getByTestId("chat-input").inputValue();
	const path = draft.match(/\/[^\n]+\.png/)?.[0];
	expect(path).toBeTruthy();
	expect(draft).toContain("iPhone SE");
	await expect.poll(() => existsSync(path ?? "")).toBe(true);

	await chip.locator("button").click();
	await expect(chip).toHaveCount(0);
	await expect.poll(() => existsSync(path ?? "")).toBe(false);
});

import { expect, type Locator, test } from "@playwright/test";
import { WS_CHANNELS } from "@thinkrail/contracts";
import { enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";

const testClient = {
	id: "test-acp",
	name: "Inline test ACP",
	command: "unused-acp-test",
	args: [],
	enabled: true,
};

const viewportWidths = [320, 375, 414, 768, 1024, 1280, 1440];

async function expectNoHorizontalOverflow(target: Locator, width: number): Promise<void> {
	const overflow = await target.evaluate(async (element) => {
		await new Promise(requestAnimationFrame);
		await new Promise(requestAnimationFrame);
		if (element.scrollWidth <= element.clientWidth) return null;
		const overflowingNodes = Array.from(element.querySelectorAll("*"))
			.filter(
				(node) =>
					node.clientWidth > 0 &&
					node.getBoundingClientRect().width > 0 &&
					node.scrollWidth > node.clientWidth,
			)
			.slice(0, 8)
			.map((node) => ({
				tag: node.tagName,
				className: typeof node.className === "string" ? node.className : "",
				scrollWidth: node.scrollWidth,
				clientWidth: node.clientWidth,
			}));
		return {
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			overflowingNodes,
		};
	});
	expect(overflow, `ACP UI overflows at ${width}px: ${JSON.stringify(overflow)}`).toBeNull();
}

test("ACP sign-in stays inside Settings for agent and terminal methods", async ({ page }) => {
	const requests: string[] = [];
	let originalCatalog: string | undefined;
	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		browser.onMessage((message) => {
			const frame = JSON.parse(String(message)) as {
				id?: string;
				method?: string;
			};
			if (!frame.id || !frame.method) {
				server.send(message);
				return;
			}

			requests.push(frame.method);
			if (frame.method === "acp.client.check") {
				browser.send(
					JSON.stringify({
						id: frame.id,
						ok: true,
						result: {
							available: true,
							authMethods: [
								{
									id: "agent-login",
									name: "Browser sign-in",
									description: "Continue in browser",
									type: "agent",
								},
								{ id: "terminal-login", name: "Terminal sign-in", type: "terminal" },
							],
						},
					}),
				);
			} else if (frame.method === "acp.client.authenticate") {
				browser.send(JSON.stringify({ id: frame.id, ok: true, result: { ok: true } }));
			} else if (frame.method === "acp.client.models") {
				browser.send(
					JSON.stringify({
						id: frame.id,
						ok: true,
						result: [
							{
								id: "model",
								name: "Model",
								category: "model",
								currentValue: "test-model",
								options: [{ value: "test-model", name: "Test model" }],
							},
						],
					}),
				);
			} else if (frame.method === "acp.client.authTerminal.start") {
				browser.send(
					JSON.stringify({
						channel: WS_CHANNELS.acpAuthTerminalData,
						data: { type: "data", id: "e2e-auth-terminal", data: "Sign in here\r\n" },
					}),
				);
				browser.send(
					JSON.stringify({
						channel: WS_CHANNELS.acpAuthTerminalExit,
						data: { type: "exit", id: "e2e-auth-terminal", success: true },
					}),
				);
				setTimeout(
					() =>
						browser.send(
							JSON.stringify({
								id: frame.id,
								ok: true,
								result: { id: "e2e-auth-terminal" },
							}),
						),
					1500,
				);
			} else {
				server.send(message);
			}
		});
		server.onMessage((message) => browser.send(message));
	});

	try {
		await openFixtureProject(page);
		await enterDefaultWorkspace(page);
		await page.getByTestId("open-settings").click();
		await page.getByTestId("settings-nav-acp").click();
		const acpSettings = page.getByTestId("settings-acp");
		await expect(page.getByTestId("settings-acp-v2-warning")).toContainText("experimental");
		await expect(page.getByTestId("settings-acp-args-security")).toContainText(
			"Do not put passwords",
		);
		for (const width of viewportWidths) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoHorizontalOverflow(acpSettings, width);
		}
		await page.setViewportSize({ width: 1280, height: 900 });
		const catalog = page.getByTestId("acp-clients-json");
		originalCatalog = await catalog.inputValue();
		await catalog.fill(JSON.stringify([testClient], null, 2));
		await page.getByTestId("acp-clients-save").click();
		await expect(page.getByTestId("acp-client-test-acp")).toBeVisible();

		await page.getByTestId("acp-client-login-test-acp").click();
		await expect(page.getByTestId("acp-client-auth-test-acp")).toContainText("Browser sign-in");
		await page.getByTestId("acp-client-auth-method-test-acp-agent-login").click();
		await expect(page.getByTestId("acp-client-auth-result-test-acp")).toContainText(
			"Sign-in completed.",
		);
		await expect(page.getByTestId("acp-client-models-test-acp")).toContainText("Test model");
		for (const width of viewportWidths) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoHorizontalOverflow(acpSettings, width);
		}
		await page.setViewportSize({ width: 1280, height: 900 });

		await page.getByTestId("acp-client-auth-method-test-acp-terminal-login").click();
		const authTerminal = page.getByTestId("acp-auth-terminal");
		await expect(authTerminal).toBeVisible();
		await expect(catalog).toBeDisabled();
		for (const width of viewportWidths) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoHorizontalOverflow(authTerminal, width);
		}
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect(page.getByTestId("acp-client-auth-result-test-acp")).toContainText(
			"Sign-in completed.",
		);
		expect(requests).toContain("acp.client.authenticate");
		expect(requests).toContain("acp.client.authTerminal.start");
		expect(requests).toContain("acp.client.models");
	} finally {
		if (originalCatalog !== undefined) {
			const dialog = page.getByTestId("settings-dialog");
			if (!(await dialog.isVisible())) await page.getByTestId("open-settings").click();
			const acpNavigation = page.getByTestId("settings-nav-acp");
			if ((await acpNavigation.getAttribute("data-active")) !== "true") {
				await acpNavigation.click();
			}
			const catalog = page.getByTestId("acp-clients-json");
			if ((await catalog.inputValue()) !== originalCatalog) {
				await catalog.fill(originalCatalog);
				await page.getByTestId("acp-clients-save").click();
				await expect(page.getByTestId("acp-client-test-acp")).toHaveCount(0);
			}
		}
	}
});

test("ACP model choices open a separate ACP chat without changing Pi", async ({ page }) => {
	const requests: Array<{ method: string; params: Record<string, string> }> = [];
	const sessionId = "acp_e2e_model_picker";
	let selectedModel = "test-fast";
	const snapshot = (workspaceId: string, clientId: string) => ({
		summary: {
			id: sessionId,
			workspaceId,
			clientId,
			clientName: "Droid",
			title: "Droid",
			state: "idle" as const,
			resumable: false,
			createdAt: 1,
			updatedAt: 1,
		},
		messages: [],
		toolCalls: [],
		plan: [],
		modes: [],
		currentMode: null,
		configOptions: [
			{
				id: "model",
				name: "Model",
				category: "model",
				currentValue: selectedModel,
				options: [
					{ value: "test-fast", name: "Test Fast" },
					{ value: "test-pro", name: "Test Pro" },
				],
			},
		],
		availableCommands: [],
		usage: null,
		permission: null,
	});

	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		browser.onMessage((message) => {
			const frame = JSON.parse(String(message)) as {
				id?: string;
				method?: string;
				params?: Record<string, string>;
			};
			if (!frame.id || !frame.method) {
				server.send(message);
				return;
			}
			requests.push({ method: frame.method, params: frame.params ?? {} });
			if (frame.method === "acp.client.models") {
				browser.send(
					JSON.stringify({
						id: frame.id,
						ok: true,
						result: [
							{
								id: "model",
								name: "Model",
								category: "model",
								currentValue: selectedModel,
								options: [
									{ value: "test-fast", name: "Test Fast" },
									{ value: "test-pro", name: "Test Pro" },
								],
							},
						],
					}),
				);
			} else if (frame.method === "acp.session.create") {
				const workspaceId = frame.params?.workspaceId ?? "";
				const clientId = frame.params?.clientId ?? "droid";
				browser.send(
					JSON.stringify({
						id: frame.id,
						ok: true,
						result: snapshot(workspaceId, clientId),
					}),
				);
			} else if (frame.method === "acp.session.setConfigOption") {
				selectedModel = frame.params?.value ?? selectedModel;
				browser.send(JSON.stringify({ id: frame.id, ok: true, result: { ok: true } }));
			} else if (frame.method === "acp.session.get") {
				browser.send(
					JSON.stringify({
						id: frame.id,
						ok: true,
						result: snapshot(frame.params?.workspaceId ?? "", "droid"),
					}),
				);
			} else {
				server.send(message);
			}
		});
		server.onMessage((message) => browser.send(message));
	});

	await openFixtureProject(page);
	await enterDefaultWorkspace(page);
	await page.getByTestId("new-chat").first().click();
	await expect(page.getByTestId("chat-input")).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 900 });
	const trigger = page.getByTestId("acp-model-picker-trigger");
	await expect(trigger).toBeVisible();
	expect(requests.some((request) => request.method === "acp.client.models")).toBe(false);
	const triggerBounds = await trigger.boundingBox();
	const historyBounds = await page.getByTestId("history-open").boundingBox();
	expect(triggerBounds).not.toBeNull();
	expect(historyBounds).not.toBeNull();
	if (triggerBounds && historyBounds) {
		expect(triggerBounds.x).toBeGreaterThan(historyBounds.x);
	}

	await trigger.click();
	const droidOptions = page.locator('[data-testid="acp-model-option"][data-client-id="droid"]');
	const antigravityOptions = page.locator(
		'[data-testid="acp-model-option"][data-client-id="antigravity"]',
	);
	await expect(droidOptions).toHaveCount(2);
	await expect(antigravityOptions).toHaveCount(2);
	expect(
		requests
			.filter((request) => request.method === "acp.client.models")
			.map((request) => request.params.clientId),
	).toEqual(["droid", "antigravity"]);
	expect(requests.some((request) => request.method === "acp.session.create")).toBe(false);
	await trigger.click();
	await expect(page.getByTestId("acp-model-picker")).toBeHidden();
	await trigger.click();
	await expect(droidOptions).toHaveCount(2);
	expect(requests.filter((request) => request.method === "acp.client.models")).toHaveLength(2);
	for (const width of viewportWidths) {
		await page.setViewportSize({ width, height: 900 });
		await expectNoHorizontalOverflow(page.locator("body"), width);
	}
	await page.setViewportSize({ width: 1280, height: 900 });
	await droidOptions.filter({ hasText: "Test Pro" }).click();
	await expect(page.getByTestId("acp-chat-pane")).toBeVisible();
	await expect(page.getByTestId("acp-model-select")).toHaveValue("test-pro");
	const modelSelectionRequest = requests.find(
		(request) => request.method === "acp.session.setConfigOption",
	);
	expect(modelSelectionRequest?.params).toEqual({
		workspaceId: expect.any(String),
		sessionId,
		configId: "model",
		value: "test-pro",
	});
	expect(requests.some((request) => request.method === "session.setModel")).toBe(false);
});

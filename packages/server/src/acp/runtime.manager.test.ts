import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpPermissionRequest, AcpSessionEvent } from "@thinkrail/contracts";
import { AcpSessionManager } from "./runtime";

const fakeAgent = `
let buffered = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "fake-agent-session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              category: "model",
              currentValue: "model-a",
              options: [
                { value: "model-a", name: "Model A" },
                { value: "model-b", name: "Model B" }
              ]
            }
          ]
        }
      });
    } else if (message.method === "session/set_config_option") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              category: "model",
              currentValue: message.params.value,
              options: [
                { value: "model-b", name: "Model B" },
                { value: "model-c", name: "Model C" }
              ]
            }
          ]
        }
      });
    } else if (message.method === "session/prompt") {
      globalThis.promptId = message.id;
      send({
        jsonrpc: "2.0",
        id: "agent-permission",
        method: "session/request_permission",
        params: {
          sessionId: "fake-agent-session",
          toolCall: { toolCallId: "fake-tool", title: "Edit a file", kind: "edit" },
          options: [
            { optionId: "agent-allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "agent-reject", name: "Deny", kind: "reject_once" }
          ]
        }
      });
    } else if (message.id === "agent-permission") {
      send({
        jsonrpc: "2.0",
        id: "file-write",
        method: "fs/write_text_file",
        params: {
          sessionId: "fake-agent-session",
          path: "allowed.txt",
          content: "fake write"
        }
      });
    } else if (message.id === "file-write") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-agent-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "fake reply" }
          }
        }
      });
      send({
        jsonrpc: "2.0",
        id: globalThis.promptId,
        result: { stopReason: "end_turn" }
      });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let tempDirectory = "";
let previousDataDirectory: string | undefined;

afterEach(() => {
	if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
	tempDirectory = "";
	if (previousDataDirectory === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = previousDataDirectory;
	previousDataDirectory = undefined;
});

test("uses ACP handshake, session identity, prompt updates, and isolated persistence", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-manager-"));
	const dataDirectory = join(tempDirectory, "data");
	const workspace = join(tempDirectory, "workspace");
	const agentPath = join(tempDirectory, "fake-agent.mjs");
	mkdirSync(workspace);
	writeFileSync(agentPath, fakeAgent);
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = dataDirectory;
	const events: AcpSessionEvent[] = [];
	let finishPrompt: (() => void) | undefined;
	let sessionId: string | undefined;
	const permissionQueue: AcpPermissionRequest[] = [];
	const permissionWaiters: Array<(permission: AcpPermissionRequest) => void> = [];
	const nextPermission = () =>
		new Promise<AcpPermissionRequest>((resolve) => {
			const permission = permissionQueue.shift();
			if (permission) resolve(permission);
			else permissionWaiters.push(resolve);
		});
	const config = {
		id: "fake-agent",
		name: "Fake ACP agent",
		command: process.execPath,
		args: [agentPath],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => workspace,
		publish: (event) => {
			events.push(event);
			if (event.type === "permission" && event.permission) {
				const waiter = permissionWaiters.shift();
				if (waiter) waiter(event.permission);
				else permissionQueue.push(event.permission);
			}
			if (event.type === "state" && event.sessionId === sessionId && event.state === "idle") {
				finishPrompt?.();
			}
		},
		clientVersion: "test",
	});

	try {
		expect(await manager.checkClient(config.id)).toEqual({ available: true });
		expect(await manager.listClientModels("workspace", config.id)).toEqual([
			{
				id: "model",
				name: "Model",
				category: "model",
				currentValue: "model-a",
				options: [
					{ value: "model-a", name: "Model A" },
					{ value: "model-b", name: "Model B" },
				],
			},
		]);
		expect(manager.list("workspace")).toEqual([]);
		const initial = await manager.create("workspace", config.id);
		expect(initial.summary.id).toMatch(/^acp_/);
		expect(initial.summary.id).not.toBe("fake-agent-session");
		expect(initial.summary.state).toBe("idle");
		expect(initial.configOptions).toEqual([
			{
				id: "model",
				name: "Model",
				category: "model",
				currentValue: "model-a",
				options: [
					{ value: "model-a", name: "Model A" },
					{ value: "model-b", name: "Model B" },
				],
			},
		]);

		sessionId = initial.summary.id;
		await manager.setConfigOption("workspace", sessionId, "model", "model-b");
		expect(manager.get("workspace", sessionId).configOptions).toEqual([
			{
				id: "model",
				name: "Model",
				category: "model",
				currentValue: "model-b",
				options: [
					{ value: "model-b", name: "Model B" },
					{ value: "model-c", name: "Model C" },
				],
			},
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "configOptions",
				sessionId,
				options: expect.arrayContaining([
					expect.objectContaining({ category: "model", currentValue: "model-b" }),
				]),
			}),
		);

		const waitForPrompt = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});
		const agentPermissionPromise = nextPermission();
		await manager.prompt("workspace", sessionId, "hello");
		const agentPermission = await agentPermissionPromise;
		expect(agentPermission.options).toContainEqual(
			expect.objectContaining({ optionId: "agent-allow-always", kind: "allow_always" }),
		);

		const localPermissionPromise = nextPermission();
		await manager.replyPermission(
			"workspace",
			sessionId,
			agentPermission.requestId,
			"agent-allow-always",
		);
		const localPermission = await localPermissionPromise;
		expect(localPermission.toolCallId).toMatch(/^thinkrail-/);
		const allowOnce = localPermission.options.find((option) => option.kind === "allow_once");
		if (!allowOnce) throw new Error("fake client permission was not available");
		await manager.replyPermission(
			"workspace",
			sessionId,
			localPermission.requestId,
			allowOnce.optionId,
		);
		await waitForPrompt;

		expect(readFileSync(join(workspace, "allowed.txt"), "utf8")).toBe("fake write");
		expect(manager.get("workspace", sessionId).messages).toContainEqual(
			expect.objectContaining({ role: "assistant", text: "fake reply" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "messageDelta",
				sessionId,
				delta: "fake reply",
			}),
		);
	} finally {
		await manager.closeAll();
	}
});

test("reports an unavailable ACP executable distinctly", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-missing-"));
	const missingCommand = join(tempDirectory, "missing-agent");
	const config = {
		id: "missing-agent",
		name: "Missing ACP agent",
		command: missingCommand,
		args: [],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		clientVersion: "test",
	});

	expect(await manager.checkClient(config.id)).toEqual({ available: false, issue: "executable" });
});

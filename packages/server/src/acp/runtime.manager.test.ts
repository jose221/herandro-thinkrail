import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as AcpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type {
	AcpAuthTerminalEvent,
	AcpPermissionRequest,
	AcpSessionEvent,
} from "@thinkrail/contracts";
import { AcpSessionManager } from "./runtime";

const fakeAgent = `
import { appendFileSync } from "node:fs";
const auditStart = process.argv.indexOf("--audit-start");
if (auditStart >= 0) appendFileSync(process.argv[auditStart + 1], "started\\n");
const initDelayIndex = process.argv.indexOf("--init-delay");
const initDelayMs = initDelayIndex >= 0 ? Number(process.argv[initDelayIndex + 1]) : 0;
let buffered = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const options = process.argv.includes("--large-config")
  ? Array.from({ length: 40 }, (_, index) => ({
      id: "option-" + index,
      name: "Option " + index,
      type: "select",
      category: "model",
      currentValue: "value-0",
      options: Array.from({ length: 120 }, (_, choiceIndex) => ({
        value: "value-" + choiceIndex,
        name: "Value " + choiceIndex
      }))
    }))
  : [
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
    ];
if (process.argv.includes("--large-config")) {
  options[31].name = "x".repeat(300);
}
const auditClose = process.argv.indexOf("--audit-close");
const recordClose = () => {
  if (auditClose >= 0) appendFileSync(process.argv[auditClose + 1], "closed\\n");
};
if (auditClose >= 0) {
  process.on("SIGTERM", () => {
    recordClose();
    process.exit(0);
  });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      const result = { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } };
      if (initDelayMs > 0) setTimeout(() => send(result), initDelayMs);
      else send(result);
    } else if (message.method === "session/new") {
      const result = {
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: "fake-agent-session", configOptions: options }
      };
      if (process.argv.includes("--slow-new")) setTimeout(() => send(result), 100);
      else send(result);
    } else if (message.method === "session/close") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
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
process.stdin.on("end", () => {
  recordClose();
  process.exit(0);
});
`;

const fakeAuthAgent = `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
if (process.argv.includes("--login-ui")) {
  process.stdout.write("ACP sign-in prompt\\r\\n");
  process.stdin.on("data", () => process.exit(0));
} else {
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
        const result = {
          protocolVersion: 1,
          authMethods: [
            { id: "agent-login", name: "Browser sign-in", description: "Continue in browser" },
            ...(process.argv.includes("--slow-auth")
              ? [{ id: "slow-login", name: "Slow sign-in" }]
              : []),
            {
              type: "terminal",
              id: "terminal-login",
              name: "Terminal sign-in",
              args: ["--login-ui"],
              env: { PRIVATE_AUTH_HINT: "not-sent-to-browser" }
            }
          ]
        };
        if (process.argv.includes("--slow-init")) {
          writeFileSync(process.argv[2], "started");
          setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result }), 10000);
        } else {
          send({ jsonrpc: "2.0", id: message.id, result });
        }
      } else if (message.method === "authenticate") {
        if (message.params.methodId === "slow-login") {
          writeFileSync(process.argv[2], "started");
        } else {
          send({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      } else if (message.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "fake-auth-session",
            configOptions: [
              {
                id: "model",
                name: "Model",
                type: "select",
                category: "model",
                currentValue: "model-a",
                options: [{ value: "model-a", name: "Model A" }]
              }
            ]
          }
        });
      }
    }
  });
}
`;

const fakeV2Agent = `
import { appendFileSync } from "node:fs";
const methods = ${JSON.stringify({
	initialize: AcpV2.methods.agent.initialize,
	sessionNew: AcpV2.methods.agent.session.new,
	sessionResume: AcpV2.methods.agent.session.resume,
	sessionClose: AcpV2.methods.agent.session.close,
	authLogin: AcpV2.methods.agent.auth.login,
	setConfigOption: AcpV2.methods.agent.session.setConfigOption,
	prompt: AcpV2.methods.agent.session.prompt,
	requestPermission: AcpV2.methods.client.session.requestPermission,
	update: AcpV2.methods.client.session.update,
})};
const configOptions = [
  {
    configId: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "model-a",
    options: [
      { value: "model-a", name: "Model A" },
      { value: "model-b", name: "Model B" }
    ]
  },
  {
    configId: "autopilot",
    name: "Autopilot",
    type: "boolean",
    category: "general",
    currentValue: false
  },
  {
    configId: "mode",
    name: "Mode",
    type: "select",
    category: "mode",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "build", name: "Build" }
    ]
  }
];
if (process.argv.includes("--terminal-login")) {
  process.stdout.write("ACP v2 sign-in " + process.env.ACP_V2_HINT + "\\r\\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", () => process.exit(0));
} else {
let buffered = "";
let promptId;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const setup = (sessionId) => ({
  sessionId,
  configOptions,
  availableCommands: [{ name: "review", description: "Review changes", input: { type: "text", hint: "Focus" } }]
});
const update = (sessionId, value) => send({
  jsonrpc: "2.0",
  method: methods.update,
  params: { sessionId, update: value }
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.method === methods.initialize) {
      if (!message.params.capabilities) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "ACP v2 required" } });
      } else {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 2,
            info: { name: "Fake ACP v2", version: "test" },
            capabilities: { session: {} },
            authMethods: [
              { type: "agent", methodId: "browser-login", name: "Browser sign-in" },
              {
                type: "terminal",
                methodId: "terminal-login",
                name: "Terminal sign-in",
                args: ["--terminal-login"],
                env: [{ name: "ACP_V2_HINT", value: "v2-terminal-env" }]
              }
            ]
          }
        });
      }
    } else if (message.method === methods.sessionNew) {
      send({ jsonrpc: "2.0", id: message.id, result: setup("fake-v2-session") });
    } else if (message.method === methods.sessionResume) {
      if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify({ method: "resume" }) + "\\n");
      update(message.params.sessionId, {
        sessionUpdate: "state_update",
        state: process.argv.includes("--resume-running") ? "running" : "idle"
      });
      send({ jsonrpc: "2.0", id: message.id, result: setup(message.params.sessionId) });
    } else if (message.method === methods.sessionClose || message.method === methods.authLogin) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === methods.setConfigOption) {
      if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify(message.params) + "\\n");
      const value = message.params.value;
      const selected = message.params.configId;
      for (const option of configOptions) {
        if (option.configId === selected) option.currentValue = value;
      }
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
    } else if (message.method === methods.prompt) {
      promptId = message.id;
      globalThis.activeSessionId = message.params.sessionId;
      const promptText = message.params.prompt.find((content) => content.type === "text")?.text;
      if (promptText === "action-then-idle") {
        update(message.params.sessionId, { sessionUpdate: "state_update", state: "requires_action" });
        update(message.params.sessionId, { sessionUpdate: "state_update", state: "idle" });
        send({ jsonrpc: "2.0", id: promptId, result: { messageId: "user-message-action" } });
        continue;
      }
      update(message.params.sessionId, { sessionUpdate: "state_update", state: "running" });
      if (promptText === "hang") {
        send({ jsonrpc: "2.0", id: promptId, result: { messageId: "user-message-hang" } });
        continue;
      }
      if (promptText === "metadata") {
        update(message.params.sessionId, {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "metadata-plan",
            entries: Array.from({ length: 101 }, (_, index) => ({
              content: index === 0 ? "x".repeat(10_001) : "plan-" + index,
              status: "in_progress",
              priority: "medium"
            }))
          }
        });
        update(message.params.sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: Array.from({ length: 101 }, (_, index) => ({
            name: "command-" + index,
            description: index === 0 ? "x".repeat(2_049) : "Description " + index,
            input: { type: "text", hint: "Hint " + index }
          }))
        });
        update(message.params.sessionId, {
          sessionUpdate: "session_info_update",
          title: "Agent title"
        });
        update(message.params.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "x".repeat(257),
          title: "x".repeat(1001),
          kind: "x".repeat(65),
          status: "completed"
        });
        update(message.params.sessionId, { sessionUpdate: "state_update", state: "idle" });
        send({ jsonrpc: "2.0", id: promptId, result: { messageId: "user-message-metadata" } });
        continue;
      }
      if (promptText === "many-message-ids") {
        for (let index = 0; index < 1000; index += 1) {
          update(message.params.sessionId, {
            sessionUpdate: "agent_message_chunk",
            messageId: "reply-" + index,
            content: { type: "text", text: "reply-" + index }
          });
        }
        update(message.params.sessionId, { sessionUpdate: "state_update", state: "idle" });
        send({ jsonrpc: "2.0", id: promptId, result: { messageId: "user-message-flood" } });
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: "v2-permission",
        method: methods.requestPermission,
        params: {
          sessionId: message.params.sessionId,
          subject: {
            type: "tool_call",
            toolCall: { toolCallId: "v2-tool", title: "Edit a file", kind: "edit" }
          },
          title: "Allow file edit",
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" }
          ]
        }
      });
    } else if (message.id === "v2-permission") {
      const sessionId = globalThis.activeSessionId;
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "v2-tool",
        title: "Edit a file",
        kind: "edit",
        status: "completed"
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "reply-1",
        content: { type: "text", text: "draft text" }
      });
      update(sessionId, {
        sessionUpdate: "agent_message",
        messageId: "reply-1",
        content: [{ type: "text", text: "Final reply" }]
      });
      for (let index = 0; index < 10; index += 1) {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          messageId: "image-reply",
          content: { type: "image", mimeType: "image/png", data: "YQ==" }
        });
      }
      update(sessionId, { sessionUpdate: "state_update", state: "idle" });
      send({ jsonrpc: "2.0", id: promptId, result: { messageId: "user-message-1" } });
    }
  }
});
}
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
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		expect(await manager.checkClient(config.id)).toEqual({
			available: true,
			authMethods: [],
		});
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

test("workspace removal closes live ACP children and purges their records", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-workspace-removal-"));
	const workspace = join(tempDirectory, "workspace");
	const agentPath = join(tempDirectory, "fake-agent.mjs");
	const closeAuditPath = join(tempDirectory, "closed.txt");
	mkdirSync(workspace);
	writeFileSync(agentPath, fakeAgent);
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(tempDirectory, "data");
	const config = {
		id: "fake-agent",
		name: "Fake ACP agent",
		command: process.execPath,
		args: [agentPath, "--audit-close", closeAuditPath, "--slow-new"],
		enabled: true,
	};
	const events: AcpSessionEvent[] = [];
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => workspace,
		publish: (event) => events.push(event),
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		const creating = manager.create("workspace", config.id);
		const removing = manager.removeWorkspace("workspace");
		const created = await creating;
		await removing;

		expect(readFileSync(closeAuditPath, "utf8")).toContain("closed\n");
		expect(manager.list("workspace")).toEqual([]);
		expect(events).toContainEqual({ type: "deleted", sessionId: created.summary.id });
		expect(() => manager.get("workspace", created.summary.id)).toThrow(
			"This ACP chat is not available",
		);
	} finally {
		await manager.closeAll();
	}
});

test("terminal approval shows the exact launch and session cleanup kills an ignoring child", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-terminal-approval-"));
	const dataDirectory = join(tempDirectory, "data");
	const workspace = join(tempDirectory, "workspace");
	const agentPath = join(tempDirectory, "fake-terminal-agent.mjs");
	const terminalPath = join(tempDirectory, "fake-terminal-child.mjs");
	const terminalPidPath = join(tempDirectory, "terminal-pid.json");
	mkdirSync(workspace);
	writeFileSync(
		terminalPath,
		`
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({
  pid: process.pid,
  mode: process.env.ACP_TERMINAL_APPROVAL_TEST
}));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
	);
	writeFileSync(
		agentPath,
		`
let buffered = "";
let promptId;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "terminal-session" } });
    } else if (message.method === "session/prompt") {
      promptId = message.id;
      send({
        jsonrpc: "2.0",
        id: "terminal-create",
        method: "terminal/create",
        params: {
          sessionId: "terminal-session",
          command: process.execPath,
          args: [${JSON.stringify(terminalPath)}, ${JSON.stringify(terminalPidPath)}],
          cwd: ".",
          env: [{ name: "ACP_TERMINAL_APPROVAL_TEST", value: "reviewed" }]
        }
      });
    } else if (message.id === "terminal-create") {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`,
	);
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = dataDirectory;
	const config = {
		id: "fake-terminal-agent",
		name: "Fake terminal agent",
		command: process.execPath,
		args: [agentPath],
		enabled: true,
	};
	let resolvePermission: ((permission: AcpPermissionRequest) => void) | undefined;
	const permissionReady = new Promise<AcpPermissionRequest>((resolve) => {
		resolvePermission = resolve;
	});
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => workspace,
		publish: (event) => {
			if (event.type === "permission" && event.permission) {
				resolvePermission?.(event.permission);
			}
		},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});
	let terminalPid: number | undefined;

	try {
		const session = await manager.create("workspace", config.id);
		const prompting = manager.prompt("workspace", session.summary.id, "run terminal");
		const permission = await permissionReady;
		expect(permission.title).toContain(
			JSON.stringify([process.execPath, terminalPath, terminalPidPath]),
		);
		expect(permission.title).toContain(JSON.stringify("ACP_TERMINAL_APPROVAL_TEST"));
		expect(permission.title).toContain(JSON.stringify("reviewed"));
		const allowOnce = permission.options.find((option) => option.kind === "allow_once");
		if (!allowOnce) throw new Error("ACP terminal permission was not available");
		await manager.replyPermission(
			"workspace",
			session.summary.id,
			permission.requestId,
			allowOnce.optionId,
		);
		await prompting;
		for (let attempt = 0; attempt < 200 && !existsSync(terminalPidPath); attempt++) {
			await Bun.sleep(10);
		}
		const terminal = JSON.parse(readFileSync(terminalPidPath, "utf8")) as {
			pid: number;
			mode: string;
		};
		terminalPid = terminal.pid;
		expect(terminal.mode).toBe("reviewed");

		await manager.closeAll();
		expect(() => process.kill(terminalPid as number, 0)).toThrow();
	} finally {
		await manager.closeAll();
		if (terminalPid !== undefined) {
			try {
				process.kill(terminalPid, "SIGKILL");
			} catch {}
		}
	}
});

test("supports ACP v2 auth, config options, permissions, message upserts, and resume", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-v2-"));
	const dataDirectory = join(tempDirectory, "data");
	const workspace = join(tempDirectory, "workspace");
	const agentPath = join(tempDirectory, "fake-v2-agent.mjs");
	const configAuditPath = join(tempDirectory, "config-options.jsonl");
	mkdirSync(workspace);
	writeFileSync(agentPath, fakeV2Agent);
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = dataDirectory;

	const events: AcpSessionEvent[] = [];
	const authTerminalEvents: AcpAuthTerminalEvent[] = [];
	let authTerminalOutput = "";
	let finishAuthTerminalOutput: (() => void) | undefined;
	let finishAuthTerminalExit: ((event: AcpAuthTerminalEvent) => void) | undefined;
	const authTerminalOutputReady = new Promise<void>((resolve) => {
		finishAuthTerminalOutput = resolve;
	});
	const authTerminalExited = new Promise<AcpAuthTerminalEvent>((resolve) => {
		finishAuthTerminalExit = resolve;
	});
	let sessionId: string | undefined;
	let finishPrompt: (() => void) | undefined;
	let metadataUpdateTypes: Set<string> | null = null;
	let finishMetadataUpdates: (() => void) | undefined;
	let runningEvents = 0;
	let finishAgentRunning: (() => void) | undefined;
	let runningBaseline = 0;
	const permissionQueue: AcpPermissionRequest[] = [];
	const permissionWaiters: Array<(permission: AcpPermissionRequest) => void> = [];
	const nextPermission = () =>
		new Promise<AcpPermissionRequest>((resolve) => {
			const permission = permissionQueue.shift();
			if (permission) resolve(permission);
			else permissionWaiters.push(resolve);
		});
	const config = {
		id: "fake-v2-agent",
		name: "Fake ACP v2 agent",
		command: process.execPath,
		args: [agentPath, configAuditPath],
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
			if (event.type === "state" && event.sessionId === sessionId && event.state === "running") {
				runningEvents += 1;
				if (finishAgentRunning && runningEvents >= runningBaseline + 2) {
					finishAgentRunning();
					finishAgentRunning = undefined;
				}
			}
			if (
				metadataUpdateTypes &&
				(event.type === "plan" || event.type === "availableCommands" || event.type === "title")
			) {
				metadataUpdateTypes.delete(event.type);
				if (metadataUpdateTypes.size === 0) finishMetadataUpdates?.();
			}
		},
		publishAuthTerminal: (clientKey, event) => {
			expect(clientKey).toBe("client-v2");
			authTerminalEvents.push(event);
			if (event.type === "data") {
				authTerminalOutput += event.data;
				if (authTerminalOutput.includes("v2-terminal-env")) finishAuthTerminalOutput?.();
			} else {
				finishAuthTerminalExit?.(event);
			}
			return true;
		},
		clientVersion: "test",
	});

	try {
		expect(await manager.checkClient(config.id)).toEqual({
			available: true,
			authMethods: [
				{ id: "browser-login", name: "Browser sign-in", type: "agent" },
				{ id: "terminal-login", name: "Terminal sign-in", type: "terminal" },
			],
		});
		await expect(
			manager.authenticateClient(config.id, "browser-login", "client-v2"),
		).resolves.toEqual({
			ok: true,
		});
		const authTerminal = await manager.startAuthTerminal(
			{
				workspaceId: "workspace",
				clientId: config.id,
				methodId: "terminal-login",
				cols: 80,
				rows: 24,
			},
			"client-v2",
		);
		await authTerminalOutputReady;
		expect(authTerminalOutput).toContain("v2-terminal-env");
		manager.writeAuthTerminal(authTerminal.id, "continue\r", "client-v2");
		expect(await authTerminalExited).toEqual({
			type: "exit",
			id: authTerminal.id,
			success: true,
		});
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

		const initial = await manager.create("workspace", config.id);
		sessionId = initial.summary.id;
		expect(initial.summary.resumable).toBe(true);
		expect(initial.modes).toEqual([
			{ id: "ask", name: "Ask" },
			{ id: "build", name: "Build" },
		]);
		expect(initial.availableCommands).toEqual([
			{ name: "review", description: "Review changes", inputHint: "Focus" },
		]);
		await expect(
			manager.prompt("workspace", sessionId, "oversized image", [
				{ type: "image", mimeType: "image/png", data: "A".repeat(1_000_001) },
			]),
		).rejects.toThrow("transcript size limit");

		await manager.setConfigOption("workspace", sessionId, "model", "model-b");
		await manager.setConfigOption("workspace", sessionId, "autopilot", "true");
		await manager.setMode("workspace", sessionId, "build");
		const configRequests = readFileSync(configAuditPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(configRequests).toContainEqual({
			sessionId: "fake-v2-session",
			configId: "model",
			type: "id",
			value: "model-b",
		});
		expect(configRequests).toContainEqual({
			sessionId: "fake-v2-session",
			configId: "autopilot",
			type: "boolean",
			value: true,
		});
		expect(configRequests).toContainEqual({
			sessionId: "fake-v2-session",
			configId: "mode",
			type: "id",
			value: "build",
		});

		const waitForPrompt = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});
		const permissionPromise = nextPermission();
		await manager.prompt("workspace", sessionId, "hello");
		const permission = await permissionPromise;
		expect(permission).toMatchObject({
			toolCallId: "v2-tool",
			title: "Allow file edit",
			options: expect.arrayContaining([
				expect.objectContaining({ optionId: "allow-once", kind: "allow_once" }),
			]),
		});
		await manager.replyPermission("workspace", sessionId, permission.requestId, "allow-once");
		await waitForPrompt;

		const snapshot = manager.get("workspace", sessionId);
		expect(
			snapshot.messages.filter((message) => message.role === "assistant" && message.text),
		).toEqual([
			expect.objectContaining({
				id: "v2-assistant-reply-1",
				role: "assistant",
				text: "Final reply",
			}),
		]);
		expect(
			snapshot.messages.find((message) => message.id === "v2-assistant-image-reply")?.images,
		).toHaveLength(8);
		expect(snapshot.currentMode).toBe("build");
		expect(snapshot.toolCalls).toContainEqual(
			expect.objectContaining({ id: "v2-tool", status: "completed" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "message",
				sessionId,
				entry: expect.objectContaining({ text: "Final reply" }),
			}),
		);

		const actionPromptSettled = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});
		await manager.prompt("workspace", sessionId, "action-then-idle");
		await actionPromptSettled;
		expect(manager.get("workspace", sessionId).summary.state).toBe("idle");

		const metadataPromptSettled = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});
		metadataUpdateTypes = new Set(["plan", "availableCommands", "title"]);
		const metadataUpdatesSettled = new Promise<void>((resolve) => {
			finishMetadataUpdates = resolve;
		});
		await manager.prompt("workspace", sessionId, "metadata");
		await metadataPromptSettled;
		await metadataUpdatesSettled;
		const metadataSnapshot = manager.get("workspace", sessionId);
		expect(metadataSnapshot.summary.state).toBe("idle");
		expect(metadataSnapshot.summary.title).toBe("Agent title");
		expect(metadataSnapshot.plan).toHaveLength(99);
		expect(metadataSnapshot.plan.every((entry) => entry.content.length <= 10_000)).toBe(true);
		expect(metadataSnapshot.plan.at(-1)?.content).toBe("plan-99");
		expect(metadataSnapshot.availableCommands).toHaveLength(99);
		expect(metadataSnapshot.availableCommands.at(-1)?.name).toBe("command-99");
		expect(metadataSnapshot.toolCalls).toHaveLength(1);
		expect(events).toContainEqual({ type: "title", sessionId, title: "Agent title" });

		const floodedPromptSettled = new Promise<void>((resolve) => {
			finishPrompt = resolve;
		});
		await manager.prompt("workspace", sessionId, "many-message-ids");
		await floodedPromptSettled;
		const floodedSnapshot = manager.get("workspace", sessionId);
		expect(floodedSnapshot.messages.length).toBeLessThanOrEqual(800);
		expect(floodedSnapshot.messages.at(-1)?.text).toBe("reply-999");

		await manager.closeAll();
		const resumed = await manager.resume("workspace", sessionId);
		expect(resumed.summary.state).toBe("idle");
		expect(resumed.summary.resumable).toBe(true);

		runningBaseline = runningEvents;
		const waitForAgentRunning = new Promise<void>((resolve) => {
			finishAgentRunning = resolve;
		});
		await manager.prompt("workspace", sessionId, "hang");
		await waitForAgentRunning;
		await manager.closeAll();
		expect(manager.get("workspace", sessionId).summary.state).toBe("interrupted");
	} finally {
		await manager.closeAll();
	}
});

test("coalesces concurrent ACP v2 resumes and preserves the resumed state", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-v2-resume-"));
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(tempDirectory, "data");
	const workspace = join(tempDirectory, "workspace");
	const agentPath = join(tempDirectory, "fake-v2-agent.mjs");
	const auditPath = join(tempDirectory, "resume-audit.jsonl");
	mkdirSync(workspace);
	writeFileSync(agentPath, fakeV2Agent);
	const config = {
		id: "fake-v2-agent",
		name: "Fake ACP v2 agent",
		command: process.execPath,
		args: [agentPath, auditPath, "--resume-running"],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => workspace,
		publish: () => {},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		const created = await manager.create("workspace", config.id);
		await manager.closeAll();
		const resumed = await Promise.all([
			manager.resume("workspace", created.summary.id),
			manager.resume("workspace", created.summary.id),
		]);
		expect(resumed.map((session) => session.summary.state)).toEqual(["running", "running"]);
		expect(
			readFileSync(auditPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.method === "resume"),
		).toHaveLength(1);
		await expect(
			manager.prompt("workspace", created.summary.id, "must not overlap resumed turn"),
		).rejects.toThrow("already responding");
	} finally {
		await manager.closeAll();
	}
});

test("keeps persisted ACP history when a restart interrupts a pending permission", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-pending-permission-"));
	const dataDirectory = join(tempDirectory, "data");
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = dataDirectory;
	const workspace = join(tempDirectory, "workspace");
	const agentPath = join(tempDirectory, "fake-v2-agent.mjs");
	mkdirSync(workspace);
	writeFileSync(agentPath, fakeV2Agent);
	const config = {
		id: "fake-v2-agent",
		name: "Fake ACP v2 agent",
		command: process.execPath,
		args: [agentPath],
		enabled: true,
	};
	let resolvePermission!: (permission: AcpPermissionRequest) => void;
	const permissionReady = new Promise<AcpPermissionRequest>((resolve) => {
		resolvePermission = resolve;
	});
	const options = {
		getClient: (id: string) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => workspace,
		publish: (event: AcpSessionEvent) => {
			if (event.type === "permission" && event.permission) resolvePermission(event.permission);
		},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	};
	const manager = new AcpSessionManager(options);
	let recovered: AcpSessionManager | undefined;

	try {
		const created = await manager.create("workspace", config.id);
		await manager.prompt("workspace", created.summary.id, "wait for permission");
		await permissionReady;
		const persistedPath = join(dataDirectory, "acp-sessions.json");
		const persistenceDeadline = Date.now() + 2_000;
		while (
			Date.now() < persistenceDeadline &&
			(!existsSync(persistedPath) ||
				!readFileSync(persistedPath, "utf8").includes("wait for permission"))
		) {
			await Bun.sleep(10);
		}
		expect(readFileSync(persistedPath, "utf8")).toContain("wait for permission");
		expect(statSync(persistedPath).mode & 0o777).toBe(0o600);

		recovered = new AcpSessionManager(options);
		const restored = recovered.get("workspace", created.summary.id);
		expect(restored.permission).toBeNull();
		expect(restored.summary.state).toBe("interrupted");
		expect(restored.messages.some((message) => message.role === "user")).toBe(true);
	} finally {
		await manager.closeAll();
		await recovered?.closeAll();
	}
});

test("reports an ACP start timeout distinctly", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-timeout-"));
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(tempDirectory, "data");
	const agentPath = join(tempDirectory, "fake-agent.mjs");
	writeFileSync(agentPath, fakeAgent);
	const config = {
		id: "slow-agent",
		name: "Slow ACP agent",
		command: process.execPath,
		args: [agentPath, "--init-delay", "1500"],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		getStartTimeout: () => 1_000,
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		expect(await manager.checkClient(config.id)).toEqual({ available: false, issue: "timeout" });
	} finally {
		await manager.closeAll();
	}
});

test("reuses the first successful ACP connection instead of probing twice", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-single-spawn-"));
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(tempDirectory, "data");
	const agentPath = join(tempDirectory, "fake-agent.mjs");
	const auditPath = join(tempDirectory, "starts.txt");
	writeFileSync(agentPath, fakeAgent);
	const config = {
		id: "single-spawn",
		name: "Single spawn agent",
		command: process.execPath,
		args: [agentPath, "--audit-start", auditPath],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		expect((await manager.create("workspace", config.id)).summary.state).toBe("idle");
		expect(readFileSync(auditPath, "utf8").trim().split("\n")).toEqual(["started"]);
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
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	expect(await manager.checkClient(config.id)).toEqual({ available: false, issue: "executable" });
});

test("discovers bounded auth methods and authenticates only agent-managed methods", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-auth-"));
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(tempDirectory, "data");
	const agentPath = join(tempDirectory, "fake-auth-agent.mjs");
	writeFileSync(agentPath, fakeAuthAgent);
	const config = {
		id: "fake-auth",
		name: "Fake auth agent",
		command: process.execPath,
		args: [agentPath],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		expect(await manager.checkClient(config.id)).toEqual({
			available: true,
			authMethods: [
				{
					id: "agent-login",
					name: "Browser sign-in",
					description: "Continue in browser",
					type: "agent",
				},
				{
					id: "terminal-login",
					name: "Terminal sign-in",
					type: "terminal",
				},
			],
		});
		expect(await manager.authenticateClient(config.id, "agent-login", "client-a")).toEqual({
			ok: true,
		});
		expect(await manager.listClientModels(tempDirectory, config.id)).toEqual([
			{
				id: "model",
				name: "Model",
				category: "model",
				currentValue: "model-a",
				options: [{ value: "model-a", name: "Model A" }],
			},
		]);
		expect((await manager.create(tempDirectory, config.id)).summary.state).toBe("idle");
		await expect(
			manager.authenticateClient(config.id, "terminal-login", "client-a"),
		).rejects.toThrow("ACP sign-in failed.");
		await expect(
			manager.authenticateClient(config.id, "not-advertised", "client-a"),
		).rejects.toThrow("ACP sign-in failed.");
	} finally {
		await manager.closeAll();
	}
});

test("bounds ACP config options before persisting sessions", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-config-limits-"));
	const workspace = join(tempDirectory, "workspace");
	const agentPath = join(tempDirectory, "large-config-agent.mjs");
	mkdirSync(workspace);
	writeFileSync(agentPath, fakeAgent);
	previousDataDirectory = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(tempDirectory, "data");
	const config = {
		id: "large-config",
		name: "Large config agent",
		command: process.execPath,
		args: [agentPath, "--large-config"],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => workspace,
		publish: () => {},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		const snapshot = await manager.create(workspace, config.id);
		expect(snapshot.configOptions).toHaveLength(31);
		expect(snapshot.configOptions[0]?.options).toHaveLength(100);
		expect(snapshot.configOptions.every((option) => option.name.length <= 256)).toBe(true);
	} finally {
		await manager.closeAll();
	}
});

test("runs terminal auth in an owner-addressed ephemeral PTY", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-auth-terminal-"));
	const agentPath = join(tempDirectory, "fake-auth-agent.mjs");
	writeFileSync(agentPath, fakeAuthAgent);
	const config = {
		id: "fake-auth",
		name: "Fake auth agent",
		command: process.execPath,
		args: [agentPath],
		enabled: true,
	};
	const events: AcpAuthTerminalEvent[] = [];
	let resolveData: (() => void) | undefined;
	let resolveExit: ((event: AcpAuthTerminalEvent) => void) | undefined;
	let resolveCleanupExit: ((event: AcpAuthTerminalEvent) => void) | undefined;
	const dataReady = new Promise<void>((resolve) => {
		resolveData = resolve;
	});
	const exited = new Promise<AcpAuthTerminalEvent>((resolve) => {
		resolveExit = resolve;
	});
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: (clientKey, event) => {
			expect(["owner", "disconnected-owner"]).toContain(clientKey);
			events.push(event);
			if (event.type === "data") resolveData?.();
			else {
				resolveExit?.(event);
				resolveCleanupExit?.(event);
			}
			return true;
		},
		clientVersion: "test",
	});

	try {
		const terminal = await manager.startAuthTerminal(
			{
				clientId: config.id,
				methodId: "terminal-login",
				cols: 80,
				rows: 24,
			},
			"owner",
		);
		await dataReady;
		expect(events).toContainEqual(expect.objectContaining({ type: "data", id: terminal.id }));
		expect(() =>
			manager.writeAuthTerminal(terminal.id, "should-not-reach-agent", "intruder"),
		).toThrow("ACP sign-in terminal is no longer available.");
		expect(() =>
			manager.writeAuthTerminal(terminal.id, "x".repeat(32 * 1024 + 1), "owner"),
		).toThrow("ACP sign-in terminal input is invalid.");
		expect(() => manager.resizeAuthTerminal(terminal.id, 0, 24, "owner")).toThrow(
			"Invalid ACP sign-in terminal size.",
		);
		manager.writeAuthTerminal(terminal.id, "continue\r", "owner");
		expect(await exited).toEqual({ type: "exit", id: terminal.id, success: true });
		const shutdownTerminal = await manager.startAuthTerminal(
			{
				clientId: config.id,
				methodId: "terminal-login",
				cols: 80,
				rows: 24,
			},
			"owner",
		);
		await manager.closeAll();
		expect(events).toContainEqual({
			type: "exit",
			id: shutdownTerminal.id,
			success: false,
		});
		const cleanupExited = new Promise<AcpAuthTerminalEvent>((resolve) => {
			resolveCleanupExit = resolve;
		});
		const disconnectedTerminal = await manager.startAuthTerminal(
			{
				clientId: config.id,
				methodId: "terminal-login",
				cols: 80,
				rows: 24,
			},
			"disconnected-owner",
		);
		manager.cleanupClient("disconnected-owner");
		expect(await cleanupExited).toEqual({
			type: "exit",
			id: disconnectedTerminal.id,
			success: false,
		});
	} finally {
		await manager.closeAll();
	}
});

test("cleans up a disconnected agent sign-in and releases its client lock", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-auth-cancel-"));
	const agentPath = join(tempDirectory, "fake-auth-agent.mjs");
	const markerPath = join(tempDirectory, "auth-started");
	writeFileSync(agentPath, fakeAuthAgent);
	const config = {
		id: "fake-auth",
		name: "Fake auth agent",
		command: process.execPath,
		args: [agentPath, markerPath, "--slow-auth"],
		enabled: true,
	};
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		const authentication = manager.authenticateClient(config.id, "slow-login", "client-a");
		for (let attempt = 0; attempt < 200 && !existsSync(markerPath); attempt++) {
			await Bun.sleep(10);
		}
		expect(existsSync(markerPath)).toBe(true);
		manager.cancelClientAuthentication(config.id, "another-client");
		manager.cleanupClient("client-a");

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cancellation = Promise.race([
			authentication,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("Sign-in cancellation timed out.")), 2000);
			}),
		]);
		try {
			await expect(cancellation).rejects.toThrow("ACP sign-in failed.");
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		await expect(manager.authenticateClient(config.id, "agent-login", "client-a")).resolves.toEqual(
			{ ok: true },
		);
	} finally {
		await manager.closeAll();
	}
});

test("reserves the terminal auth limit while starts are negotiating", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-auth-limit-"));
	const agentPath = join(tempDirectory, "fake-auth-agent.mjs");
	writeFileSync(agentPath, fakeAuthAgent);
	const clients = Array.from({ length: 5 }, (_, index) => ({
		id: `fake-auth-${index}`,
		name: "Fake auth agent",
		command: process.execPath,
		args: [agentPath],
		enabled: true,
	}));
	const manager = new AcpSessionManager({
		getClient: (id) => clients.find((client) => client.id === id),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: () => true,
		clientVersion: "test",
	});

	try {
		const results = await Promise.allSettled(
			clients.map((client) =>
				manager.startAuthTerminal(
					{
						clientId: client.id,
						methodId: "terminal-login",
						cols: 80,
						rows: 24,
					},
					"owner",
				),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	} finally {
		await manager.closeAll();
	}
});

test("closeAll cancels a terminal auth start during ACP initialization", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-auth-start-shutdown-"));
	const agentPath = join(tempDirectory, "fake-auth-agent.mjs");
	const markerPath = join(tempDirectory, "auth-starting");
	writeFileSync(agentPath, fakeAuthAgent);
	const config = {
		id: "fake-auth",
		name: "Fake auth agent",
		command: process.execPath,
		args: [agentPath, markerPath, "--slow-init"],
		enabled: true,
	};
	const events: AcpAuthTerminalEvent[] = [];
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: (_clientKey, event) => {
			events.push(event);
			return true;
		},
		clientVersion: "test",
	});

	try {
		const starting = manager.startAuthTerminal(
			{
				clientId: config.id,
				methodId: "terminal-login",
				cols: 80,
				rows: 24,
			},
			"owner",
		);
		for (let attempt = 0; attempt < 200 && !existsSync(markerPath); attempt++) {
			await Bun.sleep(10);
		}
		expect(existsSync(markerPath)).toBe(true);
		let startError: unknown;
		const startSettled = starting.catch((error: unknown) => {
			startError = error;
		});
		await manager.closeAll();
		await startSettled;
		expect(startError).toBeInstanceOf(Error);
		expect(startError).toMatchObject({
			message: expect.stringContaining("ACP terminal sign-in could not start."),
		});
		expect(events).toEqual([]);
	} finally {
		await manager.closeAll();
	}
});

test("cancels pending and active auth terminal starts for the owning client", async () => {
	tempDirectory = mkdtempSync(join(tmpdir(), "thinkrail-acp-auth-start-cancel-"));
	const agentPath = join(tempDirectory, "fake-auth-agent.mjs");
	const markerPath = join(tempDirectory, "auth-starting");
	writeFileSync(agentPath, fakeAuthAgent);
	const config = {
		id: "fake-auth",
		name: "Fake auth agent",
		command: process.execPath,
		args: [agentPath, markerPath, "--slow-init"],
		enabled: true,
	};
	let resolveExit: ((event: AcpAuthTerminalEvent) => void) | undefined;
	const activeExit = new Promise<AcpAuthTerminalEvent>((resolve) => {
		resolveExit = resolve;
	});
	const manager = new AcpSessionManager({
		getClient: (id) => (id === config.id ? config : undefined),
		resolveWorkspaceCwd: () => tempDirectory,
		publish: () => {},
		publishAuthTerminal: (_clientKey, event) => {
			if (event.type === "exit") resolveExit?.(event);
			return true;
		},
		clientVersion: "test",
	});

	try {
		const starting = manager.startAuthTerminal(
			{ clientId: config.id, methodId: "terminal-login", cols: 80, rows: 24 },
			"owner",
		);
		for (let attempt = 0; attempt < 200 && !existsSync(markerPath); attempt++) {
			await Bun.sleep(10);
		}
		expect(existsSync(markerPath)).toBe(true);
		manager.cancelAuthTerminalStart(config.id, "another-client");
		manager.cancelAuthTerminalStart(config.id, "owner");
		await expect(starting).rejects.toThrow("ACP terminal sign-in could not start.");

		config.args = [agentPath];
		const terminal = await manager.startAuthTerminal(
			{ clientId: config.id, methodId: "terminal-login", cols: 80, rows: 24 },
			"owner",
		);
		manager.cancelAuthTerminalStart(config.id, "owner");
		expect(await activeExit).toEqual({
			type: "exit",
			id: terminal.id,
			success: false,
		});
	} finally {
		await manager.closeAll();
	}
});

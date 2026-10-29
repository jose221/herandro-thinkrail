import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidEmulatorManager, type AndroidToolchain } from "./runtime";

let directory = "";
const managers: AndroidEmulatorManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose();
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = "";
});

function fixture(options: { idleTtlMs?: number } = {}) {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-android-emulator-"));
	const callsPath = join(directory, "adb-calls.jsonl");
	const launchPath = join(directory, "emulator-launches.txt");
	const adbPath = join(directory, "fake-adb.js");
	const emulatorPath = join(directory, "fake-emulator.js");
	const workspaceRoot = join(directory, "workspace");
	mkdirSync(workspaceRoot);
	const adbScript = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "devices") {
  process.stdout.write("List of devices attached\\n3b413722 device product:test model:phone\\n");
} else if (args[0] === "-s") {
  const command = args.slice(2);
  if (command[0] === "get-state") process.stdout.write("device\\n");
  else if (command[0] === "shell" && command[1] === "getprop") {
    const properties = {
      "sys.boot_completed": "1",
      "ro.product.manufacturer": "Google",
      "ro.product.model": "Pixel 8",
      "ro.build.version.release": "15",
      "ro.build.version.sdk": "35",
    };
    process.stdout.write((properties[command[2]] || "") + "\\n");
  } else if (command[0] === "shell" && command[1] === "wm" && command[2] === "size") {
    process.stdout.write("Physical size: 1080x2400\\n");
  } else if (command[0] === "shell" && command[1] === "wm" && command[2] === "density") {
    process.stdout.write("Physical density: 420\\n");
  } else if (command[0] === "exec-out") {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    process.stdout.write(png);
  } else if (command[0] === "logcat") {
    process.stdout.write("sample emulator log\\n");
  }
} else {
  process.exitCode = 2;
}
`;
	const emulatorScript = `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-list-avds") {
  process.stdout.write("Pixel_8_API_35\\ninvalid;avd\\n");
} else {
  fs.appendFileSync(${JSON.stringify(launchPath)}, args.join(" ") + "\\n");
  setInterval(() => {}, 1000);
}
`;
	writeFileSync(adbPath, adbScript);
	writeFileSync(emulatorPath, emulatorScript);
	const toolchain: AndroidToolchain = {
		adb: [process.execPath, adbPath],
		emulator: [process.execPath, emulatorPath],
	};
	const manager = new AndroidEmulatorManager({ toolchain, ...options });
	managers.push(manager);
	return { manager, callsPath, launchPath, workspaceRoot };
}

test("reports missing SDK tools without starting an emulator", async () => {
	const manager = new AndroidEmulatorManager({
		toolchain: { adb: null, emulator: null },
	});

	expect(await manager.status()).toMatchObject({
		available: false,
		issue: "sdk-not-found",
		state: "stopped",
	});
	await expect(manager.listAvds()).rejects.toThrow("Android emulator executable is unavailable");
	await manager.dispose();
});

test("concurrent starts share one emulator launch", async () => {
	const { manager, launchPath } = fixture();
	const [first, second] = await Promise.all([
		manager.start("Pixel_8_API_35"),
		manager.start("Pixel_8_API_35"),
	]);

	expect(first).toEqual(second);
	expect(readFileSync(launchPath, "utf8").trim().split("\n")).toHaveLength(1);
});

test("stop cancels an in-flight start before launching an emulator", async () => {
	const { manager, launchPath } = fixture();
	const starting = manager.start("Pixel_8_API_35");
	const stopping = manager.stop();

	await expect(starting).rejects.toThrow();
	expect(await stopping).toMatchObject({ state: "stopped" });
	expect(existsSync(launchPath)).toBe(false);
});

test("restarts the selected AVD after an explicit stop", async () => {
	const { manager, launchPath } = fixture();
	await manager.start("Pixel_8_API_35");
	await manager.stop();
	expect(await manager.start("Pixel_8_API_35")).toMatchObject({
		avdName: "Pixel_8_API_35",
		state: "running",
	});
	expect(readFileSync(launchPath, "utf8").trim().split("\n")).toHaveLength(2);
});

test("starts and controls only the emulator serial with bounded inspection", async () => {
	const { manager, callsPath, workspaceRoot } = fixture();
	const apkPath = join(workspaceRoot, "debug.apk");
	writeFileSync(apkPath, "test apk");
	const avds = await manager.listAvds();

	expect(avds).toEqual(["Pixel_8_API_35"]);
	expect(await manager.start("Pixel_8_API_35")).toMatchObject({
		available: true,
		avdName: "Pixel_8_API_35",
		serial: "emulator-5554",
		state: "running",
	});
	expect(await manager.details()).toEqual({
		manufacturer: "Google",
		model: "Pixel 8",
		androidVersion: "15",
		apiLevel: "35",
		resolution: "1080x2400",
		densityDpi: "420",
	});
	expect(await manager.screenshot()).toMatchObject({
		mimeType: "image/png",
		width: 2,
		height: 3,
	});
	await manager.tap(10, 20);
	await manager.typeText("hello world");
	await manager.typeText("hello; exit");
	await manager.swipe(1, 2, 3, 4, 500);
	await manager.installApk(workspaceRoot, "debug.apk");
	const outsideApk = join(directory, "outside.apk");
	writeFileSync(outsideApk, "outside");
	symlinkSync(outsideApk, join(workspaceRoot, "outside-link.apk"));
	expect(await manager.logs(100)).toEqual({
		text: "sample emulator log\n",
		truncated: false,
	});
	await expect(manager.installApk(workspaceRoot, "../outside.apk")).rejects.toThrow(
		"inside the active workspace",
	);
	await expect(manager.installApk(workspaceRoot, "outside-link.apk")).rejects.toThrow(
		"inside the active workspace",
	);
	await expect(manager.typeText("hello%")).rejects.toThrow("percent signs");
	await manager.stop();

	const calls = readFileSync(callsPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string[]);
	const targeted = calls.filter((args) => args[0] === "-s");
	const typed = targeted.filter(
		(args) => args.includes("input") && args[args.indexOf("input") + 1] === "text",
	);
	expect(targeted.length).toBeGreaterThan(0);
	expect(targeted.every((args) => args[1] === "emulator-5554")).toBe(true);
	expect(targeted.some((args) => args.includes("3b413722"))).toBe(false);
	expect(targeted.some((args) => args[1] === "-d")).toBe(false);
	expect(typed.map((args) => args.at(-1))).toEqual(["'hello%sworld'", "'hello;%sexit'"]);
});

test("stops the owned emulator after its idle TTL", async () => {
	const { manager } = fixture({ idleTtlMs: 200 });
	await manager.start("Pixel_8_API_35");
	await Bun.sleep(300);

	expect(await manager.status()).toMatchObject({ state: "stopped" });
});

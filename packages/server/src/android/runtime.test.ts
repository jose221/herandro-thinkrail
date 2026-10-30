import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
	const installRacePath = join(directory, "install-race.json");
	const installGatePath = join(directory, "install-gate.json");
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
  } else if (command[0] === "shell" && command[1] === "screenrecord") {
    const target = command.at(-1);
    const name = target.split("/").pop();
    const mp4 = Buffer.alloc(32);
    mp4.write("ftyp", 4, "ascii");
    fs.writeFileSync(${JSON.stringify(directory)} + "/" + name, mp4);
    fs.writeFileSync(${JSON.stringify(join(directory, "screenrecord.pid"))}, String(process.pid));
    setInterval(() => {}, 1000);
  } else if (command[0] === "pull") {
    const name = command[1].split("/").pop();
    fs.copyFileSync(${JSON.stringify(directory)} + "/" + name, command[2]);
  } else if (command[0] === "shell" && command[1] === "pkill") {
    try {
      process.kill(Number(fs.readFileSync(${JSON.stringify(join(directory, "screenrecord.pid"))}, "utf8")), "SIGINT");
    } catch {}
  } else if (command[0] === "shell" && command[1] === "rm") {
    // The fake device file is disposable.
  } else if (command[0] === "logcat") {
    process.stdout.write("sample emulator log\\n");
  } else if (command[0] === "install" && fs.existsSync(${JSON.stringify(installGatePath)})) {
    const { started, release } = JSON.parse(fs.readFileSync(${JSON.stringify(installGatePath)}, "utf8"));
    fs.writeFileSync(started, "started");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(release)) Atomics.wait(waitCell, 0, 0, 10);
  } else if (command[0] === "install" && fs.existsSync(${JSON.stringify(installRacePath)})) {
    const { target, replacement, installed } = JSON.parse(fs.readFileSync(${JSON.stringify(installRacePath)}, "utf8"));
    fs.unlinkSync(target);
    fs.symlinkSync(replacement, target);
    fs.writeFileSync(installed, fs.readFileSync(command.at(-1)));
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
	return { manager, callsPath, installRacePath, installGatePath, launchPath, workspaceRoot };
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

test("records the owned emulator to an MP4 and removes the device artifact", async () => {
	const { manager, callsPath } = fixture();
	await manager.start("Pixel_8_API_35");
	const started = await manager.recordStart("workspace-1", 5_000);
	expect(started).toMatchObject({ durationMs: 5_000 });
	expect((await manager.status()).recording).toMatchObject({ durationMs: 5_000 });

	const recording = await manager.recordStop("workspace-1");
	expect(recording).toMatchObject({ width: 1080, height: 2400 });
	expect(recording.durationMs).toBeGreaterThan(0);
	expect(recording.durationMs).toBeLessThanOrEqual(5_000);
	expect(recording.data.subarray(4, 8).toString("ascii")).toBe("ftyp");
	expect((await manager.status()).recording).toBeUndefined();
	await manager.stop();

	const calls = readFileSync(callsPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string[]);
	expect(calls.some((args) => args.includes("screenrecord"))).toBe(true);
	expect(calls.some((args) => args.includes("pull"))).toBe(true);
	expect(calls.some((args) => args.includes("pkill") && args.includes("-INT"))).toBe(true);
	expect(calls.some((args) => args.includes("rm") && args.includes("-f"))).toBe(true);
});

test("records only while the owned emulator is running", async () => {
	const { manager } = fixture();
	await expect(manager.recordStart("workspace-1")).rejects.toThrow("Start an Android emulator");
	await manager.start("Pixel_8_API_35");
	await expect(manager.recordStart("workspace-1", 50)).rejects.toThrow("between 1 and 60");
	await manager.recordStart("workspace-1", 5_000);
	await expect(manager.recordStop("other")).rejects.toThrow("active for this workspace");
	await manager.stop();
});

test("installs the validated APK snapshot when its workspace path changes", async () => {
	const { manager, installRacePath, workspaceRoot } = fixture();
	const apkPath = join(workspaceRoot, "debug.apk");
	const replacementPath = join(directory, "outside.apk");
	const installedPath = join(directory, "installed.apk");
	writeFileSync(apkPath, "workspace apk");
	writeFileSync(replacementPath, "outside apk");
	writeFileSync(
		installRacePath,
		JSON.stringify({ target: apkPath, replacement: replacementPath, installed: installedPath }),
	);
	await manager.start("Pixel_8_API_35");

	await manager.installApk(workspaceRoot, "debug.apk");

	expect(readFileSync(installedPath, "utf8")).toBe("workspace apk");
	await manager.stop();
});

test("rejects concurrent APK installs before taking another workspace snapshot", async () => {
	const { manager, callsPath, installGatePath, workspaceRoot } = fixture();
	const apkPath = join(workspaceRoot, "debug.apk");
	const startedPath = join(directory, "install-started");
	const releasePath = join(directory, "install-release");
	writeFileSync(apkPath, "workspace apk");
	writeFileSync(installGatePath, JSON.stringify({ started: startedPath, release: releasePath }));
	await manager.start("Pixel_8_API_35");

	const firstInstall = manager.installApk(workspaceRoot, "debug.apk");
	for (let attempt = 0; attempt < 100 && !existsSync(startedPath); attempt += 1) {
		await Bun.sleep(10);
	}
	expect(existsSync(startedPath)).toBe(true);
	await expect(manager.installApk(workspaceRoot, "debug.apk")).rejects.toThrow(
		"already in progress",
	);
	const installCalls = readFileSync(callsPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string[])
		.filter((args) => args[0] === "-s" && args[2] === "install");
	expect(installCalls).toHaveLength(1);

	writeFileSync(releasePath, "release");
	await firstInstall;
	await manager.stop();
});

test("rejects an APK FIFO without waiting for a writer", async () => {
	if (process.platform === "win32") return;
	const { manager, workspaceRoot } = fixture();
	await manager.start("Pixel_8_API_35");
	execFileSync("mkfifo", [join(workspaceRoot, "pipe.apk")], { timeout: 2000 });

	await expect(manager.installApk(workspaceRoot, "pipe.apk")).rejects.toThrow(
		"APK must be a regular file",
	);
	await manager.stop();
});

test("stops the owned emulator after its idle TTL", async () => {
	const { manager } = fixture({ idleTtlMs: 200 });
	await manager.start("Pixel_8_API_35");
	await Bun.sleep(300);

	expect(await manager.status()).toMatchObject({ state: "stopped" });
});

import { expect, test } from "bun:test";
import { dedupe, frameworkFor, localPort, parseLsof, parseNetstat, parseSs } from "./ports";

test("lsof listeners keep process names and skip infrastructure ports", () => {
	const listeners = parseLsof(
		[
			"p1234",
			"cnode",
			"n127.0.0.1:5173",
			"p2345",
			"cpostgres",
			"n127.0.0.1:5432",
			"p3456",
			"cGoogle Chrome",
			"n*:3000",
		].join("\n"),
	);
	expect(listeners).toEqual([
		{ port: 5173, process: "node", pid: 1234 },
		{ port: 3000, process: "Google Chrome", pid: 3456 },
	]);
});

test("ss and netstat listeners parse their own layouts", () => {
	expect(parseSs('LISTEN 0 511 127.0.0.1:8000 0.0.0.0:* users:(("uvicorn",pid=999,fd=7))')).toEqual(
		[{ port: 8000, process: "uvicorn", pid: 999 }],
	);
	expect(parseNetstat("  TCP    0.0.0.0:4200    0.0.0.0:0    LISTENING    4321")).toEqual([
		{ port: 4200, process: "", pid: 4321 },
	]);
});

test("listener addresses must be local and useful", () => {
	expect(localPort("127.0.0.1:5173")).toBe(5173);
	expect(localPort("*:3000")).toBe(3000);
	expect(localPort("192.168.1.4:8080")).toBeNull();
	expect(localPort("127.0.0.1:443")).toBeNull();
	expect(localPort("127.0.0.1:5432")).toBeNull();
	expect(localPort("127.0.0.1:22")).toBeNull();
});

test("framework detection uses the process first and the port second", () => {
	expect(frameworkFor(9999, "node vite")).toBe("vite");
	expect(frameworkFor(4200, "node")).toBe("angular");
	expect(frameworkFor(9000, "python")).toBe("other");
});

test("duplicate ports keep one listener and prefer a named process", () => {
	const ports = dedupe([
		{ port: 3000, process: "", pid: 1 },
		{ port: 3000, process: "next-server", pid: 2 },
		{ port: 5173, process: "node", pid: 3 },
	]);
	expect(ports.map((port) => [port.port, port.process])).toEqual([
		[3000, "next-server"],
		[5173, "node"],
	]);
});

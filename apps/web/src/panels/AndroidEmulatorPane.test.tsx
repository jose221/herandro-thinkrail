import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AndroidEmulatorPane, supportsAndroidEmulatorProtocol } from "./AndroidEmulatorPane";

test("renders an explicit, stopped-by-default Android emulator surface", () => {
	const markup = renderToStaticMarkup(<AndroidEmulatorPane workspaceId="workspace-1" />);

	expect(markup).toContain('data-testid="android-emulator-pane"');
	expect(markup).toContain('data-testid="android-emulator-start"');
	expect(markup).toContain('data-testid="android-emulator-stop"');
	expect(markup).toContain('data-testid="android-emulator-screen-refresh"');
	expect(markup).toContain('data-testid="android-emulator-install"');
	expect(markup).toContain("Start an emulator to inspect its screen.");
	expect(markup).not.toContain('aria-pressed="true"');
});

test("gates Android requests on protocol v100", () => {
	expect(supportsAndroidEmulatorProtocol(null)).toBe(false);
	expect(supportsAndroidEmulatorProtocol(99)).toBe(false);
	expect(supportsAndroidEmulatorProtocol(100)).toBe(true);
});

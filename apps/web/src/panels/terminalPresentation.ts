import type { ITheme } from "@xterm/xterm";
import { cssColorToHex } from "@/lib";
import { terminalContrastFloor } from "./terminalContrast";

const ANSI_TOKENS = [
	["black", "--ansi-black"],
	["red", "--ansi-red"],
	["green", "--ansi-green"],
	["yellow", "--ansi-yellow"],
	["blue", "--ansi-blue"],
	["magenta", "--ansi-magenta"],
	["cyan", "--ansi-cyan"],
	["white", "--ansi-white"],
	["brightBlack", "--ansi-bright-black"],
	["brightRed", "--ansi-bright-red"],
	["brightGreen", "--ansi-bright-green"],
	["brightYellow", "--ansi-bright-yellow"],
	["brightBlue", "--ansi-bright-blue"],
	["brightMagenta", "--ansi-bright-magenta"],
	["brightCyan", "--ansi-bright-cyan"],
	["brightWhite", "--ansi-bright-white"],
] as const;

function cssVar(name: string): string | undefined {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

function cssColorVar(name: string): string | undefined {
	return cssColorToHex(cssVar(name) ?? "") || undefined;
}

export function terminalHighContrastEnabled(): boolean {
	return document.documentElement.dataset.themeContrast === "high";
}

export function terminalMinimumContrastRatio(): number {
	return terminalContrastFloor(terminalHighContrastEnabled());
}

export function terminalFontSettings(): { fontFamily: string; fontSize: number } {
	return {
		fontFamily: cssVar("--tr-font-family-code") ?? "monospace",
		fontSize: Number.parseFloat(cssVar("--tr-font-size-s13") ?? "") || 13,
	};
}

export function readTerminalTheme(): ITheme {
	const theme: ITheme = {};
	const background = cssColorVar("--container-terminal-bg");
	if (background) theme.background = background;
	const foreground = cssColorVar("--text-default");
	if (foreground) theme.foreground = foreground;
	const cursor = cssColorVar("--primary");
	if (cursor) theme.cursor = cursor;
	const selectionBackground = cssColorVar("--editor-selection-bg");
	if (selectionBackground) theme.selectionBackground = selectionBackground;
	const selectionForeground = cssColorVar("--editor-selection-text");
	if (selectionForeground) theme.selectionForeground = selectionForeground;
	for (const [slot, name] of ANSI_TOKENS) {
		const color = cssColorVar(name);
		if (color) theme[slot] = color;
	}
	return theme;
}

import type { AcpAuthTerminalEvent } from "@thinkrail/contracts";
import { WS_CHANNELS } from "@thinkrail/contracts";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebFontsAddon } from "@xterm/addon-web-fonts";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { useT } from "@thinkrail/locales/react";
import { onThemeSwap } from "@thinkrail/ui/theme";
import { isRecord } from "../lib/utils";
import { getTransport } from "../transport";
import { createPtySizeSync, runAfterTerminalRelayout } from "./ptySizeSync";
import { createTerminalPrebindBuffer } from "./terminalPrebindBuffer";
import {
	readTerminalTheme,
	terminalFontSettings,
	terminalMinimumContrastRatio,
} from "./terminalPresentation";

const AUTH_TERMINAL_RELAYOUT_TIMEOUT_MS = 4000;
const AUTH_TERMINAL_PENDING_EVENT_LIMIT = 64;
const AUTH_TERMINAL_PENDING_CHAR_LIMIT = 1_048_576;

interface Props {
	clientId: string;
	methodId: string;
	workspaceId?: string;
	onExit: (success: boolean) => void;
}

function isAuthTerminalData(
	value: unknown,
): value is Extract<AcpAuthTerminalEvent, { type: "data" }> {
	return (
		isRecord(value) &&
		value.type === "data" &&
		typeof value.id === "string" &&
		typeof value.data === "string"
	);
}

function isAuthTerminalExit(
	value: unknown,
): value is Extract<AcpAuthTerminalEvent, { type: "exit" }> {
	return (
		isRecord(value) &&
		value.type === "exit" &&
		typeof value.id === "string" &&
		typeof value.success === "boolean"
	);
}

function fitTerminal(fit: FitAddon): void {
	try {
		fit.fit();
	} catch {}
}

export default function AcpAuthTerminal({ clientId, methodId, workspaceId, onExit }: Props) {
	const t = useT();
	const hostRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const term = new XTerm({
			allowProposedApi: true,
			cursorBlink: true,
			...terminalFontSettings(),
			minimumContrastRatio: terminalMinimumContrastRatio(),
			scrollback: 1000,
			theme: readTerminalTheme(),
		});
		const fit = new FitAddon();
		const clipboard = new ClipboardAddon();
		const unicode = new Unicode11Addon();
		const webFonts = new WebFontsAddon();
		term.loadAddon(fit);
		term.loadAddon(clipboard);
		term.loadAddon(unicode);
		term.loadAddon(webFonts);
		term.unicode.activeVersion = "11";
		term.open(host);

		let disposed = false;
		let serverId: string | undefined;
		let startRequestPending = false;
		let exitReported = false;
		const prebind = createTerminalPrebindBuffer(
			AUTH_TERMINAL_PENDING_CHAR_LIMIT,
			AUTH_TERMINAL_PENDING_EVENT_LIMIT,
		);
		const transport = getTransport();
		const handleData = (value: unknown): void => {
			if (!isAuthTerminalData(value)) return;
			if (!serverId) {
				prebind.acceptData({ id: value.id, data: value.data });
				return;
			}
			if (value.id === serverId) term.write(value.data);
		};
		const handleExit = (value: unknown): void => {
			if (!isAuthTerminalExit(value)) return;
			if (!serverId) {
				prebind.acceptExit({ id: value.id, exitCode: value.success ? 0 : 1 });
				return;
			}
			if (value.id !== serverId || exitReported) return;
			exitReported = true;
			onExit(value.success);
		};
		const unsubscribeData = transport.subscribe(WS_CHANNELS.acpAuthTerminalData, handleData);
		const unsubscribeExit = transport.subscribe(WS_CHANNELS.acpAuthTerminalExit, handleExit);
		let fitFrame = 0;
		let resizeObserver: ResizeObserver | undefined;
		const sizeSync = createPtySizeSync((size) => {
			const id = serverId;
			if (!id) return Promise.reject(new Error("ACP terminal is not bound yet."));
			return transport.request("acp.client.authTerminal.resize", { id, ...size });
		});

		const resize = (): void => {
			cancelAnimationFrame(fitFrame);
			fitFrame = requestAnimationFrame(() => {
				if (disposed) return;
				fitTerminal(fit);
				if (!serverId) return;
				sizeSync.request({ cols: term.cols, rows: term.rows });
			});
		};
		resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(host);

		const inputSubscription = term.onData((data) => {
			if (!serverId || exitReported) return;
			void transport
				.request("acp.client.authTerminal.write", { id: serverId, data })
				.catch(() => {});
		});

		const reportStartFailure = (): void => {
			if (!disposed && !exitReported) {
				exitReported = true;
				onExit(false);
			}
		};
		const cancelStart = (): void => {
			void transport.request("acp.client.authTerminal.cancelStart", { clientId }).catch(() => {});
		};
		const handleStartResult = (result: { id: string }): void => {
			if (disposed) {
				void transport.request("acp.client.authTerminal.stop", { id: result.id }).catch(() => {});
				return;
			}
			serverId = result.id;
			const buffered = prebind.bind(serverId);
			if (buffered.truncated) {
				term.write(`\r\n${t("panels.terminalInstance.outputTruncated")}\r\n`);
			}
			for (const frame of buffered.frames) term.write(frame.data);
			if (buffered.exit && !exitReported) {
				exitReported = true;
				onExit(buffered.exit.exitCode === 0);
			}
			resize();
			term.focus();
		};
		void runAfterTerminalRelayout(
			() => webFonts.relayout(),
			() => {
				if (disposed) return;
				fitTerminal(fit);
				const startSize = { cols: term.cols, rows: term.rows };
				startRequestPending = true;
				void transport
					.request(
						"acp.client.authTerminal.start",
						{
							...(workspaceId ? { workspaceId } : {}),
							clientId,
							methodId,
							...startSize,
						},
						{ timeoutMs: 60_000 },
					)
					.then((result) => {
						startRequestPending = false;
						sizeSync.acknowledge(startSize);
						handleStartResult(result);
					})
					.catch(() => {
						startRequestPending = false;
						cancelStart();
						reportStartFailure();
					});
			},
			{
				timeoutMs: AUTH_TERMINAL_RELAYOUT_TIMEOUT_MS,
				onTimeout: () => webFonts.dispose(),
			},
		).catch(reportStartFailure);

		const stopThemeWatch = onThemeSwap(() => {
			term.options.theme = readTerminalTheme();
			term.options.minimumContrastRatio = terminalMinimumContrastRatio();
		});

		return () => {
			disposed = true;
			if (startRequestPending && !serverId) cancelStart();
			if (fitFrame) cancelAnimationFrame(fitFrame);
			resizeObserver?.disconnect();
			sizeSync.dispose();
			stopThemeWatch();
			inputSubscription.dispose();
			prebind.stop();
			unsubscribeData();
			unsubscribeExit();
			if (serverId) {
				void transport.request("acp.client.authTerminal.stop", { id: serverId }).catch(() => {});
			}
			term.dispose();
		};
	}, [clientId, methodId, onExit, workspaceId]);

	return (
		<section
			aria-label={t("settings.acp.terminalLabel")}
			data-testid="acp-auth-terminal"
			className="relative h-[min(50vh,20rem)] min-h-[12rem] max-h-[50vh] min-w-0 overflow-hidden rounded-sm border border-border-default bg-container-terminal-bg"
		>
			<div ref={hostRef} className="absolute inset-8 min-w-0" />
		</section>
	);
}

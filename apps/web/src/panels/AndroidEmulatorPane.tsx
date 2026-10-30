import { RiPlayLine, RiRefreshLine, RiStopLine } from "@remixicon/react";
import type {
	AndroidEmulatorDetails,
	AndroidEmulatorLogs,
	AndroidEmulatorScreenshot,
	AndroidEmulatorState,
	AndroidEmulatorStatus,
} from "@thinkrail/contracts";
import { ANDROID_EMULATOR_PROTOCOL_VERSION } from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { AndroidApkPicker } from "./AndroidApkPicker";

const STATE_KEYS: Record<AndroidEmulatorState, MessageKey> = {
	starting: "androidEmulator.state.starting",
	running: "androidEmulator.state.running",
	stopping: "androidEmulator.state.stopping",
	stopped: "androidEmulator.state.stopped",
};

const ISSUE_KEYS: Record<NonNullable<AndroidEmulatorStatus["issue"]>, MessageKey> = {
	"sdk-not-found": "androidEmulator.issue.sdk",
	"adb-not-found": "androidEmulator.issue.adb",
	"emulator-not-found": "androidEmulator.issue.emulator",
};

const INPUT_CLASS =
	"min-h-32 min-w-0 rounded-sm border border-border-default bg-control-bg px-8 text-text-default tr-text-ui focus-visible:ring-2 focus-visible:ring-primary";

interface ScreenPoint {
	x: number;
	y: number;
	at: number;
}

function readScreenPoint(
	event: ReactPointerEvent<HTMLButtonElement>,
	screen: AndroidEmulatorScreenshot,
): ScreenPoint {
	const bounds = event.currentTarget.getBoundingClientRect();
	const x = bounds.width > 0 ? ((event.clientX - bounds.left) / bounds.width) * screen.width : 0;
	const y = bounds.height > 0 ? ((event.clientY - bounds.top) / bounds.height) * screen.height : 0;
	return {
		x: Math.max(0, Math.min(screen.width - 1, Math.round(x))),
		y: Math.max(0, Math.min(screen.height - 1, Math.round(y))),
		at: Date.now(),
	};
}

export function supportsAndroidEmulatorProtocol(protocolVersion: number | null): boolean {
	return protocolVersion !== null && protocolVersion >= ANDROID_EMULATOR_PROTOCOL_VERSION;
}

export function AndroidEmulatorPane({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const supported = supportsAndroidEmulatorProtocol(protocolVersion);
	const [status, setStatus] = useState<AndroidEmulatorStatus | null>(null);
	const [avds, setAvds] = useState<string[]>([]);
	const [selectedAvd, setSelectedAvd] = useState("");
	const [details, setDetails] = useState<AndroidEmulatorDetails | null>(null);
	const [screen, setScreen] = useState<AndroidEmulatorScreenshot | null>(null);
	const [logs, setLogs] = useState<AndroidEmulatorLogs | null>(null);
	const [initialLoading, setInitialLoading] = useState(true);
	const [isBusy, setIsBusy] = useState(false);
	const [requestFailed, setRequestFailed] = useState(false);
	const [tapX, setTapX] = useState("");
	const [tapY, setTapY] = useState("");
	const [text, setText] = useState("");
	const [fromX, setFromX] = useState("");
	const [fromY, setFromY] = useState("");
	const [toX, setToX] = useState("");
	const [toY, setToY] = useState("");
	const [apkPath, setApkPath] = useState("");
	const pointerStart = useRef<ScreenPoint | null>(null);
	const state = status?.state;
	const running = supported && state === "running";

	useEffect(() => {
		if (!supported) {
			setStatus(null);
			setAvds([]);
			setSelectedAvd("");
			setDetails(null);
			setScreen(null);
			setLogs(null);
			setInitialLoading(protocolVersion === null);
			setRequestFailed(false);
			return;
		}
		let mounted = true;
		setInitialLoading(true);
		void Promise.allSettled([
			getTransport().request("android.emulator.status", {}),
			getTransport().request("android.avds.list", {}),
		]).then(([statusResult, avdsResult]) => {
			if (!mounted) return;
			let failed = false;
			if (statusResult.status === "fulfilled") setStatus(statusResult.value);
			else failed = true;
			if (avdsResult.status === "fulfilled") {
				setAvds(avdsResult.value);
				setSelectedAvd(
					statusResult.status === "fulfilled"
						? (statusResult.value.avdName ?? avdsResult.value[0] ?? "")
						: (avdsResult.value[0] ?? ""),
				);
			} else if (statusResult.status !== "fulfilled" || statusResult.value.available) failed = true;
			setRequestFailed(failed);
			setInitialLoading(false);
		});
		return () => {
			mounted = false;
		};
	}, [protocolVersion, supported]);

	const refreshInspection = useCallback(async () => {
		const [detailsResult, screenResult, logsResult] = await Promise.allSettled([
			getTransport().request("android.emulator.details", {}),
			getTransport().request("android.emulator.screen", {}),
			getTransport().request("android.emulator.logs", { lines: 200 }),
		]);
		let failed = false;
		if (detailsResult.status === "fulfilled") setDetails(detailsResult.value);
		else failed = true;
		if (screenResult.status === "fulfilled") setScreen(screenResult.value);
		else failed = true;
		if (logsResult.status === "fulfilled") setLogs(logsResult.value);
		else failed = true;
		if (failed) throw new Error("Android emulator inspection failed");
	}, []);

	useEffect(() => {
		if (!supported || state !== "running") return;
		void refreshInspection().catch(() => setRequestFailed(true));
	}, [state, refreshInspection, supported]);

	useEffect(() => {
		if (!supported || (state !== "starting" && state !== "running")) return;
		const intervalMs = state === "starting" ? 2000 : 10_000;
		let requestPending = false;
		let mounted = true;
		const timer = window.setInterval(() => {
			if (requestPending) return;
			requestPending = true;
			void getTransport()
				.request("android.emulator.status", {})
				.then(
					(nextStatus) => {
						requestPending = false;
						if (mounted) setStatus(nextStatus);
					},
					() => {
						requestPending = false;
					},
				);
		}, intervalMs);
		return () => {
			mounted = false;
			window.clearInterval(timer);
		};
	}, [state, supported]);

	const runAction = async (action: () => Promise<void>) => {
		if (!supported) return;
		setIsBusy(true);
		setRequestFailed(false);
		try {
			await action();
		} catch {
			setRequestFailed(true);
		} finally {
			setIsBusy(false);
		}
	};

	const refresh = () =>
		runAction(async () => {
			const [statusResult, avdsResult] = await Promise.allSettled([
				getTransport().request("android.emulator.status", {}),
				getTransport().request("android.avds.list", {}),
			]);
			if (statusResult.status === "fulfilled") setStatus(statusResult.value);
			if (avdsResult.status === "fulfilled") {
				setAvds(avdsResult.value);
				const activeAvd =
					statusResult.status === "fulfilled" ? statusResult.value.avdName : undefined;
				setSelectedAvd(
					(current) =>
						activeAvd ??
						(avdsResult.value.includes(current) ? current : (avdsResult.value[0] ?? "")),
				);
			}
			if (
				statusResult.status === "rejected" ||
				(avdsResult.status === "rejected" &&
					(statusResult.status !== "fulfilled" || statusResult.value.available))
			) {
				throw new Error("Android emulator refresh failed");
			}
		});

	const refreshScreen = () =>
		runAction(async () => {
			setScreen(await getTransport().request("android.emulator.screen", {}));
		});

	const start = () =>
		runAction(async () => {
			setStatus(await getTransport().request("android.emulator.start", { avdName: selectedAvd }));
		});

	const stop = () =>
		runAction(async () => {
			setStatus(await getTransport().request("android.emulator.stop", {}));
			setDetails(null);
			setScreen(null);
			setLogs(null);
		});

	const tap = (x: number, y: number) =>
		runAction(async () => {
			await getTransport().request("android.emulator.tap", { x, y });
			setScreen(await getTransport().request("android.emulator.screen", {}));
		});

	const submitTap = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (tapX === "" || tapY === "") return;
		void tap(Number(tapX), Number(tapY));
	};

	const submitText = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!text.trim()) return;
		void runAction(async () => {
			await getTransport().request("android.emulator.type", { text });
			setText("");
			setScreen(await getTransport().request("android.emulator.screen", {}));
		});
	};

	const submitSwipe = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if ([fromX, fromY, toX, toY].some((value) => value === "")) return;
		void runAction(async () => {
			await getTransport().request("android.emulator.swipe", {
				x1: Number(fromX),
				y1: Number(fromY),
				x2: Number(toX),
				y2: Number(toY),
			});
			setScreen(await getTransport().request("android.emulator.screen", {}));
		});
	};

	const submitInstall = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!apkPath.trim()) return;
		void runAction(async () => {
			await getTransport().request(
				"android.emulator.installApk",
				{
					workspaceId,
					path: apkPath.trim(),
				},
				{ timeoutMs: 180_000 },
			);
		});
	};

	const issueKey = status?.issue ? ISSUE_KEYS[status.issue] : null;
	const detailsRows = [
		[t("androidEmulator.manufacturer"), details?.manufacturer],
		[t("androidEmulator.model"), details?.model],
		[t("androidEmulator.androidVersion"), details?.androidVersion],
		[t("androidEmulator.apiLevel"), details?.apiLevel],
		[t("androidEmulator.resolution"), details?.resolution],
		[t("androidEmulator.density"), details?.densityDpi],
	].filter((row): row is [string, string] => typeof row[1] === "string");
	const swipeFields: Array<{
		label: string;
		value: string;
		onChange: (value: string) => void;
	}> = [
		{ label: t("androidEmulator.fromX"), value: fromX, onChange: setFromX },
		{ label: t("androidEmulator.fromY"), value: fromY, onChange: setFromY },
		{ label: t("androidEmulator.toX"), value: toX, onChange: setToX },
		{ label: t("androidEmulator.toY"), value: toY, onChange: setToY },
	];

	return (
		<div
			data-testid="android-emulator-pane"
			className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
		>
			<header className="flex h-panel-header-row shrink-0 items-center gap-8 border-border-default border-b px-12">
				<h2 className="min-w-0 flex-1 truncate tr-title-compact text-text-default">
					{t("androidEmulator.title")}
				</h2>
				<Button
					type="button"
					variant="ghost"
					size="m"
					iconLeft={RiRefreshLine}
					disabled={!supported || isBusy}
					onClick={() => void refresh()}
					data-testid="android-emulator-refresh"
				>
					{t("androidEmulator.refresh")}
				</Button>
			</header>
			<div className="min-h-0 min-w-0 flex-1 overflow-auto p-panel-inset">
				<div className="flex min-w-0 flex-col gap-16">
					<p className="break-words text-text-muted tr-text-metadata">
						{t("androidEmulator.description")}
					</p>

					<section className="flex min-w-0 flex-col gap-8" aria-label={t("androidEmulator.title")}>
						<div className="flex min-w-0 flex-wrap items-center gap-8">
							<p
								data-testid="android-emulator-status"
								role="status"
								className={
									status?.available && running
										? "text-feedback-success tr-text-ui"
										: "text-text-muted tr-text-ui"
								}
							>
								{!supported
									? protocolVersion === null
										? t("androidEmulator.loading")
										: t("androidEmulator.hostTooOld")
									: initialLoading && !status
										? t("androidEmulator.loading")
										: issueKey
											? t(issueKey)
											: status
												? t(STATE_KEYS[status.state])
												: t("androidEmulator.loading")}
							</p>
							{running && status?.idleRemainingMs !== undefined ? (
								<span className="text-text-subtle tr-text-metadata">
									{t("androidEmulator.idleRemaining", {
										seconds: Math.ceil(status.idleRemainingMs / 1000),
									})}
								</span>
							) : null}
						</div>
						<div className="flex min-w-0 flex-col gap-8 sm:flex-row sm:items-end">
							<label className="flex min-w-0 flex-1 flex-col gap-4">
								<span className="text-text-muted tr-text-metadata">{t("androidEmulator.avd")}</span>
								<select
									value={selectedAvd}
									onChange={(event) => setSelectedAvd(event.currentTarget.value)}
									disabled={!supported || !status?.available || running || avds.length === 0}
									className={INPUT_CLASS}
									data-testid="android-emulator-avd"
								>
									<option value="">{t("androidEmulator.selectAvd")}</option>
									{avds.map((avd) => (
										<option value={avd} key={avd}>
											{avd}
										</option>
									))}
								</select>
								{supported &&
								status?.available &&
								!initialLoading &&
								!requestFailed &&
								avds.length === 0 ? (
									<p role="status" className="text-text-muted tr-text-metadata">
										{t("androidEmulator.noAvdsInstalled")}
									</p>
								) : null}
							</label>
							<div className="flex flex-wrap gap-8">
								<Button
									type="button"
									variant="primary"
									size="m"
									iconLeft={RiPlayLine}
									disabled={
										!supported ||
										!status?.available ||
										running ||
										!selectedAvd ||
										isBusy ||
										state === "starting" ||
										state === "stopping"
									}
									onClick={() => void start()}
									data-testid="android-emulator-start"
								>
									{t("androidEmulator.start")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="m"
									iconLeft={RiStopLine}
									disabled={!supported || !status || state === "stopped" || isBusy}
									onClick={() => void stop()}
									data-testid="android-emulator-stop"
								>
									{t("androidEmulator.stop")}
								</Button>
							</div>
						</div>
					</section>

					{supported && requestFailed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("androidEmulator.requestFailed")}
						</p>
					) : null}

					<section className="flex min-w-0 flex-col gap-8">
						<div className="flex items-center gap-8">
							<h3 className="flex-1 tr-title-compact text-text-default">
								{t("androidEmulator.screen")}
							</h3>
							<Button
								type="button"
								variant="ghost"
								size="s"
								iconLeft={RiRefreshLine}
								disabled={!running || isBusy}
								onClick={() => void refreshScreen()}
								data-testid="android-emulator-screen-refresh"
							>
								{t("androidEmulator.screenRefresh")}
							</Button>
						</div>
						<p className="text-text-muted tr-text-metadata">{t("androidEmulator.screenHelp")}</p>
						<div className="flex min-w-0 justify-center overflow-hidden rounded-sm border border-border-default bg-container-content-bg p-8">
							{screen && running ? (
								<button
									type="button"
									disabled={isBusy}
									aria-label={t("androidEmulator.screenAlt", {
										width: screen.width,
										height: screen.height,
									})}
									onClick={(event) => {
										if (event.detail !== 0) return;
										void tap(Math.floor(screen.width / 2), Math.floor(screen.height / 2));
									}}
									onPointerDown={(event) => {
										if (!running || isBusy) return;
										pointerStart.current = readScreenPoint(event, screen);
										event.currentTarget.setPointerCapture(event.pointerId);
									}}
									onPointerUp={(event) => {
										const startPoint = pointerStart.current;
										pointerStart.current = null;
										if (!startPoint || !running || isBusy) return;
										const endPoint = readScreenPoint(event, screen);
										const distance = Math.hypot(
											endPoint.x - startPoint.x,
											endPoint.y - startPoint.y,
										);
										if (distance > 8) {
											void runAction(async () => {
												await getTransport().request("android.emulator.swipe", {
													x1: startPoint.x,
													y1: startPoint.y,
													x2: endPoint.x,
													y2: endPoint.y,
													durationMs: Math.max(50, Math.min(10_000, Date.now() - startPoint.at)),
												});
												setScreen(await getTransport().request("android.emulator.screen", {}));
											});
										} else void tap(endPoint.x, endPoint.y);
									}}
									onPointerCancel={() => {
										pointerStart.current = null;
									}}
									className="flex w-fit min-w-0 max-w-full cursor-pointer items-center justify-center border-0 bg-transparent p-0 disabled:cursor-default"
									data-testid="android-emulator-screen"
								>
									<img
										src={`data:${screen.mimeType};base64,${screen.data}`}
										alt=""
										aria-hidden="true"
										className="h-auto max-h-screen w-auto max-w-full select-none object-contain touch-none"
									/>
								</button>
							) : (
								<p className="py-24 text-center text-text-subtle tr-text-metadata">
									{t("androidEmulator.screenUnavailable")}
								</p>
							)}
						</div>

						<form
							onSubmit={submitTap}
							className="grid min-w-0 grid-cols-2 gap-8 sm:grid-cols-[1fr_1fr_auto]"
						>
							<label className="flex min-w-0 flex-col gap-4">
								<span className="text-text-muted tr-text-metadata">
									{t("androidEmulator.tapX")}
								</span>
								<input
									type="number"
									min="0"
									max="100000"
									value={tapX}
									onChange={(event) => setTapX(event.currentTarget.value)}
									disabled={!running || isBusy}
									className={INPUT_CLASS}
								/>
							</label>
							<label className="flex min-w-0 flex-col gap-4">
								<span className="text-text-muted tr-text-metadata">
									{t("androidEmulator.tapY")}
								</span>
								<input
									type="number"
									min="0"
									max="100000"
									value={tapY}
									onChange={(event) => setTapY(event.currentTarget.value)}
									disabled={!running || isBusy}
									className={INPUT_CLASS}
								/>
							</label>
							<Button
								type="submit"
								variant="outline"
								size="m"
								disabled={!running || isBusy || tapX === "" || tapY === ""}
								className="col-span-2 sm:col-span-1"
								data-testid="android-emulator-tap"
							>
								{t("androidEmulator.tap")}
							</Button>
						</form>
					</section>

					<form onSubmit={submitText} className="flex min-w-0 flex-col gap-8">
						<label htmlFor="android-emulator-text" className="text-text-default tr-title-compact">
							{t("androidEmulator.text")}
						</label>
						<div className="flex min-w-0 flex-col gap-8 sm:flex-row">
							<input
								id="android-emulator-text"
								type="text"
								autoComplete="off"
								maxLength={2000}
								value={text}
								placeholder={t("androidEmulator.textPlaceholder")}
								onChange={(event) => setText(event.currentTarget.value)}
								disabled={!running || isBusy}
								className={`${INPUT_CLASS} flex-1`}
							/>
							<Button
								type="submit"
								variant="outline"
								size="m"
								disabled={!running || isBusy || !text.trim()}
								data-testid="android-emulator-type"
							>
								{t("androidEmulator.type")}
							</Button>
						</div>
					</form>

					<form onSubmit={submitSwipe} className="flex min-w-0 flex-col gap-8">
						<h3 className="tr-title-compact text-text-default">{t("androidEmulator.swipe")}</h3>
						<div className="grid min-w-0 grid-cols-2 gap-8">
							{swipeFields.map(({ label, value, onChange }) => (
								<label className="flex min-w-0 flex-col gap-4" key={label}>
									<span className="text-text-muted tr-text-metadata">{label}</span>
									<input
										type="number"
										min="0"
										max="100000"
										value={value}
										onChange={(event) => onChange(event.currentTarget.value)}
										disabled={!running || isBusy}
										className={INPUT_CLASS}
									/>
								</label>
							))}
						</div>
						<Button
							type="submit"
							variant="outline"
							size="m"
							disabled={
								!running || isBusy || [fromX, fromY, toX, toY].some((value) => value === "")
							}
							className="self-start"
							data-testid="android-emulator-swipe"
						>
							{t("androidEmulator.sendSwipe")}
						</Button>
					</form>

					<form onSubmit={submitInstall} className="flex min-w-0 flex-col gap-8">
						<h3 className="tr-title-compact text-text-default">
							{t("androidEmulator.installTitle")}
						</h3>
						<span className="text-text-muted tr-text-metadata">{t("androidEmulator.apkPath")}</span>
						<div className="flex min-w-0 flex-col gap-8 sm:flex-row">
							<AndroidApkPicker
								workspaceId={workspaceId}
								value={apkPath}
								disabled={!supported || isBusy}
								onSelect={setApkPath}
							/>
							<Button
								type="submit"
								variant="outline"
								size="m"
								disabled={!running || isBusy || !apkPath.trim()}
								data-testid="android-emulator-install"
							>
								{t("androidEmulator.install")}
							</Button>
						</div>
						<p className="break-words text-text-subtle tr-text-metadata">
							{t("androidEmulator.apkHint")}
						</p>
					</form>

					<section className="flex min-w-0 flex-col gap-8">
						<h3 className="tr-title-compact text-text-default">{t("androidEmulator.details")}</h3>
						{supported && detailsRows.length > 0 ? (
							<dl className="grid min-w-0 grid-cols-1 gap-8 sm:grid-cols-2">
								{detailsRows.map(([label, value]) => (
									<div className="flex min-w-0 flex-col gap-2" key={label}>
										<dt className="text-text-subtle tr-text-metadata">{label}</dt>
										<dd className="min-w-0 break-words text-text-default tr-text-ui">{value}</dd>
									</div>
								))}
							</dl>
						) : (
							<p className="text-text-subtle tr-text-metadata">
								{t("androidEmulator.screenUnavailable")}
							</p>
						)}
					</section>

					<section className="flex min-w-0 flex-col gap-8">
						<div className="flex items-center gap-8">
							<h3 className="flex-1 tr-title-compact text-text-default">
								{t("androidEmulator.logs")}
							</h3>
							<Button
								type="button"
								variant="ghost"
								size="s"
								iconLeft={RiRefreshLine}
								disabled={!running || isBusy}
								onClick={() => void runAction(refreshInspection)}
								data-testid="android-emulator-inspect"
							>
								{t("androidEmulator.refresh")}
							</Button>
						</div>
						{supported && logs && logs.text.length > 0 ? (
							<pre className="max-h-192 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border-default bg-container-content-bg p-8 tr-code-text">
								{logs.text}
							</pre>
						) : (
							<p className="text-text-subtle tr-text-metadata">
								{supported && logs
									? t("androidEmulator.logsEmpty")
									: t("androidEmulator.screenUnavailable")}
							</p>
						)}
						{supported && logs?.truncated ? (
							<p className="text-text-subtle tr-text-metadata">
								{t("androidEmulator.logsTruncated")}
							</p>
						) : null}
					</section>
				</div>
			</div>
		</div>
	);
}

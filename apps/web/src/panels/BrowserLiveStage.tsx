import { type BrowserFramePush, WS_CHANNELS } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { isImeComposing } from "@thinkrail/ui/keyboard";
import { cn } from "@thinkrail/ui/utils";
import {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { getTransport } from "../transport";

export interface BrowserLiveStageHandle {
	getImageElement: () => HTMLImageElement | null;
	getLatestFrame: () => BrowserFramePush | null;
	focus: () => void;
}

interface BrowserLiveStageProps {
	workspaceId: string;
	url: string;
	fill?: boolean;
}

const BARE_MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);
const INPUT_TIMEOUT_MS = 5_000;

function eventModifiers(event: {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}): number {
	return (
		(event.altKey ? 1 : 0) |
		(event.ctrlKey ? 2 : 0) |
		(event.metaKey ? 4 : 0) |
		(event.shiftKey ? 8 : 0)
	);
}

function pointOnLiveElement(
	clientX: number,
	clientY: number,
	element: HTMLImageElement | null,
	frame: BrowserFramePush | null,
): { x: number; y: number } | null {
	if (!element || !frame || frame.width <= 0 || frame.height <= 0) return null;
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	const x = Math.round(((clientX - rect.left) / rect.width) * frame.width);
	const y = Math.round(((clientY - rect.top) / rect.height) * frame.height);
	return {
		x: Math.max(0, Math.min(frame.width - 1, x)),
		y: Math.max(0, Math.min(frame.height - 1, y)),
	};
}

export const BrowserLiveStage = memo(
	forwardRef<BrowserLiveStageHandle, BrowserLiveStageProps>(function BrowserLiveStage(
		{ workspaceId, url, fill = false },
		ref,
	) {
		const t = useT();
		const stageRef = useRef<HTMLDivElement>(null);
		const inputRef = useRef<HTMLTextAreaElement>(null);
		const imgRef = useRef<HTMLImageElement>(null);
		const frameRef = useRef<BrowserFramePush | null>(null);
		const pendingFrameRef = useRef<BrowserFramePush | null>(null);
		const rafRef = useRef<number | null>(null);
		const lastMoveSentRef = useRef(0);
		const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
		const [hasFrame, setHasFrame] = useState(false);

		const enqueue = useCallback((task: () => Promise<unknown>) => {
			inputQueueRef.current = inputQueueRef.current
				.then(() => task())
				.then(
					() => undefined,
					() => undefined,
				);
		}, []);

		const focusInput = useCallback(() => {
			inputRef.current?.focus({ preventScroll: true });
		}, []);

		useImperativeHandle(
			ref,
			() => ({
				getImageElement: () => imgRef.current,
				getLatestFrame: () => frameRef.current,
				focus: focusInput,
			}),
			[focusInput],
		);

		useEffect(() => {
			frameRef.current = null;
			pendingFrameRef.current = null;
			setHasFrame(false);
		}, [workspaceId]);

		useEffect(() => {
			const unsub = getTransport().subscribe(WS_CHANNELS.browserFrame, (data) => {
				const push = data as BrowserFramePush;
				if (!push || push.workspaceId !== workspaceId || !push.data) return;
				frameRef.current = push;
				pendingFrameRef.current = push;
				setHasFrame((prev) => (prev ? prev : true));
				if (rafRef.current !== null) return;
				rafRef.current = requestAnimationFrame(() => {
					rafRef.current = null;
					const latest = pendingFrameRef.current;
					pendingFrameRef.current = null;
					if (!latest || !imgRef.current) return;
					imgRef.current.src = `data:${latest.mimeType};base64,${latest.data}`;
				});
			});
			return () => {
				unsub();
				if (rafRef.current !== null) {
					cancelAnimationFrame(rafRef.current);
					rafRef.current = null;
				}
			};
		}, [workspaceId]);

		useEffect(() => {
			const stage = stageRef.current;
			if (!stage) return;
			const onWheel = (event: WheelEvent) => {
				const pt = pointOnLiveElement(
					event.clientX,
					event.clientY,
					imgRef.current,
					frameRef.current,
				);
				if (!pt) return;
				event.preventDefault();
				event.stopPropagation();
				enqueue(() =>
					getTransport().request(
						"browser.wheel",
						{
							workspaceId,
							x: pt.x,
							y: pt.y,
							deltaX: event.deltaX,
							deltaY: event.deltaY,
						},
						{ timeoutMs: INPUT_TIMEOUT_MS },
					),
				);
			};
			stage.addEventListener("wheel", onWheel, { passive: false });
			return () => stage.removeEventListener("wheel", onWheel);
		}, [enqueue, workspaceId]);

		useEffect(() => {
			const isActiveInStage = () => {
				const input = inputRef.current;
				const stage = stageRef.current;
				const active = document.activeElement;
				return Boolean(input && stage && (active === input || stage.contains(active)));
			};

			const onKeyDown = (event: KeyboardEvent) => {
				if (!isActiveInStage()) return;
				if (isImeComposing(event) || event.key === "Dead" || event.key === "Process") {
					return;
				}
				if (event.key === "F6") return;
				if (BARE_MODIFIERS.has(event.key)) {
					event.stopPropagation();
					return;
				}
				if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
					event.stopPropagation();
					return;
				}
				if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
					event.preventDefault();
					event.stopImmediatePropagation();
					const text = event.key;
					enqueue(() =>
						getTransport().request(
							"browser.text",
							{ workspaceId, text },
							{ timeoutMs: INPUT_TIMEOUT_MS },
						),
					);
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				const payload = {
					workspaceId,
					action: "down" as const,
					key: event.key,
					code: event.code,
					keyCode: event.keyCode,
					modifiers: eventModifiers(event),
				};
				enqueue(() =>
					getTransport().request("browser.key", payload, { timeoutMs: INPUT_TIMEOUT_MS }),
				);
			};

			const onKeyUp = (event: KeyboardEvent) => {
				if (!isActiveInStage()) return;
				if (isImeComposing(event)) return;
				if (event.key === "F6") return;
				if (BARE_MODIFIERS.has(event.key)) {
					event.stopPropagation();
					return;
				}
				if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
					event.stopPropagation();
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				const payload = {
					workspaceId,
					action: "up" as const,
					key: event.key,
					code: event.code,
					keyCode: event.keyCode,
					modifiers: eventModifiers(event),
				};
				enqueue(() =>
					getTransport().request("browser.key", payload, { timeoutMs: INPUT_TIMEOUT_MS }),
				);
			};

			window.addEventListener("keydown", onKeyDown, true);
			window.addEventListener("keyup", onKeyUp, true);
			return () => {
				window.removeEventListener("keydown", onKeyDown, true);
				window.removeEventListener("keyup", onKeyUp, true);
			};
		}, [enqueue, workspaceId]);

		const sendPointer = useCallback(
			(action: "down" | "up" | "move", event: React.PointerEvent<HTMLImageElement>) => {
				const point = pointOnLiveElement(
					event.clientX,
					event.clientY,
					imgRef.current,
					frameRef.current,
				);
				if (!point) return;
				if (action === "move") {
					const now = Date.now();
					if (now - lastMoveSentRef.current < 24) return;
					lastMoveSentRef.current = now;
					void getTransport()
						.request(
							"browser.pointer",
							{
								workspaceId,
								action,
								x: point.x,
								y: point.y,
							},
							{ timeoutMs: INPUT_TIMEOUT_MS },
						)
						.catch(() => undefined);
					return;
				}
				const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
				enqueue(() =>
					getTransport().request(
						"browser.pointer",
						{
							workspaceId,
							action,
							x: point.x,
							y: point.y,
							button,
							clickCount: event.detail || 1,
						},
						{ timeoutMs: INPUT_TIMEOUT_MS },
					),
				);
			},
			[enqueue, workspaceId],
		);

		const handleCompositionEnd = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
			const data = event.data;
			event.currentTarget.value = "";
			if (!data) return;
			enqueue(() =>
				getTransport().request(
					"browser.text",
					{ workspaceId, text: data },
					{ timeoutMs: INPUT_TIMEOUT_MS },
				),
			);
		};

		const handleInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
			if (event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing) return;
			const val = event.currentTarget.value;
			if (!val) return;
			event.currentTarget.value = "";
			enqueue(() =>
				getTransport().request(
					"browser.text",
					{ workspaceId, text: val },
					{ timeoutMs: INPUT_TIMEOUT_MS },
				),
			);
		};

		const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
			event.preventDefault();
			event.stopPropagation();
			const pasted = event.clipboardData?.getData("text");
			if (!pasted) return;
			enqueue(() =>
				getTransport().request(
					"browser.text",
					{ workspaceId, text: pasted },
					{ timeoutMs: INPUT_TIMEOUT_MS },
				),
			);
		};

		return (
			<div
				ref={stageRef}
				data-testid="browser-live-stage"
				className={cn(
					"relative flex min-h-0 items-center justify-center overflow-hidden bg-container-elevated-bg focus-within:focus-ring-inset",
					fill ? "h-full w-full" : "mx-auto w-full flex-1",
				)}
			>
				<textarea
					ref={inputRef}
					data-testid="browser-live-input"
					rows={1}
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					aria-label={t("browser.frameTitle", { url })}
					className="pointer-events-none absolute top-0 left-0 h-px w-px resize-none opacity-0"
					onCompositionEnd={handleCompositionEnd}
					onInput={handleInput}
					onPaste={handlePaste}
				/>
				<img
					ref={imgRef}
					alt={t("browser.frameTitle", { url })}
					data-testid="browser-live-frame"
					draggable={false}
					onMouseDown={() => {
						focusInput();
					}}
					onPointerDown={(event) => {
						focusInput();
						try {
							event.currentTarget.setPointerCapture(event.pointerId);
						} catch {}
						sendPointer("down", event);
					}}
					onPointerMove={(event) => sendPointer("move", event)}
					onPointerUp={(event) => {
						try {
							if (event.currentTarget.hasPointerCapture(event.pointerId)) {
								event.currentTarget.releasePointerCapture(event.pointerId);
							}
						} catch {}
						sendPointer("up", event);
					}}
					onPointerCancel={(event) => {
						try {
							if (event.currentTarget.hasPointerCapture(event.pointerId)) {
								event.currentTarget.releasePointerCapture(event.pointerId);
							}
						} catch {}
						sendPointer("up", event);
					}}
					onContextMenu={(event) => event.preventDefault()}
					className={cn(
						"cursor-pointer select-none object-contain",
						fill ? "h-full w-full" : "max-h-full max-w-full",
						hasFrame ? "block" : "hidden",
					)}
				/>
				{!hasFrame ? (
					<span className="text-text-muted tr-text-ui">{t("browser.engine.starting")}</span>
				) : null}
			</div>
		);
	}),
);

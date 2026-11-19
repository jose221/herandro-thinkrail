import { RiCloseLine, RiDeleteBinLine, RiSendPlaneLine } from "@remixicon/react";
import type { CaptureFrame } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { useRef, useState } from "react";

export interface AnnotatedRegion {
	id: string;
	/** Normalized 0..1 image coordinates */
	x: number;
	y: number;
	width: number;
	height: number;
	note: string;
}

interface DragState {
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
}

const INPUT_CLASS =
	"min-h-28 min-w-0 flex-1 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-metadata text-text-default placeholder:text-text-muted focus-visible:border-control-border-active focus-visible:focus-ring";

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function normalizedRect(drag: DragState): { x: number; y: number; width: number; height: number } {
	const left = Math.min(drag.startX, drag.currentX);
	const top = Math.min(drag.startY, drag.currentY);
	const right = Math.max(drag.startX, drag.currentX);
	const bottom = Math.max(drag.startY, drag.currentY);
	return {
		x: clamp01(left),
		y: clamp01(top),
		width: clamp01(right - left),
		height: clamp01(bottom - top),
	};
}

export async function renderAnnotatedFrame(
	frame: CaptureFrame,
	regions: readonly AnnotatedRegion[],
): Promise<CaptureFrame> {
	if (regions.length === 0) return frame;
	const image = new Image();
	image.src = `data:${frame.mimeType};base64,${frame.data}`;
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error("Could not decode capture image."));
	});
	const width = image.naturalWidth || frame.width;
	const height = image.naturalHeight || frame.height;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return frame;
	ctx.drawImage(image, 0, 0, width, height);

	const rootStyle = getComputedStyle(document.documentElement);
	const strokeColor =
		rootStyle.getPropertyValue("--feedback-error").trim() ||
		rootStyle.getPropertyValue("--text-default").trim();
	const badgeTextColor =
		rootStyle.getPropertyValue("--control-destructive-text").trim() ||
		rootStyle.getPropertyValue("--text-on-primary").trim();
	const lineWidth = Math.max(2, Math.round(Math.min(width, height) * 0.004));
	const badgeRadius = Math.max(12, Math.round(Math.min(width, height) * 0.022));

	regions.forEach((region, index) => {
		const px = Math.round(region.x * width);
		const py = Math.round(region.y * height);
		const pw = Math.max(8, Math.round(region.width * width));
		const ph = Math.max(8, Math.round(region.height * height));

		ctx.save();
		ctx.fillStyle = strokeColor;
		ctx.globalAlpha = 0.14;
		ctx.fillRect(px, py, pw, ph);
		ctx.globalAlpha = 1;
		ctx.strokeStyle = strokeColor;
		ctx.lineWidth = lineWidth;
		ctx.strokeRect(px, py, pw, ph);

		const badgeX = Math.max(badgeRadius, Math.min(width - badgeRadius, px));
		const badgeY = Math.max(badgeRadius, Math.min(height - badgeRadius, py));
		ctx.beginPath();
		ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
		ctx.fillStyle = strokeColor;
		ctx.fill();

		ctx.fillStyle = badgeTextColor;
		ctx.font = `700 ${Math.round(badgeRadius * 1.1)}px sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(index + 1), badgeX, badgeY + 1);
		ctx.restore();
	});

	const dataUrl = canvas.toDataURL("image/png");
	const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
	return {
		mimeType: "image/png",
		data: base64,
		width,
		height,
	};
}

export function formatAnnotationSummary(
	frame: Pick<CaptureFrame, "width" | "height">,
	regions: readonly AnnotatedRegion[],
): string[] {
	return regions.map((region, index) => {
		const px = Math.round(region.x * frame.width);
		const py = Math.round(region.y * frame.height);
		const pw = Math.max(1, Math.round(region.width * frame.width));
		const ph = Math.max(1, Math.round(region.height * frame.height));
		const detail = region.note.trim();
		return detail.length > 0
			? `[${index + 1}] (${px},${py} ${pw}×${ph}): ${detail}`
			: `[${index + 1}] (${px},${py} ${pw}×${ph})`;
	});
}

export function CaptureAnnotator({
	frame,
	busy = false,
	onCancel,
	onSend,
}: {
	frame: CaptureFrame;
	busy?: boolean;
	onCancel: () => void;
	onSend: (annotatedFrame: CaptureFrame, regionNotes: string[]) => Promise<void> | void;
}) {
	const t = useT();
	const [regions, setRegions] = useState<AnnotatedRegion[]>([]);
	const [drag, setDrag] = useState<DragState | null>(null);
	const stageRef = useRef<HTMLDivElement>(null);

	const pointFromPointer = (clientX: number, clientY: number): { x: number; y: number } | null => {
		const stage = stageRef.current;
		if (!stage) return null;
		const rect = stage.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		return {
			x: clamp01((clientX - rect.left) / rect.width),
			y: clamp01((clientY - rect.top) / rect.height),
		};
	};

	const draftRect = drag ? normalizedRect(drag) : null;

	const send = async () => {
		const composite = await renderAnnotatedFrame(frame, regions);
		const notes = formatAnnotationSummary(composite, regions);
		await onSend(composite, notes);
	};

	return (
		<div
			data-testid="capture-annotator"
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-sm border border-border-default bg-container-elevated-bg"
		>
			<div className="flex shrink-0 flex-wrap items-center gap-8 border-border-default border-b px-12 py-8">
				<span className="min-w-0 flex-1 truncate tr-title-compact text-text-default">
					{t("browser.annotateTitle")}
				</span>
				<Button
					variant="ghost"
					size="s"
					disabled={busy || regions.length === 0}
					onClick={() => setRegions([])}
					data-testid="capture-annotator-clear"
				>
					{t("browser.annotateClear")}
				</Button>
				<Button
					variant="outline"
					size="s"
					disabled={busy}
					onClick={onCancel}
					data-testid="capture-annotator-cancel"
				>
					{t("browser.annotateCancel")}
				</Button>
				<Button
					variant="primary"
					size="s"
					iconLeft={RiSendPlaneLine}
					loading={busy}
					disabled={regions.length === 0}
					onClick={() => void send()}
					data-testid="capture-annotator-send"
				>
					{t("browser.annotateSend")}
				</Button>
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-12 overflow-auto p-12">
				<div className="flex min-h-0 justify-center rounded-sm border border-border-muted bg-container-content-bg p-8">
					<div
						ref={stageRef}
						role="application"
						aria-label={t("browser.annotateTitle")}
						data-testid="capture-annotator-stage"
						onPointerDown={(event) => {
							if (busy) return;
							const pt = pointFromPointer(event.clientX, event.clientY);
							if (!pt) return;
							event.currentTarget.setPointerCapture(event.pointerId);
							setDrag({ startX: pt.x, startY: pt.y, currentX: pt.x, currentY: pt.y });
						}}
						onPointerMove={(event) => {
							if (!drag) return;
							const pt = pointFromPointer(event.clientX, event.clientY);
							if (!pt) return;
							setDrag((prev) => (prev ? { ...prev, currentX: pt.x, currentY: pt.y } : null));
						}}
						onPointerUp={(event) => {
							if (!drag) return;
							const pt = pointFromPointer(event.clientX, event.clientY);
							const finalDrag = pt ? { ...drag, currentX: pt.x, currentY: pt.y } : drag;
							const rect = normalizedRect(finalDrag);
							setDrag(null);
							if (event.currentTarget.hasPointerCapture(event.pointerId)) {
								event.currentTarget.releasePointerCapture(event.pointerId);
							}
							if (rect.width < 0.015 || rect.height < 0.015) return;
							setRegions((prev) => [
								...prev,
								{
									id: `${Date.now()}-${prev.length + 1}`,
									...rect,
									note: "",
								},
							]);
						}}
						onPointerCancel={() => setDrag(null)}
						className="relative max-h-[52vh] w-fit cursor-crosshair select-none touch-none overflow-hidden"
					>
						<img
							src={`data:${frame.mimeType};base64,${frame.data}`}
							alt=""
							draggable={false}
							className="block max-h-[52vh] w-auto max-w-full object-contain"
						/>
						{regions.map((region, index) => (
							<div
								key={region.id}
								style={{
									left: `${region.x * 100}%`,
									top: `${region.y * 100}%`,
									width: `${region.width * 100}%`,
									height: `${region.height * 100}%`,
								}}
								className="pointer-events-none absolute border-2 border-feedback-error bg-feedback-error-subtle"
							>
								<span className="absolute -top-8 -left-8 flex size-16 items-center justify-center rounded-full bg-feedback-error tr-text-metadata text-control-destructive-text">
									{index + 1}
								</span>
							</div>
						))}
						{draftRect && draftRect.width > 0.005 && draftRect.height > 0.005 ? (
							<div
								style={{
									left: `${draftRect.x * 100}%`,
									top: `${draftRect.y * 100}%`,
									width: `${draftRect.width * 100}%`,
									height: `${draftRect.height * 100}%`,
								}}
								className="pointer-events-none absolute border-2 border-dashed border-feedback-error bg-feedback-error-subtle"
							/>
						) : null}
					</div>
				</div>

				{regions.length === 0 ? (
					<p className="text-center text-text-muted tr-text-metadata">
						{t("browser.annotateEmpty")}
					</p>
				) : (
					<ul className="flex flex-col gap-8">
						{regions.map((region, index) => (
							<li key={region.id} className="flex items-center gap-8">
								<span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-feedback-error tr-text-metadata text-control-destructive-text">
									{index + 1}
								</span>
								<input
									value={region.note}
									aria-label={t("browser.annotateRegion", { index: index + 1 })}
									placeholder={t("browser.annotateNotePlaceholder")}
									onChange={(event) => {
										const nextNote = event.currentTarget.value;
										setRegions((prev) =>
											prev.map((item) =>
												item.id === region.id ? { ...item, note: nextNote } : item,
											),
										);
									}}
									className={INPUT_CLASS}
								/>
								<IconButton
									icon={RiDeleteBinLine}
									label={t("common.delete")}
									variant="ghost"
									size="s"
									onClick={() => setRegions((prev) => prev.filter((item) => item.id !== region.id))}
								/>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
export { RiCloseLine };

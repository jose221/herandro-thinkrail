import { RiCloseLine, RiVideoLine } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { IconButton } from "@thinkrail/ui/button";
import type { VideoAttachment } from "./types";

function formatDuration(durationMs: number): string {
	const seconds = Math.max(1, Math.round(durationMs / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function VideoChip({ video, onRemove }: { video: VideoAttachment; onRemove: () => void }) {
	const t = useT();
	return (
		<span
			className="flex max-w-full items-center gap-8 rounded-sm border border-border-default bg-container-elevated-bg px-8 py-4 tr-text-metadata"
			data-testid="composer-video"
		>
			{video.poster ? (
				<img
					src={`data:${video.poster.mimeType};base64,${video.poster.data}`}
					alt=""
					className="h-32 w-40 shrink-0 rounded-xs object-cover"
				/>
			) : (
				<RiVideoLine className="size-16 shrink-0 text-text-muted" aria-hidden="true" />
			)}
			<span className="min-w-0 truncate" title={video.path}>
				{video.name}
			</span>
			<span className="shrink-0 text-text-subtle">
				{formatDuration(video.durationMs)} · {formatBytes(video.bytes)}
			</span>
			<IconButton icon={RiCloseLine} size="s" label={t("chat.video.remove")} onClick={onRemove} />
		</span>
	);
}

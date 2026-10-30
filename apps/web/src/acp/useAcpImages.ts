import type { ImageContent } from "@thinkrail/contracts";
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";
import { fileToAttachedImage } from "../components/imageAttachment";

/** Keep the full ACP prompt under the host's 1,000,000-character transcript budget. */
const ACP_IMAGE_BASE64_BUDGET = 850_000;
const ACP_IMAGE_MAX_EDGE = 1400;
const ACP_IMAGE_LIMIT = 8;

export interface AcpPromptImage {
	id: string;
	name: string;
	content: ImageContent;
	width?: number;
	height?: number;
}

export type AcpPromptImageErrorReason = "unsupported" | "limit";

export interface AcpPromptImageError {
	id: string;
	name: string;
	reason: AcpPromptImageErrorReason;
}

export interface AcpPromptImagesController {
	images: AcpPromptImage[];
	pending: number;
	errors: AcpPromptImageError[];
	addFiles: (files: File[]) => void;
	removeImage: (id: string) => void;
	dismissError: (id: string) => void;
	reset: () => void;
}

export function acpImagePasteDropHandlers(
	controller: Pick<AcpPromptImagesController, "addFiles">,
): {
	onPaste: (event: ClipboardEvent<HTMLElement>) => void;
	onDrop: (event: DragEvent<HTMLElement>) => void;
} {
	return {
		onPaste: (event) => {
			const files = [...event.clipboardData.files];
			if (files.length === 0) return;
			event.preventDefault();
			controller.addFiles(files);
		},
		onDrop: (event) => {
			const files = [...event.dataTransfer.files];
			if (files.length === 0) return;
			event.preventDefault();
			controller.addFiles(files);
		},
	};
}

export function useAcpImages(): AcpPromptImagesController {
	const [images, setImages] = useState<AcpPromptImage[]>([]);
	const imagesRef = useRef<AcpPromptImage[]>([]);
	const [pending, setPending] = useState(0);
	const [errors, setErrors] = useState<AcpPromptImageError[]>([]);
	const generation = useRef(0);

	const commit = useCallback((next: AcpPromptImage[]) => {
		imagesRef.current = next;
		setImages(next);
	}, []);

	const addFiles = useCallback(
		(files: File[]) => {
			const picked = files.filter((file) => file.type.startsWith("image/"));
			if (picked.length === 0) return;
			const startedGeneration = generation.current;
			setPending((count) => count + picked.length);
			void Promise.allSettled(
				picked.map((file) =>
					fileToAttachedImage(file, {
						maxBase64Bytes: ACP_IMAGE_BASE64_BUDGET,
						maxEdge: ACP_IMAGE_MAX_EDGE,
					}),
				),
			)
				.then((settled) => {
					if (startedGeneration !== generation.current) return;
					let used = imagesRef.current.reduce((sum, image) => sum + image.content.data.length, 0);
					let count = imagesRef.current.length;
					const additions: AcpPromptImage[] = [];
					const nextErrors: AcpPromptImageError[] = [];
					settled.forEach((result, index) => {
						const name = picked[index]?.name || `image-${index + 1}`;
						if (result.status !== "fulfilled" || result.value === null) {
							nextErrors.push({
								id: crypto.randomUUID(),
								name,
								reason: "unsupported",
							});
							return;
						}
						if (count >= ACP_IMAGE_LIMIT) {
							nextErrors.push({ id: crypto.randomUUID(), name, reason: "limit" });
							return;
						}
						const size = result.value.content.data.length;
						if (used + size > ACP_IMAGE_BASE64_BUDGET) {
							nextErrors.push({ id: crypto.randomUUID(), name, reason: "limit" });
							return;
						}
						used += size;
						count += 1;
						additions.push({ id: crypto.randomUUID(), name, ...result.value });
					});
					if (additions.length > 0) commit([...imagesRef.current, ...additions]);
					if (nextErrors.length > 0) setErrors((current) => [...current, ...nextErrors]);
				})
				.finally(() => setPending((count) => count - picked.length));
		},
		[commit],
	);

	const removeImage = useCallback(
		(id: string) => commit(imagesRef.current.filter((image) => image.id !== id)),
		[commit],
	);

	const dismissError = useCallback((id: string) => {
		setErrors((current) => current.filter((error) => error.id !== id));
	}, []);

	const reset = useCallback(() => {
		generation.current += 1;
		commit([]);
		setErrors([]);
	}, [commit]);

	return { images, pending, errors, addFiles, removeImage, dismissError, reset };
}

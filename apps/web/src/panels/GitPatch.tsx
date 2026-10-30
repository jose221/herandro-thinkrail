import { cn } from "@thinkrail/ui/utils";

export type PatchLineKind = "add" | "delete" | "hunk" | "meta" | "context";

export interface PatchLine {
	kind: PatchLineKind;
	text: string;
	hidden: boolean;
}

export interface PatchSection {
	path: string;
	lines: PatchLine[];
	added: number;
	removed: number;
}

const DIFF_HEADER = "diff --git ";
const HUNK_HEADER = "@@";
const NOISE_HEADER = /^(diff --git |index |--- |\+\+\+ )/;

function unquotePath(value: string): string {
	if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
	try {
		return JSON.parse(value) as string;
	} catch {
		return value.slice(1, -1);
	}
}

function stripSidePrefix(value: string): string {
	return value.replace(/^[ab]\//, "");
}

function pathFromHeaderLine(line: string): string {
	const raw = unquotePath(line.slice(4).trim());
	return raw === "/dev/null" ? "" : stripSidePrefix(raw);
}

function pathFromDiffHeader(line: string): string {
	const quoted = /^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(line);
	if (quoted?.[2]) return stripSidePrefix(unquotePath(quoted[2]));
	const rest = line.slice(DIFF_HEADER.length);
	const split = rest.lastIndexOf(" b/");
	return split >= 0 ? rest.slice(split + 3) : rest;
}

export function parsePatch(patch: string): PatchSection[] {
	const sections: PatchSection[] = [];
	let section: PatchSection | null = null;
	let inHunk = false;

	const flush = () => {
		if (!section) return;
		if (!section.path) {
			const header = section.lines.find((line) => line.text.startsWith(DIFF_HEADER));
			if (header) section.path = pathFromDiffHeader(header.text);
		}
		sections.push(section);
		section = null;
		inHunk = false;
	};

	const lines = patch.split("\n");
	if (lines.at(-1) === "") lines.pop();

	for (const text of lines) {
		if (text.startsWith(DIFF_HEADER)) {
			flush();
			section = { path: "", lines: [], added: 0, removed: 0 };
			section.lines.push({ kind: "meta", text, hidden: true });
			continue;
		}
		if (!section) continue;
		if (text.startsWith(HUNK_HEADER)) {
			inHunk = true;
			section.lines.push({ kind: "hunk", text, hidden: false });
			continue;
		}
		if (!inHunk) {
			if (text.startsWith("+++ ") || text.startsWith("--- ")) {
				const candidate = pathFromHeaderLine(text);
				if (candidate) section.path = candidate;
			}
			section.lines.push({ kind: "meta", text, hidden: NOISE_HEADER.test(text) });
			continue;
		}
		if (text.startsWith("+")) {
			section.added += 1;
			section.lines.push({ kind: "add", text, hidden: false });
			continue;
		}
		if (text.startsWith("-")) {
			section.removed += 1;
			section.lines.push({ kind: "delete", text, hidden: false });
			continue;
		}
		if (text.startsWith("\\")) {
			section.lines.push({ kind: "meta", text, hidden: false });
			continue;
		}
		section.lines.push({ kind: "context", text, hidden: false });
	}
	flush();
	return sections;
}

const LINE_CLASS: Record<PatchLineKind, string> = {
	add: "bg-feedback-success-subtle text-feedback-success",
	delete: "bg-feedback-error-subtle text-feedback-error",
	hunk: "bg-primary-subtle text-primary",
	meta: "text-text-subtle",
	context: "text-text-default",
};

export function PatchLinesView({
	lines,
	className,
}: {
	lines: readonly PatchLine[];
	className?: string | undefined;
}) {
	const visible = lines.filter((line) => !line.hidden);

	if (visible.length === 0) {
		return <div className={cn("min-h-0 flex-1", className)} />;
	}

	return (
		<div
			data-testid="git-patch"
			className={cn(
				"min-h-0 flex-1 overflow-auto bg-container-content-bg py-4 tr-code-text",
				className,
			)}
		>
			<div className="w-max min-w-full">
				{visible.map((line, index) => (
					<div key={index} className={cn("min-w-full whitespace-pre px-12", LINE_CLASS[line.kind])}>
						{line.text === "" ? " " : line.text}
					</div>
				))}
			</div>
		</div>
	);
}

export function PatchView({ text, className }: { text: string; className?: string }) {
	const parsed = parsePatch(text);
	const lines =
		parsed.length > 0
			? parsed.flatMap((section) => section.lines)
			: text.split("\n").map<PatchLine>((line) => ({ kind: "context", text: line, hidden: false }));
	return <PatchLinesView lines={lines} className={className} />;
}

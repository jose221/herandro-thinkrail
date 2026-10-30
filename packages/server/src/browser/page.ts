import { BROWSER_LIMITS, type BrowserPageSnapshot } from "@thinkrail/contracts";
import { normalizeBrowserUrl } from "./session";

const PAGE_TIMEOUT_MS = 15_000;
const TITLE_CHARS = 300;

const ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
};

function decodeEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
		if (entity.startsWith("#")) {
			const code =
				entity.startsWith("#x") || entity.startsWith("#X")
					? Number.parseInt(entity.slice(2), 16)
					: Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: match;
		}
		return ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function pageTitle(html: string): string {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return match ? collapse(decodeEntities(match[1] ?? "")).slice(0, TITLE_CHARS) : "";
}

function pageText(html: string): string {
	const stripped = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template\b[\s\S]*?<\/template>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ");
	return collapse(decodeEntities(stripped)).slice(0, BROWSER_LIMITS.pageTextChars);
}

function pageLinks(html: string, base: string): string[] {
	const links: string[] = [];
	const seen = new Set<string>();
	for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
		const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (!raw || raw.startsWith("#") || /^(?:javascript|mailto|tel|data):/i.test(raw)) continue;
		let resolved: string;
		try {
			resolved = new URL(raw, base).toString();
		} catch {
			continue;
		}
		if (!/^https?:/i.test(resolved) || seen.has(resolved)) continue;
		seen.add(resolved);
		links.push(resolved);
		if (links.length >= BROWSER_LIMITS.pageLinks) break;
	}
	return links;
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
	const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
	try {
		return new TextDecoder(charset === "iso-8859-1" ? "latin1" : "utf-8").decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

async function readBounded(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const remaining = BROWSER_LIMITS.pageBytes - total;
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, Math.max(0, remaining)));
				total += Math.max(0, remaining);
				truncated = true;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		if (truncated) await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

/** Reads a page as text without a browser engine. It never executes scripts or stores credentials. */
export async function fetchPageSnapshot(
	value: string,
	timeoutMs = PAGE_TIMEOUT_MS,
): Promise<BrowserPageSnapshot> {
	const url = normalizeBrowserUrl(value);
	const startedAt = performance.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, PAGE_TIMEOUT_MS));
	try {
		const response = await fetch(url, {
			redirect: "follow",
			signal: controller.signal,
			headers: {
				Accept: "text/html,application/xhtml+xml,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
				"User-Agent": "ThinkRail-Browser/1.0",
			},
		});
		const contentType = response.headers.get("content-type") ?? "";
		const { bytes, truncated } = await readBounded(response);
		const body = decodeBody(bytes, contentType);
		const isHtml = /html|xhtml/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(body);
		return {
			url,
			finalUrl: response.url,
			status: response.status,
			contentType,
			title: isHtml ? pageTitle(body) : "",
			text: isHtml ? pageText(body) : body.slice(0, BROWSER_LIMITS.pageTextChars),
			links: isHtml ? pageLinks(body, response.url || url) : [],
			truncated: truncated || body.length >= BROWSER_LIMITS.pageTextChars,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	} finally {
		clearTimeout(timer);
	}
}

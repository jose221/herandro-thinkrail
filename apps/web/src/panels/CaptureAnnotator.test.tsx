import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CaptureAnnotator, formatAnnotationSummary } from "./CaptureAnnotator";

test("renders annotator stage and toolbar controls", () => {
	const markup = renderToStaticMarkup(
		<CaptureAnnotator
			frame={{ mimeType: "image/png", data: "AAAA", width: 800, height: 600 }}
			onCancel={() => {}}
			onSend={() => {}}
		/>,
	);
	expect(markup).toContain('data-testid="capture-annotator"');
	expect(markup).toContain('data-testid="capture-annotator-stage"');
	expect(markup).toContain('data-testid="capture-annotator-send"');
	expect(markup).toContain('data-testid="capture-annotator-cancel"');
});

test("formats normalized regions into pixel coordinates and notes", () => {
	const lines = formatAnnotationSummary({ width: 1000, height: 500 }, [
		{ id: "r1", x: 0.1, y: 0.2, width: 0.3, height: 0.4, note: "Align header" },
		{ id: "r2", x: 0.5, y: 0.5, width: 0.2, height: 0.1, note: "   " },
	]);
	expect(lines).toEqual(["[1] (100,100 300×200): Align header", "[2] (500,250 200×50)"]);
});

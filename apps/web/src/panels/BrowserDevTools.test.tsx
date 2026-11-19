import { expect, test } from "bun:test";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserDevTools } from "./BrowserDevTools";

test("renders console and network tabs with counts and entries", () => {
	const markup = renderToStaticMarkup(
		<TooltipProvider>
			<BrowserDevTools
				workspaceId="ws-1"
				activeUrl="http://localhost:3000"
				consoleLogs={[
					{
						id: "c1",
						level: "error",
						text: "Uncaught ReferenceError: foo is not defined",
						timestamp: 1000,
						url: "http://localhost:3000/app.js",
						line: 12,
					},
				]}
				networkLogs={[
					{
						id: "n1",
						method: "GET",
						url: "http://localhost:8080/api",
						status: 0,
						resourceType: "Fetch",
						timestamp: 1000,
						durationMs: 14,
						corsError: "CORS policy blocked request",
					},
				]}
				onClearConsole={() => {}}
				onClearNetwork={() => {}}
				onAskAi={() => {}}
				onClose={() => {}}
			/>
		</TooltipProvider>,
	);
	expect(markup).toContain('data-testid="browser-devtools"');
	expect(markup).toContain('data-testid="browser-devtools-tab-console"');
	expect(markup).toContain('data-testid="browser-devtools-tab-network"');
	expect(markup).toContain('data-testid="browser-devtools-tab-storage"');
	expect(markup).toContain("Uncaught ReferenceError: foo is not defined");
	expect(markup).toContain("http://localhost:3000/app.js:12");
});

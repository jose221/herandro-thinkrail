import type { AcpSessionState } from "@thinkrail/contracts";

export function acpSessionStateKey(state: AcpSessionState) {
	switch (state) {
		case "idle":
			return "acp.chat.state.idle";
		case "running":
			return "acp.chat.state.running";
		case "needs-input":
			return "acp.chat.state.needsInput";
		case "failed":
			return "acp.chat.state.failed";
		case "interrupted":
			return "acp.chat.state.interrupted";
	}
}

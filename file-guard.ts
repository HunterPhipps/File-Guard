/**
 * File Guard PI Extension
 *
 * Version: 1.0.0
 *
 * PI agent extension that blocks file deletion commands (rm, unlink, find -delete, truncate, shred,
 * mv to /dev/null, language one-liners) and queues them for user approval.
 * The agent continues immediately — the user can approve or reject pending
 * deletions at any time via slash commands.
 *
 * Commands:
 *   /approve-delete [N]   — Approve and execute deletion N (or most recent)
 *   /reject-delete [N]    — Reject deletion N (or most recent)
 *   /approve-all-deletes  — Approve all pending deletions
 *   /reject-all-deletes   — Reject all pending deletions
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface PendingDeletion {
	command: string;
	origCommand: string;
	targets: string[];
}

const pending: PendingDeletion[] = [];
let executing = false;

const DELETE_PATTERNS = [
	// Direct deletion
	/(^|[;&|]\s*)rm\s+/, 
	/(^|[;&|]\s*)unlink\s+/, 
	/(^|[;&|]\s*)find\b.*(-delete|\-exec\s+rm\b)/, 
	// Workarounds: truncate, shred, mv to /dev/null
	/(^|[;&|]\s*)truncate\s+/, 
	/(^|[;&|]\s*)shred\s+/, 
	/(^|[;&|]\s*)mv\s+[^;&|]*\/dev\/null\b/,
	// Workarounds: cp /dev/null file, dd if=/dev/null of=file
	/(^|[;&|]\s*)cp\s+\/dev\/null\b\s+/, 
	/(^|[;&|]\s*)dd\b.*if=\/dev\/null\b.*of=/, 
	// Workarounds: language one-liners that delete files
	/(^|[;&|]\s*)python3?\b.*os\.(remove|unlink|rename)\b/, 
	/(^|[;&|]\s*)python3?\b.*pathlib.*unlink\b/, 
	/(^|[;&|]\s*)node\b.*require\(['"]fs['"]\).*\.(rmSync|unlinkSync|rm|unlink)\b/, 
	/(^|[;&|]\s*)perl\b.*unlink\b/, 
	/(^|[;&|]\s*)ruby\b.*File\.(delete|unlink)\b/, 
];

// Extract just the relevant command segment from a compound command
function extractCommand(command: string): string {
	const segments = command.split(/\s*(?:&&|[;&|])\s*/);
	for (const seg of segments) {
		const trimmed = seg.trim();
		if (DELETE_PATTERNS.some(p => p.test(trimmed))) {
			return trimmed;
		}
	}
	return command;
}

function extractTargets(command: string): string[] {
	const targets: string[] = [];

	if (command.includes("rm")) {
		const m = command.match(/\brm\b\s+(-[a-zA-Z]+(?:\s+-[a-zA-Z]+)*)?\s+(.+)$/);
		if (m) {
			m[2]!.split(/\s+/).forEach((t) => {
				if (!t.startsWith("-") && t !== "\\") targets.push(t);
			});
		}
	}

	if (command.includes("unlink")) {
		const m = command.match(/\bunlink\b\s+(.+)/);
		if (m) targets.push(m[1]!.trim());
	}

	if (command.includes("truncate") || command.includes("shred")) {
		const m = command.match(/\b(truncate|shred)\b\s+(-[a-zA-Z]+(?:\s+-[a-zA-Z]+)*)?\s+(.+)/);
		if (m) targets.push(m[3]!.trim());
	}

	if (command.includes("mv") && command.includes("/dev/null")) {
		const m = command.match(/\bmv\b\s+(-[a-zA-Z]+(?:\s+-[a-zA-Z]+)*)?\s+(.+?)\s+\/dev\/null/);
		if (m) targets.push(m[2]!.trim());
	}

	if (command.includes("cp") && command.includes("/dev/null")) {
		const m = command.match(/\bcp\b\s+\/dev\/null\b\s+(.+)/);
		if (m) targets.push(m[1]!.trim());
	}

	if (command.includes("find") && (command.includes("-delete") || command.includes("-exec rm"))) {
		const m = command.match(/\bfind\b\s+("([^"]+)"|'([^']+)'|(\S+))/);
		if (m) {
			const p = m[2] || m[3] || m[4] || ".";
			targets.push(`find results in: ${p}`);
		}
	}

	if (command.includes("python") && (command.includes("os.remove") || command.includes("os.unlink"))) {
		const m = command.match(/os\.(remove|unlink)\s*\(\s*["']([^"']+)["']/);
		if (m) targets.push(m[2]!);
	}

	if (command.includes("node") && (command.includes("fs.unlinkSync") || command.includes("fs.rmSync"))) {
		const m = command.match(/fs\.(unlinkSync|rmSync)\s*\(\s*["']([^"']+)["']/);
		if (m) targets.push(m[2]!);
	}

	return targets.length > 0 ? targets : [command.trim()];
}

function buildSummary(): string {
	const lines: string[] = [`🗑 ${pending.length} pending deletion(s):`];
	for (let i = 0; i < pending.length; i++) {
		const item = pending[i]!;
		const targetStr = item.targets.join(", ");
		lines.push(`  [${i + 1}] ${targetStr}`);
	}
	lines.push("");
	lines.push("/approve-delete [N]  /reject-delete [N]  /approve-all-deletes  /reject-all-deletes");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	// Show pending deletions summary when the agent finishes
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI || pending.length === 0) return;
		ctx.ui.notify(buildSummary(), "warning");
	});

	// Intercept bash tool calls
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		if (executing) return undefined;

		const command = event.input.command as string;
		const isDelete = DELETE_PATTERNS.some((p) => p.test(command));

		if (!isDelete) return undefined;

		const targets = extractTargets(command);
		const execCommand = extractCommand(command);
		pending.push({ command, origCommand: execCommand, targets });
		const index = pending.length;

		if (ctx.hasUI) {
			const targetStr = targets.join(", ");
			ctx.ui.notify(`🗑 Deletion queued [${index}]: ${targetStr}`, "warning");
		} else {
			console.warn(`[delete-confirmation] Blocked [${index}]: ${command}`);
		}

		return {
			block: true,
			reason: `🗑 Deletion queued as [${index}]. The user wants to verify file deletions before they execute. Continue your work — the user will approve or reject via /approve-delete [${index}] or /approve-all-deletes.`,
		};
	});

	// ── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("approve-delete", {
		description: "Approve a pending file deletion",
		handler: async (args, ctx) => {
			if (pending.length === 0) {
				ctx.ui.notify("No pending deletions", "info");
				return;
			}

			const index = args ? parseInt(args.trim(), 10) : pending.length;
			const itemIdx = index - 1;

			if (itemIdx < 0 || itemIdx >= pending.length) {
				ctx.ui.notify(`Deletion [${index}] not found`, "warning");
				return;
			}

			const item = pending.splice(itemIdx, 1)[0]!;
			const targetStr = item.targets.join(", ");

			try {
				executing = true;
				await pi.exec("bash", ["-c", item.origCommand], { timeout: 30000 });
				ctx.ui.notify(`✅ Approved [${index}]: ${targetStr}`, "success");
			} catch (err: any) {
				ctx.ui.notify(`⚠️ [${index}] error: ${err.message || err}`, "warning");
			} finally {
				executing = false;
			}
		},
	});

	pi.registerCommand("reject-delete", {
		description: "Reject a pending file deletion",
		handler: async (args, ctx) => {
			if (pending.length === 0) {
				ctx.ui.notify("No pending deletions", "info");
				return;
			}

			const index = args ? parseInt(args.trim(), 10) : pending.length;
			const itemIdx = index - 1;

			if (itemIdx < 0 || itemIdx >= pending.length) {
				ctx.ui.notify(`Deletion [${index}] not found`, "warning");
				return;
			}

			const item = pending.splice(itemIdx, 1)[0]!;
			const targetStr = item.targets.join(", ");
			ctx.ui.notify(`❌ Rejected [${index}]: ${targetStr}`, "info");
		},
	});

	pi.registerCommand("approve-all-deletes", {
		description: "Approve all pending file deletions",
		handler: async (_args, ctx) => {
			if (pending.length === 0) {
				ctx.ui.notify("No pending deletions", "info");
				return;
			}

			const items = [...pending];
			pending.length = 0;
			let successCount = 0;

			executing = true;
			for (const item of items) {
				try {
					await pi.exec("bash", ["-c", item.origCommand], { timeout: 30000 });
					successCount++;
				} catch {
					// Silently continue on error
				}
			}
			executing = false;

			ctx.ui.notify(`✅ Approved ${successCount}/${items.length} deletion(s)`, "success");
		},
	});

	pi.registerCommand("reject-all-deletes", {
		description: "Reject all pending file deletions",
		handler: async (_args, ctx) => {
			if (pending.length === 0) {
				ctx.ui.notify("No pending deletions", "info");
				return;
			}

			const count = pending.length;
			pending.length = 0;
			ctx.ui.notify(`❌ Rejected ${count} pending deletion(s)`, "info");
		},
	});
}

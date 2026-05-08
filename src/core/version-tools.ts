/**
 * Figma Version History MCP Tools
 *
 * Phase 1 of the version-history-diff effort:
 *   - figma_get_file_versions: list a file's version history with
 *     auto-pagination, labeled-only filtering by default, and a hard cap.
 *   - figma_get_file_at_version: snapshot a file (or selected nodes) at a
 *     specific version_id. Thin wrapper over getFile/getNodes which already
 *     accept the `version` query param.
 *
 * Both work in local and Cloudflare Workers modes. Required scope is
 * file_versions:read on OAuth, or "Versions" Read on a Personal Access Token.
 *
 * The diff engine (figma_diff_versions, figma_get_changes_since_version)
 * arrives in Phase 2; design brief at .notes/VERSION-HISTORY-DIFF-DESIGN.md.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey } from "./figma-api.js";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "version-tools" });

// ============================================================================
// Internal types
// ============================================================================

interface VersionUser {
	id: string;
	handle: string;
	img_url: string;
}

interface VersionEntry {
	id: string;
	label: string;
	description: string;
	created_at: string;
	user: VersionUser;
	is_labeled: boolean;
}

// Hard safety cap — 20 pages × 50 page_size = 1000 versions scanned worst-case.
// Prevents an infinite loop if Figma returns inconsistent pagination metadata.
const MAX_SCAN_PAGES = 20;

// Figma's documented page_size max
const FIGMA_PAGE_SIZE_MAX = 50;

// Tool-level cap on max_versions; design brief §4.
const MAX_VERSIONS_HARD_CAP = 200;

// ============================================================================
// Tool Registration
// ============================================================================

export function registerVersionTools(
	server: McpServer,
	getFigmaAPI: () => Promise<FigmaAPI>,
	getCurrentUrl: () => string | null,
	_options?: { isRemoteMode?: boolean },
): void {
	// -----------------------------------------------------------------------
	// Tool: figma_get_file_versions
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_file_versions",
		"List a Figma file's version history with metadata (label, description, author, timestamp). Auto-paginates up to max_versions. By default returns only labeled versions (skips auto-saves). Pass include_autosaves=true to see every saved state. Use the returned pagination.next_cursor to continue paging. Required scope: file_versions:read (OAuth) or 'Versions' Read (PAT).",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			include_autosaves: z
				.boolean()
				.optional()
				.default(false)
				.describe("Include auto-saved versions (those without a label). Default: false."),
			max_versions: z
				.number()
				.int()
				.min(1)
				.max(MAX_VERSIONS_HARD_CAP)
				.optional()
				.default(50)
				.describe("Hard cap on returned versions. Default 50, max 200."),
			cursor: z
				.string()
				.optional()
				.describe("Version ID returned as pagination.next_cursor on a previous call. Pass to continue from where the last call stopped."),
		},
		async ({ fileUrl, include_autosaves = false, max_versions = 50, cursor }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "no_file_url",
									message:
										"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
								}),
							},
						],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "invalid_url",
									message: `Invalid Figma URL: ${url}`,
								}),
							},
						],
						isError: true,
					};
				}

				const cap = Math.min(Math.max(1, max_versions), MAX_VERSIONS_HARD_CAP);
				logger.info({ fileKey, cap, include_autosaves, cursor }, "Fetching file versions");

				const api = await getFigmaAPI();

				const collected: VersionEntry[] = [];
				let totalFiltered = 0;
				let cursorForNextPage = cursor;
				let figmaSaysMore = true;
				let lastReceivedId: string | null = null;
				let pages = 0;
				let apiCalls = 0;

				while (pages < MAX_SCAN_PAGES && figmaSaysMore && collected.length < cap) {
					// Figma's pagination semantics: in a newest-first list, `after=X`
					// returns versions that come AFTER X in list order, i.e. OLDER in time.
					// (Empirically verified — `before=X` returns newer items, which is the
					// opposite of what we want when paging into history.)
					const response = await api.getFileVersions(fileKey, {
						page_size: FIGMA_PAGE_SIZE_MAX,
						after: cursorForNextPage,
					});
					pages++;
					apiCalls++;

					const versions = response.versions || [];
					if (versions.length === 0) {
						figmaSaysMore = false;
						break;
					}

					lastReceivedId = versions[versions.length - 1].id;

					for (const v of versions) {
						const isLabeled = v.label != null && v.label !== "";
						if (!include_autosaves && !isLabeled) {
							totalFiltered++;
							continue;
						}
						if (collected.length >= cap) break;
						collected.push({
							id: v.id,
							label: v.label || "",
							description: v.description || "",
							created_at: v.created_at,
							user: v.user,
							is_labeled: isLabeled,
						});
					}

					figmaSaysMore = !!response.pagination?.next_page;

					// Defensive: stop if cursor didn't advance (would otherwise loop forever)
					if (lastReceivedId === cursorForNextPage) break;
					cursorForNextPage = lastReceivedId;
				}

				// next_cursor must be the LAST DISPLAYED item, not the last RECEIVED.
				// If the user paged forward with the last-received id, they would skip the
				// items between their last visible row and the page boundary.
				// Edge case: if labeled-only mode collected zero items but Figma has more
				// data to scan, expose lastReceivedId so the caller can keep scanning past
				// the autosave-only stretch.
				const lastCollectedId = collected.length > 0 ? collected[collected.length - 1].id : null;
				const hasMore = collected.length >= cap || figmaSaysMore;
				const nextCursor = hasMore
					? (lastCollectedId ?? lastReceivedId)
					: null;

				const result = {
					file_key: fileKey,
					versions: collected,
					pagination: {
						has_more: hasMore,
						next_cursor: nextCursor,
						returned: collected.length,
						filtered_out_autosaves: totalFiltered,
					},
					_meta: {
						api_calls_made: apiCalls,
						pages_scanned: pages,
					},
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to get file versions");

				const hint = message.includes("403")
					? " Hint: this endpoint requires the 'file_versions:read' OAuth scope, or the 'Versions' Read permission on a Personal Access Token. Add it at figma.com/developers/api#access-tokens and reissue your token."
					: "";

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "get_file_versions_failed",
								message: message + hint,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_file_at_version
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_file_at_version",
		"Fetch a Figma file (or specific nodes) as it existed at a past version_id. Thin snapshot tool — same shape as figma_get_file_data but bound to a historical version. Use figma_get_file_versions to discover version IDs. Combine with depth and node_ids to keep payloads small. Required scope: file_content:read (already standard).",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			version_id: z
				.string()
				.describe("The version ID to snapshot (from figma_get_file_versions)."),
			node_ids: z
				.array(z.string())
				.optional()
				.describe("Optional: snapshot only these node IDs instead of the full file. Reduces payload significantly for targeted inspection."),
			depth: z
				.number()
				.int()
				.min(1)
				.max(10)
				.optional()
				.describe("How deep into the document tree to recurse. Lower is cheaper. Default: full depth (no limit)."),
		},
		async ({ fileUrl, version_id, node_ids, depth }) => {
			try {
				const url = fileUrl || getCurrentUrl();
				if (!url) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "no_file_url",
									message:
										"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
								}),
							},
						],
						isError: true,
					};
				}

				const fileKey = extractFileKey(url);
				if (!fileKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "invalid_url",
									message: `Invalid Figma URL: ${url}`,
								}),
							},
						],
						isError: true,
					};
				}

				logger.info({ fileKey, version_id, node_ids, depth }, "Snapshotting file at version");

				const api = await getFigmaAPI();
				const fileData =
					node_ids && node_ids.length > 0
						? await api.getNodes(fileKey, node_ids, { version: version_id, depth })
						: await api.getFile(fileKey, { version: version_id, depth });

				const result = {
					_version: {
						id: version_id,
						fetched_at: new Date().toISOString(),
						fileKey,
						scope: node_ids && node_ids.length > 0 ? "nodes" : "file",
					},
					...fileData,
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error({ error }, "Failed to snapshot file at version");

				const hint = message.includes("404")
					? " Hint: the version_id may have been pruned by Figma's plan-tier retention policy, or it may not belong to this file. Use figma_get_file_versions to list valid version IDs."
					: "";

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: "get_file_at_version_failed",
								message: message + hint,
							}),
						},
					],
					isError: true,
				};
			}
		},
	);
}

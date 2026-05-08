/**
 * Figma Version History MCP Tools
 *
 *   - figma_get_file_versions: list a file's version history with
 *     auto-pagination, labeled-only filtering by default, and a hard cap.
 *   - figma_get_file_at_version: snapshot a file (or selected nodes) at a
 *     specific version_id. Thin wrapper over getFile/getNodes which already
 *     accept the `version` query param.
 *   - figma_diff_versions: compare two versions. Always returns a page-structure
 *     diff (cheap, 2 API calls). When component_ids are passed, also returns
 *     per-node diffs at depth=2 (added/removed children, name/description
 *     changes, componentPropertyDefinitions changes, boundVariables deltas).
 *   - figma_get_changes_since_version: convenience wrapper for diff against HEAD.
 *
 * All tools work in local and Cloudflare Workers modes. Required scope is
 * file_versions:read on OAuth, or "Versions" Read on a Personal Access Token,
 * plus the standard file_content:read for fetching file snapshots.
 *
 * Design notes at .notes/VERSION-HISTORY-DIFF-DESIGN.md.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FigmaAPI } from "./figma-api.js";
import { extractFileKey } from "./figma-api.js";
import { createChildLogger } from "./logger.js";
import { VersionSnapshotCache } from "./diff/version-cache.js";
import {
	diffNode,
	diffPageStructure,
	type DiffMode,
	type NodeDiff,
	type PageStructureDiff,
} from "./diff/diff-engine.js";

const logger = createChildLogger({ component: "version-tools" });

// Module-scoped cache shared across all tool calls within a process.
// Past versions are immutable so the cache can live indefinitely.
const versionSnapshotCache = new VersionSnapshotCache({ maxEntries: 50 });

/** Test-only: clears the module-scoped snapshot cache so unit tests see fresh state. */
export function _clearVersionSnapshotCacheForTesting(): void {
	versionSnapshotCache.clear();
}

// Sentinel for "use HEAD instead of a specific version_id"
const CURRENT_VERSION_SENTINEL = "current";

function isCurrentSentinel(versionId: string): boolean {
	return versionId === CURRENT_VERSION_SENTINEL;
}

/**
 * Fetch the document at depth=1 for either a specific version_id or HEAD.
 * HEAD responses are not cached (they're mutable). Past versions are cached.
 */
async function fetchDocumentAtVersion(
	api: FigmaAPI,
	fileKey: string,
	versionId: string,
): Promise<any> {
	const isHead = isCurrentSentinel(versionId);
	const cacheKey = isHead ? null : versionSnapshotCache.makeKey(fileKey, versionId, 1);
	const cached = versionSnapshotCache.get<any>(cacheKey);
	if (cached) return cached;
	const opts = isHead ? { depth: 1 } : { version: versionId, depth: 1 };
	const data = await api.getFile(fileKey, opts);
	if (cacheKey) versionSnapshotCache.set(cacheKey, data);
	return data;
}

/**
 * Fetch a single node at depth=2 for either a specific version_id or HEAD.
 * Same caching policy as above.
 */
async function fetchNodeAtVersion(
	api: FigmaAPI,
	fileKey: string,
	nodeId: string,
	versionId: string,
): Promise<any> {
	const isHead = isCurrentSentinel(versionId);
	const cacheKey = isHead ? null : versionSnapshotCache.makeKey(fileKey, versionId, 2, [nodeId]);
	const cached = versionSnapshotCache.get<any>(cacheKey);
	if (cached) return cached;
	const opts = isHead ? { depth: 2 } : { version: versionId, depth: 2 };
	const data = await api.getNodes(fileKey, [nodeId], opts);
	if (cacheKey) versionSnapshotCache.set(cacheKey, data);
	return data;
}

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

	// Shared diff implementation invoked by both figma_diff_versions and
	// figma_get_changes_since_version. Keeping it here (rather than at module
	// scope) so it closes over getFigmaAPI/getCurrentUrl without re-passing.
	const runDiff = async (args: {
		fileUrl?: string;
		from_version: string;
		to_version: string;
		component_ids?: string[];
		mode?: DiffMode;
	}) => {
		const { fileUrl, from_version, to_version, component_ids } = args;
		const mode: DiffMode = args.mode ?? "standard";
		try {
			const url = fileUrl || getCurrentUrl();
			if (!url) {
				return errorResponse(
					"no_file_url",
					"No Figma file URL available. Pass the fileUrl parameter or ensure the Desktop Bridge plugin is open in Figma.",
				);
			}
			const fileKey = extractFileKey(url);
			if (!fileKey) {
				return errorResponse("invalid_url", `Invalid Figma URL: ${url}`);
			}
			if (from_version === to_version) {
				return errorResponse(
					"same_version",
					"from_version and to_version are identical — nothing to diff.",
				);
			}

			logger.info(
				{ fileKey, from_version, to_version, mode, scoped: !!component_ids?.length },
				"Diffing versions",
			);
			const api = await getFigmaAPI();

			// Phase A: cheap orientation, parallel fetch
			const [fromFile, toFile] = await Promise.all([
				fetchDocumentAtVersion(api, fileKey, from_version),
				fetchDocumentAtVersion(api, fileKey, to_version),
			]);
			let apiCalls = 2;
			const pageDiff: PageStructureDiff = diffPageStructure(
				fromFile.document,
				toFile.document,
			);

			// Phase B: scoped node diffs (only if user provided component_ids)
			const scoped: NodeDiff[] = [];
			const fetchErrors: Array<{ node_id: string; error: string }> = [];
			if (component_ids && component_ids.length > 0) {
				for (const nodeId of component_ids) {
					try {
						const [fromResp, toResp] = await Promise.all([
							fetchNodeAtVersion(api, fileKey, nodeId, from_version),
							fetchNodeAtVersion(api, fileKey, nodeId, to_version),
						]);
						apiCalls += 2;
						const fromNode = fromResp?.nodes?.[nodeId]?.document ?? null;
						const toNode = toResp?.nodes?.[nodeId]?.document ?? null;
						scoped.push(diffNode(fromNode, toNode, mode));
					} catch (e) {
						fetchErrors.push({
							node_id: nodeId,
							error: e instanceof Error ? e.message : String(e),
						});
					}
				}
			}

			const fromMeta = extractFileMeta(fromFile, from_version);
			const toMeta = extractFileMeta(toFile, to_version);

			const notes: string[] = [];
			if (!component_ids || component_ids.length === 0) {
				notes.push(
					"Only page-structure diff returned. Pass component_ids to get per-component analysis (added/removed children, property changes, binding changes).",
				);
			}
			notes.push(
				"Variable VALUE history is not retrievable from Figma REST API. Variable definition value changes between these versions are not represented; only binding-reference changes on scoped nodes are detected.",
			);
			if (fetchErrors.length > 0) {
				notes.push(
					`Failed to fetch ${fetchErrors.length} of ${component_ids?.length ?? 0} requested nodes — see _fetch_errors.`,
				);
			}

			const scopedChanged = scoped.filter((n) => n.change_count > 0).length;

			const result = {
				file_key: fileKey,
				from: fromMeta,
				to: toMeta,
				page_structure: pageDiff,
				scoped_nodes: component_ids && component_ids.length > 0 ? scoped : undefined,
				summary: {
					page_changes:
						pageDiff.summary.added + pageDiff.summary.removed + pageDiff.summary.renamed,
					scoped_nodes_requested: component_ids?.length ?? 0,
					scoped_nodes_returned: scoped.length,
					scoped_nodes_with_changes: scopedChanged,
					api_calls_made: apiCalls,
				},
				notes,
				_fetch_errors: fetchErrors.length > 0 ? fetchErrors : undefined,
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
			logger.error({ error }, "Failed to diff versions");
			const hint = message.includes("403")
				? " Hint: ensure your token has both file_content:read and file_versions:read scopes."
				: message.includes("404")
					? " Hint: a version_id may have been pruned or may not belong to this file. Use figma_get_file_versions to list valid IDs."
					: "";
			return errorResponse("diff_versions_failed", message + hint);
		}
	};

	// -----------------------------------------------------------------------
	// Tool: figma_diff_versions
	// -----------------------------------------------------------------------
	server.tool(
		"figma_diff_versions",
		"Diff two versions of a Figma file. Always returns a cheap page-structure diff (added/removed/renamed pages, 2 API calls). Pass component_ids to additionally get per-node deep diffs at depth=2 (added/removed children, name/description changes, componentPropertyDefinitions changes for COMPONENT_SETs, boundVariables deltas) — costs 2 API calls per scoped node. Use 'current' for to_version to diff against HEAD. NOTE: variable VALUE history is not retrievable from Figma REST and is not represented in this diff.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			from_version: z
				.string()
				.describe("The earlier version_id to compare from. Get from figma_get_file_versions."),
			to_version: z
				.string()
				.describe("The later version_id to compare to. Use 'current' for HEAD."),
			component_ids: z
				.array(z.string())
				.optional()
				.describe("Optional. Node IDs (typically COMPONENT_SETs) to diff in detail. Without this you only get the page-structure diff. Use figma_get_design_system_kit or figma_search_components to discover IDs."),
			mode: z
				.enum(["summary", "standard", "detailed"])
				.optional()
				.default("standard")
				.describe("Output verbosity. summary=counts only, standard=names+counts (default), detailed=full property/binding details."),
		},
		async (args) => runDiff(args as any),
	);

	// -----------------------------------------------------------------------
	// Tool: figma_get_changes_since_version
	// -----------------------------------------------------------------------
	server.tool(
		"figma_get_changes_since_version",
		"Convenience wrapper for figma_diff_versions: compares a given version against the current HEAD. Same output shape as figma_diff_versions, with to_version implicitly 'current'. Useful for 'what's changed since the last code-sync' workflows.",
		{
			fileUrl: z
				.string()
				.url()
				.optional()
				.describe("Figma file URL. Uses current URL if omitted."),
			since_version: z
				.string()
				.describe("The version_id to compare against the current HEAD."),
			component_ids: z
				.array(z.string())
				.optional()
				.describe("Optional. Node IDs to diff in detail. Same semantics as figma_diff_versions."),
			mode: z
				.enum(["summary", "standard", "detailed"])
				.optional()
				.default("standard"),
		},
		async ({ fileUrl, since_version, component_ids, mode }) =>
			runDiff({
				fileUrl,
				from_version: since_version,
				to_version: CURRENT_VERSION_SENTINEL,
				component_ids,
				mode: mode as DiffMode | undefined,
			}),
	);
}

// ============================================================================
// Helpers
// ============================================================================

function errorResponse(code: string, message: string) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ error: code, message }),
			},
		],
		isError: true,
	};
}

function extractFileMeta(fileData: any, requestedVersionId: string) {
	return {
		version_id: requestedVersionId,
		resolved_version_id: fileData?.version ?? null,
		last_modified: fileData?.lastModified ?? null,
		thumbnail_url: fileData?.thumbnailUrl ?? null,
	};
}

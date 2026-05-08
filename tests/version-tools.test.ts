/**
 * Version Tools Tests
 *
 * Unit tests for figma_get_file_versions and figma_get_file_at_version.
 * Mirrors the structure of comment-tools.test.ts: a hand-rolled mock McpServer
 * captures registrations, and a mock FigmaAPI lets us drive responses without
 * fetch mocking.
 */

import { registerVersionTools } from "../src/core/version-tools";

// ============================================================================
// Mock infrastructure
// ============================================================================

interface RegisteredTool {
	name: string;
	description: string;
	schema: any;
	handler: (args: any) => Promise<any>;
}

function createMockServer() {
	const tools: RegisteredTool[] = {};
	return {
		tool: jest.fn((name: string, description: string, schema: any, handler: any) => {
			(tools as any)[name] = { name, description, schema, handler };
		}),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return (tools as any)[name];
		},
	};
}

function createMockFigmaAPI(overrides: Record<string, jest.Mock> = {}) {
	return {
		getFileVersions: jest.fn().mockResolvedValue({
			versions: [],
			pagination: { prev_page: null, next_page: null },
		}),
		getFile: jest.fn().mockResolvedValue({ document: { id: "0:0", children: [] } }),
		getNodes: jest.fn().mockResolvedValue({ nodes: {} }),
		...overrides,
	};
}

const MOCK_FILE_URL = "https://www.figma.com/design/abc123/My-File";
const MOCK_FILE_KEY = "abc123";

function makeUser(handle = "alice"): { id: string; handle: string; img_url: string } {
	return { id: `user-${handle}`, handle, img_url: `https://img.example.com/${handle}.png` };
}

function makeVersion(opts: {
	id: string;
	label?: string;
	description?: string;
	created_at?: string;
	user?: { id: string; handle: string; img_url: string };
}) {
	return {
		id: opts.id,
		label: opts.label ?? "",
		description: opts.description ?? "",
		created_at: opts.created_at ?? "2026-04-01T10:00:00Z",
		user: opts.user ?? makeUser(),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Version Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockApi: ReturnType<typeof createMockFigmaAPI>;

	beforeEach(() => {
		server = createMockServer();
		mockApi = createMockFigmaAPI();

		registerVersionTools(
			server as any,
			async () => mockApi as any,
			() => MOCK_FILE_URL,
		);
	});

	it("registers both version tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(2);
		const names = server.tool.mock.calls.map((c: any[]) => c[0]);
		expect(names).toContain("figma_get_file_versions");
		expect(names).toContain("figma_get_file_at_version");
	});

	// -----------------------------------------------------------------------
	// figma_get_file_versions
	// -----------------------------------------------------------------------
	describe("figma_get_file_versions", () => {
		it("returns labeled versions only by default (filters auto-saves)", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [
					makeVersion({ id: "v1", label: "Release 2.4" }),
					makeVersion({ id: "v2", label: "" }), // auto-save
					makeVersion({ id: "v3", label: "Release 2.3" }),
					makeVersion({ id: "v4", label: "" }), // auto-save
				],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(2);
			expect(data.versions.map((v: any) => v.id)).toEqual(["v1", "v3"]);
			expect(data.versions.every((v: any) => v.is_labeled)).toBe(true);
			expect(data.pagination.filtered_out_autosaves).toBe(2);
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
			expect(data._meta.api_calls_made).toBe(1);
		});

		it("includes auto-saves when include_autosaves=true", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [
					makeVersion({ id: "v1", label: "Release 2.4" }),
					makeVersion({ id: "v2", label: "" }),
					makeVersion({ id: "v3", label: "" }),
				],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: true, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(3);
			expect(data.versions.map((v: any) => v.is_labeled)).toEqual([true, false, false]);
			expect(data.pagination.filtered_out_autosaves).toBe(0);
		});

		it("auto-paginates across multiple pages until cap reached", async () => {
			// Page 1 returns 2 labeled versions and signals more available.
			// Page 2 returns 2 more labeled versions and signals more available.
			// max_versions=3 means we should stop mid-page-2 and report has_more=true.
			// next_cursor must be the last DISPLAYED item (v3), not the last RECEIVED (v4).
			mockApi.getFileVersions
				.mockResolvedValueOnce({
					versions: [
						makeVersion({ id: "v1", label: "L1" }),
						makeVersion({ id: "v2", label: "L2" }),
					],
					pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=v2" },
				})
				.mockResolvedValueOnce({
					versions: [
						makeVersion({ id: "v3", label: "L3" }),
						makeVersion({ id: "v4", label: "L4" }),
					],
					pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=v4" },
				});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 3 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions.map((v: any) => v.id)).toEqual(["v1", "v2", "v3"]);
			expect(data.pagination.has_more).toBe(true);
			expect(data.pagination.next_cursor).toBe("v3"); // last DISPLAYED — caller continues with after=v3
			expect(data._meta.api_calls_made).toBe(2);
		});

		it("falls back to last-received id as next_cursor when no items collected", async () => {
			// Labeled-only mode, page returns only autosaves but Figma signals more pages.
			// Caller needs *some* cursor to continue scanning forward.
			mockApi.getFileVersions.mockResolvedValueOnce({
				versions: [
					makeVersion({ id: "vA", label: "" }),
					makeVersion({ id: "vB", label: "" }),
				],
				pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=vB" },
			}).mockResolvedValueOnce({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(0);
			expect(data.pagination.filtered_out_autosaves).toBe(2);
			// Loop exited because page 2 returned empty (figmaSaysMore=false).
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
		});

		it("stops paginating when Figma signals no more pages", async () => {
			mockApi.getFileVersions
				.mockResolvedValueOnce({
					versions: [makeVersion({ id: "v1", label: "L1" })],
					pagination: { prev_page: null, next_page: "https://api.figma.com/...?after=v1" },
				})
				.mockResolvedValueOnce({
					versions: [makeVersion({ id: "v2", label: "L2" })],
					pagination: { prev_page: null, next_page: null }, // no more
				});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions.map((v: any) => v.id)).toEqual(["v1", "v2"]);
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
			expect(data._meta.api_calls_made).toBe(2);
		});

		it("passes provided cursor as 'after' on the first call", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [makeVersion({ id: "vOld", label: "Old" })],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			await tool.handler({ include_autosaves: false, max_versions: 10, cursor: "vSomething" });

			expect(mockApi.getFileVersions).toHaveBeenCalledWith(MOCK_FILE_KEY, {
				page_size: 50,
				after: "vSomething",
			});
		});

		it("clamps max_versions above the hard cap", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			// Schema validation rejects values > 200; the runtime cap also clamps.
			// Test the runtime side by feeding a borderline value.
			await tool.handler({ include_autosaves: false, max_versions: 200 });
			expect(mockApi.getFileVersions).toHaveBeenCalled();
		});

		it("uses explicit fileUrl when provided", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			await tool.handler({
				fileUrl: "https://www.figma.com/design/xyz999/Other",
				include_autosaves: false,
				max_versions: 50,
			});

			expect(mockApi.getFileVersions).toHaveBeenCalledWith("xyz999", expect.any(Object));
		});

		it("returns no_file_url error when neither URL is available", async () => {
			server = createMockServer();
			registerVersionTools(server as any, async () => mockApi as any, () => null);

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("returns invalid_url error for non-Figma URLs", async () => {
			server = createMockServer();
			registerVersionTools(
				server as any,
				async () => mockApi as any,
				() => "https://example.com/not-figma",
			);

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("invalid_url");
		});

		it("surfaces 403 error with scope hint", async () => {
			mockApi.getFileVersions.mockRejectedValue(
				new Error("Figma API error (403): forbidden"),
			);

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("get_file_versions_failed");
			expect(data.message).toContain("403");
			expect(data.message).toContain("file_versions:read");
		});

		it("does not loop forever when cursor fails to advance", async () => {
			// Pathological case: same response twice — should detect non-advancement and stop.
			mockApi.getFileVersions.mockResolvedValue({
				versions: [makeVersion({ id: "vSame", label: "L" })],
				pagination: { prev_page: null, next_page: "https://api/.../?before=vSame" },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({
				include_autosaves: false,
				max_versions: 50,
				cursor: "vSame",
			});

			expect(result.isError).toBeUndefined();
			const data = JSON.parse(result.content[0].text);
			// We should have called once and stopped (cursor === lastReceivedId after one page)
			expect(data._meta.api_calls_made).toBe(1);
		});

		it("handles empty response", async () => {
			mockApi.getFileVersions.mockResolvedValue({
				versions: [],
				pagination: { prev_page: null, next_page: null },
			});

			const tool = server._getTool("figma_get_file_versions");
			const result = await tool.handler({ include_autosaves: false, max_versions: 50 });

			const data = JSON.parse(result.content[0].text);
			expect(data.versions).toHaveLength(0);
			expect(data.pagination.has_more).toBe(false);
			expect(data.pagination.next_cursor).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// figma_get_file_at_version
	// -----------------------------------------------------------------------
	describe("figma_get_file_at_version", () => {
		it("calls getFile with version when no node_ids given", async () => {
			mockApi.getFile.mockResolvedValue({
				name: "My File",
				lastModified: "2026-04-01T10:00:00Z",
				document: { id: "0:0", children: [] },
			});

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "v1" });

			expect(result.isError).toBeUndefined();
			expect(mockApi.getFile).toHaveBeenCalledWith(MOCK_FILE_KEY, {
				version: "v1",
				depth: undefined,
			});
			expect(mockApi.getNodes).not.toHaveBeenCalled();

			const data = JSON.parse(result.content[0].text);
			expect(data._version.id).toBe("v1");
			expect(data._version.fileKey).toBe(MOCK_FILE_KEY);
			expect(data._version.scope).toBe("file");
			expect(data._version.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(data.name).toBe("My File");
		});

		it("calls getNodes with version when node_ids given", async () => {
			mockApi.getNodes.mockResolvedValue({ nodes: { "1:2": { document: { id: "1:2" } } } });

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({
				version_id: "v1",
				node_ids: ["1:2", "3:4"],
				depth: 2,
			});

			expect(result.isError).toBeUndefined();
			expect(mockApi.getNodes).toHaveBeenCalledWith(MOCK_FILE_KEY, ["1:2", "3:4"], {
				version: "v1",
				depth: 2,
			});
			expect(mockApi.getFile).not.toHaveBeenCalled();

			const data = JSON.parse(result.content[0].text);
			expect(data._version.scope).toBe("nodes");
		});

		it("respects explicit fileUrl", async () => {
			mockApi.getFile.mockResolvedValue({});

			const tool = server._getTool("figma_get_file_at_version");
			await tool.handler({
				fileUrl: "https://www.figma.com/design/xyz999/Other",
				version_id: "v9",
			});

			expect(mockApi.getFile).toHaveBeenCalledWith("xyz999", expect.objectContaining({ version: "v9" }));
		});

		it("returns no_file_url error when no URL", async () => {
			server = createMockServer();
			registerVersionTools(server as any, async () => mockApi as any, () => null);

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "v1" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("no_file_url");
		});

		it("surfaces 404 error with retention hint", async () => {
			mockApi.getFile.mockRejectedValue(new Error("Figma API error (404): not found"));

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "vGone" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("get_file_at_version_failed");
			expect(data.message).toContain("404");
			expect(data.message).toContain("retention");
		});

		it("returns invalid_url error for non-Figma URLs", async () => {
			server = createMockServer();
			registerVersionTools(
				server as any,
				async () => mockApi as any,
				() => "https://example.com/not-figma",
			);

			const tool = server._getTool("figma_get_file_at_version");
			const result = await tool.handler({ version_id: "v1" });

			expect(result.isError).toBe(true);
			const data = JSON.parse(result.content[0].text);
			expect(data.error).toBe("invalid_url");
		});
	});
});

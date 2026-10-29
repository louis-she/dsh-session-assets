/**
 * Offline smoke test for dsh-session-assets (host half).
 * Mocks the cordis context, exercises all three routes, the present-event
 * archive copy, back-fill on list, and de-duplication.
 * Run: node test/smoke.mjs
 */
import assert from "node:assert";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

/** Copies of the persistence encoders the plugin mirrors. */
function encodeSegment(raw) {
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}
function projectKey(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/u, "") || "root").slice(0, 251)}--`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, budget = 3000) {
	const start = Date.now();
	while (Date.now() - start < budget) {
		if (await predicate()) return;
		await wait(25);
	}
	throw new Error(`timeout: ${label}`);
}

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`ok ${passed} - ${label}`);
};

const home = await mkdtemp(join(tmpdir(), "dsh-session-assets-"));
const sessionsRoot = join(home, "sessions");
const workspace = join(home, "project");
const sessionId = "sess-1";
const cwd = workspace;
const sessionDir = join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId));
await mkdir(sessionDir, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(join(sessionDir, "session.v4.jsonl"), "{}\n", "utf8");

const sourcePath = join(workspace, "报告 数据.xlsx");
await writeFile(sourcePath, "hello-assets", "utf8");
const gonePath = join(workspace, "deleted-later.pdf");

const presented = {
	turn: 3,
	callId: "call-1",
	files: [
		{ path: sourcePath, description: "季度报告" },
		{ path: gonePath, description: "先消失" }
	]
};

const newFilePath = join(workspace, "new-file.txt");
const editedFilePath = join(workspace, "edited.txt");
const failedPath = join(workspace, "failed.txt");
await writeFile(newFilePath, "hi", "utf8");
await writeFile(editedFilePath, "ab", "utf8");

/** Durable tool events: successful write, successful edit, failed write, re-written presented file. */
const toolEvents = {
	20: { type: "tool/call", data: { turn: 4, callId: "c-write", name: "write", arguments: JSON.stringify({ file_path: newFilePath, content: "hi" }) } },
	21: { type: "tool/result", data: { turn: 4, message: { isError: false, source: { callId: "c-write" } }, meta: { path: newFilePath } } },
	22: { type: "tool/call", data: { turn: 4, callId: "c-edit", name: "edit", arguments: JSON.stringify({ file_path: editedFilePath, old_string: "a", new_string: "b" }) } },
	23: { type: "tool/result", data: { turn: 4, message: { source: { callId: "c-edit" } } } },
	24: { type: "tool/call", data: { turn: 5, callId: "c-fail", name: "write", arguments: JSON.stringify({ file_path: failedPath, content: "x" }) } },
	25: { type: "tool/result", data: { turn: 5, message: { isError: true, source: { callId: "c-fail" } } } },
	26: { type: "tool/call", data: { turn: 5, callId: "c-also", name: "write", arguments: JSON.stringify({ file_path: sourcePath, content: "y" }) } },
	27: { type: "tool/result", data: { turn: 5, message: { isError: false, source: { callId: "c-also" } }, meta: { path: sourcePath } } }
};

const routes = new Map();
const listeners = new Map();
const readEventCalls = [];
const ctx = {
	connection: {
		fetch: {
			register(route) {
				if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
				routes.set(route.path, route);
			}
		}
	},
	on(name, fn) {
		const list = listeners.get(name) ?? [];
		list.push(fn);
		listeners.set(name, list);
		return () => {};
	},
	get(name) {
		return name === "sessionPersistence" ? undefined : undefined;
	},
	sessions: { get: () => undefined },
	sandboxPolicy: { workspaceRoot: workspace },
	fs: {
		async resolve(path, options) {
			const abs = path.startsWith("/") ? path : join(options?.cwd ?? workspace, path);
			return { path: abs };
		},
		contains(root, target) {
			return target.path === root.path || target.path.startsWith(`${root.path}/`);
		},
		processPath(target) {
			return target.path;
		}
	}
};

const sessionQuery = {
	/** The single full-log observation the list route must rely on. */
	async readSession(id) {
		if (id !== sessionId) {
			throw Object.assign(new Error("no session"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
		}
		return {
			session: { cwd },
			inheritedEventCount: 0,
			events: [
				{ seq: 11, type: "request/user", data: {} },
				{ seq: 12, type: "deliverables/presented", data: presented },
				...Object.entries(toolEvents).map(([seq, event]) => ({ seq: Number(seq), type: event.type, data: event.data }))
			]
		};
	},
	async listEvents(id) {
		if (id !== sessionId) return [];
		return [
			{ sessionId: id, seq: 11, type: "request/user" },
			{ sessionId: id, seq: 12, type: "deliverables/presented" },
			...Object.entries(toolEvents).map(([seq, event]) => ({ sessionId: id, seq: Number(seq), type: event.type }))
		];
	},
	async readEvent({ sessionId: id, seq }, signal) {
		readEventCalls.push([id, seq]);
		if (id !== sessionId) {
			throw Object.assign(new Error("no session"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
		}
		if (seq === 12) return {
			session: { cwd },
			target: { type: "deliverables/presented", data: presented },
			events: [],
			startSeq: 12,
			endSeq: 12
		};
		if (toolEvents[seq] !== void 0) return {
			session: { cwd },
			target: { type: toolEvents[seq].type, data: toolEvents[seq].data },
			events: [],
			startSeq: seq,
			endSeq: seq
		};
		throw Object.assign(new Error("no event"), { code: "SESSION_QUERY_EVENT_NOT_FOUND" });
	}
};
ctx.sessionQuery = sessionQuery;

// listCacheMs: 0 disables the payload cache so idempotency re-runs back-fill
apply(ctx, { sessionsRoot, listCacheMs: 0 });
ok("apply registers without throwing");

assert.equal(routes.size, 4, `expected 4 routes, got ${[...routes.keys()].join(",")}`);
assert.deepEqual([...routes.keys()].sort(), [
	"/api/session.assets.download",
	"/api/session.assets.file",
	"/api/session.assets.list",
	"/api/session.assets.present"
].sort());
ok("four routes registered");

// --- present event triggers the archive copy ---
for (const fn of listeners.get("session/event") ?? []) {
	fn({ id: sessionId, header: { cwd } }, { type: "deliverables/presented", seq: 12, data: presented });
}
const assetsDir = join(sessionDir, "assets");
await until(async () => {
	try {
		await readFile(join(assetsDir, "manifest.json"), "utf8");
		return true;
	} catch {
		return false;
	}
}, "manifest written by session/event copy");
const afterEvent = await readdir(assetsDir);
assert.ok(afterEvent.includes("报告 数据.xlsx"), `assets: ${afterEvent.join(",")}`);
assert.ok(!afterEvent.includes("deleted-later.pdf"), "missing source must not be copied");
ok("session/event copies present files into <sessionDir>/assets");

// --- list route: asset + unavailable presented, no duplicates ---
const listRoute = routes.get("/api/session.assets.list");
const listResponse = await listRoute.fetch(new Request(`http://localhost${listRoute.path}?sessionId=${encodeURIComponent(sessionId)}`));
assert.equal(listResponse.status, 200);
const payload = await listResponse.json();
assert.equal(payload.cwd, cwd);
assert.equal(payload.items.length, 4, JSON.stringify(payload.items, null, 2));
const assetItem = payload.items.find((item) => item.kind === "asset");
const goneItem = payload.items.find((item) => item.kind === "presented");
assert.equal(assetItem.name, "报告 数据.xlsx");
assert.equal(assetItem.bytes, "hello-assets".length);
assert.equal(assetItem.seq, 12);
assert.equal(assetItem.index, 0);
assert.equal(assetItem.description, "季度报告");
assert.equal(assetItem.available, true);
assert.equal(assetItem.display, "报告 数据.xlsx");
assert.equal(goneItem.name, "deleted-later.pdf");
assert.equal(goneItem.available, false);
const producedNames = payload.items.filter((item) => item.kind === "produced").map((item) => item.name).sort();
assert.deepEqual(producedNames, ["edited.txt", "new-file.txt"], JSON.stringify(payload.items, null, 2));
assert.ok(!payload.items.some((item) => item.name === "failed.txt"), "failed mutation must not be listed");
assert.ok(!payload.items.some((item) => item.kind === "produced" && item.name === "报告 数据.xlsx"), "presented source must not duplicate as produced");
const newFileItem = payload.items.find((item) => item.name === "new-file.txt");
assert.equal(newFileItem.available, true);
assert.equal(newFileItem.bytes, 2);
assert.equal(readEventCalls.length, 0, "list must read the corpus once — no per-event readEvent");
ok("list returns assets + presented + durable produced files (failures excluded, deduped, single observation)");

// --- list again: back-fill must not duplicate ---
const second = await (await listRoute.fetch(new Request(`http://localhost${listRoute.path}?sessionId=${encodeURIComponent(sessionId)}`))).json();
assert.equal(second.items.length, 4, JSON.stringify(second.items, null, 2));
const manifestFiles = JSON.parse(await readFile(join(assetsDir, "manifest.json"), "utf8")).files;
assert.equal(manifestFiles.length, 1, `manifest grew: ${JSON.stringify(manifestFiles)}`);
ok("second list is idempotent (no duplicate items, no manifest growth)");

// --- present route: GET streams bytes, HEAD gives headers only ---
const presentRoute = routes.get("/api/session.assets.present");
const presentUrl = `http://localhost${presentRoute.path}?sessionId=${encodeURIComponent(sessionId)}&seq=12&index=0`;
const presentGet = await presentRoute.fetch(new Request(presentUrl));
assert.equal(presentGet.status, 200);
assert.match(presentGet.headers.get("content-disposition") ?? "", /attachment; filename="/u);
assert.match(presentGet.headers.get("content-disposition") ?? "", /filename\*=UTF-8''/u);
assert.equal(await presentGet.text(), "hello-assets");
ok("present GET streams file bytes with RFC 5987 filename");

const presentHead = await presentRoute.fetch(new Request(presentUrl, { method: "HEAD" }));
assert.equal(presentHead.status, 200);
assert.equal(presentHead.body, null);
assert.equal(presentHead.headers.get("content-length"), String("hello-assets".length));
ok("present HEAD returns headers only");

const badCoords = await presentRoute.fetch(new Request(`http://localhost${presentRoute.path}?sessionId=x&seq=abc&index=0`));
assert.equal(badCoords.status, 400);
const unknownSession = await presentRoute.fetch(new Request(`http://localhost${presentRoute.path}?sessionId=nope&seq=12&index=0`));
assert.equal(unknownSession.status, 404);
const wrongEvent = await presentRoute.fetch(new Request(`http://localhost${presentRoute.path}?sessionId=${encodeURIComponent(sessionId)}&seq=11&index=0`));
assert.equal(wrongEvent.status, 404);
ok("present route refuses bad coordinates (400) and unknown targets (404)");

// --- download route: asset bytes by name, traversal refused ---
const downloadRoute = routes.get("/api/session.assets.download");
const downloadUrl = `http://localhost${downloadRoute.path}?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent("报告 数据.xlsx")}`;
const downloadGet = await downloadRoute.fetch(new Request(downloadUrl));
assert.equal(downloadGet.status, 200);
assert.equal(await downloadGet.text(), "hello-assets");
const downloadHead = await downloadRoute.fetch(new Request(downloadUrl, { method: "HEAD" }));
assert.equal(downloadHead.status, 200);
assert.equal(downloadHead.body, null);
const traversal = await downloadRoute.fetch(new Request(`http://localhost${downloadRoute.path}?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent("../session.v4.jsonl")}`));
assert.equal(traversal.status, 400);
const missingAsset = await downloadRoute.fetch(new Request(`http://localhost${downloadRoute.path}?sessionId=${encodeURIComponent(sessionId)}&name=nope.txt`));
assert.equal(missingAsset.status, 404);
ok("download route streams assets, refuses traversal (400) and misses (404)");

// --- file route: workspace-confined streaming by path ---
const fileRoute = routes.get("/api/session.assets.file");
const fileQuery = `sessionId=${encodeURIComponent(sessionId)}`;
const fileGet = await fileRoute.fetch(new Request(`http://localhost${fileRoute.path}?${fileQuery}&path=${encodeURIComponent(newFilePath)}`));
assert.equal(fileGet.status, 200);
assert.equal(await fileGet.text(), "hi");
const fileHead = await fileRoute.fetch(new Request(`http://localhost${fileRoute.path}?${fileQuery}&path=${encodeURIComponent(newFilePath)}`, { method: "HEAD" }));
assert.equal(fileHead.status, 200);
assert.equal(fileHead.body, null);
const relativeFile = await fileRoute.fetch(new Request(`http://localhost${fileRoute.path}?${fileQuery}&path=${encodeURIComponent("new-file.txt")}`));
assert.equal(relativeFile.status, 200, "workspace-relative paths resolve");
const outside = await fileRoute.fetch(new Request(`http://localhost${fileRoute.path}?${fileQuery}&path=${encodeURIComponent("/etc/hosts")}`, { method: "HEAD" }));
assert.equal(outside.status, 200, "read authority matches preview (outside-workspace readable)");
const badFile = await fileRoute.fetch(new Request(`http://localhost${fileRoute.path}?${fileQuery}`));
assert.equal(badFile.status, 400, "missing path is refused");
ok("file route streams files (absolute + relative, preview read authority), refuses bad requests (400)");

// --- list degrades to presented-only when the full-log read fails ---
const originalReadSession = sessionQuery.readSession;
sessionQuery.readSession = async () => {
	throw Object.assign(new Error("replay validation failed"), { code: "SESSION_QUERY_CORPUS" });
};
const degraded = await (await listRoute.fetch(new Request(`http://localhost${listRoute.path}?sessionId=${encodeURIComponent(sessionId)}`))).json();
assert.ok(degraded.items.some((item) => item.kind === "asset"), "fallback keeps assets");
assert.ok(degraded.items.some((item) => item.kind === "presented"), "fallback keeps presented");
assert.ok(!degraded.items.some((item) => item.kind === "produced"), "fallback skips produced (no quadratic reads)");
sessionQuery.readSession = originalReadSession;
ok("list degrades to presented-only when readSession fails (no quadratic fallback)");

// --- self-instrumentation ---
const state = JSON.parse(await readFile(join(dirnameOf(import.meta.url), "..", ".state.json"), "utf8"));
assert.equal(state.sessionsRoot, sessionsRoot);
ok("activation recorded in .state.json");

function dirnameOf(url) {
	return new URL(".", url).pathname.replace(/\/$/u, "");
}

await rm(home, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);

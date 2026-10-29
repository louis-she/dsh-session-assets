/**
 * dsh-session-assets — per-session file assets for DSH Web (host half).
 *
 * What this plugin adds:
 *   1. `/api/session.assets.present`  — download the file behind a `present`
 *      card coordinate (sessionId, seq, index) straight from the chat.
 *   2. `/api/session.assets.list`     — every file this session produced:
 *      asset copies (kind "asset") plus presented files that could not be
 *      copied (kind "presented"), with availability flags for the Files tab.
 *   3. `/api/session.assets.download` — download one file from the session's
 *      asset directory by name.
 *   4. `session/event` listener — every `deliverables/presented` event copies
 *      the declared files into `<sessionDir>/assets/` (plus a manifest.json),
 *      so the assets live and die with the session directory. Opening the
 *      Files tab back-fills the same copies for sessions presented before
 *      this plugin existed.
 *
 * Design notes:
 *   - All routes sit inside Connection's authenticated fetch fence; a plain
 *     browser GET (anchor navigation) authenticates with the signed cookie,
 *     exactly like `@deepseek-ai/dsh-session-log-export`.
 *   - Zero third-party imports: Node built-ins only, so the package loads
 *     from a local path with no installed dependencies. With no static
 *     `Config` schema, cordis passes the raw `config` object through
 *     untouched (`resolveConfig` returns it as-is), which we read defensively.
 *   - `encodeSegment`/`projectKey` mirror `@deepseek-ai/dsh-session-persistence-jsonl`
 *     so assets land inside the session's own directory:
 *     `~/.dsh/sessions/<projectKey(cwd)>/<encodeSegment(id)>/assets/`.
 *     Deleting the session directory therefore deletes its assets too.
 *
 * @module dsh-session-assets
 */
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat as statPath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/** Stable Cordis plugin name. */
export const name = "session-assets";
/** Services this host half needs before `apply` runs. */
export const inject = ["connection", "sessionQuery", "fs", "sessions", "sandboxPolicy"];

/** Authenticated GET/HEAD route serving one presented file's bytes. */
const PRESENT_PATH = "/api/session.assets.present";
/** Authenticated GET route serving the session's produced-file inventory. */
const LIST_PATH = "/api/session.assets.list";
/** Authenticated GET/HEAD route serving one asset-directory file. */
const DOWNLOAD_PATH = "/api/session.assets.download";
/** Authenticated GET/HEAD route serving one workspace-confined file by path. */
const FILE_PATH = "/api/session.assets.file";
/** Directory name under the session directory that owns copied artifacts. */
const ASSETS_DIR = "assets";
/** Manifest filename inside the assets directory. */
const MANIFEST_NAME = "manifest.json";
/** Package directory, for self-instrumentation files. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

//#region path encoding (mirrors dsh-session-persistence-jsonl)
/**
 * Encode an arbitrary string as one safe path segment: safe code units stay
 * literal, everything else becomes `~XXXX`, with `.`/`..` special-cased.
 * @param raw - non-empty string.
 * @returns a single traversal-safe path segment.
 */
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
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
/**
 * Build the readable directory key for a project path (separators become `-`,
 * unsafe units use the `~XXXX` escape, wrapped in `--…--`, lossy by design).
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
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
//#endregion

//#region small helpers
/** Best-effort diagnostic log beside the package (stdout is discarded here). */
async function log(level, message) {
	try {
		await appendFile(join(PACKAGE_DIR, ".log"), `${new Date().toISOString()} ${level} ${message}\n`);
	} catch {}
}
/** Expand a leading `~` against the home directory. */
function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}
/** Plain-text response for route errors. */
function text(body, status) {
	return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
/** `Content-Disposition` with an ASCII fallback plus RFC 5987 UTF-8 name. */
function disposition(filename) {
	const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
	return `attachment; filename="${ascii}"${/[\x00-\x1f\x7f-\uffff]/u.test(filename) ? `; filename*=UTF-8''${encodeURIComponent(filename)}` : ""}`;
}
/** Final path segment of a POSIX or Windows-style path. */
function baseName(path) {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut === -1 ? path : path.slice(cut + 1);
}
/** Last extension, lower-case, without the dot ("" when none). */
function extensionOf(name) {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
/** Whether a coordinate value came through as a safe integer. */
function coordinate(value) {
	return value !== null && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}
/** The deliverables/presented payload we accept (mirrors isPresentedData). */
function isPresentedData(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const { turn, callId, files } = value;
	return typeof turn === "number" && Number.isSafeInteger(turn) && turn >= 1 && typeof callId === "string" && callId.length > 0 && Array.isArray(files);
}
/** One declared file we accept (mirrors isPresentedFile). */
function isPresentedFile(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const { path, description } = value;
	return typeof path === "string" && path.trim().length > 0 && (description === void 0 || typeof description === "string");
}
/** A stat's failure folded into "does not exist" without throwing. */
async function statOrUndefined(path) {
	try {
		return await statPath(path);
	} catch {
		return undefined;
	}
}
/** Whether the path currently exists as a regular file. */
async function isFile(path) {
	const info = await statOrUndefined(path);
	return info !== void 0 && info.isFile();
}
/** Whether the path currently exists as a directory. */
async function isDirectory(path) {
	const info = await statOrUndefined(path);
	return info !== void 0 && info.isDirectory();
}
/** Absolute source path of one presented file declaration. */
function sourceOf(file, cwd) {
	return isAbsolute(file.path) || typeof cwd !== "string" || cwd === "" ? file.path : join(cwd, file.path);
}
//#endregion

//#region produced-file derivation (mirrors dsh-client-ui-deliverables turn-deliverables)
/** Narrow parsed JSON to a plain record. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A non-blank path preserves the exact spelling supplied to the tool. */
function pathValue(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}
/** Validate the fields an `edit` execution requires. */
function validEditArgs(args) {
	return typeof args.old_string === "string" && args.old_string.length > 0 && typeof args.new_string === "string" && args.new_string !== args.old_string && (args.replace_all === void 0 || typeof args.replace_all === "boolean");
}
/** Extract a path only from a complete mutating editor command. */
function editorMutationPath(args) {
	const path = pathValue(args.path);
	if (path === null) return null;
	switch (args.command) {
		case "create": return typeof args.file_text === "string" ? path : null;
		case "str_replace": return typeof args.old_str === "string" && args.old_str.length > 0 && (args.new_str === void 0 || typeof args.new_str === "string") ? path : null;
		case "insert": return typeof args.insert_line === "number" && Number.isInteger(args.insert_line) && args.insert_line >= 0 && typeof args.new_str === "string" ? path : null;
		default: return null;
	}
}
/** Whether the path is spelled in the host-facing absolute form. */
function isAbsoluteWorkspacePath(path) {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path);
}
/** Extract the mutation path from one recorded `tool/call`. */
function mutationPath(name, argsRaw) {
	let args;
	try {
		args = JSON.parse(argsRaw);
	} catch {
		return null;
	}
	if (!isRecord(args)) return null;
	switch (name) {
		case "write": return typeof args.content === "string" ? pathValue(args.file_path) : null;
		case "edit": return validEditArgs(args) ? pathValue(args.file_path) : null;
		case "str_replace_editor": return editorMutationPath(args);
		default: return null;
	}
}
/** Resolve a settled mutation from recorded metadata, retaining legacy argument paths. */
function mutationResultPath(argumentPath, meta) {
	if (!isRecord(meta) || !Object.hasOwn(meta, "path")) return argumentPath;
	if (typeof meta.path === "string" && isAbsoluteWorkspacePath(meta.path)) return meta.path;
	return isAbsoluteWorkspacePath(argumentPath) ? argumentPath : null;
}
//#endregion

//#region streaming responses
/**
 * Stream one local file as a browser download.
 * Every check finishes before the stream starts; later failures surface as
 * stream errors, never as a changed status.
 * @param path - path of a regular file.
 * @param method - GET streams the body, HEAD answers headers only.
 * @returns the download response, or a 404/405 refusal.
 */
async function fileResponse(path, method) {
	const info = await statOrUndefined(path);
	if (info === void 0) return text("not found", 404);
	if (!info.isFile()) return text("not a regular file", 404);
	if (method !== "GET" && method !== "HEAD") return text("method not allowed", 405);
	const headers = {
		"content-type": "application/octet-stream",
		"content-length": String(info.size),
		"content-disposition": disposition(baseName(path)),
		"cache-control": "no-store"
	};
	if (method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(Readable.toWeb(createReadStream(path)), { status: 200, headers });
}
/** Map a session-query failure onto the status the browser should retry from. */
function failureStatus(error) {
	const code = String(error?.code ?? error?.cause?.code ?? "");
	return /NOT_FOUND|not-found|ENOENT|ENOTDIR/iu.test(code) ? 404 : 500;
}
//#endregion

//#region asset directory layout
/**
 * Root that owns every session directory: `config.sessionsRoot` when set, the
 * live persistence root when it exposes one, else `$DSH_HOME/sessions`.
 * @param ctx - host context carrying the persistence service.
 * @param config - raw plugin config (may set `sessionsRoot`).
 * @returns the absolute sessions root.
 */
function sessionsRootOf(ctx, config) {
	const configured = typeof config?.sessionsRoot === "string" ? config.sessionsRoot.trim() : "";
	if (configured !== "") return expandHome(configured);
	try {
		const root = ctx.get("sessionPersistence")?.root;
		if (typeof root === "string" && root !== "") return root;
	} catch {}
	return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "sessions");
}
/**
 * The directory owned by one session (persistence layout), resolved from the
 * header's cwd when available and otherwise located by scanning the root.
 * @param root - the sessions root directory.
 * @param id - session id.
 * @param cwd - the session's working directory, when known.
 * @returns the absolute session directory, or its not-yet-created path.
 */
async function locateSessionDir(root, id, cwd) {
	const encoded = encodeSegment(id);
	if (typeof cwd === "string" && cwd !== "") {
		const direct = join(root, projectKey(cwd), encoded);
		if (await isDirectory(direct)) return direct;
	}
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = join(root, entry.name, encoded);
		if (await isDirectory(candidate)) return candidate;
	}
	if (typeof cwd === "string" && cwd !== "") return join(root, projectKey(cwd), encoded);
	return undefined;
}
/** The asset directory for one session (created on demand). */
async function assetsDirOf(root, id, cwd) {
	const sessionDir = await locateSessionDir(root, id, cwd);
	return sessionDir === void 0 ? undefined : join(sessionDir, ASSETS_DIR);
}
//#endregion

//#region manifest
/** @returns the parsed manifest of one assets directory, or a fresh one. */
async function readManifest(dir) {
	try {
		const raw = await readFile(join(dir, MANIFEST_NAME), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.files)) return parsed;
	} catch {}
	return { v: 1, files: [] };
}
/** Persist one assets-directory manifest (atomic replace). */
async function writeManifest(dir, manifest) {
	const target = join(dir, MANIFEST_NAME);
	const temp = `${target}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(manifest, null, "\t"), "utf8");
	await rename(temp, target);
}
/**
 * Pick a collision-free file name inside one assets directory: the plain name
 * first, then `stem (2).ext`, `stem (3).ext`, …
 * @param dir - the assets directory.
 * @param desired - the requested file name.
 * @param reserved - names already claimed by manifest entries.
 * @returns a free file name.
 */
async function uniqueAssetName(dir, desired, reserved) {
	const taken = new Set(reserved);
	if (!taken.has(desired) && !await isFile(join(dir, desired))) return desired;
	const ext = extensionOf(desired);
	const stem = ext === "" ? desired : desired.slice(0, desired.length - ext.length - 1);
	for (let n = 2; n < 10000; n++) {
		const candidate = ext === "" ? `${stem} (${n})` : `${stem} (${n}).${ext}`;
		if (!taken.has(candidate) && !await isFile(join(dir, candidate))) return candidate;
	}
	return `${stem}-${Date.now()}${ext === "" ? "" : `.${ext}`}`;
}
//#endregion

/**
 * Cordis plugin body: register the three download/list routes and copy every
 * presented file into its session's asset directory.
 * @param ctx - host context carrying connection, sessionQuery, and fs.
 * @param config - raw config from the profile patch entry.
 */
export function apply(ctx, config = {}) {
	const root = () => sessionsRootOf(ctx, config);
	/** Serialize manifest reads/writes per session so copies never interleave. */
	const locks = new Map();
	/**
	* Short-lived list payloads keyed by session. `SessionCorpus.load` (the
	* backing read for `readSession`/`listEvents`/`readEvent`) has no cache of
	* its own — every call re-loads and deep-clones the entire event log — so a
	* request window keeps one observation instead of repeating the load.
	*/
	const listCache = new Map();
	const withLock = (sessionId, task) => {
		const previous = locks.get(sessionId) ?? Promise.resolve();
		const next = previous.then(task, task);
		locks.set(sessionId, next.then(() => {}, () => {}));
		return next;
	};

	/**
	 * Copy one `deliverables/presented` payload's files into the session's
	 * asset directory, recording each copy in manifest.json. Unchanged sources
	 * are left alone (the manifest entry's coords are refreshed in place);
	 * repeated basenames get ` (2)`-style suffixes; vanished sources stay out
	 * of the manifest so the list route can report them as unavailable.
	 * @param sessionId - the session that declared the files.
	 * @param cwd - the session's working directory, when known.
	 * @param data - the event payload ({turn, callId, files}).
	 * @param eventSeq - the event's sequence number, when known.
	 * @returns the per-file records for this pass.
	 */
	const copyPresented = (sessionId, cwd, data, eventSeq) => withLock(sessionId, async () => {
		if (!isPresentedData(data)) return [];
		const dir = await assetsDirOf(root(), sessionId, cwd);
		if (dir === void 0) {
			await log("warn", `no session directory for ${sessionId}; skip copy`);
			return [];
		}
		await mkdir(dir, { recursive: true });
		const manifest = await readManifest(dir);
		let dirty = false;
		const records = [];
		for (let index = 0; index < data.files.length; index++) {
			const file = data.files[index];
			if (!isPresentedFile(file)) continue;
			const source = sourceOf(file, cwd);
			const info = await statOrUndefined(source);
			if (info === void 0 || !info.isFile()) {
				records.push({ seq: eventSeq ?? null, index, source, name: baseName(source), bytes: null, mtimeMs: null, description: file.description ?? null, missing: true });
				continue;
			}
			const existing = manifest.files.find((entry) => entry.source === source && entry.bytes === info.size && entry.mtimeMs === Math.trunc(info.mtimeMs));
			if (existing !== void 0) {
				if (await isFile(join(dir, existing.name))) {
					if (existing.seq !== (eventSeq ?? null) || existing.index !== index || existing.description !== (file.description ?? null)) {
						existing.seq = eventSeq ?? existing.seq ?? null;
						existing.index = index;
						existing.description = file.description ?? existing.description ?? null;
						dirty = true;
					}
					records.push({ ...existing, index });
					continue;
				}
				manifest.files = manifest.files.filter((entry) => entry !== existing);
				dirty = true;
			}
			const name = await uniqueAssetName(dir, baseName(source) || "file", manifest.files.map((entry) => entry.name));
			await copyFile(source, join(dir, name));
			const record = {
				seq: eventSeq ?? null,
				index,
				source,
				name,
				bytes: info.size,
				mtimeMs: Math.trunc(info.mtimeMs),
				description: file.description ?? null
			};
			manifest.files.push(record);
			dirty = true;
			records.push(record);
		}
		if (dirty) await writeManifest(dir, manifest);
		return records;
	});

	/** `session/event` → drop the list cache, and archive presented files. */
	ctx.on("session/event", (session, event) => {
		const sessionId = typeof session?.id === "string" ? session.id : void 0;
		if (sessionId !== void 0) listCache.delete(sessionId);
		if (event?.type !== "deliverables/presented") return;
		if (sessionId === void 0) return;
		const cwd = session?.header?.cwd ?? session?.cwd;
		const seq = Number.isSafeInteger(event?.seq) ? event.seq : null;
		copyPresented(sessionId, cwd, event.data, seq).catch(async (error) => {
			await log("error", `copy for ${sessionId}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		});
	});

	/** Resolve one presented coordinate (sessionId, seq, index) to its entry. */
	const readPresentedFile = async (sessionId, seq, index, signal) => {
		const read = await ctx.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal);
		const target = read?.target;
		if (target?.type !== "deliverables/presented" || !isPresentedData(target.data)) return undefined;
		const file = target.data.files[index];
		return isPresentedFile(file) ? { file, cwd: read?.session?.cwd } : undefined;
	};

	/** GET/HEAD — download the live file behind a present card. */
	ctx.connection.fetch.register({
		path: PRESENT_PATH,
		methods: ["GET", "HEAD"],
		requestBody: "buffered",
		fetch: async (request) => {
			try {
				const query = new URL(request.url).searchParams;
				const sessionId = query.get("sessionId");
				const seq = coordinate(query.get("seq"));
				const index = coordinate(query.get("index"));
				if (!sessionId || seq === void 0 || index === void 0) return text("bad presented coordinates", 400);
				const located = await readPresentedFile(sessionId, seq, index, request.signal);
				if (located === void 0) return text("presented file not found", 404);
				return await fileResponse(sourceOf(located.file, located.cwd), request.method);
			} catch (error) {
				await log("error", `present route: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				return text("presented file unavailable", failureStatus(error));
			}
		}
	});

	/** GET/HEAD — download one file from the session's asset directory. */
	ctx.connection.fetch.register({
		path: DOWNLOAD_PATH,
		methods: ["GET", "HEAD"],
		requestBody: "buffered",
		fetch: async (request) => {
			try {
				const query = new URL(request.url).searchParams;
				const sessionId = query.get("sessionId");
				const name = query.get("name");
				const cwd = query.get("cwd") || undefined;
				if (!sessionId || !name || name !== baseName(name) || name === "." || name === "..") return text("bad asset name", 400);
				const dir = await assetsDirOf(root(), sessionId, cwd);
				if (dir === void 0) return text("session not found", 404);
				return await fileResponse(join(dir, name), request.method);
			} catch (error) {
				await log("error", `download route: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				return text("asset unavailable", failureStatus(error));
			}
		}
	});

	/** GET/HEAD — stream one readable file by path (preview drawer). */
	ctx.connection.fetch.register({
		path: FILE_PATH,
		methods: ["GET", "HEAD"],
		requestBody: "buffered",
		fetch: async (request) => {
			try {
				const query = new URL(request.url).searchParams;
				const sessionId = query.get("sessionId");
				const path = query.get("path");
				if (!sessionId || !path || path.includes("\0")) return text("bad file path", 400);
				// Read authority matches the preview itself (workspaceFiles reads
				// follow the composed filesystem, including outside the workspace);
				// the signed-cookie fence is the exposure boundary, as elsewhere.
				let workspaceRoot = ctx.sandboxPolicy?.workspaceRoot;
				try {
					workspaceRoot = ctx.sessions?.get(sessionId)?.header?.cwd ?? workspaceRoot;
				} catch {}
				const target = await ctx.fs.resolve(path, {
					cwd: typeof workspaceRoot === "string" && workspaceRoot !== "" ? workspaceRoot : void 0,
					signal: request.signal
				});
				return await fileResponse(ctx.fs.processPath(target), request.method);
			} catch (error) {
				await log("error", `file route: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				return text("file unavailable", failureStatus(error));
			}
		}
	});

	/** GET — the session's produced-file inventory for the Files tab. */
	ctx.connection.fetch.register({
		path: LIST_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: async (request) => {
			try {
				const query = new URL(request.url).searchParams;
				const sessionId = query.get("sessionId");
				if (!sessionId) return text("bad sessionId", 400);
				const cacheMs = Number.isFinite(config?.listCacheMs) && config.listCacheMs >= 0 ? config.listCacheMs : 10000;
				if (cacheMs > 0) {
					const hit = listCache.get(sessionId);
					if (hit !== void 0 && Date.now() - hit.at < cacheMs) return Response.json(hit.payload, { headers: { "cache-control": "no-store" } });
				}
				const items = [];
				const cwdHint = query.get("cwd") || undefined;
				const displayOf = (source, cwd) => {
					if (typeof source !== "string" || source === "") return "";
					if (typeof cwd === "string" && cwd !== "" && source.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`)) return source.slice(cwd.length + 1);
					return baseName(source);
				};

				// 1) ONE full-corpus observation. `SessionCorpus.load` (behind
				//    readSession/listEvents/readEvent) is uncached: every call
				//    re-loads and deep-clones the whole event log, so the former
				//    per-event readEvent loop was quadratic — ~80s on a 1.7MB
				//    session here, minutes on larger ones (pinning the event loop
				//    and taking the whole Web UI down). readSession pays that load
				//    exactly once; a failed replay degrades to presented-only.
				const started = Date.now();
				let events = [];
				let headerCwd;
				try {
					const full = await ctx.sessionQuery.readSession(sessionId);
					events = Array.isArray(full?.events) ? full.events : [];
					headerCwd = full?.session?.cwd;
				} catch (error) {
					await log("warn", `readSession for ${sessionId}: ${error instanceof Error ? error.message : String(error)}; presented-only fallback`);
					const records = await ctx.sessionQuery.listEvents(sessionId).catch(() => []);
					for (const record of records) {
						if (record?.type !== "deliverables/presented") continue;
						const read = await ctx.sessionQuery.readEvent({ sessionId, seq: record.seq, before: 0, after: 0 }, request.signal).catch(() => undefined);
						if (read?.target?.type === "deliverables/presented") events.push({
							...read.target,
							seq: record.seq
						});
					}
				}
				let cwd = typeof headerCwd === "string" && headerCwd !== "" ? headerCwd : cwdHint;

				// 2) Present events: back-fill asset copies, then collect them.
				const presented = [];
				for (let position = 0; position < events.length; position++) {
					const event = events[position];
					if (event?.type !== "deliverables/presented" || !isPresentedData(event.data)) continue;
					const seq = Number.isSafeInteger(event.seq) ? event.seq : position;
					await copyPresented(sessionId, cwd, event.data, seq).catch(async (error) => {
						await log("error", `list back-fill for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
					});
					for (let index = 0; index < event.data.files.length; index++) {
						const file = event.data.files[index];
						if (!isPresentedFile(file)) continue;
						presented.push({ seq, index, file });
					}
				}

				// 3) Asset directory: manifest entries plus any unmanaged files.
				const dir = await assetsDirOf(root(), sessionId, cwd);
				const manifestSources = new Set();
				if (dir !== void 0 && await isDirectory(dir)) {
					const manifest = await readManifest(dir);
					for (const entry of manifest.files) {
						if (typeof entry.source === "string" && entry.source !== "") manifestSources.add(entry.source);
						const info = await statOrUndefined(join(dir, entry.name));
						if (info === void 0 || !info.isFile()) continue;
						items.push({
							kind: "asset",
							name: entry.name,
							bytes: info.size,
							mtimeMs: Math.trunc(info.mtimeMs),
							seq: Number.isSafeInteger(entry.seq) ? entry.seq : null,
							index: Number.isSafeInteger(entry.index) ? entry.index : null,
							source: entry.source ?? null,
							display: displayOf(entry.source, cwd),
							description: entry.description ?? null,
							available: true
						});
					}
					for (const name of await readdir(dir).catch(() => [])) {
						if (name === MANIFEST_NAME || name.endsWith(".tmp")) continue;
						if (manifest.files.some((entry) => entry.name === name)) continue;
						const info = await statOrUndefined(join(dir, name));
						if (info === void 0 || !info.isFile()) continue;
						items.push({
							kind: "asset",
							name,
							bytes: info.size,
							mtimeMs: Math.trunc(info.mtimeMs),
							seq: null,
							index: null,
							source: null,
							display: name,
							description: null,
							available: true
						});
					}
				}

				// 4) Presented files with no surviving asset copy (vanished sources
				//    stay visible here, flagged unavailable).
				const presentedSources = new Set();
				for (const { seq, index, file } of presented) {
					const source = sourceOf(file, cwd);
					presentedSources.add(source);
					if (manifestSources.has(source)) continue;
					const info = await statOrUndefined(source);
					items.push({
						kind: "presented",
						name: baseName(source),
						bytes: info?.isFile() ? info.size : null,
						mtimeMs: info?.isFile() ? Math.trunc(info.mtimeMs) : null,
						seq,
						index,
						source,
						display: displayOf(source, cwd),
						description: file.description ?? null,
						available: info !== void 0 && info.isFile()
					});
				}

				// 5) Produced files: successful write/edit/str_replace_editor calls,
				//    derived durably from the same single event observation
				//    (tool/call + tool/result), never per-event reads.
				const producedBySource = new Map();
				const callPaths = new Map();
				for (let position = 0; position < events.length; position++) {
					const event = events[position];
					if (event?.type !== "tool/call" && event?.type !== "tool/result") continue;
					const seq = Number.isSafeInteger(event.seq) ? event.seq : position;
					const data = event.data;
					if (event.type === "tool/call") {
						if (typeof data?.callId === "string" && typeof data?.name === "string" && typeof data?.arguments === "string") callPaths.set(String(data.callId), mutationPath(data.name, data.arguments));
						continue;
					}
					if (!isRecord(data) || !isRecord(data.message) || data.message.isError === true) continue;
					const callId = data.message.source?.callId;
					if (typeof callId !== "string") continue;
					const argumentPath = callPaths.get(String(callId));
					if (argumentPath === null || argumentPath === void 0) continue;
					const path = mutationResultPath(argumentPath, data.meta);
					if (path === null) continue;
					producedBySource.set(path, seq);
				}
				const producedEntries = [...producedBySource].map(([path, seq]) => ({
					path,
					seq
				})).reverse();
				const producedSeen = new Set();
				for (const { path, seq } of producedEntries) {
					const source = isAbsolute(path) || typeof cwd !== "string" || cwd === "" ? path : join(cwd, path);
					if (producedSeen.has(source) || manifestSources.has(source) || presentedSources.has(source)) continue;
					producedSeen.add(source);
					const info = await statOrUndefined(source);
					const present = info !== void 0 && info.isFile();
					items.push({
						kind: "produced",
						name: baseName(source),
						bytes: present ? info.size : null,
						mtimeMs: present ? Math.trunc(info.mtimeMs) : null,
						seq,
						index: null,
						source,
						display: displayOf(source, cwd),
						description: null,
						available: present
					});
				}

				items.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
				const payload = {
					sessionId,
					cwd: cwd ?? null,
					items
				};
				const totalMs = Date.now() - started;
				if (totalMs > 500) await log("warn", `list ${sessionId}: ${totalMs}ms events=${events.length} items=${items.length}`);
				if (cacheMs > 0) listCache.set(sessionId, { at: Date.now(), payload });
				return Response.json(payload, { headers: { "cache-control": "no-store" } });
			} catch (error) {
				await log("error", `list route: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				return text("listing unavailable", failureStatus(error));
			}
		}
	});

	// Self-instrumentation: stdout/stderr of this deployment are discarded, so
	// record successful activation beside the package for debugging.
	Promise.resolve().then(async () => {
		await writeFile(join(PACKAGE_DIR, ".state.json"), JSON.stringify({
			loadedAt: new Date().toISOString(),
			config: config ?? {},
			sessionsRoot: sessionsRootOf(ctx, config),
			routes: [PRESENT_PATH, LIST_PATH, DOWNLOAD_PATH, FILE_PATH]
		}, null, "\t"), "utf8");
		await log("info", `applied; routes ${PRESENT_PATH} ${LIST_PATH} ${DOWNLOAD_PATH}`);
	}).catch(async (error) => {
		await log("error", `state write: ${error instanceof Error ? error.message : String(error)}`);
	});
}

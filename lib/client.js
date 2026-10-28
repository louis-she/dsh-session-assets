/**
 * dsh-session-assets — per-session file assets for DSH Web (browser half).
 *
 *   1. A download button on every `present` file card, registered into the
 *      `deliverables.file.actions` slot. It needs no file path: the card's
 *      `actionUrl` carries (sessionId, seq, index), which the host route
 *      `/api/session.assets.present` resolves to bytes. It therefore works
 *      even when no Host desktop is available (remote access), unlike the
 *      existing native-open control.
 *   2. A right-sidebar tab type (`session-assets`, titled 会话文件) listing
 *      everything this session produced — asset copies and presented files —
 *      each row downloadable. Reachable from the sidebar's guide panel
 *      (clicking a guide entry opens its kind directly).
 *
 * The bundle is hand-written in the `window.__ModuleLoader__` plugin format
 * and needs no build step; the host serves it from `exports["./client"]`.
 *
 * @module dsh-session-assets/lib/client
 */
window.__ModuleLoader__.load({
	id: "dsh-session-assets",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let P = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region routes (document-relative, authenticated by the signed cookie)
		const PRESENT_ROUTE = "/api/session.assets.present";
		const DOWNLOAD_ROUTE = "/api/session.assets.download";
		const LIST_ROUTE = "/api/session.assets.list";
		const FILE_ROUTE = "/api/session.assets.file";
		//#endregion

		//#region locale
		/** Locale namespace owned by this plugin. */
		const NS = "sessionAssets";
		/** Simplified-Chinese strings. */
		const zh = {
			"download.label": "下载",
			"download.failed": "下载失败：文件可能已被移走",
			"tab.title": "会话文件",
			"tab.guideTitle": "会话文件",
			"tab.guideDescription": "查看本会话生成的文件，逐个下载",
			"list.loading": "正在读取…",
			"list.count": "{count} 个文件",
			"list.empty": "本会话还没有生成文件。Agent 用 present 交付文件后会自动归档到这里。",
			"list.error": "读取失败",
			"list.retry": "重试",
			"list.refresh": "刷新",
			"row.download": "下载",
			"row.unavailable": "已不存在",
			"row.live": "未归档",
			"badge.produced": "已生成",
			"view.files": "文件"
		};
		/** English strings. */
		const en = {
			"download.label": "Download",
			"download.failed": "Download failed: the file may have been moved",
			"tab.title": "Session files",
			"tab.guideTitle": "Session files",
			"tab.guideDescription": "Browse and download the files this session produced",
			"list.loading": "Loading…",
			"list.count": "{count} files",
			"list.empty": "This session has not produced any file yet. Files delivered with present are archived here automatically.",
			"list.error": "Could not load the list",
			"list.retry": "Retry",
			"list.refresh": "Refresh",
			"row.download": "Download",
			"row.unavailable": "Gone",
			"row.live": "not archived",
			"badge.produced": "written",
			"view.files": "Files"
		};
		//#endregion

		//#region styles
		const css = ".dshSes_root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:12px;background:var(--dsw-alias-bg-layer-1)}.dshSes_header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}.dshSes_count{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dshSes_list{flex:1;min-height:0;overflow:auto;margin:0;padding:4px 0;list-style:none}.dshSes_row{display:flex;align-items:center;gap:8px;padding:6px 10px;min-width:0}.dshSes_row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshSes_icon{width:30px;height:30px;flex:none;display:grid;place-items:center;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in srgb, var(--dsw-static-neutral-00) 40%, transparent);color:var(--dsw-alias-link);overflow:hidden}.dshSes_main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.dshSes_name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:18px}.dshSes_meta{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;gap:6px;min-width:0}.dshSes_badge{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 4px;font-size:9px;line-height:13px}.dshSes_actions{flex:none;display:inline-flex;gap:2px;align-items:center}.dshSes_state{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}.dshSes_state[data-error=true],.dshSes_gone{color:var(--dshSes-error, var(--dsw-alias-state-error-primary));font-size:10px;white-space:nowrap}.dshSes_note{padding:6px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dshSes_error{padding:12px 10px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;color:var(--dsw-alias-state-error-primary);font-size:11px}.dshSes_empty{padding:16px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}.dshSes_row[data-off=true] .dshSes_name{color:var(--dsw-alias-label-tertiary)}@media (pointer:coarse){.dshSes_row{min-height:44px}}";
		const tagId = "dsh-session-assets/tab.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-assets";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region helpers
		/**
		* Parse the coordinate the deliverables card hands to its action slot
		* (`api/present.open?sessionId=…&seq=…&index=…`) back into its parts.
		* @param actionUrl - owner's action URL.
		* @returns the coordinate, or undefined when it is not one.
		*/
		function parsePresentUrl(actionUrl) {
			if (typeof actionUrl !== "string" || actionUrl === "") return void 0;
			try {
				const params = new URL(actionUrl, document.baseURI).searchParams;
				const sessionId = params.get("sessionId");
				const seq = params.get("seq");
				const index = params.get("index");
				if (!sessionId || !/^\d+$/u.test(seq ?? "") || !/^\d+$/u.test(index ?? "")) return void 0;
				return { sessionId, seq: Number(seq), index: Number(index) };
			} catch {
				return void 0;
			}
		}
		/** Hand one URL to the browser's download manager (cookie authenticates it). */
		function saveViaAnchor(url, filename) {
			const anchor = document.createElement("a");
			anchor.href = url;
			if (typeof filename === "string" && filename !== "") anchor.download = filename;
			anchor.rel = "noopener";
			anchor.click();
		}
		/** HEAD the route first so failures surface as a state, not a broken page. */
		async function probe(url, signal) {
			const response = await fetch(url, { method: "HEAD", signal, cache: "no-store" });
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(`HTTP ${response.status}${detail === "" ? "" : ` ${detail}`}`);
			}
			return response;
		}
		/** Human byte size for row metadata. */
		function formatBytes(bytes) {
			if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
			if (bytes < 1024) return `${bytes} B`;
			const units = ["KB", "MB", "GB", "TB"];
			let value = bytes / 1024;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
		}
		/** The download route for one inventory row. */
		function rowHref(item, sessionId) {
			if (item.kind === "asset") return `${DOWNLOAD_ROUTE}?${new URLSearchParams({ sessionId, name: String(item.name) })}`;
			if (item.kind === "produced") return typeof item.source === "string" && item.source !== "" ? `${FILE_ROUTE}?${new URLSearchParams({ sessionId, path: item.source })}` : "";
			return `${PRESENT_ROUTE}?${new URLSearchParams({ sessionId, seq: String(item.seq ?? 0), index: String(item.index ?? 0) })}`;
		}
		//#endregion

		//#region card download button
		/**
		* The download control on one presented-file card. Owner props are only
		* `{actionUrl, available, pending, onAction}`; `sessionId` and `t` come
		* from the session-scoped slot kit. `available` (Host desktop) is
		* deliberately ignored — downloads never need a desktop.
		* @param props - the action slot's owner props plus kit props.
		* @returns the compact download button.
		*/
		function CardDownload({ actionUrl, t }) {
			const [state, setState] = react.useState("idle");
			const onClick = async (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (state === "busy") return;
				const coords = parsePresentUrl(actionUrl);
				if (coords === void 0) {
					setState("error");
					return;
				}
				setState("busy");
				const url = `${PRESENT_ROUTE}?${new URLSearchParams({
					sessionId: coords.sessionId,
					seq: String(coords.seq),
					index: String(coords.index)
				})}`;
				try {
					await probe(url);
					saveViaAnchor(url);
					setState("idle");
				} catch (error) {
					console.error("session-assets: card download failed", error);
					setState("error");
				}
			};
			const failed = state === "error";
			return (0, react_jsx_runtime.jsx)(P.Button, {
				size: "sm",
				disabled: state === "busy",
				"aria-label": failed ? t("download.failed") : t("download.label"),
				"aria-busy": state === "busy" || void 0,
				title: failed ? t("download.failed") : t("download.label"),
				"data-state": state === "idle" ? void 0 : state,
				onClick,
				children: (0, react_jsx_runtime.jsx)(P.IconDownloadOutlineRegular, {})
			});
		}
		//#endregion

		//#region preview drawer download
		/**
		* Download control for the file-preview drawer. Owner props carry the
		* file's `absolutePath`; the host streams it confined to the session's
		* workspace through `/api/session.assets.file`. Registered in both the
		* previewable header actions and the "该格式文件暂时无法预览" empty state
		* (there with a text label beside the icon).
		* @param props - owner props ({absolutePath}) plus kit props and flags.
		* @returns the compact (or labeled) download control.
		*/
		function PreviewDownload({ absolutePath, sessionId, t, withLabel }) {
			const [state, setState] = react.useState("idle");
			const enabled = typeof absolutePath === "string" && absolutePath !== "";
			const onClick = async (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (state === "busy" || !enabled) return;
				setState("busy");
				const url = `${FILE_ROUTE}?${new URLSearchParams({
					sessionId: typeof sessionId === "string" ? sessionId : "",
					path: absolutePath
				})}`;
				try {
					await probe(url);
					saveViaAnchor(url, baseNameOf(absolutePath));
					setState("idle");
				} catch (error) {
					console.error("session-assets: preview download failed", error);
					setState("error");
				}
			};
			const failed = state === "error";
			const icon = (0, react_jsx_runtime.jsx)(P.IconDownloadOutlineRegular, {});
			return (0, react_jsx_runtime.jsx)(P.Button, {
				size: "sm",
				disabled: state === "busy" || !enabled,
				"aria-label": failed ? t("download.failed") : t("download.label"),
				"aria-busy": state === "busy" || void 0,
				title: failed ? t("download.failed") : t("download.label"),
				"data-state": state === "idle" ? void 0 : state,
				onClick,
				children: withLabel === true ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
					children: [icon, (0, react_jsx_runtime.jsx)("span", {
						style: { marginInlineStart: "4px" },
						children: failed ? t("download.failed") : t("download.label")
					})]
				}) : icon
			});
		}
		/** Final path segment, browser-side. */
		function baseNameOf(path) {
			const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
			return at === -1 ? path : path.slice(at + 1);
		}
		//#endregion

		//#region files tab
		/** One inventory row: icon, name, metadata, and its own download control. */
		function AssetRow({ item, sessionId, t }) {
			const [state, setState] = react.useState("idle");
			const gone = item.available === false;
			const onClick = async () => {
				if (state === "busy" || gone) return;
				setState("busy");
				const href = rowHref(item, sessionId);
				try {
					await probe(href);
					saveViaAnchor(href, item.name);
					setState("idle");
				} catch (error) {
					console.error("session-assets: row download failed", error);
					setState("error");
				}
			};
			const meta = [];
			const size = formatBytes(item.bytes);
			if (size !== "") meta.push(size);
			if (typeof item.description === "string" && item.description !== "") meta.push(item.description);
			const failed = state === "error";
			return (0, react_jsx_runtime.jsxs)("li", {
				className: "dshSes_row",
				"data-off": gone ? "true" : void 0,
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: "dshSes_icon",
					children: (0, react_jsx_runtime.jsx)(P.FileTypeIcon, {
						path: item.name,
						size: 16
					})
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: "dshSes_main",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "dshSes_name",
						title: typeof item.source === "string" && item.source !== "" ? item.source : item.name,
						children: item.display && item.display !== item.name ? item.display : item.name
					}), meta.length > 0 && (0, react_jsx_runtime.jsxs)("span", {
						className: "dshSes_meta",
						children: [meta.map((entry, at) => (0, react_jsx_runtime.jsx)("span", {
							children: entry
						}, at)), !gone && item.kind !== "asset" && (0, react_jsx_runtime.jsx)("span", {
							className: "dshSes_badge",
							children: t(item.kind === "presented" ? "row.live" : "badge.produced")
						})]
					})]
				}), (0, react_jsx_runtime.jsxs)("span", {
					className: "dshSes_actions",
					children: [failed && (0, react_jsx_runtime.jsx)("span", {
						className: "dshSes_state",
						"data-error": true,
						children: t("download.failed")
					}), gone ? (0, react_jsx_runtime.jsx)("span", {
						className: "dshSes_gone",
						children: t("row.unavailable")
					}) : (0, react_jsx_runtime.jsx)(P.Button, {
						size: "sm",
						disabled: state === "busy",
						"aria-label": t("row.download"),
						"aria-busy": state === "busy" || void 0,
						title: t("row.download"),
						onClick,
						children: (0, react_jsx_runtime.jsx)(P.IconDownloadOutlineRegular, {})
					})]
				})]
			});
		}
		/**
		* The tab body: everything this session produced, newest first.
		* `sessionId` comes from the session-scoped kit; `loadList` from the
		* registration's inject face.
		* @param props - kit props plus the injected list loader.
		* @returns the inventory panel.
		*/
		function AssetsTab({ sessionId, t, loadList }) {
			const [view, setView] = react.useState({ status: "loading", items: [] });
			const reload = react.useCallback(() => {
				let cancelled = false;
				setView((previous) => ({ status: "loading", items: previous.items }));
				Promise.resolve().then(() => loadList(sessionId)).then((items) => {
					if (!cancelled) setView({ status: "ready", items });
				}).catch((error) => {
					console.error("session-assets: list failed", error);
					if (!cancelled) setView({ status: "error", items: [], error: String(error?.message ?? error) });
				});
				return () => {
					cancelled = true;
				};
			}, [
				loadList,
				sessionId
			]);
			react.useEffect(() => reload(), [reload]);
			const items = view.status === "error" ? [] : view.items;
			const header = view.status === "loading" ? t("list.loading") : t("list.count", { count: String(items.length) });
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshSes_root",
				"data-session-assets": true,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: "dshSes_header",
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: "dshSes_count",
						children: header
					}), (0, react_jsx_runtime.jsx)(P.Button, {
						size: "sm",
						disabled: view.status === "loading",
						onClick: reload,
						children: t("list.refresh")
					})]
				}), view.status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
					className: "dshSes_error",
					children: [(0, react_jsx_runtime.jsx)("span", {
						children: `${t("list.error")}: ${view.error ?? ""}`
					}), (0, react_jsx_runtime.jsx)(P.Button, {
						size: "sm",
						onClick: reload,
						children: t("list.retry")
					})]
				}) : items.length === 0 && view.status !== "loading" ? (0, react_jsx_runtime.jsx)("div", {
					className: "dshSes_empty",
					children: t("list.empty")
				}) : (0, react_jsx_runtime.jsx)("ul", {
					className: "dshSes_list",
					children: items.map((item, at) => (0, react_jsx_runtime.jsx)(AssetRow, {
						item,
						sessionId,
						t
					}, `${String(at)}:${item.kind}:${String(item.seq)}:${String(item.index)}:${item.name}`))
				})]
			});
		}
		//#endregion

		//#region tab type
		/** The tab kind this package owns. */
		const ASSETS_KIND = "session-assets";
		/** This implementation's identity, and the key its body registers under. */
		const ASSETS_ID = "dsh-session-assets";
		/** Address prefix for opening the tab through `sidebarRight.openResource`. */
		const ASSETS_ADDRESS = "dsh-resource://session-assets/session/";
		/** The tab's address for one session. */
		function assetsAddress(sessionId) {
			return `${ASSETS_ADDRESS}${encodeURIComponent(sessionId)}`;
		}
		/** @returns the sessionId an address names, or undefined when it is not ours. */
		function parseAssetsAddress(address) {
			if (typeof address !== "string" || !address.startsWith(ASSETS_ADDRESS)) return void 0;
			const sessionId = decodeURIComponent(address.slice(ASSETS_ADDRESS.length));
			return sessionId === "" ? void 0 : { sessionId };
		}
		/**
		* The tab type: claim our address space and appear in the sidebar guide
		* (guide entries open their kind directly on click).
		* @param t - bound dictionary.
		* @returns the tab definition.
		*/
		function assetsDefinition(t) {
			return {
				id: ASSETS_ID,
				kind: ASSETS_KIND,
				patterns: ["dsh-resource://session-assets/**"],
				priority: "extension",
				canOpen: (address) => parseAssetsAddress(address) !== void 0,
				title: () => t("tab.title"),
				guide: [{
					id: "session-files",
					order: 11,
					title: () => t("tab.guideTitle"),
					description: () => t("tab.guideDescription")
				}]
			};
		}
		//#endregion

		/** Required browser services. */
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs"
		];
		/**
		* Client plugin body: dictionaries, the card download button, the tab
		* type, and the tab body.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "session-assets: dictionaries");
			const t = ctx.locale.bind(NS);
			/** The session's produced-file inventory (shared by the sidebar tab and the Files view). */
			const loadList = async (sessionId) => {
				const response = await fetch(`${LIST_ROUTE}?${new URLSearchParams({ sessionId })}`, {
					cache: "no-store"
				});
				if (!response.ok) {
					const detail = await response.text().catch(() => "");
					throw new Error(`HTTP ${response.status}${detail === "" ? "" : ` ${detail}`}`);
				}
				const payload = await response.json();
				return Array.isArray(payload?.items) ? payload.items : [];
			};

			// (a) download button on every presented-file card
			ctx.effect(() => ctx.slots.inject("deliverables.file.actions", () => ctx.slots.register({
				name: "deliverables.file.actions",
				id: `${ASSETS_ID}/download`,
				locale: NS
			}, CardDownload)), "session-assets: card download");

			// (a2) download in the preview drawer: previewable header actions …
			ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document.actions", () => ctx.slots.register({
				name: "sidebar.right.tab.document.actions",
				id: `${ASSETS_ID}/preview`,
				locale: NS
			}, PreviewDownload)), "session-assets: preview download");

			// … and the "该格式文件暂时无法预览" empty state (with a text label)
			ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document.unpreviewable", () => ctx.slots.register({
				name: "sidebar.right.tab.document.unpreviewable",
				id: `${ASSETS_ID}/preview`,
				locale: NS,
				inject: () => ({ withLabel: true })
			}, PreviewDownload)), "session-assets: unpreviewable download");

			// (b) the 会话文件 tab type (guide entry included) …
			ctx.effect(() => ctx.sidebarRightTabs.register(assetsDefinition(t)), "session-assets: assets type");

			// … and its body behind the keyed seat …
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: ASSETS_ID,
				locale: NS,
				inject: () => ({ loadList })
			}, AssetsTab)), "session-assets: assets body");

			// (c) 「文件」 view beside 对话/轨迹 in the main conversation area.
			// Fresh id (never reuse "chat"/"trajectory"); mount == tab activated,
			// so AssetsTab's effect lazily loads the inventory on open.
			ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "session-files",
				order: 20,
				locale: NS,
				label: () => t("view.files"),
				inject: () => ({ loadList })
			}, AssetsTab)), "session-assets: conversation files view");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

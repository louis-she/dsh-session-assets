/**
 * Browser-half logic test for dsh-session-assets, no browser required.
 * Loads the shipped client bundle with stubbed react/DOM/module-loader,
 * runs `apply` against a mock context, then exercises the registration
 * factories, the tab definition, and the component code paths (including
 * the card button's async click → HEAD probe → anchor download).
 * Run: node test/client-smoke.mjs
 */
import assert from "node:assert";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

//#region DOM / fetch stubs
const anchors = [];
globalThis.document = {
	baseURI: "http://localhost/",
	querySelector: () => null,
	createElement: (tag) => {
		const element = {
			tag,
			dataset: {},
			href: "",
			download: "",
			rel: "",
			click() {
				if (tag === "a") anchors.push({ href: this.href, download: this.download });
			}
		};
		return element;
	},
	head: { appendChild() {} }
};
globalThis.window = globalThis;
const fetchCalls = [];
let fetchPlan = [];
globalThis.fetch = async (url, options) => {
	fetchCalls.push({ url: String(url), method: options?.method ?? "GET" });
	const next = fetchPlan.shift() ?? { ok: true, status: 200, items: [] };
	return {
		ok: next.ok,
		status: next.status,
		body: null,
		text: async () => next.detail ?? "",
		json: async () => ({ items: next.items ?? [] })
	};
};
//#endregion

//#region react stubs (drive hooks deterministically)
let hookIndex = 0;
let hookStates = [];
const effects = [];
function resetHooks() {
	hookIndex = 0;
	hookStates = [];
	effects.length = 0;
}
const reactStub = {
	useState(initial) {
		const at = hookIndex++;
		if (!(at in hookStates)) hookStates[at] = initial;
		const setter = (value) => {
			hookStates[at] = typeof value === "function" ? value(hookStates[at]) : value;
		};
		return [hookStates[at], setter];
	},
	useCallback(fn) {
		hookIndex++;
		return fn;
	},
	useEffect(fn) {
		hookIndex++;
		effects.push(fn);
	},
	Fragment: Symbol("Fragment")
};
const elements = [];
const jsxRuntimeStub = {
	Fragment: reactStub.Fragment,
	jsx: (type, props) => {
		const element = { type, props: props ?? {} };
		elements.push(element);
		return element;
	},
	jsxs: (type, props) => jsxRuntimeStub.jsx(type, props)
};
const primitivesStub = {
	Button: "Button",
	IconDownloadOutlineRegular: "IconDownload",
	FileTypeIcon: "FileTypeIcon",
	PathLabel: "PathLabel"
};
//#endregion

//#region module loader capture
let captured;
globalThis.__ModuleLoader__ = {
	load(descriptor) {
		captured = descriptor;
	}
};
await import(pathToFileURL(join(PACKAGE_DIR, "lib", "client.js")).href);
assert.ok(captured, "bundle must call __ModuleLoader__.load");
const moduleExports = captured.factory((specifier) => {
	if (specifier === "react") return reactStub;
	if (specifier === "react/jsx-runtime") return jsxRuntimeStub;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
	throw new Error(`unexpected require: ${specifier}`);
});
assert.deepEqual(Object.keys(moduleExports).sort(), ["apply", "inject"]);
assert.ok(moduleExports.inject.includes("slots"));
assert.ok(moduleExports.inject.includes("locale"));
assert.ok(moduleExports.inject.includes("sidebarRightTabs"));

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`ok ${passed} - ${label}`);
};

//#region mock ctx + apply
const localeRegistrations = [];
const slotInjections = [];
const tabRegistrations = [];
const ctx = {
	effect(fn, label) {
		const dispose = fn();
		return typeof dispose === "function" ? dispose : () => {};
	},
	locale: {
		register(ns, dicts) {
			localeRegistrations.push({ ns, dicts });
			return () => {};
		},
		bind(ns) {
			return (key, params) => {
				const dict = localeRegistrations.find((entry) => entry.ns === ns)?.dicts.zh ?? {};
				const template = dict[key] ?? key;
				return params === void 0 ? template : template.replace(/\{(\w+)\}/gu, (all, name) => params[name] ?? all);
			};
		}
	},
	slots: {
		inject(name, factory) {
			slotInjections.push({ name, factory });
			return () => {};
		},
		register(options, component) {
			return { options, component };
		}
	},
	sidebarRightTabs: {
		register(definition) {
			tabRegistrations.push(definition);
			return () => {};
		}
	}
};
moduleExports.apply(ctx);
ok("apply runs against a mock context");

assert.equal(localeRegistrations.length, 1);
assert.equal(localeRegistrations[0].ns, "sessionAssets");
assert.ok(localeRegistrations[0].dicts.zh["tab.title"] && localeRegistrations[0].dicts.en["tab.title"]);
ok("locale dictionary registered (zh + en)");

const fileActions = slotInjections.find((entry) => entry.name === "deliverables.file.actions");
assert.ok(fileActions, "deliverables.file.actions injection present");
const cardEntry = fileActions.factory();
assert.equal(cardEntry.options.id, "dsh-session-assets/download");
assert.equal(cardEntry.options.name, "deliverables.file.actions");
assert.equal(typeof cardEntry.component, "function");
ok("card download registered into deliverables.file.actions");

const definition = tabRegistrations[0];
assert.equal(definition.id, "dsh-session-assets");
assert.equal(definition.kind, "session-assets");
assert.deepEqual(definition.patterns, ["dsh-resource://session-assets/**"]);
assert.equal(definition.canOpen("dsh-resource://session-assets/session/abc%20d") !== void 0, true);
assert.equal(definition.canOpen("dsh-resource://other/x"), false);
assert.equal(typeof definition.title(), "string");
assert.equal(definition.guide.length, 1);
assert.equal(typeof definition.guide[0].title(), "string");
assert.equal(typeof definition.guide[0].description(), "string");
ok("tab type registered: kind/id/patterns/canOpen/guide");

const tabBody = slotInjections.find((entry) => entry.name === "sidebar.right.pane.tab");
assert.ok(tabBody, "sidebar.right.pane.tab injection present");
const tabEntry = tabBody.factory();
assert.equal(tabEntry.options.key, definition.id, "body key must equal definition.id");
assert.equal(tabEntry.component.name, "AssetsTab");
ok("tab body registered under the definition's key");
//#endregion

//#region loadList wiring
const injected = tabEntry.options.inject();
assert.equal(typeof injected.loadList, "function");
fetchPlan = [{ ok: true, items: [{ name: "a.txt", kind: "asset", bytes: 3, mtimeMs: 1, seq: 5, index: 0, available: true }] }];
const listed = await injected.loadList("sess-x");
assert.equal(listed.length, 1);
assert.ok(fetchCalls.at(-1).url.startsWith("/api/session.assets.list?"));
assert.ok(fetchCalls.at(-1).url.includes("sessionId=sess-x"));
fetchPlan = [{ ok: false, status: 500, detail: "boom" }];
await assert.rejects(() => injected.loadList("sess-x"), /HTTP 500/);
ok("loadList hits /api/session.assets.list and surfaces failures");
//#endregion

//#region CardDownload component
resetHooks();
elements.length = 0;
const t = ctx.locale.bind("sessionAssets");
const validUrl = "api/present.open?sessionId=sess-x&seq=12&index=3";
let render = cardEntry.component({ actionUrl: validUrl, t });
assert.equal(render.type, "Button");
assert.equal(render.props["aria-label"], "下载");
anchors.length = 0;
fetchPlan = [{ ok: true }];
await render.props.onClick({ preventDefault() {}, stopPropagation() {} });
assert.equal(fetchCalls.at(-1).method, "HEAD");
assert.ok(fetchCalls.at(-1).url.startsWith("/api/session.assets.present?"));
assert.equal(anchors.length, 1);
assert.ok(anchors[0].href.includes("sessionId=sess-x"));
assert.ok(anchors[0].href.includes("seq=12"));
assert.ok(anchors[0].href.includes("index=3"));
ok("card button: HEAD probe then anchor download with parsed coordinates");

resetHooks();
elements.length = 0;
render = cardEntry.component({ actionUrl: "not-a-coordinate", t });
anchors.length = 0;
fetchPlan = [];
await render.props.onClick({ preventDefault() {}, stopPropagation() {} });
assert.equal(anchors.length, 0, "no anchor for a bad coordinate");
assert.notEqual(hookStates[0], "busy");
ok("card button: unparseable actionUrl never downloads");

resetHooks();
render = cardEntry.component({ actionUrl: validUrl, t });
fetchPlan = [{ ok: false, status: 404, detail: "presented file not found" }];
await render.props.onClick({ preventDefault() {}, stopPropagation() {} });
assert.equal(hookStates[0], "error", "failed probe lands in the error state");
ok("card button: failed probe lands in the error state");
//#endregion

//#region AssetsTab + AssetRow
resetHooks();
elements.length = 0;
const rows = [];
fetchPlan = [{ ok: true, items: [
	{ name: "报表.xlsx", display: "报表.xlsx", kind: "asset", bytes: 2048, mtimeMs: 2, seq: 9, index: 0, description: "季度报表", available: true },
	{ name: "gone.pdf", display: "gone.pdf", kind: "presented", bytes: null, mtimeMs: 0, seq: 8, index: 1, available: false }
] }];
const tabRender = tabEntry.component({ sessionId: "sess-x", t, loadList: injected.loadList });
assert.equal(tabRender.type, "div");
assert.equal(tabRender.props["data-session-assets"], true);
assert.equal(effects.length, 1);
const cleanup = effects[0]();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(hookStates[0].status, "ready");
assert.equal(hookStates[0].items.length, 2);
cleanup?.();
ok("tab: effect loads the list through loadList");

resetHooks();
elements.length = 0;
const rowAvailable = tabEntry.component;
// Render the row component through the tab's element tree.
const rowElement = (() => {
	// Find AssetRow by rendering rows via the recorded jsx calls of a fresh AssetsTab render.
	resetHooks();
	hookStates[0] = { status: "ready", items: [
		{ name: "报表.xlsx", display: "报表.xlsx", kind: "asset", bytes: 2048, mtimeMs: 2, seq: 9, index: 0, description: "季度报表", available: true },
		{ name: "gone.pdf", display: "gone.pdf", kind: "presented", bytes: null, mtimeMs: 0, seq: 8, index: 1, available: false }
	] };
	elements.length = 0;
	tabEntry.component({ sessionId: "sess-x", t, loadList: injected.loadList });
	const listElement = elements.find((element) => element.type === "ul");
	assert.ok(listElement, "list element rendered when ready");
	assert.equal(listElement.props.children.length, 2);
	return listElement.props.children;
})();
const [assetRow, goneRow] = rowElement;
assert.equal(assetRow.type.name, "AssetRow");
// Component references are closed over; re-render each row through the tab's children by
// invoking them directly with the props the tab passed.
const real = (children) => children.filter((child) => child !== false && child !== null && typeof child === "object");
const assetInstance = assetRow.type(assetRow.props);
const goneInstance = goneRow.type(goneRow.props);
const assetActions = real(assetInstance.props.children[2].props.children);
const goneActions = real(goneInstance.props.children[2].props.children);
assert.ok(assetActions.some((child) => child.type === "Button"), "available row offers a download button");
assert.equal(goneActions[0].type, "span");
assert.equal(goneActions[0].props.children, "已不存在");
ok("rows: available row shows a download button, vanished row shows 已不存在");

resetHooks();
elements.length = 0;
const goneRowElement = (() => {
	resetHooks();
	hookStates[0] = { status: "ready", items: [{ name: "gone.pdf", kind: "presented", bytes: null, mtimeMs: 0, seq: 8, index: 1, display: "gone.pdf", available: false }] };
	elements.length = 0;
	tabEntry.component({ sessionId: "sess-x", t, loadList: injected.loadList });
	return elements.find((element) => element.type === "ul").props.children[0];
})();
const goneButtonRow = goneRowElement.type(goneRowElement.props);
assert.ok(!real(goneButtonRow.props.children[2].props.children).some((child) => child.type === "Button"), "gone row must not offer a button");
ok("gone row offers no download button");
//#endregion

//#region preview drawer download
const actionsSlot = slotInjections.find((entry) => entry.name === "sidebar.right.tab.document.actions");
const unpreviewSlot = slotInjections.find((entry) => entry.name === "sidebar.right.tab.document.unpreviewable");
assert.ok(actionsSlot, "sidebar.right.tab.document.actions injection present");
assert.ok(unpreviewSlot, "sidebar.right.tab.document.unpreviewable injection present");
const previewEntry = actionsSlot.factory();
const emptyPreviewEntry = unpreviewSlot.factory();
assert.equal(previewEntry.component.name, "PreviewDownload");
assert.equal(emptyPreviewEntry.component.name, "PreviewDownload");
assert.equal(previewEntry.options.inject, void 0);
assert.equal(emptyPreviewEntry.options.inject().withLabel, true);
ok("preview drawer: download registered in previewable actions and unpreviewable empty state");

resetHooks();
elements.length = 0;
anchors.length = 0;
let preview = previewEntry.component({ absolutePath: "/w/report.pdf", sessionId: "sess-x", t });
assert.equal(preview.type, "Button");
fetchPlan = [{ ok: true }];
await preview.props.onClick({ preventDefault() {}, stopPropagation() {} });
assert.ok(fetchCalls.at(-1).url.startsWith("/api/session.assets.file?"), fetchCalls.at(-1).url);
assert.ok(fetchCalls.at(-1).url.includes("path=%2Fw%2Freport.pdf"));
assert.equal(anchors.length, 1);
assert.ok(anchors[0].href.includes("sessionId=sess-x"));
ok("preview drawer: click probes then downloads by workspace path");

resetHooks();
preview = previewEntry.component({ absolutePath: void 0, sessionId: "sess-x", t });
assert.equal(preview.props.disabled, true);
anchors.length = 0;
fetchPlan = [];
await preview.props.onClick({ preventDefault() {}, stopPropagation() {} });
assert.equal(anchors.length, 0);
ok("preview drawer: missing path renders a disabled button");
//#endregion

//#region produced row download route
resetHooks();
elements.length = 0;
hookStates[0] = { status: "ready", items: [{ name: "made.txt", display: "made.txt", kind: "produced", bytes: 5, mtimeMs: 3, seq: 40, index: null, source: "/w/made.txt", available: true }] };
tabEntry.component({ sessionId: "sess-x", t, loadList: injected.loadList });
const producedRowElement = elements.find((element) => element.type === "ul").props.children[0];
const producedRow = producedRowElement.type(producedRowElement.props);
const producedButton = real(producedRow.props.children[2].props.children).find((child) => child.type === "Button");
assert.ok(producedButton, "produced row offers a download button");
const producedMeta = real(producedRow.props.children[1].props.children[1].props.children);
assert.ok(producedMeta.some((child) => child.type === "span" && child.props.children === "已生成"), "produced row shows the 已生成 badge");
anchors.length = 0;
fetchPlan = [{ ok: true }];
await producedButton.props.onClick();
assert.ok(fetchCalls.at(-1).url.startsWith("/api/session.assets.file?"), fetchCalls.at(-1).url);
assert.ok(fetchCalls.at(-1).url.includes("path=%2Fw%2Fmade.txt"));
assert.equal(anchors.length, 1);
ok("produced row downloads through the workspace file route (with 已生成 badge)");
//#endregion

//#region conversation view (main-area 文件 tab)
const viewInjection = slotInjections.find((entry) => entry.name === "conversation.view");
assert.ok(viewInjection, "conversation.view injection present");
const viewEntry = viewInjection.factory();
assert.equal(viewEntry.options.id, "session-files");
assert.equal(viewEntry.options.order, 20);
assert.equal(viewEntry.options.name, "conversation.view");
assert.equal(viewEntry.options.label(), "文件");
assert.equal(viewEntry.component.name, "AssetsTab");
const viewInjected = viewEntry.options.inject();
fetchPlan = [{ ok: true, items: [{ name: "v.txt", kind: "produced", bytes: 1, mtimeMs: 1, seq: 3, index: null, source: "/w/v.txt", available: true }] }];
const viewItems = await viewInjected.loadList("sess-v");
assert.equal(viewItems.length, 1);
assert.equal(viewEntry.options.inject().loadList, viewInjected.loadList, "view and sidebar share one loader");
ok("conversation view registered: id session-files, order 20, label 文件, shared loader");
//#endregion

console.log(`\n${passed} checks passed`);

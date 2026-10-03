import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { DEFAULT_ID, builtinPresets, composeSystem, fetchPresets, savePresets, openPresetModal } from "./lib/presets.js";
import { t } from "./lib/i18n.js";

const NODE_NAME = "LiveChatStream";
const LS_KEY = "live_chat_stream_settings";
const NODE_W = 560;
const UI_H = 560;
const LIVE_INTERVAL_MS = 900;

const instances = new Set();

// ---------- プリセット(サーバー保存・全ノードで共有) ----------
const store = { list: null, promise: null };

function ensurePresets() {
    store.promise ||= (async () => {
        let list = [];
        try { list = await fetchPresets(); } catch (e) { console.warn("[LiveChatStream] presets load failed:", e); }
        if (!list.length) {
            list = builtinPresets();
            try { await savePresets(list); } catch { /* 保存失敗でもメモリ上では使える */ }
        } else if (!list.some((p) => p.id === DEFAULT_ID)) {
            list = [builtinPresets()[0], ...list];
        }
        store.list = list;
        return list;
    })();
    return store.promise;
}

function activePreset(node) {
    const list = store.list || builtinPresets();
    return list.find((p) => p.id === node.properties?.presetId) || list.find((p) => p.id === DEFAULT_ID) || list[0];
}

function refreshPresetSelects() {
    for (const inst of instances) {
        const sel = inst._ui?.presetSel;
        if (!sel || !store.list) continue;
        sel.replaceChildren();
        for (const p of store.list) {
            const o = document.createElement("option");
            o.value = p.id;
            o.textContent = (p.type === "character" ? "👤 " : "") + p.name;
            sel.appendChild(o);
        }
        sel.value = activePreset(inst).id;
        inst._ui.updateSummaries?.();
    }
}

// ---------- settings (localStorage は失敗し得るので全て try/catch) ----------
function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
}
function saveSettings(patch) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); } catch { /* ignore */ }
}

// ---------- <prompt>/<negative> 抽出(ストリーミング途中の未閉じタグにも対応) ----------
function extractTags(text) {
    const out = { prompt: null, negative: null, mind: null, promptClosed: false, mindClosed: false };
    for (const tag of ["prompt", "negative", "mind"]) {
        const open = text.lastIndexOf(`<${tag}>`);
        if (open < 0) continue;
        const start = open + tag.length + 2;
        const close = text.indexOf(`</${tag}>`, start);
        let body = close < 0 ? text.slice(start).replace(/<\/?[a-z]*$/i, "") : text.slice(start, close);
        out[tag] = body.trim();
        if (tag === "prompt") out.promptClosed = close >= 0;
        if (tag === "mind") out.mindClosed = close >= 0;
    }
    return out;
}

function renderAssistant(el, text, thinking = "") {
    el.replaceChildren();
    if (thinking) {
        const t = document.createElement("div");
        t.className = "lcs-think";
        t.textContent = "💭 " + thinking;
        el.appendChild(t);
    }
    const parts = text.split(/(<prompt>[\s\S]*?(?:<\/prompt>|$)|<negative>[\s\S]*?(?:<\/negative>|$)|<mind>[\s\S]*?(?:<\/mind>|$))/);
    for (const part of parts) {
        if (!part) continue;
        const m = part.match(/^<(prompt|negative|mind)>([\s\S]*?)(?:<\/\1>)?$/);
        if (m) {
            const box = document.createElement("div");
            box.className = `lcs-tag lcs-tag-${m[1]}`;
            box.textContent = ({ prompt: "🎨 ", negative: "🚫 ", mind: "💭 " })[m[1]] + m[2].replace(/<\/?[a-z]*$/i, "").trim();
            el.appendChild(box);
        } else {
            const span = document.createElement("span");
            span.textContent = part;
            el.appendChild(span);
        }
    }
}

// ---------- 画像入力(socket)/ I2Iソース ----------
const imageInputLink = (node) => node.inputs?.find((i) => i.name === "image")?.link ?? null;
const imageOutputLinked = (node) => !!node.outputs?.find((o) => o.name === "image")?.links?.length;
const widgetValue = (node, name) => node.widgets?.find((w) => w.name === name)?.value;

// socketの画像をフロントで取得する。上流がLoad Image系ならそのファイル、それ以外は実行済みのサーバーキャッシュ。
async function getInputImage(node) {
    const linkId = imageInputLink(node);
    if (linkId == null) return null;
    const link = app.graph.links?.[linkId] ?? app.graph.links?.get?.(linkId);
    const origin = link && app.graph.getNodeById(link.origin_id);
    const w = origin?.widgets?.find((x) => x.name === "image" && typeof x.value === "string");
    if (w && /LoadImage/i.test(origin.type)) {
        const m = w.value.match(/\[(input|output|temp)\]\s*$/);
        const parts = w.value.replace(/\s*\[(input|output|temp)\]\s*$/, "").split("/");
        const filename = parts.pop();
        const q = new URLSearchParams({ filename, subfolder: parts.join("/"), type: m ? m[1] : "input" });
        const r = await fetch(api.apiURL(`/view?${q}`));
        if (r.ok) {
            const blob = await r.blob();
            return { b64: await blobToBase64(blob), type: blob.type || "image/png" };
        }
    }
    const r2 = await fetch(api.apiURL(`/live_chat_stream/input_image?node_id=${encodeURIComponent(node.id)}`));
    if (r2.ok) return { b64: await blobToBase64(await r2.blob()), type: "image/png" };
    return null;
}

// ---------- 系統B: 思考・返信そのものを画像プロンプトにする ----------
const stripThinkTags = (t) => t.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
const stripPromptBlocks = (t) => stripThinkTags(t)
    .replace(/<(prompt|negative|mind)>[\s\S]*?(<\/\1>|$)/gi, "")
    .replace(/<\/?[a-z]+>/gi, "").replace(/<\/?[a-z]*$/i, "");

// 長すぎると画像モデルのCLIPが破綻するので文字数を制限。思考は最新側(末尾)、返信は先頭を採用。
function buildPromptB(src, thinking, reply, maxChars, mind = "") {
    const th = thinking.replace(/\s+/g, " ").trim();
    const rp = stripPromptBlocks(reply).replace(/\s+/g, " ").trim();
    const head = (t) => (t.length > maxChars ? t.slice(0, maxChars) : t);
    const tail = (t) => (t.length > maxChars ? t.slice(-maxChars) : t);
    if (src === "reply") return head(rp);
    if (src === "mind") return head(mind.replace(/\s+/g, " ").trim());
    if (src === "both") return head(`${tail(th).slice(0, Math.floor(maxChars / 2))} ${rp}`.trim());
    return tail(th || rp); // thinking: 思考が無いモデルは返信にフォールバック
}

// ノードの出力スロット群から下流のPreview/Saveノードidを集める(どの画像が系統Aか判別する用)
function downstreamImageNodes(node, slots) {
    const found = new Set();
    const seen = new Set();
    const walk = (n, slot) => {
        const links = (slot == null ? n.outputs : [n.outputs?.[slot]]).flatMap((o) => o?.links || []);
        for (const id of links) {
            const l = app.graph.links?.[id] ?? app.graph.links?.get?.(id);
            const t = l && app.graph.getNodeById(l.target_id);
            if (!t || seen.has(t.id)) continue;
            seen.add(t.id);
            if (/Preview|Save/.test(t.type)) found.add(String(t.id));
            walk(t, null);
        }
    };
    for (const sl of slots) walk(node, sl);
    return found;
}

// ---------- 生成キュー(1つ実行中なら保留して直列化) ----------
function setWidget(node, name, value) {
    const w = node.widgets?.find((x) => x.name === name);
    if (!w || w.value === value) return;
    w.value = value;
    w.callback?.(value);
    app.graph.setDirtyCanvas(true, true);
    const ui = node._ui;
    const area = ui?.promptAreas?.[name];
    if (area && area.value !== value) area.value = value;
    if (area) ui.updateSummaries?.();
}

function queueGen(inst, final) {
    const g = inst._gen;
    if (g.inflight) {
        g.pending = true;
        g.pendingFinal = g.pendingFinal || final;
        return;
    }
    runGen(inst, final);
}

// 生成開始前にOllamaのモデルをアンロードして空きVRAMを作る(失敗しても生成は止めない)
async function prepareVram(inst) {
    const ui = inst._ui;
    const mode = ui?.vramSel.value;
    if (!ui || !mode || mode === "off") return;
    ui.setStatus(t("freeingVram"));
    try {
        // ストリーミング中のチャットモデルはアンロードできない(応答が途切れる)ので除外
        const exclude = inst._streamModel ? [inst._streamModel] : [];
        const res = await fetch(api.apiURL("/live_chat_stream/vram_prepare"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode, target_gb: parseFloat(ui.vramGb.value) || 8, exclude }),
        });
        const d = await res.json();
        if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
        const gb = (mb) => (mb / 1024).toFixed(1);
        if (d.unloaded.length) {
            ui.addNote(t("vramUnloaded", { names: d.unloaded.map((u) => u.name).join(", "), a: gb(d.free_before_mb), b: gb(d.free_after_mb) }));
        }
        if (mode === "auto" && !d.reached) {
            const note = d.skipped_in_use.length
                ? t("vramShortInUse", { a: gb(d.free_after_mb), t: d.target_gb, names: d.skipped_in_use.join(", ") })
                : t("vramShort", { a: gb(d.free_after_mb), t: d.target_gb });
            if (inst._lastVramNote !== note) { inst._lastVramNote = note; ui.addNote(note); } // Liveモードで連投しない
        }
    } catch (e) {
        ui.addNote(t("vramFailed", { msg: e.message || e }));
    }
}

async function runGen(inst, final) {
    const g = inst._gen;
    g.inflight = true;
    g.pending = false;
    g.pendingFinal = false;
    g.judgeThis = final && !!inst._ui?.judgeChk.checked;
    g.images = {};
    g.aNodes = downstreamImageNodes(inst, [0, 1]);
    inst._ui?.setStatus(t("generating"));
    try {
        await prepareVram(inst);
        inst._ui?.setStatus(t("generating"));
        await app.queuePrompt(0, 1);
    } catch (e) {
        g.inflight = false;
        inst._ui?.setStatus(t("queueFailed", { msg: e.message || e }));
    }
}

function onGenEnd() {
    for (const inst of instances) {
        const g = inst._gen;
        if (!g.inflight) continue;
        g.inflight = false;
        inst._ui?.setStatus(t("ready"));
        // 判定は系統A(依頼どおりの画像)のみ。Aの出力先が特定できなければ最初の画像
        const imgs = Object.entries(g.images || {});
        const a = imgs.find(([id]) => g.aNodes?.has(id)) || (g.aNodes?.size ? null : imgs[0]);
        if (g.judgeThis && a) judgeImage(inst, a[1]).catch((e) => { inst._ui?.addNote(t("judgeFailed", { msg: e.message || e })); inst._ui?.setStatus(t("ready")); });
        if (g.pending) runGen(inst, g.pendingFinal);
    }
}

api.addEventListener("executed", ({ detail }) => {
    const img = detail?.output?.images?.[0];
    if (!img) return;
    for (const inst of instances) if (inst._gen.inflight) (inst._gen.images ||= {})[String(detail.node)] = img;
});
api.addEventListener("execution_success", onGenEnd);
api.addEventListener("execution_error", onGenEnd);
api.addEventListener("execution_interrupted", onGenEnd);

// ---------- 意思決定モデルによる生成画像の判定 ----------
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

async function judgeImage(inst, img) {
    const ui = inst._ui;
    const model = ui.vlaSel.value;
    if (!model) return;
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
    const blob = await (await fetch(api.apiURL(`/view?${q}`))).blob();
    const b64 = await blobToBase64(blob);
    ui.setStatus(t("judging"));
    const state = `User request: ${inst._lastUserText || ""}\nImage prompt used: ${inst._lastPrompt || ""}`;
    const body = JSON.stringify({
        model,
        state,
        images: [b64],
        questions: {
            match: { type: "noul", instructions: "Does the image match the user's request?" },
            quality: { type: "score", instructions: "Image quality (anatomy, artifacts)?", criteria: ["poor", "acceptable", "good"] },
        },
    });
    const call = async () => {
        const r = await fetch(api.apiURL("/live_chat_stream/decide"), { method: "POST", headers: { "Content-Type": "application/json" }, body });
        return [r, await r.json()];
    };
    let [res, data] = await call();
    if (res.status >= 500) {
        // 大きな決定モデルは、ComfyUIの生成直後だとVRAM競合でロードに失敗することがある → 少し待って1回だけ再試行
        ui.setStatus(t("judgeBusy"));
        await new Promise((r) => setTimeout(r, 4000));
        [res, data] = await call();
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const a = data.answers || {};
    const match = a.match?.noul;
    const quality = a.quality?.score;
    ui.addNote(t("judgeResult", {
        model,
        match: match != null ? Math.round(match * 100) + "%" : "-",
        quality: quality != null ? quality.toFixed(1) + "/2" : "-",
    }));
    ui.setStatus(t("ready"));
}

// ---------- UI ----------
function injectStyle() {
    if (document.getElementById("lcs-style")) return;
    const st = document.createElement("style");
    st.id = "lcs-style";
    st.textContent = `
.lcs{display:flex;flex-direction:column;gap:4px;width:100%;height:100%;box-sizing:border-box;font-size:12px;color:var(--fg-color,#ddd)}
.lcs select,.lcs input[type=text],.lcs textarea{background:var(--comfy-input-bg,#222);color:var(--input-text,#ddd);border:1px solid var(--border-color,#444);border-radius:4px;padding:2px 4px;font-size:12px;min-width:0}
.lcs button{background:var(--comfy-input-bg,#333);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:4px;padding:2px 8px;cursor:pointer}
.lcs button:disabled{opacity:.5;cursor:default}
.lcs-row{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.lcs-row label{display:flex;gap:3px;align-items:center}
.lcs-row select{flex:1}
.lcs-log{flex:1;min-height:80px;overflow-y:auto;border:1px solid var(--border-color,#444);border-radius:4px;padding:4px;display:flex;flex-direction:column;gap:4px;background:rgba(0,0,0,.15)}
.lcs-msg{padding:4px 6px;border-radius:6px;white-space:pre-wrap;word-break:break-word;max-width:92%;user-select:text}
.lcs-user{align-self:flex-end;background:#2b4a6f}
.lcs-assistant{align-self:flex-start;background:#3a3a3a}
.lcs-note{align-self:center;opacity:.8;font-size:11px}
.lcs-think{padding:3px 5px;margin:2px 0;border-radius:4px;opacity:.65;font-style:italic;max-height:90px;overflow-y:auto}
.lcs-tag{padding:3px 5px;margin:2px 0;border-radius:4px;font-family:monospace}
.lcs-tag-mind{background:#4a3a6a;font-style:italic}
.lcs-tag-prompt{background:#2f5d3a}.lcs-tag-negative{background:#5d2f2f}
.lcs-drop{border:1px dashed var(--border-color,#666);border-radius:6px;padding:4px 6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-height:26px;cursor:pointer;opacity:.85}
.lcs-drop.over{border-color:#4aa3ff;background:rgba(74,163,255,.15);opacity:1}
.lcs-drop-label{font-size:11px;opacity:.8}
.lcs-drop.locked{border-style:solid;border-color:#c9a227;opacity:.7;cursor:not-allowed}
.lcs-chip{display:inline-flex;gap:4px;align-items:center;font-size:11px;background:rgba(74,163,255,.2);border-radius:10px;padding:1px 6px}
.lcs-chip img{height:28px;border-radius:3px}.lcs-chip b{cursor:pointer;color:#f66}
.lcs-sec-h{display:flex;align-items:center;gap:6px;cursor:pointer;padding:3px 6px;border:1px solid var(--border-color,#444);border-radius:4px;background:rgba(255,255,255,.04);user-select:none}
.lcs-sec-h:hover{background:rgba(255,255,255,.08)}
.lcs-sec-h .arrow{width:10px;opacity:.8}.lcs-sec-h .title{font-weight:bold}
.lcs-sec-h .sum{flex:1;min-width:0;opacity:.65;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.lcs-sec-b{display:flex;flex-direction:column;gap:4px;padding:3px 1px}
.lcs-pgrid{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.lcs-pgrid label{font-size:10px;opacity:.7}
.lcs-pgrid textarea{height:56px;resize:vertical}
.lcs-genchk{display:flex;gap:3px;align-items:center;white-space:nowrap;cursor:pointer}
.lcs-bottom{display:flex;gap:8px;align-items:center}
.lcs-bottom .lcs-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lcs-unload{background:#5a2a2a!important}
.lcs-thumbs{display:flex;gap:4px;flex-wrap:wrap}
.lcs-thumbs span{position:relative}.lcs-thumbs img{height:40px;border-radius:4px}
.lcs-thumbs b{position:absolute;top:-4px;right:-4px;background:#c33;color:#fff;border-radius:50%;width:14px;height:14px;line-height:14px;text-align:center;cursor:pointer;font-size:10px}
.lcs-input{display:flex;gap:4px}.lcs-input textarea{flex:1;height:48px;resize:none}
.lcs-status{opacity:.7;font-size:11px;min-height:14px}
`;
    document.head.appendChild(st);
}

function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
}

function fillSelect(sel, items, saved, empty, preferSmallest = false) {
    sel.replaceChildren();
    if (!items.length) sel.appendChild(el("option", { value: "", textContent: empty }));
    for (const m of items) {
        sel.appendChild(el("option", { value: m.name, textContent: m.name }));
    }
    if (saved && items.some((m) => m.name === saved)) sel.value = saved;
    // 初回(保存された選択なし)は、重いモデルを既定にしないよう最小サイズを選ぶ(LLM/VLMのみ)
    else if (preferSmallest && items.length) sel.value = items.reduce((a, b) => ((b.size || Infinity) < (a.size || Infinity) ? b : a)).name;
}

function buildUI(node) {
    injectStyle();
    const s = loadSettings();
    const ui = { attach: [], abort: null };

    const fillOptions = (sel, pairs) => { for (const [v, k] of pairs) sel.appendChild(el("option", { value: v, textContent: t(k) })); };
    // Ollamaのアドレスはブラウザ(リクエスト)ではなくサーバー側の設定で決める
    ui.ollamaNote = el("span", { textContent: t("ollamaServerSetting"), title: t("ollamaServerSettingTitle"), style: "flex:1;opacity:.75" });
    ui.refreshBtn = el("button", { textContent: "⟳", title: t("reloadModels") });
    ui.llmSel = el("select", { title: t("llmTitle") });
    ui.vlmSel = el("select", { title: t("vlmTitle") });
    ui.vlaSel = el("select", { title: t("vlaTitle") });
    ui.modeSel = el("select", { title: t("modeTitle") });
    fillOptions(ui.modeSel, [["close", "modeClose"], ["live", "modeLive"], ["off", "modeManual"]]);
    ui.modeSel.value = s.mode || "close";
    ui.srcSel = el("select", { title: t("srcTitle") });
    fillOptions(ui.srcSel, [["tag", "srcTag"], ["response", "srcResponse"]]);
    ui.srcSel.value = s.source || "tag";
    ui.srcBSel = el("select", { title: t("srcBTitle") });
    fillOptions(ui.srcBSel, [["off", "srcBOff"], ["thinking", "srcBThinking"], ["reply", "srcBReply"], ["both", "srcBBoth"], ["mind", "srcBMind"]]);
    ui.srcBSel.value = s.srcB || "off";
    ui.mindEnChk = el("input", { type: "checkbox", checked: !!s.mindEn });
    ui.mindEnLabel = el("label", { title: t("mindEnTitle") }, ui.mindEnChk, t("mindEn"));
    ui.maxBInput = el("input", { type: "number", value: s.maxB || 400, min: 50, max: 2000, step: 50, style: "width:64px", title: t("maxBTitle") });
    ui.negBInput = el("input", { type: "text", value: s.negB ?? "lowres, bad anatomy, text, watermark", style: "flex:1", title: t("negBTitle") });
    ui.vramSel = el("select", { title: t("vramTitle") });
    fillOptions(ui.vramSel, [["off", "vramOff"], ["auto", "vramAuto"], ["all", "vramAll"]]);
    ui.vramSel.value = s.vramMode || "off";
    ui.vramGb = el("input", { type: "number", value: s.vramGb || 8, min: 0, max: 64, step: 0.5, style: "width:56px", title: t("vramGbTitle") });
    ui.judgeChk = el("input", { type: "checkbox", checked: !!s.judge });
    ui.thinkChk = el("input", { type: "checkbox", checked: !!s.think });
    // 画像生成のON/OFF(OFF=通常のチャット。画像プロンプトの指示・生成・VRAM調整を行わない)
    ui.genChk = el("input", { type: "checkbox", checked: s.gen !== false });
    ui.genLabel = el("label", { className: "lcs-genchk", title: t("genTitle") }, ui.genChk, t("genLabel"));
    ui.presetSel = el("select", { title: t("presetTitle") });
    ui.presetBtn = el("button", { textContent: t("presetsBtn"), title: t("presetsBtnTitle") });
    ui.clearBtn = el("button", { textContent: t("clear"), title: t("clearTitle") });
    ui.log = el("div", { className: "lcs-log" });
    ui.thumbs = el("div", { className: "lcs-thumbs" });
    ui.input = el("textarea", { placeholder: t("inputPlaceholder") });
    ui.attachBtn = el("button", { textContent: "📎", title: t("attachTitle") });
    ui.fileInput = el("input", { type: "file", accept: "image/*", multiple: true, style: "display:none" });
    ui.sendBtn = el("button", { textContent: t("send") });
    ui.status = el("div", { className: "lcs-status", textContent: t("ready") });
    ui.dropLabel = el("span", { className: "lcs-drop-label", textContent: t("dropIdle") });
    ui.srcChip = el("span", { className: "lcs-chip", style: "display:none" });
    ui.dropZone = el("div", { className: "lcs-drop", title: t("dropTitle") }, ui.dropLabel, ui.srcChip, ui.thumbs);
    ui.unloadBtn = el("button", { className: "lcs-unload", textContent: t("unload"), title: t("unloadTitle") });

    // 画像プロンプト欄(系統A/B)。ネイティブのウィジェットは隠し、値はこちらと双方向に同期する。
    ui.promptAreas = {};
    const pgrid = el("div", { className: "lcs-pgrid" });
    for (const [name, label] of [["prompt_text", "positive (A)"], ["negative_text", "negative (A)"], ["chat_p_text", "chat_p (B)"], ["chat_n_text", "chat_n (B)"]]) {
        const ta = el("textarea", { placeholder: label });
        ta.addEventListener("keydown", (e) => e.stopPropagation());
        ta.oninput = () => {
            const w = node.widgets?.find((x) => x.name === name);
            if (w) { w.value = ta.value; w.callback?.(ta.value); }
            ui.updateSummaries();
        };
        ui.promptAreas[name] = ta;
        pgrid.appendChild(el("div", {}, el("label", { textContent: label }), ta));
    }

    // 折りたたみセクション(状態は保存。既定は両方とも折りたたみ=チャットを主役に)
    const collapsed = { settings: true, prompt: true, ...(s.collapsed || {}) };
    const makeSection = (key, title, bodyKids) => {
        const arrow = el("span", { className: "arrow" });
        const sum = el("span", { className: "sum" });
        const head = el("div", { className: "lcs-sec-h", title: t("sectionToggle") }, arrow, el("span", { className: "title", textContent: title }), sum);
        const body = el("div", { className: "lcs-sec-b" }, ...bodyKids);
        const apply = () => { arrow.textContent = collapsed[key] ? "▸" : "▾"; body.style.display = collapsed[key] ? "none" : ""; };
        const grow = (dh) => {
            const min = node.computeSize()[1];
            node.setSize([node.size[0], Math.max(min, node.size[1] + dh)]);
            app.graph.setDirtyCanvas(true, true);
        };
        head.onclick = () => {
            if (collapsed[key]) {
                collapsed[key] = false; apply();
                requestAnimationFrame(() => grow(body.offsetHeight));
            } else {
                const h = body.offsetHeight;
                collapsed[key] = true; apply();
                grow(-h);
            }
            saveSettings({ collapsed: { ...collapsed } });
        };
        apply();
        return { head, body, sum };
    };
    const settingsSec = makeSection("settings", t("settings"), [
        el("div", { className: "lcs-row" }, el("span", { textContent: "Ollama" }), ui.ollamaNote, ui.refreshBtn),
        el("div", { className: "lcs-row" }, el("span", { textContent: "Preset" }), ui.presetSel, ui.presetBtn),
        el("div", { className: "lcs-row" }, el("span", { textContent: "LLM" }), ui.llmSel),
        el("div", { className: "lcs-row" }, el("span", { textContent: "VLM" }), ui.vlmSel),
        el("div", { className: "lcs-row" }, el("span", { textContent: "VLA" }), ui.vlaSel, el("label", {}, ui.judgeChk, t("judge"))),
        el("div", { className: "lcs-row" }, ui.srcSel, ui.modeSel, el("label", {}, ui.thinkChk, t("think"))),
        el("div", { className: "lcs-row" }, ui.srcBSel, ui.mindEnLabel, ui.maxBInput, ui.negBInput),
        el("div", { className: "lcs-row" }, ui.vramSel, ui.vramGb, el("span", { textContent: t("gbFree") })),
    ]);
    const promptSec = makeSection("prompt", t("promptSec"), [pgrid]);

    // 折りたたんでいても状況が分かるよう、見出しに要約を出す
    const cut = (t, n) => { t = (t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
    ui.updateSummaries = () => {
        const preset = ui.presetSel.selectedOptions[0]?.textContent || "";
        const vram = ui.vramSel.value !== "off" ? ` · VRAM:${ui.vramSel.value}` : "";
        const gen = ui.genChk.checked ? "" : " · 🖼OFF";
        settingsSec.sum.textContent = `${preset ? preset + " · " : ""}${ui.llmSel.value || "-"} / ${ui.vlmSel.value || "-"} / ${ui.vlaSel.value || "-"}${vram}${gen}`;
        const a = ui.promptAreas;
        promptSec.sum.textContent = a.prompt_text.value || a.chat_p_text.value
            ? `A: ${cut(a.prompt_text.value, 48) || "-"}  B: ${cut(a.chat_p_text.value, 32) || "-"}`
            : t("empty");
    };

    const wrap = el("div", { className: "lcs" },
        settingsSec.head, settingsSec.body,
        promptSec.head, promptSec.body,
        ui.log, ui.dropZone,
        el("div", { className: "lcs-input" }, ui.input, el("div", { style: "display:flex;flex-direction:column;gap:4px" }, ui.attachBtn, ui.sendBtn)),
        ui.fileInput,
        // 誤操作防止: 破壊的な操作(Unload)は Send と反対の左端に置く
        el("div", { className: "lcs-bottom" }, ui.unloadBtn, ui.status, ui.genLabel, ui.clearBtn),
    );
    ui.wrap = wrap;
    for (const sel of [ui.llmSel, ui.vlmSel, ui.vlaSel, ui.presetSel, ui.vramSel]) sel.addEventListener("change", () => ui.updateSummaries());
    ui.updateSummaries();

    ui.setStatus = (t) => { ui.status.textContent = t; };
    ui.scroll = () => { ui.log.scrollTop = ui.log.scrollHeight; };
    ui.addMsg = (role, text) => {
        const m = el("div", { className: `lcs-msg lcs-${role}` });
        if (role === "assistant") renderAssistant(m, text); else m.textContent = text;
        ui.log.appendChild(m);
        ui.scroll();
        return m;
    };
    ui.addNote = (text) => { ui.log.appendChild(el("div", { className: "lcs-msg lcs-note", textContent: text })); ui.scroll(); };

    ui.renderThumbs = () => {
        ui.thumbs.replaceChildren();
        ui.attach.forEach((a, i) => {
            const rm = el("b", { textContent: "×" });
            rm.onclick = () => { ui.attach.splice(i, 1); ui.renderThumbs(); };
            ui.thumbs.appendChild(el("span", {}, el("img", { src: `data:${a.type};base64,${a.b64}` }), rm));
        });
    };
    ui.imageLocked = () => imageInputLink(node) != null;

    // socket接続中は入力画像が優先(ドロップ/選択は受け付けない)。I2Iソースのチップも更新する。
    ui.updateImageState = () => {
        const linked = ui.imageLocked();
        ui.dropZone.classList.toggle("locked", linked);
        ui.dropLabel.textContent = linked
            ? t("dropLocked")
            : t("dropIdle");
        ui.thumbs.style.display = linked ? "none" : "";
        ui.srcChip.replaceChildren();
        const name = widgetValue(node, "input_image_name");
        if (linked || !name) { ui.srcChip.style.display = "none"; return; }
        const parts = name.split("/");
        const filename = parts.pop();
        const img = el("img", { src: api.apiURL(`/view?${new URLSearchParams({ filename, subfolder: parts.join("/"), type: "input" })}`) });
        const rm = el("b", { textContent: "×", title: t("i2iClear") });
        rm.onclick = (e) => { e.stopPropagation(); setWidget(node, "input_image_name", ""); ui.lastAttach = null; ui.updateImageState(); };
        ui.srcChip.append(img, el("span", { textContent: t("i2iSource") }), rm);
        ui.srcChip.style.display = "";
    };

    // ドロップ/選択した画像(最新の1枚)を inputへアップロードし、I2Iソースにする(出力 image に流れる)
    ui.uploadSource = async (att) => {
        const blob = await (await fetch(`data:${att.type};base64,${att.b64}`)).blob();
        const file = new File([blob], `lcs_${Date.now()}.${att.type.split("/")[1] || "png"}`, { type: att.type });
        const fd = new FormData();
        fd.append("image", file);
        fd.append("type", "input");
        fd.append("subfolder", "live_chat_stream");
        fd.append("overwrite", "true");
        const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
        const d = await res.json();
        setWidget(node, "input_image_name", d.subfolder ? `${d.subfolder}/${d.name}` : d.name);
        ui.updateImageState();
    };
    ui.syncSource = async () => {
        if (!ui.lastAttach || ui.imageLocked() || !imageOutputLinked(node)) return;
        try { await ui.uploadSource(ui.lastAttach); } catch (e) { ui.setStatus(t("i2iSourceErr", { msg: e.message || e })); }
    };

    ui.addFiles = async (files) => {
        if (ui.imageLocked()) { ui.setStatus(t("lockedDrop")); return; }
        let first = null;
        for (const f of files) {
            if (!f.type.startsWith("image/") || ui.attach.length >= 4) continue;
            const att = { type: f.type, b64: await blobToBase64(f) };
            ui.attach.push(att);
            first ||= att;
        }
        ui.renderThumbs();
        if (first) { ui.lastAttach = first; await ui.syncSource(); }
    };

    ui.loadModels = async () => {
        ui.setStatus(t("loadingModels"));
        try {
            const res = await fetch(api.apiURL("/live_chat_stream/models"));
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            const st = loadSettings();
            fillSelect(ui.llmSel, data.models.filter((m) => m.llm), st.llm, t("noLlmOpt"), true);
            fillSelect(ui.vlmSel, data.models.filter((m) => m.vlm), st.vlm, t("noVlmOpt"), true);
            fillSelect(ui.vlaSel, data.models.filter((m) => m.vla), st.vla, t("noDecisionOpt"));
            ui.setStatus(t("ollamaStatus", { version: data.version || "?", n: data.models.length }));
            ui.updateSummaries();
        } catch (e) {
            ui.setStatus(t("ollamaUnreachable", { msg: e.message || e }));
        }
    };

    ui.refreshBtn.onclick = ui.loadModels;
    ui.llmSel.onchange = () => saveSettings({ llm: ui.llmSel.value });
    ui.vlmSel.onchange = () => saveSettings({ vlm: ui.vlmSel.value });
    ui.vlaSel.onchange = () => saveSettings({ vla: ui.vlaSel.value });
    ui.modeSel.onchange = () => saveSettings({ mode: ui.modeSel.value });
    ui.srcBSel.onchange = () => saveSettings({ srcB: ui.srcBSel.value });
    ui.vramSel.onchange = () => saveSettings({ vramMode: ui.vramSel.value });
    ui.vramGb.onchange = () => saveSettings({ vramGb: parseFloat(ui.vramGb.value) || 8 });
    ui.maxBInput.onchange = () => saveSettings({ maxB: parseInt(ui.maxBInput.value, 10) || 400 });
    ui.negBInput.onchange = () => saveSettings({ negB: ui.negBInput.value });
    ui.srcSel.onchange = () => saveSettings({ source: ui.srcSel.value });
    ui.judgeChk.onchange = () => saveSettings({ judge: ui.judgeChk.checked });
    ui.thinkChk.onchange = () => saveSettings({ think: ui.thinkChk.checked });
    ui.mindEnChk.onchange = () => saveSettings({ mindEn: ui.mindEnChk.checked });
    ui.genChk.onchange = () => {
        saveSettings({ gen: ui.genChk.checked });
        ui.setStatus(t(ui.genChk.checked ? "genOn" : "genOff"));
        ui.updateSummaries();
    };
    ui.presetSel.onchange = () => {
        node.properties = node.properties || {};
        node.properties.presetId = ui.presetSel.value;
    };
    ui.presetBtn.onclick = async () => {
        try {
            await ensurePresets();
            const res = await openPresetModal({
                list: store.list,
                activeId: activePreset(node).id,
                ctx: { source: ui.srcSel.value, srcB: ui.srcBSel.value, images: true, mindEn: ui.mindEnChk.checked },
            });
            if (!res) return;
            await savePresets(res.list);
            store.list = res.list;
            if (res.useId) { node.properties = node.properties || {}; node.properties.presetId = res.useId; }
            refreshPresetSelects();
            ui.setStatus(t("presetsSaved", { n: res.list.length }));
        } catch (e) {
            ui.setStatus(t("presetsError", { msg: e.message || e }));
        }
    };
    const pickFile = () => {
        if (ui.imageLocked()) { ui.setStatus(t("lockedPick")); return; }
        ui.fileInput.click();
    };
    ui.attachBtn.onclick = pickFile;
    ui.dropZone.onclick = (e) => { if (e.target === ui.dropZone || e.target === ui.dropLabel) pickFile(); };
    // ComfyUI本体はドロップでワークフローを読み込むため、UI内のドロップは本体へ伝播させない
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    for (const ev of ["dragenter", "dragover"]) {
        wrap.addEventListener(ev, (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); e.stopPropagation();
            ui.dropZone.classList.add("over");
        });
    }
    wrap.addEventListener("dragleave", (e) => {
        if (!wrap.contains(e.relatedTarget)) ui.dropZone.classList.remove("over");
    });
    wrap.addEventListener("drop", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        ui.dropZone.classList.remove("over");
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
        if (files.length) ui.addFiles(files); else ui.setStatus(t("onlyImages"));
    });
    ui.unloadBtn.onclick = async () => {
        if (ui.abort) { ui.setStatus(t("streamingBusy")); return; }
        ui.unloadBtn.disabled = true;
        ui.setStatus(t("unloading"));
        try {
            const res = await fetch(api.apiURL("/live_chat_stream/unload"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            const names = data.unloaded.join(", ") || "-";
            const msg = data.unloaded.length || data.failed.length
                ? (data.failed.length ? t("unloadedFailed", { names, failed: data.failed.join(", ") }) : t("unloaded", { names }))
                : t("noneLoaded");
            ui.setStatus(msg);
        } catch (e) {
            ui.setStatus(t("unloadFailed", { msg: e.message || e }));
        } finally {
            ui.unloadBtn.disabled = false;
        }
    };
    ui.fileInput.onchange = async () => { await ui.addFiles(ui.fileInput.files); ui.fileInput.value = ""; };
    ui.input.addEventListener("paste", (e) => {
        const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
        if (files.length) { e.preventDefault(); ui.addFiles(files); }
    });
    ui.input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // ComfyUIのショートカットに奪われない
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendOrStop(node); }
    });
    ui.sendBtn.onclick = () => sendOrStop(node);
    ui.clearBtn.onclick = () => {
        node._chat = [];
        node.properties.chat = [];
        ui.log.replaceChildren();
    };
    return ui;
}

// ---------- 送信・ストリーミング ----------
function persistChat(node) {
    node.properties = node.properties || {};
    node.properties.chat = node._chat.slice(-60);
}

function sendOrStop(node) {
    const ui = node._ui;
    if (ui.abort) { ui.abort.abort(); return; }
    send(node).catch((e) => ui.setStatus(t("errorPrefix", { msg: e.message || e })));
}

async function send(node) {
    const ui = node._ui;
    const text = ui.input.value.trim();
    let images = ui.attach.map((a) => a.b64);
    const linked = imageInputLink(node) != null;
    // 画像入力(socket)が接続されていれば、ドロップ/選択画像より優先してVLMへ渡す
    const sock = linked ? await getInputImage(node).catch(() => null) : null;
    if (sock) images = [sock.b64];
    if (!text && !images.length) return;
    if (sock && ui.attach.length) ui.addNote(t("socketPriority"));
    else if (linked && !sock) ui.addNote(t("socketUnavailable"));
    const model = images.length ? ui.vlmSel.value : ui.llmSel.value;
    if (!model) { ui.setStatus(t(images.length ? "noVlm" : "noLlm")); return; }

    await ensurePresets();
    const preset = activePreset(node);
    if (preset.type === "character" && ui.srcSel.value === "response") {
        // キャラクターは <prompt> ブロック前提のため、画像プロンプトの取り方を切り替える
        ui.srcSel.value = "tag";
        saveSettings({ source: "tag" });
        ui.addNote(t("charSwitched"));
    }
    const genOn = ui.genChk.checked;
    const sys = composeSystem(preset, { source: ui.srcSel.value, srcB: ui.srcBSel.value, images: genOn, mindEn: ui.mindEnChk.checked });
    const userText = text || "(image)";
    const messages = [{ role: "system", content: sys }, ...node._chat.map((m) => ({ role: m.role, content: m.content }))];
    messages.push({ role: "user", content: userText, ...(images.length ? { images } : {}) });
    node._chat.push({ role: "user", content: userText });
    node._lastUserText = userText;
    ui.addMsg("user", images.length ? `📎×${images.length} ${userText}` : userText);
    ui.input.value = "";
    ui.attach = [];
    ui.renderThumbs();

    node._streamModel = model;
    const bubble = ui.addMsg("assistant", "");
    const ctrl = new AbortController();
    ui.abort = ctrl;
    ui.sendBtn.textContent = t("stop");
    ui.setStatus(t("streamingModel", { model }));

    const mode = genOn ? ui.modeSel.value : "off";
    const source = ui.srcSel.value;
    const srcB = genOn ? ui.srcBSel.value : "off";
    const maxB = Math.min(2000, Math.max(50, parseInt(ui.maxBInput.value, 10) || 400));
    const negB = ui.negBInput.value.trim();
    // 返信を待ってから生成するか(系統Bが返信を使う場合、返信は<prompt>の後に続くため)
    const waitEnd = srcB === "reply" || srcB === "both";
    const useThink = ui.thinkChk.checked || srcB === "thinking" || srcB === "both";
    const g = node._gen;
    let full = "";
    let thinkFull = "";
    let promptB = "";
    let genFiredForClose = false;
    let lastLive = 0;
    let lastLivePrompt = "";
    let finalPrompt = "";

    const onUpdate = () => {
        renderAssistant(bubble, full, thinkFull);
        ui.scroll();
        // response/thinking出力はストリーミング中も最新にする(生成は完了前に始まるため)
        setWidget(node, "response_text", full);
        setWidget(node, "thinking_text", thinkFull);
        if (!genOn) return; // 画像生成OFF: プロンプトの抽出も生成も行わない
        const tg = extractTags(full);
        if (srcB !== "off") {
            promptB = buildPromptB(srcB, thinkFull, full, maxB, tg.mind || "");
            if (promptB) {
                setWidget(node, "chat_p_text", promptB);
                setWidget(node, "chat_n_text", negB);
            }
        }
        let promptNow;
        let closed = false;
        if (source === "response") {
            // 応答全体をプロンプトにする: <think>とタグだけ除去
            promptNow = full.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
                .replace(/<\/?[a-z]+>/gi, "").replace(/<\/?[a-z]*$/i, "").trim();
        } else {
            if (tg.negative != null) setWidget(node, "negative_text", tg.negative);
            promptNow = tg.prompt;
            // mindをchat_pに使う場合は <mind> も閉じてから生成する(Bを欠かさないため)
            closed = tg.promptClosed && (srcB !== "mind" || tg.mindClosed);
        }
        if (!promptNow) return;
        setWidget(node, "prompt_text", promptNow);
        node._lastPrompt = promptNow;
        finalPrompt = promptNow;
        if (mode === "off") return;
        if (closed && !genFiredForClose && !waitEnd) {
            genFiredForClose = true;
            lastLivePrompt = promptNow;
            queueGen(node, true);
        } else if (mode === "live" && !closed && promptNow !== lastLivePrompt
            && promptNow.length >= 30 && (source === "response" || promptNow.split(",").length >= 4)
            && Date.now() - lastLive >= LIVE_INTERVAL_MS) {
            lastLive = Date.now();
            lastLivePrompt = promptNow;
            queueGen(node, false);
        }
    };

    const run = async (thinkFlag) => {
        const res = await fetch(api.apiURL("/live_chat_stream/chat"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages, think: thinkFlag }),
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim();
                buf = buf.slice(i + 1);
                if (!line) continue;
                const obj = JSON.parse(line);
                if (obj.error) throw new Error(obj.error);
                if (obj.message?.thinking) { thinkFull += obj.message.thinking; ui.setStatus(t("thinkingStatus")); onUpdate(); }
                if (obj.message?.content) { full += obj.message.content; onUpdate(); }
            }
        }
    };

    try {
        try {
            await run(useThink);
        } catch (e) {
            // thinking非対応モデルは400で拒否される → 思考なしで1回だけ再試行(Bは返信にフォールバック)
            if (e.name === "AbortError" || !useThink || full || thinkFull || !/think/i.test(String(e.message))) throw e;
            ui.addNote(t("noThinkRetry"));
            await run(false);
        }
    } catch (e) {
        if (e.name !== "AbortError") ui.addNote(`⚠ ${e.message || e}`);
    } finally {
        node._streamModel = null;
        ui.abort = null;
        ui.sendBtn.textContent = t("send");
        ui.setStatus(t(g.inflight ? "generating" : "ready"));
        if (full) {
            node._chat.push({ role: "assistant", content: full });
        } else {
            bubble.remove();
        }
        persistChat(node);
        // <mind>が出なかった場合は返信にフォールバック
        if (srcB === "mind" && !promptB && full) {
            promptB = buildPromptB("reply", "", full, maxB);
            if (promptB) { setWidget(node, "chat_p_text", promptB); setWidget(node, "chat_n_text", negB); }
        }
        // 閉じタグが無いまま終了した場合も、最終プロンプトで1回生成する
        if (mode !== "off" && (finalPrompt || promptB) && !genFiredForClose) queueGen(node, true);
        // 応答に画像プロンプトが無いと生成されない。原因が分かるよう理由を表示する
        else if (mode !== "off" && full && !finalPrompt && !promptB) {
            ui.addNote(t("noPromptWarn"));
        }
    }
}

// ---------- ノード登録 ----------
app.registerExtension({
    name: "LiveChatStream.Chat",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origCompute = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (out) {
            const size = origCompute ? origCompute.call(this, out) : (out || [NODE_W, 200]);
            size[0] = Math.max(size[0], NODE_W);
            size[1] = Math.max(size[1], UI_H + 30);
            return size;
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated?.apply(this, arguments);
            this._chat = [];
            this._gen = { inflight: false, pending: false, pendingFinal: false, judgeThis: false, images: {}, aNodes: new Set() };
            this._ui = buildUI(this);
            instances.add(this);

            // response_text / thinking_text は内部用なので非表示(値は保持)
            for (const name of ["response_text", "thinking_text", "input_image_name", "prompt_text", "negative_text", "chat_p_text", "chat_n_text"]) {
                const rw = this.widgets?.find((w) => w.name === name);
                if (!rw) continue;
                if (rw.element) rw.element.style.display = "none";
                rw.draw = () => {};
                rw.computeSize = () => [0, -4];
            }

            const w = this.addDOMWidget("chat_ui", "customtext", this._ui.wrap, {
                serialize: false,
                getValue() { return ""; },
                setValue() {},
                getMinHeight: () => UI_H,
                computeSize: (width) => [width, UI_H],
            });
            w.serialize = false;

            this.size = [NODE_W, UI_H + 60];
            this._ui.loadModels();
            ensurePresets().then(refreshPresetSelects);
            return r;
        };

        const origConn = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, index, connected) {
            const r = origConn?.apply(this, arguments);
            this._ui?.updateImageState();
            // 出力 image を配線した時点で、保持中のドロップ画像をI2Iソースとして反映
            if (type === LiteGraph.OUTPUT && connected && this.outputs?.[index]?.name === "image") this._ui?.syncSource();
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origConfigure?.apply(this, arguments);
            refreshPresetSelects();
            this._ui?.updateImageState();
            for (const [name, area] of Object.entries(this._ui?.promptAreas || {})) area.value = widgetValue(this, name) || "";
            this._ui?.updateSummaries();
            const saved = this.properties?.chat;
            if (Array.isArray(saved) && this._ui && !this._chat.length) {
                this._chat = saved.filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"));
                for (const m of this._chat) this._ui.addMsg(m.role, m.content);
            }
            return r;
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            instances.delete(this);
            this._ui?.abort?.abort();
            return origRemoved?.apply(this, arguments);
        };
    },
});

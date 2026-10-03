// システムプロンプト / キャラクターのプリセット管理(保存はサーバー側JSON、編集はモーダル)
import { api } from "../../../scripts/api.js";
import { t } from "./i18n.js";

export const DEFAULT_SYSTEM = `You chat with the user, and every turn the conversation is shown as an image made by Stable Diffusion XL (anime style, LCM, few steps).
START every reply with the complete, updated English prompt inside <prompt>...</prompt> (comma-separated tags / short phrases, at most ~60 words). Even in casual chat, depict the current scene, the speaker's expression and the mood of the conversation; when the user asks for a specific image or a change, follow that. Optionally add <negative>...</negative> right after it.
Always write the full prompt, never a diff. After the tags, reply in the user's language. Never mention the tags themselves.`;

// 応答全体をそのまま画像プロンプトにするモード用(タグも雑談も出させない)
export const DEFAULT_SYSTEM_RESPONSE = `You write image prompts for Stable Diffusion XL (anime style, LCM, few steps).
Reply with ONLY the complete, updated English prompt for the user's request: comma-separated tags / short phrases, at most ~60 words. No explanations, no greetings, no tags like <prompt>, no quotes, no line breaks.
Always write the full prompt, never a diff. Use the earlier conversation to apply the user's requested changes.`;

// <mind> ブロック(キャラの内面独白)の指示。mindEn=true なら英語で書かせる(画像モデルは英語のほうが解釈しやすい)
const mindNote = (en) => `Right after the </prompt> block (and the optional <negative> block), write <mind>...</mind>: the inner monologue right now — raw feelings and true thoughts in the first person, vivid and sensory, 1-3 sentences, ${en ? "written in English even if the user writes in another language" : "in the user's language"}. Then write the spoken reply${en ? " in the user's language" : ""}.`;

export const DEFAULT_ID = "default";

export function newId() {
    return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function builtinPresets() {
    return [
        { id: DEFAULT_ID, type: "plain", name: "Default", system: "", persona: "", appearance: "", emotion: "" },
        {
            id: "sample_lumi", type: "character", name: t("sampleName"), system: "",
            persona: t("samplePersona"),
            appearance: "1girl, silver hair, long hair, blue eyes, school uniform, ribbon",
            emotion: "Always reflect the character's current emotion in the image prompt: facial expression, gaze, blush, posture, hand gestures, lighting and atmosphere.",
        },
    ];
}

// ---------- システムプロンプトの組み立て ----------
export const DEFAULT_CHAT_SYSTEM = `You are a friendly, helpful assistant. Reply in the user's language.`;

export function composeSystem(preset, { source = "tag", srcB = "off", images = true, mindEn = false } = {}) {
    const p = preset || builtinPresets()[0];
    let text;
    if (!images) {
        // 画像生成OFF: <prompt>等の指示は入れず、キャラクター/システムプロンプトの内容だけで会話する
        text = p.type === "character"
            ? [
                `You are roleplaying as the character "${p.name}". Stay in character at all times.`,
                p.persona.trim() && `## Character\n${p.persona.trim()}`,
                `Reply in character in the user's language.`,
            ].filter(Boolean).join("\n\n")
            : (p.system.trim() || DEFAULT_CHAT_SYSTEM);
        return text;
    }
    if (p.type === "character") {
        text = [
            `You are roleplaying as the character "${p.name}". Stay in character at all times.`,
            p.persona.trim() && `## Character\n${p.persona.trim()}`,
            p.appearance.trim() && `## Fixed appearance (always include these tags in <prompt>)\n${p.appearance.trim()}`,
            `## Output format
Every reply starts with <prompt>...</prompt>: the complete, updated English image prompt for Stable Diffusion XL (comma-separated tags / short phrases, at most ~60 words). Begin with the fixed appearance tags, then the current facial expression, gaze, pose, action and scene. Optionally add <negative>...</negative> right after it.
After the tag blocks, reply in character in the user's language. Never mention the tags themselves.`,
            p.emotion.trim() && `## Emotion expression\n${p.emotion.trim()}`,
        ].filter(Boolean).join("\n\n");
    } else {
        text = p.system.trim() || (source === "response" ? DEFAULT_SYSTEM_RESPONSE : DEFAULT_SYSTEM);
    }
    if (srcB === "mind" && !text.includes("<mind>")) text += `\n\n${mindNote(mindEn)}`;
    return text;
}

// ---------- サーバー保存 ----------
export async function fetchPresets() {
    const res = await fetch(api.apiURL("/live_chat_stream/presets"));
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.presets;
}

export async function savePresets(list) {
    const res = await fetch(api.apiURL("/live_chat_stream/presets"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presets: list }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

// ---------- モーダル ----------
function injectStyle() {
    if (document.getElementById("lcs-modal-style")) return;
    const st = document.createElement("style");
    st.id = "lcs-modal-style";
    st.textContent = `
.lcs-ov{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:10000;display:flex;align-items:center;justify-content:center}
.lcs-md{background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);border:1px solid var(--border-color,#555);border-radius:8px;width:min(920px,94vw);height:min(640px,90vh);display:flex;flex-direction:column;font-size:13px}
.lcs-md-h{padding:8px 12px;border-bottom:1px solid var(--border-color,#444);font-weight:bold;display:flex;justify-content:space-between;align-items:center}
.lcs-md-b{flex:1;display:flex;min-height:0}
.lcs-md-l{width:240px;border-right:1px solid var(--border-color,#444);display:flex;flex-direction:column;min-height:0}
.lcs-md-l .lcs-md-list{flex:1;overflow-y:auto}
.lcs-md-item{padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;gap:6px}
.lcs-md-item:hover{background:rgba(255,255,255,.07)}.lcs-md-item.sel{background:rgba(74,163,255,.25)}
.lcs-md-item small{opacity:.6}
.lcs-md-r{flex:1;padding:10px 12px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-width:0}
.lcs-md-r label{font-size:11px;opacity:.75;display:block;margin-top:2px}
.lcs-md input[type=text],.lcs-md textarea{width:100%;box-sizing:border-box;background:var(--comfy-input-bg,#1b1b1b);color:var(--input-text,#ddd);border:1px solid var(--border-color,#444);border-radius:4px;padding:4px 6px;font-size:12px;font-family:inherit}
.lcs-md textarea{resize:vertical}
.lcs-md button{background:var(--comfy-input-bg,#333);color:var(--input-text,#ddd);border:1px solid var(--border-color,#555);border-radius:4px;padding:3px 10px;cursor:pointer}
.lcs-md button:disabled{opacity:.45;cursor:default}
.lcs-md-tools{padding:6px;display:flex;gap:4px;flex-wrap:wrap;border-top:1px solid var(--border-color,#444)}
.lcs-md-f{padding:8px 12px;border-top:1px solid var(--border-color,#444);display:flex;gap:6px;justify-content:flex-end;align-items:center}
.lcs-md-msg{flex:1;font-size:11px;opacity:.8}
.lcs-md .primary{background:#2b5d9e}
`;
    document.head.appendChild(st);
}

const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
};

const fieldLabels = () => ({
    plain: [["system", t("mdFieldSystem"), 12]],
    character: [
        ["persona", t("mdFieldPersona"), 6],
        ["appearance", t("mdFieldAppearance"), 3],
        ["emotion", t("mdFieldEmotion"), 3],
    ],
});

/**
 * プリセット管理モーダルを開く。
 * @returns {Promise<{list: object[], useId: string|null} | null>} キャンセル時は null
 */
export function openPresetModal({ list, activeId, ctx }) {
    injectStyle();
    return new Promise((resolve) => {
        const draft = list.map((p) => ({ ...p }));
        let selId = draft.some((p) => p.id === activeId) ? activeId : draft[0]?.id;

        const listEl = h("div", { className: "lcs-md-list" });
        const editor = h("div", { className: "lcs-md-r" });
        const msg = h("div", { className: "lcs-md-msg" });
        const close = (val) => { document.removeEventListener("keydown", onKey, true); ov.remove(); resolve(val); };
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };

        const sel = () => draft.find((p) => p.id === selId);

        const renderList = () => {
            listEl.replaceChildren();
            for (const p of draft) {
                const it = h("div", { className: "lcs-md-item" + (p.id === selId ? " sel" : "") },
                    h("span", { textContent: p.name }), h("small", { textContent: p.type === "character" ? t("mdTypeChar") : t("mdTypePlain") }));
                it.onclick = () => { selId = p.id; renderList(); renderEditor(); };
                listEl.appendChild(it);
            }
        };

        const renderEditor = () => {
            editor.replaceChildren();
            const p = sel();
            if (!p) { editor.appendChild(h("div", { textContent: t("mdNone") })); return; }
            const name = h("input", { type: "text", value: p.name, maxLength: 80 });
            name.oninput = () => { p.name = name.value; renderList(); refreshPreview(); };
            editor.append(h("label", { textContent: p.type === "character" ? t("mdCharName") : t("mdPresetName") }), name);
            const areas = {};
            for (const [key, label, rows] of fieldLabels()[p.type]) {
                const ta = h("textarea", { value: p[key] || "", rows, maxLength: 8000 });
                ta.oninput = () => { p[key] = ta.value; refreshPreview(); };
                areas[key] = ta;
                editor.append(h("label", { textContent: label }), ta);
            }
            const preview = h("textarea", { readOnly: true, rows: 7, style: "opacity:.75" });
            const refreshPreview = () => { preview.value = composeSystem(p, ctx); };
            editor.append(h("label", { textContent: t("mdPreview") }), preview);
            refreshPreview();
        };

        const add = (type) => {
            const p = type === "character"
                ? { id: newId(), type, name: "New character", system: "", persona: "", appearance: "", emotion: "" }
                : { id: newId(), type, name: "New preset", system: "", persona: "", appearance: "", emotion: "" };
            draft.push(p); selId = p.id; renderList(); renderEditor();
        };

        const dup = h("button", { textContent: t("mdDup") });
        dup.onclick = () => {
            const p = sel(); if (!p) return;
            const c = { ...p, id: newId(), name: `${p.name} (copy)` };
            draft.push(c); selId = c.id; renderList(); renderEditor();
        };
        const del = h("button", { textContent: t("mdDel") });
        del.onclick = () => {
            const p = sel();
            if (!p || p.id === DEFAULT_ID) { msg.textContent = t("mdDefaultNoDelete"); return; }
            draft.splice(draft.indexOf(p), 1); selId = draft[0]?.id; renderList(); renderEditor();
        };
        const addC = h("button", { textContent: t("mdAddChar") }); addC.onclick = () => add("character");
        const addP = h("button", { textContent: t("mdAddPlain") }); addP.onclick = () => add("plain");

        const exp = h("button", { textContent: t("mdExport") });
        exp.onclick = () => {
            const blob = new Blob([JSON.stringify({ version: 1, presets: draft }, null, 2)], { type: "application/json" });
            const a = h("a", { href: URL.createObjectURL(blob), download: "live_chat_stream_presets.json" });
            a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        };
        const fileIn = h("input", { type: "file", accept: "application/json,.json", style: "display:none" });
        const imp = h("button", { textContent: t("mdImport") }); imp.onclick = () => fileIn.click();
        fileIn.onchange = async () => {
            try {
                const data = JSON.parse(await fileIn.files[0].text());
                const arr = Array.isArray(data) ? data : data.presets;
                if (!Array.isArray(arr)) throw new Error(t("mdNoPresetsKey"));
                let n = 0;
                for (const p of arr) {
                    if (!p || !["plain", "character"].includes(p.type) || typeof p.name !== "string") continue;
                    draft.push({ id: newId(), type: p.type, name: p.name.slice(0, 80), system: String(p.system || "").slice(0, 8000),
                        persona: String(p.persona || "").slice(0, 8000), appearance: String(p.appearance || "").slice(0, 8000), emotion: String(p.emotion || "").slice(0, 8000) });
                    n++;
                }
                msg.textContent = t("mdImported", { n });
                renderList(); renderEditor();
            } catch (e) { msg.textContent = t("mdImportFailed", { msg: e.message || e }); }
            fileIn.value = "";
        };

        const cancel = h("button", { textContent: t("mdCancel") }); cancel.onclick = () => close(null);
        const save = h("button", { textContent: t("mdSave") }); save.onclick = () => close({ list: draft, useId: null });
        const saveUse = h("button", { className: "primary", textContent: t("mdSaveUse") }); saveUse.onclick = () => close({ list: draft, useId: selId });

        const ov = h("div", { className: "lcs-ov" },
            h("div", { className: "lcs-md" },
                h("div", { className: "lcs-md-h" }, h("span", { textContent: t("mdTitle") })),
                h("div", { className: "lcs-md-b" },
                    h("div", { className: "lcs-md-l" }, listEl,
                        h("div", { className: "lcs-md-tools" }, addC, addP, dup, del, imp, exp, fileIn)),
                    editor),
                h("div", { className: "lcs-md-f" }, msg, cancel, save, saveUse)));
        ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(null); });
        ov.addEventListener("keydown", (e) => e.stopPropagation());
        document.addEventListener("keydown", onKey, true);
        document.body.appendChild(ov);
        renderList();
        renderEditor();
    });
}

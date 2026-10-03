"""Ollama プロキシ(ストリーミングチャット / モデル一覧 / 意思決定API)。

ブラウザから直接 Ollama を叩くとCORS・混在コンテンツで詰まることがあるため、
ComfyUIサーバー経由で中継する。**接続先のOllamaアドレスはサーバー側の設定で決め、リクエストからは一切受け取らない**
(環境変数 LIVE_CHAT_STREAM_OLLAMA_URL、または <user>/live_chat_stream/config.json の "ollama_url"、既定は127.0.0.1)。
"""

import asyncio
import json
import logging
import os
from urllib.parse import urlparse

import aiohttp
import folder_paths
from aiohttp import web
from server import PromptServer

logger = logging.getLogger("LiveChatStream")

DEFAULT_URL = "http://127.0.0.1:11434"
ENV_OLLAMA_URL = "LIVE_CHAT_STREAM_OLLAMA_URL"
routes = PromptServer.instance.routes


def _data_dir():
    getter = getattr(folder_paths, "get_user_directory", None)
    base = getter() if getter else os.path.join(folder_paths.base_path, "user")
    d = os.path.join(base, "live_chat_stream")
    os.makedirs(d, exist_ok=True)
    return d


def _ollama_base():
    """Ollamaのアドレス。サーバーの運営者が決める値で、リクエスト(ブラウザ)からは受け取らない。

    優先順位: 環境変数 LIVE_CHAT_STREAM_OLLAMA_URL → <user>/live_chat_stream/config.json の "ollama_url" → 既定。
    呼び出しごとに読むので、config.json の変更は再起動なしで反映される。
    """
    url = os.environ.get(ENV_OLLAMA_URL, "").strip()
    if not url:
        try:
            with open(os.path.join(_data_dir(), "config.json"), "r", encoding="utf-8") as f:
                url = str((json.load(f) or {}).get("ollama_url") or "").strip()
        except (OSError, ValueError, AttributeError):
            url = ""
    url = (url or DEFAULT_URL).rstrip("/")
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
        raise ValueError("The configured Ollama URL must be http(s)://host[:port] (no credentials)")
    return url


def _classify(model):
    caps = set(model.get("capabilities") or [])
    return {
        "name": model.get("name"),
        "size": model.get("size"),
        "capabilities": sorted(caps),
        # decision(意思決定)モデル。型付きの質問に答える判定役として使う。embeddingは除外。
        "llm": "completion" in caps and "decision" not in caps,
        "vlm": "vision" in caps and "decision" not in caps,
        "vla": "decision" in caps,
        "vla_vision": "decision" in caps and "vision" in caps,
    }


async def _get_json(base, path, timeout=8):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as s:
        async with s.get(base + path, allow_redirects=False) as r:
            r.raise_for_status()
            return await r.json()


@routes.get("/live_chat_stream/models")
async def models(request: web.Request):
    try:
        base = _ollama_base()
        tags = await _get_json(base, "/api/tags")
        try:
            version = (await _get_json(base, "/api/version", 3)).get("version")
        except Exception:
            version = None
        items = [_classify(m) for m in tags.get("models", []) if "embedding" not in (m.get("capabilities") or [])]
        return web.json_response({"ok": True, "version": version, "models": items})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)


@routes.post("/live_chat_stream/chat")
async def chat(request: web.Request):
    """Ollama /api/chat のNDJSONストリームをそのまま中継する。"""
    try:
        body = await request.json()
        base = _ollama_base()
        model = body.get("model")
        messages = body.get("messages")
        if not model or not isinstance(messages, list):
            raise ValueError("model and messages are required")
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)

    payload = {"model": model, "messages": messages, "stream": True, "think": bool(body.get("think", False))}
    if isinstance(body.get("options"), dict):
        payload["options"] = body["options"]

    resp = web.StreamResponse(headers={"Content-Type": "application/x-ndjson", "Cache-Control": "no-cache"})
    await resp.prepare(request)

    async def send_error(msg):
        await resp.write(json.dumps({"error": msg}).encode("utf-8") + b"\n")

    try:
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=300)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(base + "/api/chat", json=payload, allow_redirects=False) as r:
                if r.status != 200:
                    text = (await r.text())[:300]
                    await send_error(f"Ollama HTTP {r.status}: {text}")
                else:
                    async for chunk in r.content.iter_any():
                        await resp.write(chunk)
    except (ConnectionResetError, asyncio.CancelledError):
        # クライアント中断(停止ボタン/タブ閉じ)。セッションが閉じ、Ollama側の生成も止まる。
        return resp
    except Exception as e:
        logger.error("chat stream error: %s", e)
        try:
            await send_error(str(e))
        except Exception:
            pass
    try:
        await resp.write_eof()
    except Exception:
        pass
    return resp


@routes.post("/live_chat_stream/decide")
async def decide(request: web.Request):
    """Ollama 0.35+ の /v1/systemone へ中継(意思決定モデル。imagesはvision対応モデルのみ)。"""
    try:
        body = await request.json()
        base = _ollama_base()
        payload = {
            "model": body["model"],
            "state": body.get("state", ""),
            "questions": body["questions"],
        }
        if body.get("images"):
            payload["images"] = body["images"]
        timeout = aiohttp.ClientTimeout(total=180)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(base + "/v1/systemone", json=payload, allow_redirects=False) as r:
                text = await r.text()
                try:
                    data = json.loads(text)
                except ValueError:
                    data = {"error": text[:300]}
                return web.json_response(data, status=r.status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


async def _unload_model(session, base, name):
    """keep_alive=0 でアンロード。生成モデルは /api/generate、意思決定モデルなどで拒否されたら /api/chat で再試行。"""
    for path, payload in (
        ("/api/generate", {"model": name, "keep_alive": 0}),
        ("/api/chat", {"model": name, "messages": [], "keep_alive": 0}),
    ):
        try:
            async with session.post(base + path, json=payload, allow_redirects=False) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
    return False


@routes.post("/live_chat_stream/unload")
async def unload(request: web.Request):
    """Ollamaでロード中のモデルをすべてアンロード(keep_alive=0)。VRAMをComfyUIへ返す用。"""
    try:
        body = await request.json()
        base = _ollama_base()
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

    unloaded, failed = [], []
    try:
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.get(base + "/api/ps", allow_redirects=False) as r:
                r.raise_for_status()
                loaded = [m.get("name") for m in (await r.json()).get("models", []) if m.get("name")]
            for name in loaded:
                (unloaded if await _unload_model(s, base, name) else failed).append(name)
        return web.json_response({"ok": True, "unloaded": unloaded, "failed": failed})
    except Exception as e:
        logger.error("unload error: %s", e)
        return web.json_response({"ok": False, "error": str(e), "unloaded": unloaded, "failed": failed}, status=502)


# ---------------------------------------------------------------------------
# プリセット(システムプロンプト / キャラクター)の保存。ComfyUIのuserフォルダ配下のJSON。
# ---------------------------------------------------------------------------
import re
import tempfile

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_PRESETS = 100
_MAX_TEXT = 8000
_TEXT_FIELDS = ("system", "persona", "appearance", "emotion")


def _presets_path():
    return os.path.join(_data_dir(), "presets.json")


def _clean_preset(p):
    if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not _ID_RE.match(p["id"]):
        raise ValueError("invalid preset id")
    kind = p.get("type")
    if kind not in ("plain", "character"):
        raise ValueError("invalid preset type")
    name = p.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise ValueError("invalid preset name")
    out = {"id": p["id"], "type": kind, "name": name.strip()}
    for f in _TEXT_FIELDS:
        v = p.get(f, "")
        if not isinstance(v, str) or len(v) > _MAX_TEXT:
            raise ValueError(f"invalid field: {f}")
        out[f] = v
    return out


@routes.get("/live_chat_stream/presets")
async def get_presets(request: web.Request):
    try:
        path = _presets_path()
        if not os.path.exists(path):
            return web.json_response({"ok": True, "presets": []})
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        presets = [_clean_preset(p) for p in data.get("presets", [])]
        return web.json_response({"ok": True, "presets": presets})
    except Exception as e:
        logger.error("presets read error: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@routes.post("/live_chat_stream/presets")
async def save_presets(request: web.Request):
    try:
        body = await request.json()
        raw = body.get("presets")
        if not isinstance(raw, list) or len(raw) > _MAX_PRESETS:
            raise ValueError("presets must be a list (max %d)" % _MAX_PRESETS)
        presets = [_clean_preset(p) for p in raw]
        if len({p["id"] for p in presets}) != len(presets):
            raise ValueError("duplicate preset id")
        path = _presets_path()
        # 書き込み途中で壊れないよう、一時ファイル→置換
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "presets": presets}, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        return web.json_response({"ok": True, "count": len(presets)})
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    except Exception as e:
        logger.error("presets write error: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@routes.get("/live_chat_stream/input_image")
async def input_image(request: web.Request):
    """socketから入力された画像の最新値(実行後に取得可)。フロントのVLMチャット用。"""
    from . import nodes as _nodes

    data = _nodes.get_cached_input_png(request.query.get("node_id", ""))
    if data is None:
        return web.json_response({"ok": False, "error": "no input image yet (run the graph once)"}, status=404)
    return web.Response(body=data, content_type="image/png", headers={"Cache-Control": "no-store"})


_MB = 1024 * 1024


def _smi_free_mb(ident):
    import subprocess

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    out = subprocess.run(
        ["nvidia-smi", "-i", str(ident), "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=5, creationflags=flags,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "nvidia-smi failed")
    return float(out.stdout.strip().splitlines()[0])


async def _free_vram_mb():
    """画像生成で使える空きVRAM(MB)と取得元を返す。

    ComfyUIの get_free_memory は、環境(動的VRAM管理など)によっては他プロセス(Ollama)の使用が反映されないことを
    実測で確認した。そのためドライバ側の実測(nvidia-smi)にComfyUI自身のtorch未使用キャッシュ分を足す。
    取得できなければ get_free_memory にフォールバックする。
    """
    import torch
    import comfy.model_management as mm

    dev = mm.get_torch_device()
    if getattr(dev, "type", "cpu") == "cuda":
        try:
            st = torch.cuda.memory_stats(dev)
            cached = max(0, st["reserved_bytes.all.current"] - st["active_bytes.all.current"])
            try:
                ident = f"GPU-{torch.cuda.get_device_properties(dev).uuid}"
                free = await asyncio.to_thread(_smi_free_mb, ident)
            except Exception:
                free = await asyncio.to_thread(_smi_free_mb, dev.index or 0)
            return free + cached / _MB, "nvidia-smi"
        except Exception as e:
            logger.warning("nvidia-smi free VRAM unavailable, falling back to ComfyUI: %s", e)
    return mm.get_free_memory(dev) / _MB, "comfy"


async def _wait_vram_settled(prev_mb, timeout_s=6.0):
    """アンロード後、ランナー終了に伴い空きVRAMが増えて頭打ちになるまで待ち、実測の空き(MB)を返す。"""
    now = prev_mb
    deadline = asyncio.get_event_loop().time() + timeout_s
    last = None
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.4)
        now, _ = await _free_vram_mb()
        if last is not None and abs(now - last) < 32 and now > prev_mb + 32:
            break  # 増えた後に変化が止まった
        last = now
    return now


@routes.post("/live_chat_stream/vram_prepare")
async def vram_prepare(request: web.Request):
    """画像生成の開始前に、Ollamaのモデルをアンロードして空きVRAMを作る。

    mode="all": 除外指定以外のロード中モデルをすべてアンロード。
    mode="auto": ComfyUIの空きVRAMが target_gb 未満のときだけ、VRAM使用量の大きいモデルから
                 必要な分だけアンロード。使用中(exclude)のモデルは対象外。
    """
    try:
        body = await request.json()
        base = _ollama_base()
        mode = body.get("mode")
        if mode not in ("auto", "all"):
            raise ValueError("mode must be auto or all")
        target_mb = min(max(float(body.get("target_gb", 8)), 0.0), 64.0) * 1024
        exclude = {x for x in (body.get("exclude") or []) if isinstance(x, str)}
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)

    try:
        free_before, free_src = await _free_vram_mb()
        unloaded, failed, skipped = [], [], []
        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.get(base + "/api/ps", allow_redirects=False) as r:
                r.raise_for_status()
                loaded = (await r.json()).get("models", [])
            cands = []
            for m in loaded:
                name = m.get("name")
                if not name:
                    continue
                if name in exclude:
                    skipped.append(name)
                else:
                    cands.append({"name": name, "vram_mb": int(m.get("size_vram", 0) / (1024 * 1024))})
            free_after = free_before
            if mode == "auto":
                # Ollamaの size_vram は KVキャッシュ等を含まず実際に増える空きより小さい。見込みでは余分に解放しかねないので、
                # VRAM使用量の大きいモデルから1台ずつアンロードし、そのつど実測の空きで止める。
                cands.sort(key=lambda c: c["vram_mb"], reverse=True)
                for c in cands:
                    if free_after >= target_mb:
                        break
                    if await _unload_model(s, base, c["name"]):
                        unloaded.append(c)
                        free_after = await _wait_vram_settled(free_after)
                    else:
                        failed.append(c)
            else:
                for c in cands:
                    (unloaded if await _unload_model(s, base, c["name"]) else failed).append(c)
                if unloaded:
                    free_after = await _wait_vram_settled(free_after)
        return web.json_response({
            "ok": True, "mode": mode, "target_gb": target_mb / 1024, "free_source": free_src,
            "free_before_mb": round(free_before), "free_after_mb": round(free_after),
            "unloaded": unloaded, "failed": [c["name"] for c in failed], "skipped_in_use": skipped,
            "reached": free_after >= target_mb,
        })
    except Exception as e:
        logger.error("vram_prepare error: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=502)

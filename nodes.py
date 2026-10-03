import io
import os

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageOps

try:
    from comfy_execution.graph_utils import ExecutionBlocker
except ImportError:  # 古いComfyUI: ブロックできないので黒画像で代替する
    ExecutionBlocker = None

# 入力画像(socket)の最新値をノードIDごとに保持し、フロントのVLMチャットへ渡す(PNGバイト列)。
# サーバー再起動で消える。件数を抑えて無制限に増やさない。
_INPUT_CACHE: dict = {}
_INPUT_CACHE_MAX = 16
_INPUT_CACHE_SIDE = 1024


def get_cached_input_png(node_id):
    return _INPUT_CACHE.get(str(node_id))


def _cache_input(node_id, tensor):
    if node_id is None:
        return
    arr = (tensor[0].clamp(0, 1) * 255).byte().cpu().numpy()
    img = Image.fromarray(arr)
    img.thumbnail((_INPUT_CACHE_SIDE, _INPUT_CACHE_SIDE))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    _INPUT_CACHE.pop(str(node_id), None)
    _INPUT_CACHE[str(node_id)] = buf.getvalue()
    while len(_INPUT_CACHE) > _INPUT_CACHE_MAX:
        _INPUT_CACHE.pop(next(iter(_INPUT_CACHE)))


def _load_input_image(name):
    """inputフォルダの画像(フロントがアップロードしたI2Iソース)をIMAGEテンソルへ。"""
    if not name or ".." in name.replace("\\", "/").split("/") or os.path.isabs(name):
        return None
    path = folder_paths.get_annotated_filepath(name)
    if not os.path.isfile(path):
        return None
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return torch.from_numpy(np.array(img).astype(np.float32) / 255.0)[None,]


class LiveChatStream:
    """Live Chat Stream: チャット(ストリーミング) → 画像生成プロンプト出力ノード。

    チャットUI・ストリーミング・画像生成のキュー投入はフロントエンド(web/live_chat_stream.js)が行い、
    チャット応答から抽出した <prompt>/<negative> をこのノードのウィジェットへ書き込む。
    系統A(positive/negative)=通常のチャット画像生成、
    系統B(chat_p/chat_n)=LLM/VLMの思考・返信そのものの画像化。
    画像入力(image)があればそれをVLMへ渡し、出力(image)へ通す。I2Iに使える。
    Python側は、その値を下流(CLIPTextEncode等)へ渡すだけ。
    """

    @classmethod
    def INPUT_TYPES(cls):
        # ウィジェット値はワークフローJSONに位置インデックスで保存される。
        # 追加は末尾のみ、並べ替え・削除は保存済みワークフローを壊す。
        return {
            "required": {},
            "optional": {
                "prompt_text": ("STRING", {"default": "", "multiline": True}),
                "negative_text": ("STRING", {"default": "", "multiline": True}),
                "response_text": ("STRING", {"default": "", "multiline": True}),
                # 系統B(LLM/VLMの思考・表現の画像化)。末尾に追加(位置インデックス互換のため)
                "chat_p_text": ("STRING", {"default": "", "multiline": True}),
                "chat_n_text": ("STRING", {"default": "", "multiline": True}),
                "thinking_text": ("STRING", {"default": "", "multiline": True}),
                # 画像入力(socket)。ウィジェットではないので位置インデックスに影響しない。
                "image": ("IMAGE",),
                # フロントがドロップ/選択した画像をinputへアップロードしたファイル名(内部用)
                "input_image_name": ("STRING", {"default": ""}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    # 出力スロットも末尾追加のみ(保存済みワークフローのリンクはスロット番号で保持される)
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "STRING", "STRING", "IMAGE")
    RETURN_NAMES = ("positive", "negative", "response", "chat_p", "chat_n", "thinking", "image")
    FUNCTION = "run"
    CATEGORY = "LiveChatStream"
    DESCRIPTION = "Chat with an LLM / VLM / VLA and turn the streaming reply into images. Image input / output enables I2I."

    def run(self, prompt_text="", negative_text="", response_text="",
            chat_p_text="", chat_n_text="", thinking_text="",
            image=None, input_image_name="", unique_id=None):
        # 優先順位: socket入力 > ドロップ/選択(アップロード済み) > なし
        if image is not None:
            out_image = image
            _cache_input(unique_id, image)
        else:
            out_image = _load_input_image(input_image_name)
            if out_image is None:
                # 画像が無い時は下流(I2Iの分岐)を実行させない。古いComfyUIは黒画像で代替。
                out_image = ExecutionBlocker(None) if ExecutionBlocker else torch.zeros((1, 64, 64, 3))
        return (
            (prompt_text or "").strip(),
            (negative_text or "").strip(),
            response_text or "",
            (chat_p_text or "").strip(),
            (chat_n_text or "").strip(),
            thinking_text or "",
            out_image,
        )


NODE_CLASS_MAPPINGS = {
    "LiveChatStream": LiveChatStream,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LiveChatStream": "Live Chat Stream",
}

import traceback

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

try:
    from . import server  # 副作用で /live_chat_stream/* ルートを登録
except Exception as _e:
    print(f"[LiveChatStream] ERROR: server routes failed to load: {_e}")
    traceback.print_exc()

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

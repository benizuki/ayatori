"""テスト共通の補助。"""

from __future__ import annotations

import sys
from contextlib import ExitStack
from unittest.mock import patch


class patch_auth_enabled:
    """auth_enabled を、読み込み済みのアプリ内モジュールすべてで差し替える。

    各ルーターは `from ..core.auth import auth_enabled` で取り込むため、
    1か所だけを差し替えても他のモジュールには効かない。
    `with` でも、`start()` / `stop()` でも使える。
    """

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self._stack: ExitStack | None = None

    def start(self) -> None:
        self._stack = ExitStack()
        for name, module in list(sys.modules.items()):
            if name.startswith("backend.app.") and name != "backend.app.core.auth" and hasattr(module, "auth_enabled"):
                self._stack.enter_context(patch.object(module, "auth_enabled", return_value=self.enabled))

    def stop(self) -> None:
        if self._stack is not None:
            self._stack.close()
            self._stack = None

    def __enter__(self) -> "patch_auth_enabled":
        self.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

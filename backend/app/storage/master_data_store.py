from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path
from threading import Lock
from typing import Any

from ..resources.initial_data import load_initial_data


MASTER_DATA_KEYS = (
    "departments",
    "businessMasters",
)
INITIAL_DATA_KEYS = {
    "departments": "departments",
    "businessMasters": "businessProcessMasters",
}
LEGACY_FILE_KEYS = {
    "businessMasters": "businessProcessMasters",
}
LEGACY_GUIDE_KEYS = ("guideTemplates", "interviewGuideTemplates")
TENANT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class MasterDataStore:
    """Tenant-scoped JSON master store backed by a mounted local directory."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def _tenant_path(self, tenant_id: str) -> Path:
        normalized = tenant_id.strip().lower()
        if not TENANT_ID_PATTERN.fullmatch(normalized):
            raise ValueError("Invalid tenant ID for master data")
        return self.root / f"{normalized}.json"

    def _default_master_data(self, tenant_id: str) -> dict[str, Any]:
        initial_data = load_initial_data()
        master_data = {
            key: deepcopy(initial_data[INITIAL_DATA_KEYS[key]])
            for key in MASTER_DATA_KEYS
        }
        for department in master_data["departments"]:
            department["tenantId"] = tenant_id
        return master_data

    def _write(self, path: Path, master_data: dict[str, Any]) -> None:
        temporary_path = path.with_suffix(".json.tmp")
        temporary_path.write_text(
            json.dumps(master_data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temporary_path.replace(path)

    @staticmethod
    def _adopt_legacy_guides(
        payload: dict[str, Any],
        master_data: dict[str, Any],
    ) -> dict[str, Any]:
        """ヒアリング業務マスター廃止時の移行。

        保存済みのヒアリング業務のうち、同名の業務が業務マスターに無いものを
        「作成中」の業務として取り込み、テナントが登録した調査対象を失わせない。
        取り込み後は guideTemplates が保存されなくなるため一度だけ動作する。
        """
        legacy_guides = next(
            (
                payload[key]
                for key in LEGACY_GUIDE_KEYS
                if isinstance(payload.get(key), list)
            ),
            None,
        )
        if not legacy_guides:
            return master_data
        businesses = master_data.setdefault("businessMasters", [])
        known_names = {
            str(business.get("name", "")).strip()
            for business in businesses
            if isinstance(business, dict)
        }
        known_ids = {
            str(business.get("id", "")).strip()
            for business in businesses
            if isinstance(business, dict)
        }
        for guide in legacy_guides:
            if not isinstance(guide, dict):
                continue
            name = str(guide.get("name", "")).strip()
            department_id = str(guide.get("departmentId", "")).strip()
            # departmentIdが"all"のガイドは業務を特定しない自由探索用のため取り込まない。
            if not name or not department_id or department_id == "all":
                continue
            guide_id = str(guide.get("id", "")).strip()
            business_id = f"guide-{guide_id}"
            if name in known_names or not guide_id or business_id in known_ids:
                continue
            businesses.append({
                "id": business_id,
                "code": "未設定",
                "name": name,
                "departmentId": department_id,
                "category": "ヒアリング業務から移行",
                "description": str(guide.get("description", "")),
                "startCondition": "",
                "endCondition": "",
                "sapScope": "未判定",
                "sapModule": "未判定",
                "ownerRole": "未確認",
                "status": "作成中",
                "updatedAt": "未ヒアリング",
                "interviewTopics": [],
                "maturity": "発見",
            })
            known_names.add(name)
            known_ids.add(business_id)
        return master_data

    def load(self, tenant_id: str = "default") -> dict[str, Any]:
        normalized = tenant_id.strip().lower()
        path = self._tenant_path(normalized)
        with self._lock:
            if not path.exists():
                master_data = self._default_master_data(normalized)
                self._write(path, master_data)
                return deepcopy(master_data)
            payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"Master data file must contain a JSON object: {path}")
        master_data = {
            key: deepcopy(
                payload.get(
                    key,
                    payload.get(LEGACY_FILE_KEYS.get(key, ""), []),
                )
            )
            for key in MASTER_DATA_KEYS
        }
        migrated_master_data = self._adopt_legacy_guides(payload, deepcopy(master_data))
        if migrated_master_data != master_data:
            with self._lock:
                self._write(path, migrated_master_data)
        return migrated_master_data

    def save(
        self,
        payload: dict[str, Any],
        tenant_id: str = "default",
    ) -> dict[str, Any]:
        normalized = tenant_id.strip().lower()
        missing_keys = [
            key
            for key in MASTER_DATA_KEYS
            if not isinstance(payload.get(key), list)
        ]
        if missing_keys:
            raise ValueError(
                f"Master data must contain arrays: {', '.join(missing_keys)}"
            )
        master_data = {
            key: deepcopy(payload[key])
            for key in MASTER_DATA_KEYS
        }
        for department in master_data["departments"]:
            if isinstance(department, dict):
                department["tenantId"] = normalized
        path = self._tenant_path(normalized)
        with self._lock:
            self._write(path, master_data)
        return deepcopy(master_data)

    def merge_into_app_state(
        self,
        payload: dict[str, Any],
        tenant_id: str = "default",
    ) -> dict[str, Any]:
        master_data = self.load(tenant_id)
        inherited_legacy_data = False
        for key in MASTER_DATA_KEYS:
            if key not in payload:
                continue
            if not isinstance(payload[key], list):
                raise ValueError(f"Master data field must be an array: {key}")
            master_data[key] = payload[key]
            inherited_legacy_data = True
        if inherited_legacy_data:
            master_data = self.save(master_data, tenant_id)
        return {**payload, **master_data}

    def split_from_app_state(
        self,
        payload: dict[str, Any],
        tenant_id: str = "default",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        master_data = self.load(tenant_id)
        for key in MASTER_DATA_KEYS:
            if key not in payload:
                continue
            if not isinstance(payload[key], list):
                raise ValueError(f"Master data field must be an array: {key}")
            master_data[key] = payload[key]
        master_data = self.save(master_data, tenant_id)
        operational_state = {
            key: value
            for key, value in payload.items()
            if key not in MASTER_DATA_KEYS
        }
        return operational_state, master_data

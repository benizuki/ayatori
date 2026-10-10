from __future__ import annotations

import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any


MASTER_DATA_SOURCE_DIR = Path(__file__).resolve().parent / "master_data"


def _read_json(file_name: str) -> Any:
    path = MASTER_DATA_SOURCE_DIR / file_name
    with path.open(encoding="utf-8") as master_file:
        return json.load(master_file)


def _require_list(value: Any, file_name: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError(f"{file_name} must contain a JSON array of objects")
    return value


@lru_cache(maxsize=1)
def _cached_initial_data() -> dict[str, Any]:
    department_seed = _read_json("departments.json")
    if not isinstance(department_seed, dict):
        raise ValueError("departments.json must contain a JSON object")

    topics = _require_list(
        _read_json("interview-topic-templates.json"),
        "interview-topic-templates.json",
    )

    departments = department_seed.get("departments")
    initial_department_ids = department_seed.get("initialDepartmentIds")
    if not isinstance(departments, list) or not isinstance(initial_department_ids, dict):
        raise ValueError(
            "departments.json must define departments and initialDepartmentIds"
        )

    return {
        "initialDepartmentIds": initial_department_ids,
        "departments": departments,
        "interviewTopicTemplates": topics,
        "interviewMessages": _require_list(
            _read_json("interview-messages.json"),
            "interview-messages.json",
        ),
        "processSteps": _require_list(
            _read_json("process-steps.json"),
            "process-steps.json",
        ),
        "businessProcessMasters": _require_list(
            _read_json("business-process-masters.json"),
            "business-process-masters.json",
        ),
        "workFragments": _require_list(
            _read_json("work-fragments.json"),
            "work-fragments.json",
        ),
    }


def load_initial_data() -> dict[str, Any]:
    """Return a copy so request consumers cannot mutate the cached seed data."""
    return deepcopy(_cached_initial_data())

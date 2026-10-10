from __future__ import annotations

import unittest

from backend.app.resources.initial_data import load_initial_data


class InitialDataTest(unittest.TestCase):
    def test_loads_all_frontend_bootstrap_collections(self) -> None:
        data = load_initial_data()

        self.assertEqual(
            set(data),
            {
                "initialDepartmentIds",
                "departments",
                "interviewTopicTemplates",
                "interviewMessages",
                "processSteps",
                "businessProcessMasters",
                "workFragments",
            },
        )
        self.assertGreater(len(data["departments"]), 0)
        self.assertGreater(len(data["interviewTopicTemplates"]), 0)
        self.assertGreater(len(data["businessProcessMasters"]), 0)

    def test_business_masters_cover_every_department(self) -> None:
        data = load_initial_data()
        department_ids = {department["id"] for department in data["departments"]}
        business_department_ids = {
            business["departmentId"] for business in data["businessProcessMasters"]
        }

        # 業務指定ヒアリングは業務マスターから対象業務を選ぶため、どの業務領域を
        # 選んでも候補が空にならないことを保証する。
        self.assertEqual(department_ids - business_department_ids, set())

    def test_returns_an_independent_copy(self) -> None:
        first = load_initial_data()
        first["departments"].clear()

        second = load_initial_data()

        self.assertGreater(len(second["departments"]), 0)

    def test_sample_records_reference_existing_departments_and_fragments(self) -> None:
        data = load_initial_data()
        department_ids = {department["id"] for department in data["departments"]}
        fragment_ids = {fragment["id"] for fragment in data["workFragments"]}

        self.assertTrue(
            all(
                fragment["departmentId"] in department_ids
                for fragment in data["workFragments"]
            )
        )


if __name__ == "__main__":
    unittest.main()

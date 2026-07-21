import json
import unittest
from unittest.mock import patch

import networkx as nx
from pyproj import Transformer

from fg03_proof import (
    Facility,
    NetworkSnapper,
    cluster_access_points,
    consolidate_crem_rows,
    multi_source_distances,
)
from fg03_schedule import parse_weekly_hours


def crem_row(
    washroom: str,
    *,
    accessible: str,
    status: str = "Open - Public Access",
) -> dict[str, str]:
    return {
        "FLOC_ID": "building-1",
        "Building Description": "Civic Centre",
        "Address": "100 Main St",
        "Washroom Info": washroom,
        "Gender Inclusive": "No",
        "Accessible Washroom": accessible,
        "Hours Available": "Mon-Fri 8:00am-6:00pm, Sat-Sun Closed",
        "Location Details": "Ground floor",
        "Washroom Status": status,
        "geometry": json.dumps(
            {"type": "MultiPoint", "coordinates": [[-79.4, 43.7]]}
        ),
    }


class SourceConsolidationTests(unittest.TestCase):
    def test_crem_rows_collapse_to_one_public_access_location(self):
        rows = [
            crem_row("Men's washroom", accessible="No"),
            crem_row("Universal washroom", accessible="Yes"),
            crem_row(
                "VIA lounge washroom",
                accessible="Yes",
                status="Open - Public Access to VIA Passengers only",
            ),
        ]

        facilities = consolidate_crem_rows(rows)

        self.assertEqual(len(facilities), 1)
        self.assertTrue(facilities[0].accessible)
        self.assertEqual(facilities[0].record_count, 2)

    def test_placeholder_ids_do_not_merge_different_buildings(self):
        first = crem_row("Washroom", accessible="Yes")
        first.update(
            {
                "FLOC_ID": "N/A",
                "Building Description": "City Hall",
                "Address": "100 Queen St W",
            }
        )
        second = crem_row("Washroom", accessible="Yes")
        second.update(
            {
                "FLOC_ID": "N/A",
                "Building Description": "Union Station",
                "Address": "65 Front St W",
                "geometry": json.dumps(
                    {"type": "MultiPoint", "coordinates": [[-79.38, 43.64]]}
                ),
            }
        )

        facilities = consolidate_crem_rows([first, second])

        self.assertEqual(len(facilities), 2)

    def test_nearby_same_address_records_share_an_access_point(self):
        def facility(fid: str, address: str, lon: float) -> Facility:
            return Facility(
                facility_id=fid,
                source=fid,
                name=fid,
                address=address,
                lon=lon,
                lat=43.65,
                hours_raw="9 a.m. to 10 p.m.",
                schedule=parse_weekly_hours("9 a.m. to 10 p.m."),
                accessible=None,
                all_gender=None,
            )

        facilities = [
            facility("a", "100 Main Street", -79.40000),
            facility(
                "b", "100 Main St., Toronto, ON, M5V 2T6", -79.40025
            ),
            facility("c", "102 Main St", -79.40025),
        ]

        clusters = cluster_access_points(facilities)

        self.assertEqual(clusters["a"], clusters["b"])
        self.assertNotEqual(clusters["a"], clusters["c"])


class NetworkCoverageTests(unittest.TestCase):
    def test_network_snapper_builds_coordinate_transformer_once(self):
        graph = nx.Graph()
        graph.add_nodes_from([(-79.4, 43.65), (-79.39, 43.66)])

        with patch(
            "fg03_proof.Transformer.from_crs", wraps=Transformer.from_crs
        ) as from_crs:
            snapper = NetworkSnapper(graph)
            snapper.snap(-79.4, 43.65)
            snapper.snap(-79.39, 43.66)

        self.assertEqual(from_crs.call_count, 1)

    def test_source_snap_offset_counts_toward_walking_distance(self):
        graph = nx.Graph()
        graph.add_edge("a", "b", length=100.0)
        graph.add_edge("b", "c", length=100.0)

        distances = multi_source_distances(graph, {"a": 30.0}, cutoff=180.0)

        self.assertEqual(distances, {"a": 30.0, "b": 130.0})


if __name__ == "__main__":
    unittest.main()

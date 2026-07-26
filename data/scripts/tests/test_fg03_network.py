import unittest

import geopandas as gpd
from shapely.geometry import LineString, Point

from fg03_network import (
    NetworkLengthOverride,
    NetworkTopologyException,
    NetworkValidationError,
    batch_snap_points,
    build_network,
)


def network_rows(*rows):
    return gpd.GeoDataFrame(
        [
            {"OBJECTID": object_id, "LENGTH": geometry.length, "geometry": geometry}
            for object_id, geometry in rows
        ],
        geometry="geometry",
        crs="EPSG:2952",
    )


class NetworkConstructionTests(unittest.TestCase):
    def test_t_junction_connects_through_an_interior_source_vertex(self):
        # Protected break: using only the first and last coordinate disconnects
        # a branch whose endpoint meets a source line at an interior vertex.
        source = network_rows(
            (1, LineString([(0, 0), (10, 0), (20, 0)])),
            (2, LineString([(10, 0), (10, 10)])),
        )

        network = build_network(source)

        self.assertTrue(network.graph.has_edge((0.0, 0.0), (10.0, 0.0)))
        self.assertTrue(network.graph.has_edge((10.0, 0.0), (20.0, 0.0)))
        self.assertTrue(network.graph.has_edge((10.0, 0.0), (10.0, 10.0)))
        self.assertEqual(network.graph.degree[(10.0, 0.0)], 3)

    def test_long_edge_midpoint_snap_inserts_one_shared_projected_node(self):
        # Protected break: node-only snapping can add hundreds of metres on a
        # long source edge, and sequential insertion can make results order-dependent.
        source = network_rows((1, LineString([(0, 0), (1000, 0)])))
        network = build_network(source)

        snaps = batch_snap_points(
            network,
            {
                "facility": Point(500, 12),
                "stop": Point(500, -8),
            },
        )

        self.assertEqual(snaps["facility"].node, snaps["stop"].node)
        self.assertAlmostEqual(snaps["facility"].offset_metres, 12.0)
        self.assertAlmostEqual(snaps["stop"].offset_metres, 8.0)
        midpoint = snaps["facility"].node
        self.assertTrue(network.graph.has_edge((0.0, 0.0), midpoint))
        self.assertTrue(network.graph.has_edge(midpoint, (1000.0, 0.0)))
        self.assertAlmostEqual(network.graph[(0.0, 0.0)][midpoint]["length"], 500.0)
        self.assertAlmostEqual(network.graph[midpoint][(1000.0, 0.0)]["length"], 500.0)

    def test_unresolved_at_grade_interior_crossing_fails(self):
        # Protected break: silently leaving an unreviewed at-grade crossing
        # disconnected understates pedestrian reach.
        source = network_rows(
            (10, LineString([(0, 0), (20, 0)])),
            (20, LineString([(10, -10), (10, 10)])),
        )

        with self.assertRaisesRegex(
            NetworkValidationError,
            r"FG03_TOPOLOGY_UNRESOLVED.*10.*20",
        ):
            build_network(source)

    def test_reviewed_grade_separated_crossing_remains_disconnected(self):
        # Protected break: blindly planarizing every geometric crossing creates
        # false pedestrian links between grade-separated paths.
        source = network_rows(
            (10, LineString([(0, 0), (20, 0)])),
            (20, LineString([(10, -10), (10, 10)])),
        )
        exception = NetworkTopologyException(
            first_objectid=10,
            second_objectid=20,
            x=10.0,
            y=0.0,
            action="keep_disconnected",
            reason="reviewed grade-separated crossing",
        )

        network = build_network(source, topology_exceptions=(exception,))

        self.assertEqual(network.metrics.interior_interior_crossings, 1)
        self.assertEqual(network.metrics.reviewed_disconnected_crossings, 1)
        self.assertFalse(network.graph.has_node((10.0, 0.0)))
        self.assertFalse(
            __import__("networkx").has_path(
                network.graph,
                (0.0, 0.0),
                (10.0, -10.0),
            )
        )

    def test_large_published_length_anomaly_requires_a_reviewed_override(self):
        # Protected break: trusting a substantially inconsistent published
        # LENGTH silently corrupts weights, while silently ignoring it loses auditability.
        source = network_rows((55757, LineString([(0, 0), (100, 0)])))
        source.loc[0, "LENGTH"] = 167.0

        with self.assertRaisesRegex(
            NetworkValidationError,
            r"FG03_LENGTH_MISMATCH.*55757",
        ):
            build_network(source)

        network = build_network(
            source,
            length_overrides=(
                NetworkLengthOverride(
                    objectid=55757,
                    action="use_geometry",
                    reason="reviewed published LENGTH anomaly",
                ),
            ),
        )
        self.assertAlmostEqual(
            sum(data["length"] for _u, _v, data in network.graph.edges(data=True)),
            100.0,
        )

    def test_reviewed_at_grade_crossing_inserts_a_connected_junction(self):
        # Protected break: treating a reviewed at-grade crossing like a bridge
        # preserves a false network detour instead of the documented junction.
        source = network_rows(
            (5263, LineString([(0, 0), (20, 0)])),
            (8263, LineString([(10, -10), (10, 10)])),
        )
        exception = NetworkTopologyException(
            first_objectid=5263,
            second_objectid=8263,
            x=10.0,
            y=0.0,
            action="connect",
            reason="reviewed at-grade trail junction",
        )

        network = build_network(source, topology_exceptions=(exception,))

        self.assertEqual(network.graph.degree[(10.0, 0.0)], 4)
        self.assertTrue(
            __import__("networkx").has_path(
                network.graph,
                (0.0, 0.0),
                (10.0, -10.0),
            )
        )


if __name__ == "__main__":
    unittest.main()

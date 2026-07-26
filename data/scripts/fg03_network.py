"""Validated pedestrian-network construction for Field Guide 03.

The graph is built in Toronto's projected CRS (EPSG:2952). Source coordinates
and every source interior vertex are retained. Entity points are projected to
source edges in one batch and their offsets remain separate from path length.
"""

from dataclasses import dataclass
import math
from typing import Iterable, Mapping

import networkx as nx
from shapely import STRtree
from shapely.geometry import LineString, Point
from shapely.ops import substring


class NetworkValidationError(RuntimeError):
    """A coded, actionable network-build failure."""


@dataclass(frozen=True, slots=True)
class NetworkTopologyException:
    first_objectid: int
    second_objectid: int
    x: float
    y: float
    action: str
    reason: str


@dataclass(frozen=True, slots=True)
class NetworkLengthOverride:
    objectid: int
    action: str
    reason: str


@dataclass(frozen=True, slots=True)
class NetworkMetrics:
    source_features: int
    source_vertices: int
    graph_nodes: int
    graph_edges: int
    component_count: int
    largest_component_share: float
    endpoint_interior_incidents: int
    interior_interior_crossings: int
    reviewed_disconnected_crossings: int


@dataclass(slots=True)
class PedestrianNetwork:
    graph: nx.Graph
    metrics: NetworkMetrics
    source_segments: tuple["SourceSegment", ...]
    source_crs: str


@dataclass(frozen=True, slots=True)
class SnapResult:
    node: tuple[float, float]
    offset_metres: float
    projected_x: float
    projected_y: float
    source_objectid: int


@dataclass(frozen=True, slots=True)
class SourceSegment:
    segment_id: int
    objectid: int
    start: tuple[float, float]
    end: tuple[float, float]
    geometry: LineString


_COORDINATE_PRECISION = 3
_TOPOLOGY_TOLERANCE = 0.02


def _node(point: Point | tuple[float, float]) -> tuple[float, float]:
    if isinstance(point, Point):
        x, y = point.x, point.y
    else:
        x, y = point
    return (
        round(float(x), _COORDINATE_PRECISION),
        round(float(y), _COORDINATE_PRECISION),
    )


def _is_endpoint(line: LineString, point: Point) -> bool:
    return (
        point.distance(Point(line.coords[0])) <= _TOPOLOGY_TOLERANCE
        or point.distance(Point(line.coords[-1])) <= _TOPOLOGY_TOLERANCE
    )


def _exception_key(
    first_objectid: int,
    second_objectid: int,
    x: float,
    y: float,
) -> tuple[int, int, float, float]:
    return (
        min(first_objectid, second_objectid),
        max(first_objectid, second_objectid),
        round(x, 2),
        round(y, 2),
    )


def _error(code: str, detail: str) -> NetworkValidationError:
    return NetworkValidationError(f"{code}: {detail}")


def build_network(
    source,
    *,
    topology_exceptions: Iterable[NetworkTopologyException] = (),
    length_overrides: Iterable[NetworkLengthOverride] = (),
) -> PedestrianNetwork:
    if source.crs is None:
        raise _error(
            "FG03_CONTRACT_INVALID",
            "pedestrian network has no CRS; assign its published CRS before building",
        )
    projected = source.to_crs(2952).explode(index_parts=False, ignore_index=True)
    required = {"OBJECTID", "LENGTH", "geometry"}
    missing = required.difference(projected.columns)
    if missing:
        raise _error(
            "FG03_INPUT_MISSING",
            f"pedestrian network is missing columns {sorted(missing)}",
        )

    raw_parts: list[tuple[int, LineString]] = []
    published_lengths: dict[int, float] = {}
    geometry_lengths: dict[int, float] = {}
    vertices: dict[tuple[float, float], Point] = {}
    for row in projected.itertuples():
        objectid = int(row.OBJECTID)
        line = row.geometry
        if line is None or line.is_empty or line.geom_type != "LineString":
            continue
        raw_parts.append((objectid, line))
        published_lengths.setdefault(objectid, float(row.LENGTH))
        geometry_lengths[objectid] = geometry_lengths.get(objectid, 0.0) + line.length
        for coordinate in line.coords:
            node = _node(coordinate[:2])
            vertices[node] = Point(node)

    overrides = {item.objectid: item for item in length_overrides}
    for objectid, geometry_length in geometry_lengths.items():
        published_length = published_lengths[objectid]
        relative_difference = abs(published_length - geometry_length) / geometry_length
        if relative_difference <= 0.25:
            continue
        override = overrides.get(objectid)
        if (
            override is None
            or override.action != "use_geometry"
            or not override.reason.strip()
        ):
            raise _error(
                "FG03_LENGTH_MISMATCH",
                f"OBJECTID {objectid} published LENGTH {published_length:.3f} "
                f"differs from projected geometry {geometry_length:.3f}; "
                "review data/fg03/network-topology-exceptions.csv",
            )

    vertex_points = tuple(vertices.values())
    vertex_tree = STRtree(vertex_points)
    segment_specs: list[tuple[int, LineString]] = []
    endpoint_interior_incidents: set[tuple[int, tuple[float, float]]] = set()
    for objectid, line in raw_parts:
        coordinates = list(line.coords)
        for start, end in zip(coordinates, coordinates[1:]):
            base = LineString([start, end])
            if base.length <= 0:
                continue
            split_distances = {0.0, base.length}
            nearby = vertex_tree.query(
                base,
                predicate="dwithin",
                distance=_TOPOLOGY_TOLERANCE,
            )
            for vertex_index in nearby:
                point = vertex_points[int(vertex_index)]
                distance = base.project(point)
                if (
                    distance > _TOPOLOGY_TOLERANCE
                    and distance < base.length - _TOPOLOGY_TOLERANCE
                    and base.distance(point) <= _TOPOLOGY_TOLERANCE
                ):
                    split_distances.add(distance)
                    endpoint_interior_incidents.add((objectid, _node(point)))
            ordered = sorted(split_distances)
            for first, second in zip(ordered, ordered[1:]):
                piece = substring(base, first, second)
                if piece.length > 0:
                    segment_specs.append((objectid, LineString(piece.coords)))

    segment_geometries = tuple(item[1] for item in segment_specs)
    segment_tree = STRtree(segment_geometries)
    reviewed = {
        _exception_key(
            item.first_objectid,
            item.second_objectid,
            item.x,
            item.y,
        ): item
        for item in topology_exceptions
    }
    unresolved: list[tuple[int, int, float, float]] = []
    reviewed_disconnected = 0
    crossing_keys: set[tuple[int, int, float, float]] = set()
    connect_splits: dict[int, set[float]] = {}
    if segment_geometries:
        pairs = segment_tree.query(segment_geometries, predicate="intersects")
        for left_index, right_index in zip(pairs[0], pairs[1]):
            left_index = int(left_index)
            right_index = int(right_index)
            if left_index >= right_index:
                continue
            left_id, left = segment_specs[left_index]
            right_id, right = segment_specs[right_index]
            if left_id == right_id:
                continue
            intersection = left.intersection(right)
            if intersection.geom_type != "Point" or intersection.is_empty:
                continue
            if _is_endpoint(left, intersection) or _is_endpoint(right, intersection):
                continue
            key = _exception_key(
                left_id,
                right_id,
                intersection.x,
                intersection.y,
            )
            crossing_keys.add(key)
            decision = reviewed.get(key)
            if decision is None:
                unresolved.append(key)
            elif decision.action == "keep_disconnected":
                reviewed_disconnected += 1
            elif decision.action == "connect":
                connect_splits.setdefault(left_index, set()).add(
                    left.project(intersection)
                )
                connect_splits.setdefault(right_index, set()).add(
                    right.project(intersection)
                )
            else:
                raise _error(
                    "FG03_CONTRACT_INVALID",
                    f"unsupported topology action {decision.action!r} for {key}",
                )
    if unresolved:
        sample = ", ".join(str(item) for item in sorted(unresolved)[:10])
        raise _error(
            "FG03_TOPOLOGY_UNRESOLVED",
            f"review interior crossings {sample} in data/fg03/network-topology-exceptions.csv",
        )
    if connect_splits:
        connected_specs: list[tuple[int, LineString]] = []
        for segment_index, (objectid, line) in enumerate(segment_specs):
            distances = sorted(
                {
                    0.0,
                    line.length,
                    *connect_splits.get(segment_index, set()),
                }
            )
            for first, second in zip(distances, distances[1:]):
                piece = substring(line, first, second)
                if piece.length > 0:
                    connected_specs.append((objectid, LineString(piece.coords)))
        segment_specs = connected_specs

    graph = nx.Graph()
    source_segments: list[SourceSegment] = []
    for segment_id, (objectid, line) in enumerate(segment_specs):
        start = _node(line.coords[0][:2])
        end = _node(line.coords[-1][:2])
        normalized = LineString([start, end])
        length = normalized.length
        if not math.isfinite(length) or length <= 0:
            raise _error(
                "FG03_CONTRACT_INVALID",
                f"OBJECTID {objectid} produced nonpositive segment length {length}",
            )
        graph.add_node(start, x=start[0], y=start[1])
        graph.add_node(end, x=end[0], y=end[1])
        attributes = {
            "length": length,
            "geometry": normalized,
            "objectid": objectid,
            "segment_id": segment_id,
        }
        if not graph.has_edge(start, end) or length < graph[start][end]["length"]:
            graph.add_edge(start, end, **attributes)
        source_segments.append(
            SourceSegment(segment_id, objectid, start, end, normalized)
        )

    component_sizes = sorted(
        (len(component) for component in nx.connected_components(graph)),
        reverse=True,
    )
    metrics = NetworkMetrics(
        source_features=len(published_lengths),
        source_vertices=len(vertices),
        graph_nodes=graph.number_of_nodes(),
        graph_edges=graph.number_of_edges(),
        component_count=len(component_sizes),
        largest_component_share=(
            component_sizes[0] / graph.number_of_nodes()
            if graph.number_of_nodes()
            else 0.0
        ),
        endpoint_interior_incidents=len(endpoint_interior_incidents),
        interior_interior_crossings=len(crossing_keys),
        reviewed_disconnected_crossings=reviewed_disconnected,
    )
    return PedestrianNetwork(
        graph=graph,
        metrics=metrics,
        source_segments=tuple(source_segments),
        source_crs="EPSG:2952",
    )


def batch_snap_points(
    network: PedestrianNetwork,
    points: Mapping[str, Point],
) -> dict[str, SnapResult]:
    if not points:
        return {}
    geometries = tuple(segment.geometry for segment in network.source_segments)
    tree = STRtree(geometries)
    projections: dict[int, dict[tuple[float, float], float]] = {}
    raw_results: dict[str, tuple[SourceSegment, Point, float]] = {}
    for entity_id, point in sorted(points.items()):
        segment_index = int(tree.nearest(point))
        segment = network.source_segments[segment_index]
        projected_distance = segment.geometry.project(point)
        projected = segment.geometry.interpolate(projected_distance)
        node = _node(projected)
        projections.setdefault(segment_index, {})[node] = projected_distance
        raw_results[entity_id] = (segment, projected, point.distance(projected))

    for segment_index, split_nodes in projections.items():
        segment = network.source_segments[segment_index]
        ordered = [
            (0.0, segment.start),
            *sorted(
                (
                    distance,
                    node,
                )
                for node, distance in split_nodes.items()
                if node not in {segment.start, segment.end}
            ),
            (segment.geometry.length, segment.end),
        ]
        if network.graph.has_edge(segment.start, segment.end):
            network.graph.remove_edge(segment.start, segment.end)
        for (first_distance, first), (second_distance, second) in zip(
            ordered, ordered[1:]
        ):
            geometry = substring(
                segment.geometry,
                first_distance,
                second_distance,
            )
            geometry = LineString(geometry.coords)
            network.graph.add_node(first, x=first[0], y=first[1])
            network.graph.add_node(second, x=second[0], y=second[1])
            network.graph.add_edge(
                first,
                second,
                length=geometry.length,
                geometry=geometry,
                objectid=segment.objectid,
                segment_id=segment.segment_id,
            )

    results = {}
    for entity_id, (segment, projected, offset) in raw_results.items():
        node = _node(projected)
        results[entity_id] = SnapResult(
            node=node,
            offset_metres=float(offset),
            projected_x=node[0],
            projected_y=node[1],
            source_objectid=segment.objectid,
        )
    return results

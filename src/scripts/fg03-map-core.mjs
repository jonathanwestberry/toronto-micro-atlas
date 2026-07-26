import {
  parseFg03State,
  serializeFg03State
} from "./fg03-state.mjs";
import {
  getAccessDisclosure,
  getActionLabel,
  getFg03HistoryEffect,
  getMatchingQueryCell,
  getSourceLabel
} from "./fg03-results.mjs";
const ACTIONS = /* @__PURE__ */ new Set(["open", "extend", "new", "verify", "retrofit"]);
const TIME_LABELS = Object.freeze({
  "1200": "Noon",
  "2030": "8:30 p.m.",
  "2200": "10 p.m.",
  "0030": "12:30 a.m."
});
const ACTION_STATUS_LABELS = Object.freeze({
  open: "current open facility records",
  extend: "audited extend-hours opportunities",
  new: "audited new-facility zones",
  verify: "audited information checks",
  retrofit: "audited accessibility retrofits"
});
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_DATA_PATH = /^\/data\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/;
const FG03_CONTEXT_FILES = Object.freeze({
  outside: "/data/outside-mask.geojson",
  lake: "/data/lake-ontario.geojson",
  minorStreets: "/data/streets-minor.geojson",
  water: "/data/watercourses.geojson",
  majorStreets: "/data/streets-major.geojson",
  rail: "/data/rail.geojson",
  boundary: "/data/toronto-boundary.geojson",
  labels: "/data/orientation-labels.geojson"
});
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function featureProperties(feature) {
  return asRecord(asRecord(feature)?.properties) ?? {};
}
function textValue(value, fallback = "Unknown") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
function finiteMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function isGeoJsonCollection(value) {
  const source = asRecord(value);
  return source?.type === "FeatureCollection" && Array.isArray(source.features);
}
function normalizeState(value) {
  return parseFg03State(
    serializeFg03State(value),
    void 0
  );
}
function safeFg03Href(value) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  if (LOCAL_DATA_PATH.test(value) && !value.includes("..") && !value.includes("\\") && !value.startsWith("//")) {
    return value;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}
function createFg03DeferredLoader({
  target,
  interactionTarget,
  start,
  createObserver
}) {
  let started = false;
  let cleaned = false;
  let disconnected = false;
  let resolvePromise = () => {
  };
  let rejectPromise = () => {
  };
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const interactionTypes = ["change", "input", "click", "keydown"];
  let observer = null;
  const disconnect = () => {
    if (disconnected) {
      return;
    }
    disconnected = true;
    observer?.disconnect();
    for (const type of interactionTypes) {
      interactionTarget.removeEventListener(type, begin);
    }
  };
  const begin = () => {
    if (!started) {
      started = true;
      disconnect();
      Promise.resolve().then(start).then(resolvePromise, rejectPromise);
    }
    return promise;
  };
  for (const type of interactionTypes) {
    interactionTarget.addEventListener(type, begin, { passive: true });
  }
  if (createObserver) {
    observer = createObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void begin();
        }
      },
      { rootMargin: "700px 0px" }
    );
    observer.observe(target);
  } else {
    void begin();
  }
  return {
    start: begin,
    promise,
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      disconnect();
      if (!started) {
        resolvePromise(void 0);
      }
    }
  };
}
async function defaultFetchJson(url, signal) {
  const safeUrl = safeFg03Href(url);
  if (safeUrl === null) {
    throw Object.assign(new TypeError("Invalid FG03 data path"), {
      fg03Kind: "invalid_data"
    });
  }
  const response = await fetch(safeUrl, {
    headers: { Accept: "application/geo+json, application/json" },
    signal
  });
  if (!response.ok) {
    throw Object.assign(new Error("FG03 data request failed"), {
      fg03Kind: "http"
    });
  }
  try {
    return await response.json();
  } catch {
    throw Object.assign(new TypeError("FG03 data was not valid JSON"), {
      fg03Kind: "parse"
    });
  }
}
function fileForSnapshot(files, snapshot) {
  const value = files[`stops${snapshot}`];
  return typeof value === "string" ? value : null;
}
async function settleGeoJson(url, fetchJson, signal) {
  const safeUrl = safeFg03Href(url);
  if (safeUrl === null) {
    throw Object.assign(new TypeError("Invalid FG03 GeoJSON path"), {
      fg03Kind: "invalid_data"
    });
  }
  const value = await fetchJson(safeUrl, signal);
  if (!isGeoJsonCollection(value)) {
    throw Object.assign(new TypeError("FG03 source is not a FeatureCollection"), {
      fg03Kind: "invalid_data"
    });
  }
  return value;
}
async function loadFg03Data({
  manifestUrl,
  snapshot,
  contextFiles = FG03_CONTEXT_FILES,
  fetchJson = defaultFetchJson,
  signal
}) {
  const safeManifestUrl = safeFg03Href(manifestUrl);
  if (safeManifestUrl === null) {
    throw Object.assign(new TypeError("Invalid FG03 manifest path"), {
      fg03Kind: "invalid_data",
      fg03Stage: "manifest"
    });
  }
  const manifestValue = await fetchJson(safeManifestUrl, signal);
  const manifestRecord = asRecord(manifestValue);
  const files = asRecord(manifestRecord?.files);
  const gate = asRecord(manifestRecord?.gate);
  if (files === null || gate === null || typeof gate.passed !== "boolean" || typeof manifestRecord?.snapshotDate !== "string") {
    throw Object.assign(new TypeError("Invalid FG03 manifest"), {
      fg03Kind: "invalid_data",
      fg03Stage: "manifest"
    });
  }
  const manifest = manifestValue;
  if (!gate.passed) {
    return {
      manifest,
      resources: null
    };
  }
  const corePromises = [
    settleGeoJson(files.facilities, fetchJson, signal),
    settleGeoJson(files.interventions, fetchJson, signal),
    settleGeoJson(fileForSnapshot(files, snapshot), fetchJson, signal)
  ];
  const contextEntries = Object.entries(contextFiles);
  const settled = await Promise.all([
    Promise.allSettled(corePromises),
    Promise.allSettled(
      contextEntries.map(([, url]) => settleGeoJson(url, fetchJson, signal))
    )
  ]);
  const [core, contextValues] = settled;
  const context = Object.fromEntries(
    contextEntries.map(([key], index) => [key, contextValues[index]])
  );
  return {
    manifest,
    resources: {
      facilities: core[0],
      interventions: core[1],
      stops: core[2],
      context
    }
  };
}
function createFg03OperationalLayers() {
  return [
    {
      id: "fg03-reach",
      type: "line",
      source: "fg03-reach",
      paint: {
        "line-color": "#8a4a70",
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 16, 3.5],
        "line-opacity": 0.72,
        "line-dasharray": [2, 1.4]
      }
    },
    {
      id: "fg03-stops-uncovered",
      type: "circle",
      source: "fg03-stops",
      paint: {
        "circle-color": "#6f716e",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.3, 16, 3.2],
        "circle-opacity": 0.34
      }
    },
    {
      id: "fg03-stops-unknown",
      type: "circle",
      source: "fg03-stops",
      metadata: {
        "fg03-condition": "unknown-or-missing"
      },
      paint: {
        "circle-color": "#f3eddd",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.8, 16, 4],
        "circle-stroke-color": "#d09020",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 16, 2],
        "circle-opacity": 0.92
      }
    },
    {
      id: "fg03-stops-covered",
      type: "circle",
      source: "fg03-stops",
      paint: {
        "circle-color": "#f3eddd",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.8, 16, 4.4],
        "circle-stroke-color": "#8a4a70",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 16, 1.8],
        "circle-opacity": 0.94
      }
    },
    {
      id: "fg03-facilities-unrestricted",
      type: "circle",
      source: "fg03-facilities",
      filter: ["==", ["get", "accessCondition"], "unrestricted"],
      paint: {
        "circle-color": "#f3eddd",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 16, 7],
        "circle-stroke-color": "#1a1f2a",
        "circle-stroke-width": 2
      }
    },
    {
      id: "fg03-facilities-fare-paid",
      type: "symbol",
      source: "fg03-facilities",
      filter: ["==", ["get", "accessCondition"], "fare_paid"],
      layout: {
        "icon-image": "fg03-fare-paid",
        "icon-allow-overlap": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.72, 16, 1.12]
      }
    },
    {
      id: "fg03-facilities-unknown",
      type: "symbol",
      source: "fg03-facilities",
      metadata: {
        "fg03-condition": "unknown-or-missing"
      },
      filter: [
        "!",
        [
          "in",
          ["get", "accessCondition"],
          ["literal", ["unrestricted", "fare_paid"]]
        ]
      ],
      layout: {
        "icon-image": "fg03-unknown",
        "icon-allow-overlap": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.72, 16, 1.12]
      }
    },
    {
      id: "fg03-interventions",
      type: "symbol",
      source: "fg03-interventions",
      layout: {
        "icon-image": [
          "match",
          ["get", "action"],
          "extend",
          "fg03-extend",
          "new",
          "fg03-new",
          "verify",
          "fg03-verify",
          "retrofit",
          "fg03-retrofit",
          "fg03-unknown"
        ],
        "icon-allow-overlap": true,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.76, 16, 1.18]
      }
    },
    {
      id: "fg03-selected-halo",
      type: "circle",
      source: "fg03-selected",
      paint: {
        "circle-color": "rgba(0,0,0,0)",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 9, 16, 16],
        "circle-stroke-color": "#d09020",
        "circle-stroke-width": 3,
        "circle-opacity": 0.98
      }
    }
  ];
}
async function initializeFg03RuntimeState({
  search,
  validPlaceIds,
  applyState,
  loadReach,
  applyCameraState,
  centerSelection
}) {
  const state = parseFg03State(search, validPlaceIds);
  const canonicalSearch = serializeFg03State(state);
  applyState(
    state,
    search === canonicalSearch ? "data-load" : "initial-cleanup"
  );
  if (state.place !== null) {
    await loadReach(state);
  }
  if (state.map !== null) {
    applyCameraState(state);
  } else if (state.place !== null) {
    centerSelection({ animate: false, state });
  }
  return state;
}
function createFg03MapStartController({
  hasMap,
  isHealthy,
  destroy,
  start
}) {
  let pending = null;
  const ensureStarted = () => {
    if (isHealthy()) {
      return Promise.resolve();
    }
    if (pending !== null) {
      return pending;
    }
    if (hasMap()) {
      destroy();
    }
    pending = Promise.resolve().then(start).catch((error) => {
      if (hasMap()) {
        destroy();
      }
      throw error;
    }).finally(() => {
      pending = null;
    });
    return pending;
  };
  return {
    start: ensureStarted
  };
}
function withholdFg03Explorer({
  controls,
  destroyMap,
  explorer,
  mapElement,
  root,
  template
}) {
  root.dataset.fg03GateStatus = "failed";
  controls.inert = true;
  controls.setAttribute("aria-disabled", "true");
  mapElement.inert = true;
  mapElement.tabIndex = -1;
  mapElement.setAttribute("aria-disabled", "true");
  destroyMap();
  explorer.replaceWith(template.content.cloneNode(true));
}
function chooseFg03CloseFocus(opener, replacement) {
  if (opener?.isConnected) {
    return opener;
  }
  return replacement?.isConnected ? replacement : null;
}
function formatFg03Status({
  action,
  access,
  count,
  time,
  walk
}) {
  const safeCount = typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  const accessLabel = access === "rider" ? "TTC rider access" : "public access";
  const actionLabel = ACTION_STATUS_LABELS[action] ?? ACTION_STATUS_LABELS.extend;
  const timeLabel = TIME_LABELS[time] ?? TIME_LABELS["2200"];
  const walkDistance = [300, 400, 500].includes(walk) ? walk : 400;
  return `Showing ${safeCount.toLocaleString("en-CA")} ${actionLabel} for ${timeLabel}, ${accessLabel}, and a ${walkDistance} m walk.`;
}
function shouldShowFg03ResultLabels(zoom) {
  return typeof zoom === "number" && Number.isFinite(zoom) && zoom >= 13.5;
}
function transitionAnalytics(state, input) {
  switch (input.cause) {
    case "time-change":
      return { name: "fg03_time_change", properties: { time: state.time } };
    case "access-change":
      return { name: "fg03_access_change", properties: { access: state.access } };
    case "walk-change":
      return { name: "fg03_walk_change", properties: { walk: String(state.walk) } };
    case "action-change":
      return { name: "fg03_action_change", properties: { action: state.action } };
    case "selection": {
      const selection = input.selection;
      if (selection && ACTIONS.has(selection.action) && ["facility", "intervention"].includes(selection.kind) && ["map", "list", "search"].includes(selection.source)) {
        return {
          name: "fg03_feature_select",
          properties: {
            action: selection.action,
            kind: selection.kind,
            source: selection.source
          }
        };
      }
      return null;
    }
    default:
      return null;
  }
}
function reduceFg03Transition(current, input) {
  const candidate = input.nextState ?? { ...current, ...input.patch };
  const state = normalizeState(candidate);
  const isReplay = input.cause === "popstate";
  return {
    state,
    history: isReplay ? "none" : getFg03HistoryEffect(input.cause),
    analytics: isReplay ? null : transitionAnalytics(state, input),
    focusDetail: input.cause === "selection",
    animateMap: input.cause === "selection",
    restoreFocus: input.cause === "close"
  };
}
function writeFg03History({
  effect,
  history,
  location,
  state
}) {
  if (effect === "none") {
    return;
  }
  let existing = {};
  try {
    existing = asRecord(history.state) ?? {};
  } catch {
    existing = {};
  }
  const snapshot = {
    ...state,
    map: state.map === null ? null : [...state.map]
  };
  const nextHistoryState = {
    ...existing,
    fg03: snapshot
  };
  const url = `${location.pathname}${serializeFg03State(snapshot)}${location.hash}`;
  if (effect === "push") {
    history.pushState(nextHistoryState, "", url);
  } else {
    history.replaceState(nextHistoryState, "", url);
  }
}
function appendDefinition(document, list, term, value) {
  const wrapper = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = value;
  wrapper.append(dt, dd);
  list.append(wrapper);
}
function resultMetrics(feature) {
  const properties = featureProperties(feature);
  const action = properties.action;
  if (typeof action !== "string") {
    return null;
  }
  const cell = getMatchingQueryCell(feature, {
    access: "public",
    action,
    time: "2200",
    walk: 400
  });
  return cell ? {
    activeStops: finiteMetric(cell.activeStops),
    uniqueRoutes: finiteMetric(cell.uniqueRoutes),
    uniqueTrips: finiteMetric(cell.uniqueTrips)
  } : null;
}
function renderFg03ResultItem({
  document,
  feature,
  metrics = resultMetrics(feature),
  selected = false,
  onSelect
}) {
  const properties = featureProperties(feature);
  const id = textValue(properties.id, "");
  const item = document.createElement("li");
  item.setAttribute("data-fg03-result-item", "");
  item.setAttribute("data-fg03-result-id", id);
  item.setAttribute("data-selected", String(selected));
  const summary = document.createElement("div");
  summary.className = "fg03-result-summary";
  const action = document.createElement("p");
  action.className = "fg03-result-rank";
  action.textContent = getActionLabel(feature) || "Current open washroom";
  const title = document.createElement("h4");
  title.textContent = textValue(properties.name, "Unnamed place");
  summary.append(action, title);
  if (metrics !== null) {
    const metricsList = document.createElement("dl");
    appendDefinition(
      document,
      metricsList,
      "GTFS stops and platforms",
      metrics.activeStops.toLocaleString("en-CA")
    );
    appendDefinition(
      document,
      metricsList,
      "Scheduled trips",
      metrics.uniqueTrips.toLocaleString("en-CA")
    );
    appendDefinition(
      document,
      metricsList,
      "Routes",
      metrics.uniqueRoutes.toLocaleString("en-CA")
    );
    summary.append(metricsList);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fg03-result-map-button";
  button.setAttribute("data-fg03-select-place", id);
  button.setAttribute(
    "aria-label",
    `Show ${textValue(properties.name, "this place")} on the map`
  );
  button.textContent = "Show on map";
  if (onSelect && SAFE_ID.test(id)) {
    button.addEventListener("click", () => onSelect(id, button));
  }
  summary.append(button);
  const details = document.createElement("details");
  details.setAttribute("data-fg03-result-evidence", "");
  const detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "Read the evidence";
  const evidence = document.createElement("div");
  const access = getAccessDisclosure(feature);
  const sourceLabel = getSourceLabel(feature);
  const evidenceRows = [
    ["Action", getActionLabel(feature) || "Current open washroom"],
    ["Access condition", access?.label ?? textValue(properties.accessCondition)],
    ["Published hours", textValue(properties.hours, "Not published")],
    ["Closure evidence", textValue(properties.closureCategory, "Not classified")],
    ["Accessibility", textValue(properties.accessibility, "Not published")],
    ["Stability", textValue(properties.stability, "Not evaluated")],
    ["Audit status", textValue(properties.auditStatus, "Not applicable")],
    ["Source", sourceLabel || textValue(properties.source, "Official source")]
  ];
  for (const [label, value] of evidenceRows) {
    const paragraph = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    paragraph.append(strong);
    const valueNode = document.createElement("span");
    valueNode.textContent = value;
    paragraph.append(valueNode);
    evidence.append(paragraph);
  }
  const sourceUrl = safeFg03Href(properties.sourceUrl);
  if (sourceUrl !== null) {
    const sourceParagraph = document.createElement("p");
    const sourceLink = document.createElement("a");
    sourceLink.setAttribute("href", sourceUrl);
    sourceLink.setAttribute("rel", "noopener noreferrer");
    sourceLink.textContent = "Open the official source";
    sourceParagraph.append(sourceLink);
    evidence.append(sourceParagraph);
  }
  details.append(detailsSummary, evidence);
  item.append(summary, details);
  return item;
}
function createFg03Cleanup({
  controller,
  observer = null,
  timers = /* @__PURE__ */ new Set(),
  animationFrames = /* @__PURE__ */ new Set(),
  removeListeners = [],
  clearTimer = window.clearTimeout.bind(window),
  cancelFrame = window.cancelAnimationFrame.bind(window),
  getMap = () => null
}) {
  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    observer?.disconnect();
    controller.abort();
    for (const id of timers) {
      clearTimer(id);
    }
    timers.clear();
    for (const id of animationFrames) {
      cancelFrame(id);
    }
    animationFrames.clear();
    for (const remove of removeListeners) {
      remove();
    }
    removeListeners.length = 0;
    const map = getMap();
    try {
      map?.stop();
    } catch {
    }
    try {
      map?.remove();
    } catch {
    }
  };
}
function createFg03LifecycleController({
  eventTarget,
  shouldMount,
  init
}) {
  let started = false;
  let disposed = false;
  let activeCleanup = null;
  let inFlight = null;
  let generation = 0;
  const teardown = () => {
    generation += 1;
    const cleanup = activeCleanup;
    activeCleanup = null;
    cleanup?.();
  };
  const mount = () => {
    if (!started || disposed || !shouldMount() || activeCleanup !== null || inFlight !== null) {
      return;
    }
    const token = generation;
    inFlight = init().then((cleanup) => {
      if (disposed || token !== generation || !shouldMount()) {
        cleanup();
      } else {
        activeCleanup = cleanup;
      }
    }).finally(() => {
      inFlight = null;
    });
  };
  const onPageLoad = () => mount();
  const onBeforeSwap = () => teardown();
  return {
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      eventTarget.addEventListener("astro:page-load", onPageLoad);
      eventTarget.addEventListener("astro:before-swap", onBeforeSwap);
      mount();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      eventTarget.removeEventListener("astro:page-load", onPageLoad);
      eventTarget.removeEventListener("astro:before-swap", onBeforeSwap);
      teardown();
    }
  };
}
export {
  FG03_CONTEXT_FILES,
  createFg03Cleanup,
  createFg03DeferredLoader,
  createFg03LifecycleController,
  createFg03MapStartController,
  createFg03OperationalLayers,
  chooseFg03CloseFocus,
  formatFg03Status,
  initializeFg03RuntimeState,
  loadFg03Data,
  reduceFg03Transition,
  renderFg03ResultItem,
  safeFg03Href,
  shouldShowFg03ResultLabels,
  withholdFg03Explorer,
  writeFg03History
};

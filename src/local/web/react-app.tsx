import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Database,
  Expand,
  FileCode2,
  Focus,
  GitBranch,
  Globe,
  LayoutDashboard,
  List,
  LoaderCircle,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Entity, Relationship, Provenance } from "../../graph/model.ts";
import type { GraphView } from "../presentation.ts";
import type { ImpactResult } from "../../analysis/impact.ts";
import { layoutTopology, NODE_HEIGHT, NODE_WIDTH } from "./layout.ts";
import { relationshipCurve, relationshipLanes } from "./relationship-path.ts";
import "@xyflow/react/dist/style.css";

type Detail = {
  entity: Entity;
  incoming: Linked[];
  outgoing: Linked[];
  provenance: { provenance: Provenance[] } | null;
};
type Linked = { relationship: Relationship; entity: Entity | null };
type Selection =
  | { kind: "entity"; detail: Detail }
  | { kind: "edge"; relationship: Relationship };
type Subgraph = { entities: Entity[]; relationships: Relationship[] };
type EntityNodeData = { entity: Entity; connections: number; dimmed: boolean };
type EntityNode = Node<EntityNodeData, "entity">;
const VIEWS: {
  id: string;
  name: string;
  icon: LucideIcon;
  description: string;
}[] = [
  {
    id: "architecture",
    name: "Architecture",
    icon: Network,
    description: "Applications, APIs, and the systems that support them.",
  },
  {
    id: "dependencies",
    name: "Dependencies",
    icon: GitBranch,
    description: "Trace the dependencies between projects and components.",
  },
  {
    id: "infrastructure",
    name: "Infrastructure",
    icon: Cloud,
    description:
      "Declared cloud resources, workloads, and deployment topology.",
  },
  {
    id: "messaging",
    name: "Messaging",
    icon: Radio,
    description: "Publishers, contracts, transports, and consumers.",
  },
  {
    id: "frontend",
    name: "Frontend",
    icon: Globe,
    description: "Explore routes, applications, and their API connections.",
  },
  {
    id: "meta",
    name: "MetaGraph",
    icon: Workflow,
    description:
      "Shared resources and connections across analyzed repositories.",
  },
];
const nameOf = (entity: { name: string; qualifiedName?: string | null }) =>
  entity.name || entity.qualifiedName || "Unnamed entity";
const duration = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240;
const toneOf = (kind: string) =>
  /Azure|Kubernetes|Deployment|Database|DataStore|Storage/.test(kind)
    ? "teal"
    : /Message|Topic|Queue|Contract/.test(kind)
      ? "violet"
      : /Application|Api|Endpoint|Frontend/.test(kind)
        ? "blue"
        : "neutral";
function iconOf(kind: string): LucideIcon {
  if (/Database|DataStore|Storage/.test(kind)) return Database;
  if (/Azure|Kubernetes|Deployment/.test(kind)) return Cloud;
  if (/Message|Topic|Queue/.test(kind)) return Radio;
  if (/Api|Endpoint|Http/.test(kind)) return Braces;
  if (/Application|Frontend/.test(kind)) return Globe;
  if (/File/.test(kind)) return FileCode2;
  if (/Type|Method|Property/.test(kind)) return Code2;
  if (/Repository|Project/.test(kind)) return GitBranch;
  return Box;
}
async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(
      result?.error ?? `Could not read the local graph (${response.status}).`,
    );
  }
  return response.json() as Promise<T>;
}
function EntityCard({ data, selected }: NodeProps<EntityNode>) {
  const Icon = iconOf(data.entity.kind);
  return (
    <div
      className={`entity-card ${toneOf(data.entity.kind)} ${selected ? "is-selected" : ""} ${data.dimmed ? "is-dimmed" : ""}`}
      title={data.entity.qualifiedName ?? data.entity.name}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-heading">
        <span className="node-icon">
          <Icon size={18} aria-hidden="true" />
        </span>
        <div>
          <span className="node-kind">{data.entity.kind}</span>
          <strong>{nameOf(data.entity)}</strong>
        </div>
      </div>
      <div className="node-footer">
        <span>{data.entity.language ?? data.entity.layer}</span>
        <span>
          <GitBranch size={12} aria-hidden="true" />
          {data.connections} {data.connections === 1 ? "link" : "links"}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const NODE_TYPES = { entity: EntityCard };
type RelationshipEdge = Edge<
  { relationship: Relationship; lane: number; self: boolean },
  "relationship"
>;
function RelationshipLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps<RelationshipEdge>) {
  const scale = useStore(
    (state) => 2 ** (Math.round(Math.log2(state.transform[2]) * 4) / 4),
  );
  const curve = relationshipCurve(
    sourceX,
    sourceY,
    targetX,
    targetY,
    data?.lane ?? 0,
    data?.self ?? false,
  );
  return (
    <>
      <BaseEdge
        id={id}
        path={curve.path}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth: Number(style?.strokeWidth ?? 1.4) / scale,
        }}
        interactionWidth={16}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="relationship-edge-label nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${curve.labelX}px, ${curve.labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const EDGE_TYPES = { relationship: RelationshipLine };

function App() {
  const [view, setView] = useState("architecture");
  const [complete, setComplete] = useState(false);
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [status, setStatus] = useState<{
    repository: {
      name: string;
      status: string;
      graphVersion: string | null;
    } | null;
    root: string;
  } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hidden, setHidden] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Entity[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edgeLabels, setEdgeLabels] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [compact, setCompact] = useState(() => window.innerWidth <= 900);
  const [inspector, setInspector] = useState(() => window.innerWidth > 900);
  const [textView, setTextView] = useState(false);
  const [relationshipList, setRelationshipList] = useState(false);
  const [relationshipPage, setRelationshipPage] = useState(0);
  const [focused, setFocused] = useState(false);
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<EntityNode> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<EntityNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [zoom, setZoom] = useState(100);
  const nodesInitialized = useNodesInitialized();
  const searchRef = useRef<HTMLInputElement>(null);
  const selectionRequest = useRef(0);
  const currentView = VIEWS.find((item) => item.id === view)!;
  const visibleEntities = useMemo(
    () => graph?.entities.filter((entity) => !hidden.has(entity.kind)) ?? [],
    [graph, hidden],
  );
  const visibleRelationships = useMemo(() => {
    const ids = new Set(visibleEntities.map((entity) => entity.id));
    return (
      graph?.relationships.filter(
        (relationship) =>
          ids.has(relationship.sourceId) && ids.has(relationship.targetId),
      ) ?? []
    );
  }, [graph, visibleEntities]);
  const listedRelationships = useMemo(() => {
    const hiddenIds = new Set(
      graph?.entities
        .filter((entity) => hidden.has(entity.kind))
        .map((entity) => entity.id),
    );
    return (
      graph?.relationships.filter(
        (edge) =>
          !hiddenIds.has(edge.sourceId) && !hiddenIds.has(edge.targetId),
      ) ?? []
    );
  }, [graph, hidden]);
  const entityIndex = useMemo(
    () => new Map(graph?.entities.map((entity) => [entity.id, entity]) ?? []),
    [graph],
  );
  useEffect(() => setRelationshipPage(0), [graph, hidden]);
  const degree = useMemo(() => {
    const result = new Map<string, number>();
    for (const relationship of visibleRelationships)
      for (const id of new Set([relationship.sourceId, relationship.targetId]))
        result.set(id, (result.get(id) ?? 0) + 1);
    return result;
  }, [visibleRelationships]);
  const leaders = useMemo(
    () =>
      [...visibleEntities]
        .filter((entity) => degree.has(entity.id))
        .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
        .slice(0, 3),
    [visibleEntities, degree],
  );
  const selectedId =
    selection?.kind === "entity" ? selection.detail.entity.id : null;
  const fit = useCallback(() => {
    void flow?.fitView({ padding: 0.22, maxZoom: 1, duration: duration() });
  }, [flow]);

  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    void api<typeof status>("/api/status")
      .then(setStatus)
      .catch((reason: Error) => setError(reason.message));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    selectionRequest.current++;
    setBusy("Loading graph");
    setGraph(null);
    setSelection(null);
    setImpact(null);
    setHidden(new Set());
    setFocused(false);
    setError(null);
    void api<GraphView>(
      `/api/graph?view=${view}&complete=${complete ? "1" : "0"}`,
      controller.signal,
    )
      .then(setGraph)
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [view, complete]);
  useEffect(() => {
    const positions = layoutTopology(visibleEntities, visibleRelationships);
    setNodes(
      visibleEntities.map((entity) => ({
        id: entity.id,
        type: "entity",
        position: positions.get(entity.id)!,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: {
          entity,
          connections: degree.get(entity.id) ?? 0,
          dimmed: false,
        },
        ariaLabel: `${entity.kind}: ${nameOf(entity)}`,
        selected: false,
      })),
    );
  }, [visibleEntities, visibleRelationships, degree, setNodes]);
  useEffect(() => {
    const hits = new Set(matches.map((entity) => entity.id));
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        selected:
          node.id === selectedId || (query.length > 0 && hits.has(node.id)),
        data: {
          ...node.data,
          dimmed: false,
        },
      })),
    );
    const lanes = relationshipLanes(visibleRelationships);
    setEdges(
      visibleRelationships.map((relationship) => {
        const active =
          relationship.id ===
            (selection?.kind === "edge" ? selection.relationship.id : null) ||
          relationship.sourceId === selectedId ||
          relationship.targetId === selectedId;
        return {
          id: relationship.id,
          source: relationship.sourceId,
          target: relationship.targetId,
          type: "relationship",
          data: {
            relationship,
            lane: lanes.get(relationship.id) ?? 0,
            self: relationship.sourceId === relationship.targetId,
          },
          label: edgeLabels || active ? relationship.type : undefined,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: active ? "#80c6b5" : "#626b77",
            markerUnits: "userSpaceOnUse",
          },
          style: {
            stroke: active ? "#80c6b5" : "#626b77",
            strokeWidth: active ? 2 : complete && !focused ? 0.7 : 1.4,
            vectorEffect: "non-scaling-stroke",
            opacity: 0.9,
            strokeDasharray: /INFERRED|HEURISTIC|UNKNOWN/.test(
              relationship.evidence,
            )
              ? "5 5"
              : undefined,
          },
          labelStyle: {
            fill: "#c8d0da",
            fontSize: 11,
            fontFamily: "monospace",
          },
          labelBgStyle: { fill: "#171b21" },
          selected: active,
        };
      }),
    );
  }, [
    visibleRelationships,
    selectedId,
    selection,
    matches,
    query,
    edgeLabels,
    complete,
    focused,
    setNodes,
    setEdges,
  ]);
  useEffect(() => {
    if (!nodesInitialized) return;
    const timer = window.setTimeout(fit, 90);
    return () => clearTimeout(timer);
  }, [visibleEntities, fit, nodesInitialized, inspector]);
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      setSearchBusy(false);
      return;
    }
    const controller = new AbortController();
    setSearchBusy(true);
    setMatches([]);
    const timer = window.setTimeout(() => {
      void api<{ items: Entity[] }>(
        `/api/search?q=${encodeURIComponent(query.trim())}`,
        controller.signal,
      )
        .then((result) => setMatches(result.items))
        .catch((reason: Error) => {
          if (reason.name !== "AbortError") setError(reason.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchBusy(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setShowSearch(false);
        setSidebar(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);
  const selectEntity = useCallback(
    async (id: string) => {
      const request = ++selectionRequest.current;
      setBusy("Reading entity");
      setError(null);
      setImpact(null);
      setInspector(true);
      try {
        const detail = await api<Detail>(
          `/api/entity/${encodeURIComponent(id)}?meta=${view === "meta" ? "1" : "0"}`,
        );
        if (request === selectionRequest.current)
          setSelection({ kind: "entity", detail });
      } catch (reason) {
        if (request === selectionRequest.current)
          setError((reason as Error).message);
      } finally {
        if (request === selectionRequest.current) setBusy(null);
      }
    },
    [view],
  );
  const explore = async (id = selectedId, replace = false) => {
    if (!id || !graph) return;
    setBusy("Exploring neighborhood");
    setError(null);
    try {
      const neighborhood = await api<Subgraph>(
        `/api/entity/${encodeURIComponent(id)}/neighborhood?depth=1&meta=${view === "meta" ? "1" : "0"}`,
      );
      const entities = [
        ...new Map(
          [...(replace ? [] : graph.entities), ...neighborhood.entities].map(
            (entity) => [entity.id, entity],
          ),
        ).values(),
      ];
      const relationships = [
        ...new Map(
          [
            ...(replace ? [] : graph.relationships),
            ...neighborhood.relationships,
          ].map((relationship) => [relationship.id, relationship]),
        ).values(),
      ];
      const counts = new Map<string, number>();
      for (const entity of entities)
        counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
      setGraph({
        ...graph,
        entities,
        relationships,
        categories: [...counts].map(([kind, count]) => ({
          kind: kind as Entity["kind"],
          count,
        })),
        truncated: false,
        coverage: undefined,
      });
      setHidden(new Set());
      setFocused(replace);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const traceImpact = async () => {
    if (!selectedId) return;
    setBusy("Tracing impact");
    setError(null);
    try {
      setImpact(
        await api<ImpactResult>(
          `/api/entity/${encodeURIComponent(selectedId)}/impact`,
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    setSelection(null);
    setImpact(null);
    setHidden(new Set());
    setFocused(false);
    setError(null);
    setBusy("Resetting graph");
    try {
      setGraph(
        await api<GraphView>(
          `/api/graph?view=${view}&complete=${complete ? "1" : "0"}`,
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const searchSelect = (entity: Entity) => {
    setShowSearch(false);
    void selectEntity(entity.id);
    if (!visibleEntities.some((item) => item.id === entity.id))
      void explore(entity.id, true);
    else
      void flow?.fitView({
        nodes: [{ id: entity.id }],
        maxZoom: 1,
        duration: duration(),
        padding: 0.8,
      });
  };
  const repositoryName = status?.repository?.name ?? "Repository graph";
  const total = graph?.entities.length ?? 0;
  return (
    <div
      className={`workspace ${sidebar ? "sidebar-open" : ""} ${inspector ? "with-inspector" : ""}`}
    >
      <aside
        className="sidebar"
        aria-label="Workspace navigation"
        inert={compact && !sidebar}
      >
        <a
          href="#"
          className="brand"
          onClick={(event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <span className="brand-mark">
            <Network size={20} aria-hidden="true" />
          </span>
          <strong>
            vogoban<span> / </span>
          </strong>
        </a>
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        >
          <X size={18} />
        </button>
        <div className="workspace-label">WORKSPACE</div>
        <div className="repo-card">
          <GitBranch size={16} aria-hidden="true" />
          <div>
            <strong title={repositoryName}>{repositoryName}</strong>
            <span>
              <i />
              RepositoryGraph · local
            </span>
          </div>
        </div>
        <div className="workspace-label">EXPLORE</div>
        <nav aria-label="Graph views">
          {VIEWS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "active" : ""}`}
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => {
                  setView(item.id);
                  setComplete(false);
                  setSidebar(false);
                }}
              >
                <Icon size={17} aria-hidden="true" />
                {item.name}
                {view === item.id && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="filter-heading">
          <span className="workspace-label">ENTITY TYPES</span>
          <SlidersHorizontal size={14} aria-hidden="true" />
        </div>
        <div className="type-filters">
          {graph?.categories.map((category) => (
            <label key={category.kind}>
              <input
                type="checkbox"
                checked={!hidden.has(category.kind)}
                onChange={() =>
                  setHidden((current) => {
                    const next = new Set(current);
                    next.has(category.kind)
                      ? next.delete(category.kind)
                      : next.add(category.kind);
                    return next;
                  })
                }
              />
              <span className={`type-dot ${toneOf(category.kind)}`} />
              {category.kind}
              <span className="count">{category.count}</span>
            </label>
          ))}
        </div>
        <div className="sidebar-bottom">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>Your code stays yours.</strong>
            <span>Local graph. No uploads.</span>
          </div>
        </div>
      </aside>
      {compact && sidebar && (
        <button
          className="nav-scrim"
          aria-label="Close navigation backdrop"
          onClick={() => setSidebar(false)}
        />
      )}
      <div className="workspace-body" inert={compact && sidebar}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label={sidebar ? "Close navigation" : "Open navigation"}
              onClick={() => setSidebar(!sidebar)}
            >
              {sidebar ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
            <GitBranch size={15} aria-hidden="true" />
            <span title={repositoryName}>{repositoryName}</span>
            <ChevronRight size={14} aria-hidden="true" />
            <strong>{currentView.name}</strong>
          </div>
          <div className="global-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              aria-label="Search graph"
              placeholder="Search architecture…"
              value={query}
              onFocus={() => setShowSearch(true)}
              onChange={(event) => {
                setQuery(event.target.value);
                setShowSearch(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches[0] && !searchBusy)
                  searchSelect(matches[0]);
              }}
            />
            <kbd>⌘ K</kbd>
            {showSearch && query && (
              <div className="search-popover">
                <div className="search-caption">
                  {searchBusy
                    ? "Searching local graph…"
                    : `${matches.length} matching entities`}
                </div>
                {matches.map((entity) => {
                  const Icon = iconOf(entity.kind);
                  return (
                    <button
                      key={entity.id}
                      onClick={() => searchSelect(entity)}
                    >
                      <Icon size={17} aria-hidden="true" />
                      <span>
                        <strong>{nameOf(entity)}</strong>
                        <small>{entity.kind}</small>
                      </span>
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  );
                })}
                {!searchBusy && !matches.length && (
                  <p>
                    No matching entities. Try a service, route, or resource
                    name.
                  </p>
                )}
              </div>
            )}
          </div>
          <span className="local-badge">
            <i />
            Local
          </span>
        </header>
        <div className="workspace-heading">
          <div>
            <div className="eyebrow">REPOSITORY INTELLIGENCE</div>
            <h1>
              {focused
                ? "Focused neighborhood"
                : complete
                  ? "All relationships"
                  : currentView.name}
              <span className="view-count">{visibleEntities.length}</span>
            </h1>
            <p>
              {focused
                ? "Direct, evidence-backed relationships around the selected entity."
                : complete
                  ? `Complete ${view === "meta" ? "MetaGraph" : "RepositoryGraph"}, including every stored relationship and its endpoints.`
                  : currentView.description}
            </p>
          </div>
          <div className="heading-actions">
            <button className="button secondary" onClick={() => void reset()}>
              <RotateCcw size={15} aria-hidden="true" />
              Reset view
            </button>
            <button className="button primary" onClick={fit}>
              <Expand size={15} aria-hidden="true" />
              Fit graph
            </button>
          </div>
        </div>
        <div className="canvas-toolbar">
          <div className="display-switch" aria-label="Display mode">
            <button
              className={!textView ? "selected" : ""}
              aria-pressed={!textView}
              onClick={() => setTextView(false)}
            >
              <Network size={14} aria-hidden="true" />
              Graph
            </button>
            <button
              className={textView && !relationshipList ? "selected" : ""}
              aria-pressed={textView && !relationshipList}
              onClick={() => {
                setTextView(true);
                setRelationshipList(false);
              }}
            >
              <List size={14} aria-hidden="true" />
              List
            </button>
            <button
              className={textView && relationshipList ? "selected" : ""}
              aria-pressed={textView && relationshipList}
              aria-label="Relationship list"
              onClick={() => {
                setTextView(true);
                setRelationshipList(true);
              }}
            >
              <GitBranch size={14} aria-hidden="true" />
              Edges
            </button>
          </div>
          <span className="toolbar-divider" />
          <span className="toolbar-stat">
            {visibleEntities.length} entities<span> / </span>
            {visibleRelationships.length} relationships
          </span>
          <div className="toolbar-right">
            <button
              className={`toolbar-button ${edgeLabels ? "enabled" : ""}`}
              aria-pressed={edgeLabels}
              aria-label="Toggle edge labels"
              onClick={() => setEdgeLabels(!edgeLabels)}
            >
              <GitBranch size={14} aria-hidden="true" />
              Edge labels
            </button>
            <button
              className="icon-button"
              aria-label={inspector ? "Hide inspector" : "Show inspector"}
              onClick={() => setInspector(!inspector)}
            >
              {inspector ? (
                <PanelRightClose size={17} />
              ) : (
                <PanelRightOpen size={17} />
              )}
            </button>
          </div>
        </div>
        <div className="edge-coverage" role="status">
          <span>
            {graph?.coverage
              ? complete && !focused && hidden.size === 0
                ? `All ${graph.coverage.storedRelationships.toLocaleString()} stored relationships loaded`
                : `${visibleRelationships.length.toLocaleString()} of ${graph.coverage.storedRelationships.toLocaleString()} stored relationships ${complete ? "shown (type filters)" : "in this projection"}`
              : `${visibleRelationships.length.toLocaleString()} relationships in this neighborhood`}
            {graph?.coverage?.missingEndpointIds.length
              ? ` · ${graph.coverage.missingEndpointIds.length} missing endpoints; inspect the Edges list`
              : ""}
          </span>
          <div>
            {hidden.size > 0 && (
              <button onClick={() => setHidden(new Set())}>
                Clear type filters
              </button>
            )}
            <button
              disabled={!!busy}
              aria-pressed={complete && !focused}
              onClick={() => {
                setHidden(new Set());
                if (focused && complete) void reset();
                else setComplete(!complete);
              }}
            >
              {complete && !focused
                ? `Use ${currentView.name} projection`
                : "Show all relationships"}
            </button>
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <CircleHelp size={16} aria-hidden="true" />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="graph-area">
          <section className="stage" aria-label="Graph explorer">
            {textView && relationshipList ? (
              <div className="all-relationships-list">
                <div className="list-heading">
                  <span>Source → target</span>
                  <span>Relationship</span>
                  <span>Evidence</span>
                </div>
                {listedRelationships
                  .slice(relationshipPage * 100, (relationshipPage + 1) * 100)
                  .map((relationship) => (
                    <button
                      key={relationship.id}
                      onClick={() => {
                        setSelection({ kind: "edge", relationship });
                        setInspector(true);
                      }}
                    >
                      <span>
                        {nameOf(
                          entityIndex.get(relationship.sourceId) ?? {
                            name: relationship.sourceId,
                          },
                        )}
                        <ArrowRight size={13} aria-hidden="true" />
                        {nameOf(
                          entityIndex.get(relationship.targetId) ?? {
                            name: relationship.targetId,
                          },
                        )}
                      </span>
                      <span>{relationship.type}</span>
                      <span>{relationship.evidence}</span>
                    </button>
                  ))}
                {!listedRelationships.length && (
                  <p className="muted">
                    No relationships match the current type filters.
                  </p>
                )}
                <div className="relationship-pagination">
                  <button
                    disabled={relationshipPage === 0}
                    onClick={() => setRelationshipPage((page) => page - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    {listedRelationships.length
                      ? relationshipPage * 100 + 1
                      : 0}
                    –
                    {Math.min(
                      (relationshipPage + 1) * 100,
                      listedRelationships.length,
                    )}{" "}
                    of {listedRelationships.length.toLocaleString()} stored
                    relationships
                  </span>
                  <button
                    disabled={
                      (relationshipPage + 1) * 100 >= listedRelationships.length
                    }
                    onClick={() => setRelationshipPage((page) => page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : textView ? (
              <div className="entity-list">
                <div className="list-heading">
                  <span>Entity</span>
                  <span>Type</span>
                  <span>Relationships</span>
                </div>
                {visibleEntities.map((entity) => {
                  const Icon = iconOf(entity.kind);
                  return (
                    <button
                      key={entity.id}
                      onClick={() => void selectEntity(entity.id)}
                    >
                      <span>
                        <Icon size={17} aria-hidden="true" />
                        {nameOf(entity)}
                      </span>
                      <span>{entity.kind}</span>
                      <span>
                        {degree.get(entity.id) ?? 0}
                        <ChevronRight size={14} aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : graph && visibleEntities.length ? (
              <ReactFlow<EntityNode>
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onInit={setFlow}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={(_, node) => void selectEntity(node.id)}
                onEdgeClick={(_, edge) => {
                  const relationship = graph.relationships.find(
                    (item) => item.id === edge.id,
                  );
                  if (relationship) {
                    selectionRequest.current++;
                    setBusy(null);
                    setSelection({ kind: "edge", relationship });
                    setInspector(true);
                  }
                }}
                onMove={(_, viewport) =>
                  setZoom(Math.round(viewport.zoom * 100))
                }
                minZoom={complete ? 0.002 : 0.08}
                maxZoom={2}
                nodesConnectable={false}
                onlyRenderVisibleElements={nodesInitialized}
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                ariaLabelConfig={{
                  "node.a11yDescription.default":
                    "Select an entity with Enter or Space to inspect its relationships. Use arrow keys to move it.",
                }}
              >
                <Background color="#2a2e35" gap={22} size={1} />
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap<EntityNode>
                  nodeColor={(node) =>
                    ({
                      teal: "#7cbfb0",
                      blue: "#8aafda",
                      violet: "#b6a2d3",
                      neutral: "#a1a6af",
                    })[toneOf(node.data.entity.kind)]!
                  }
                  nodeBorderRadius={5}
                  maskColor="#111317aa"
                  pannable
                  zoomable
                />
              </ReactFlow>
            ) : (
              <div className="empty-state">
                <span>
                  <Network size={30} aria-hidden="true" />
                </span>
                <h2>
                  {busy
                    ? "Loading local graph"
                    : total
                      ? "No visible entities"
                      : view === "meta"
                        ? "No MetaGraph connections yet"
                        : "No graph to explore yet"}
                </h2>
                <p>
                  {busy
                    ? "Reading repository intelligence from your local workspace."
                    : total
                      ? "Enable an entity type in the sidebar to continue exploring."
                      : view === "meta"
                        ? "Build the MetaGraph after analyzing connected repositories."
                        : "Analyze this repository to uncover its architecture."}
                </p>
                {!busy && (
                  <code>
                    {view === "meta"
                      ? "vogoban metagraph build"
                      : "vogoban analyze ."}
                  </code>
                )}
              </div>
            )}
            {busy && graph && (
              <div className="loading-pill" role="status">
                <LoaderCircle size={15} aria-hidden="true" />
                {busy}
              </div>
            )}
            {!textView && visibleEntities.length > 0 && (
              <div className="canvas-legend">
                <span>
                  <i className="blue" />
                  Application
                </span>
                <span>
                  <i className="teal" />
                  Infrastructure
                </span>
                <span>
                  <i className="violet" />
                  Contract
                </span>
              </div>
            )}
          </section>
          {inspector && (
            <Inspector
              selection={selection}
              graph={graph}
              leaders={leaders}
              degree={degree}
              selectEntity={selectEntity}
              expand={() => void explore()}
              focus={() => void explore(selectedId, true)}
              impact={impact}
              traceImpact={() => void traceImpact()}
              close={() => setInspector(false)}
              busy={!!busy}
            />
          )}
        </div>
        <footer className="statusbar">
          <span>
            <ShieldCheck size={13} aria-hidden="true" />
            Repository-scoped<span className="status-divider">·</span>Evidence
            from source, not AI
          </span>
          <span>
            {graph?.truncated
              ? "Partial view · refine or explore a neighborhood"
              : graph?.coverage?.mode === "complete"
                ? "Complete stored graph · type filters are explicit"
                : "Projected view · use Show all relationships for the full graph"}
            <span className="status-divider">·</span>
            {zoom}%
          </span>
        </footer>
      </div>
    </div>
  );
}

function Inspector({
  selection,
  graph,
  leaders,
  degree,
  selectEntity,
  expand,
  focus,
  impact,
  traceImpact,
  close,
  busy,
}: {
  selection: Selection | null;
  graph: GraphView | null;
  leaders: Entity[];
  degree: Map<string, number>;
  selectEntity: (id: string) => Promise<void>;
  expand: () => void;
  focus: () => void;
  impact: ImpactResult | null;
  traceImpact: () => void;
  close: () => void;
  busy: boolean;
}) {
  const [tab, setTab] = useState("relationships");
  useEffect(() => setTab("relationships"), [selection]);
  const edge = selection?.kind === "edge" ? selection.relationship : null;
  const detail = selection?.kind === "entity" ? selection.detail : null;
  const entity = detail?.entity;
  const Icon = entity
    ? iconOf(entity.kind)
    : edge
      ? GitBranch
      : LayoutDashboard;
  const linkRow = (item: Linked, direction: "in" | "out") => (
    <div className="relationship-row" key={item.relationship.id}>
      <span className="direction-icon">
        {direction === "in" ? (
          <ArrowDownLeft size={15} />
        ) : (
          <ArrowUpRight size={15} />
        )}
      </span>
      <div>
        <button
          disabled={!item.entity}
          onClick={() => item.entity && void selectEntity(item.entity.id)}
        >
          {item.entity ? nameOf(item.entity) : "Unresolved entity"}
        </button>
        <small>{item.relationship.type}</small>
        <details className="edge-evidence">
          <summary>
            {item.relationship.evidence}
            <ChevronDown size={11} aria-hidden="true" />
          </summary>
          <Evidence items={item.relationship.provenance} />
          <span>Confidence: {item.relationship.confidence}</span>
        </details>
      </div>
    </div>
  );
  return (
    <aside className="inspector" aria-label="Graph inspector">
      <div className="inspector-heading">
        <span>{selection ? "INSPECTOR" : "GRAPH OVERVIEW"}</span>
        <button
          className="icon-button"
          aria-label="Close inspector"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <div className="inspector-content">
        <div
          className={`inspector-icon ${entity ? toneOf(entity.kind) : "neutral"}`}
        >
          <Icon size={22} aria-hidden="true" />
        </div>
        <h2>
          {entity
            ? nameOf(entity)
            : edge
              ? edge.type
              : "Understand the connections."}
        </h2>
        <p className="inspector-description">
          {entity
            ? `${entity.kind} · ${entity.language ?? entity.layer}`
            : edge
              ? "A stored relationship, backed by graph evidence."
              : "Select an entity to explore its relationships, source evidence, and change impact."}
        </p>
        {detail && (
          <>
            <div className="entity-identity">
              <span>Canonical identity</span>
              <code>{detail.entity.qualifiedName ?? detail.entity.key}</code>
            </div>
            <div className="entity-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={focus}
              >
                <Focus size={14} />
                Focus
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={expand}
              >
                <Expand size={14} />
                Expand
              </button>
            </div>
            <div className="inspector-tabs" aria-label="Entity detail sections">
              <button
                className={tab === "relationships" ? "active" : ""}
                onClick={() => setTab("relationships")}
              >
                Relationships
                <span>{detail.incoming.length + detail.outgoing.length}</span>
              </button>
              <button
                className={tab === "evidence" ? "active" : ""}
                onClick={() => setTab("evidence")}
              >
                Evidence
              </button>
            </div>
            {tab === "relationships" ? (
              <>
                <div className="section-title">
                  OUTBOUND <span>{detail.outgoing.length}</span>
                </div>
                {detail.outgoing.length ? (
                  detail.outgoing.map((item) => linkRow(item, "out"))
                ) : (
                  <p className="muted">No outgoing relationships recorded.</p>
                )}
                <div className="section-title">
                  INBOUND <span>{detail.incoming.length}</span>
                </div>
                {detail.incoming.length ? (
                  detail.incoming.map((item) => linkRow(item, "in"))
                ) : (
                  <p className="muted">No incoming relationships recorded.</p>
                )}
                <div className="impact-card">
                  <div>
                    <Activity size={16} />
                    <strong>What changes downstream?</strong>
                  </div>
                  <p>Trace potential impact using the existing graph engine.</p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={traceImpact}
                  >
                    Explore impact
                    <ArrowRight size={14} />
                  </button>
                </div>
                {impact && (
                  <div className="impact-results">
                    <div className="section-title">
                      IMPACT <span>{impact.impacted.length}</span>
                    </div>
                    <p className="muted">
                      {impact.truncated
                        ? "Bounded results; further impact may exist."
                        : "Within four hops of this entity."}
                    </p>
                    {impact.impacted.map((item) => (
                      <div className="impact-row" key={item.entity.id}>
                        <button
                          onClick={() => void selectEntity(item.entity.id)}
                        >
                          {item.entity.name}
                        </button>
                        <span>
                          {item.level} · {item.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="section-title">SOURCE PROVENANCE</div>
                <Evidence items={detail.provenance?.provenance ?? []} />
                <div className="entity-identity">
                  <span>Graph entity ID</span>
                  <code>{detail.entity.id}</code>
                </div>
                {detail.entity.location && (
                  <div className="source-location">
                    <FileCode2 size={15} />
                    <code>
                      {detail.entity.location.file}:
                      {detail.entity.location.startLine}
                    </code>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {edge && (
          <>
            <div className="evidence-badge">
              <ShieldCheck size={14} />
              {edge.evidence}
            </div>
            <div className="entity-identity">
              <span>Source → target</span>
              <code>
                {nameOf(
                  graph?.entities.find(
                    (entity) => entity.id === edge.sourceId,
                  ) ?? { name: edge.sourceId },
                )}
                <br />↓<br />
                {nameOf(
                  graph?.entities.find(
                    (entity) => entity.id === edge.targetId,
                  ) ?? { name: edge.targetId },
                )}
              </code>
            </div>
            <div className="section-title">PROVENANCE</div>
            <Evidence items={edge.provenance} />
            <p className="muted">Confidence: {edge.confidence}</p>
          </>
        )}
        {!selection && (
          <>
            <div className="overview-metrics">
              <div>
                <strong>{graph?.entities.length ?? "—"}</strong>
                <span>Entities</span>
              </div>
              <div>
                <strong>{graph?.relationships.length ?? "—"}</strong>
                <span>Relationships</span>
              </div>
            </div>
            <div className="section-title">
              MOST CONNECTED <span>IN THIS VIEW</span>
            </div>
            {leaders.length ? (
              leaders.map((entity) => (
                <button
                  className="leader-row"
                  key={entity.id}
                  onClick={() => void selectEntity(entity.id)}
                >
                  <span className={`leader-icon ${toneOf(entity.kind)}`}>
                    <GitBranch size={16} />
                  </span>
                  <span>
                    <strong>{nameOf(entity)}</strong>
                    <small>
                      {degree.get(entity.id)} observed relationships
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))
            ) : (
              <p className="muted">
                No connections in this projection. Select an entity to explore
                its stored neighborhood.
              </p>
            )}
            <div className="provenance-note">
              <ShieldCheck size={18} />
              <strong>Architecture you can verify.</strong>
              <p>
                Every connection comes from the stored graph. Inspect its
                evidence to understand why it exists.
              </p>
            </div>
            <div className="section-title">EXPLORATION GUIDE</div>
            <div className="guide-row">
              <span>01</span>
              <div>
                <strong>Find a starting point</strong>
                <p>Search for a service, API, or resource.</p>
              </div>
            </div>
            <div className="guide-row">
              <span>02</span>
              <div>
                <strong>Follow the relationships</strong>
                <p>Focus on a node or expand its neighborhood.</p>
              </div>
            </div>
            <div className="guide-row">
              <span>03</span>
              <div>
                <strong>Check the evidence</strong>
                <p>Inspect source locations and analyzer provenance.</p>
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
function Evidence({ items }: { items: Provenance[] }) {
  return (
    <div className="evidence-list">
      {items.length ? (
        items.map((item, index) => (
          <div className="evidence-item" key={`${item.plugin}-${index}`}>
            <div>
              <FileCode2 size={14} aria-hidden="true" />
              <strong>
                {item.location
                  ? item.location.file.split("/").pop()
                  : item.plugin}
              </strong>
              {item.location && <span>L{item.location.startLine}</span>}
            </div>
            {item.location && <code>{item.location.file}</code>}
            <p>
              {item.plugin} · {item.extractor}
            </p>
            <small>{item.mechanism}</small>
          </div>
        ))
      ) : (
        <p className="muted">No source provenance recorded.</p>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </StrictMode>,
);

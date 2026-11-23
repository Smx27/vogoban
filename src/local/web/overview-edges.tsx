import { useEffect, useMemo, useRef } from "react";
import { useStore } from "@xyflow/react";
import type { Relationship } from "../../graph/model.ts";
import {
  overviewGeometry,
  overviewRadius,
  type OverviewNode,
} from "./overview.ts";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout.ts";

export type OverviewPicker = (point: { x: number; y: number }) => string | null;
export type OverviewEdgesProps = {
  nodes: OverviewNode[];
  relationships: Relationship[];
  selectedId: string | null;
  selectedRelationshipId: string | null;
  labels: boolean;
  onPicker: (picker: OverviewPicker | null) => void;
};

export function OverviewEdges({
  nodes,
  relationships,
  selectedId,
  selectedRelationshipId,
  labels,
  onPicker,
}: OverviewEdgesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transform = useStore((state) => state.transform);
  const transformRef = useRef(transform);
  const redraw = useRef<(() => void) | null>(null);
  transformRef.current = transform;
  const paths = useMemo(() => {
    return overviewGeometry(nodes, relationships)
      .map((geometry) => ({
        ...geometry,
        path2d: new Path2D(geometry.path),
        priority:
          geometry.id === selectedRelationshipId
            ? 2
            : geometry.sourceId === selectedId ||
                geometry.targetId === selectedId
              ? 1
              : 0,
      }))
      .sort((a, b) => a.priority - b.priority);
  }, [nodes, relationships, selectedId, selectedRelationshipId]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    onPicker((point) => {
      context.save();
      context.resetTransform();
      context.setLineDash([]);
      context.lineWidth = 14 / transformRef.current[2];
      context.lineCap = "round";
      let hit: string | null = null;
      for (let index = paths.length - 1; index >= 0; index--) {
        const edge = paths[index]!;
        if (context.isPointInStroke(edge.path2d, point.x, point.y)) {
          hit = edge.id;
          break;
        }
      }
      context.restore();
      return hit;
    });
    return () => onPicker(null);
  }, [onPicker, paths]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      context.resetTransform();
      context.clearRect(0, 0, canvas.width, canvas.height);
      const [x, y, zoom] = transformRef.current;
      context.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);
      context.lineCap = "round";
      context.lineJoin = "round";
      for (const edge of paths) {
        const active = edge.priority > 0;
        context.strokeStyle = active ? "#80c6b5" : "#626b77";
        context.fillStyle = context.strokeStyle;
        context.globalAlpha = active ? 1 : 0.8;
        context.lineWidth =
          (edge.priority === 2 ? 2.4 : active ? 1.8 : zoom < 0.2 ? 0.5 : 0.8) /
          zoom;
        context.setLineDash(
          /INFERRED|HEURISTIC|UNKNOWN/.test(edge.relationship.evidence)
            ? [5 / zoom, 5 / zoom]
            : [],
        );
        context.stroke(edge.path2d);
        context.setLineDash([]);
        if (zoom >= 0.2 || edge.priority > 0) {
          const arrowSize = 6 / zoom;
          context.save();
          context.translate(edge.targetX, edge.targetY);
          context.rotate(edge.arrowAngle);
          context.beginPath();
          context.moveTo(0, 0);
          context.lineTo(-arrowSize, -arrowSize * 0.5);
          context.lineTo(-arrowSize, arrowSize * 0.5);
          context.closePath();
          context.fill();
          context.restore();
        }
        if (labels || edge.priority === 2) {
          const text = edge.relationship.type;
          context.font = `${11 / zoom}px monospace`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          const textWidth = context.measureText(text).width;
          context.fillStyle = "#171b21";
          context.fillRect(
            edge.labelX - textWidth / 2 - 4 / zoom,
            edge.labelY - 8 / zoom,
            textWidth + 8 / zoom,
            16 / zoom,
          );
          context.fillStyle = "#c8d0da";
          context.fillText(text, edge.labelX, edge.labelY);
        }
      }
      if (zoom < 0.22) {
        context.setLineDash([]);
        for (const node of nodes) {
          const kind = node.data.entity?.kind ?? "";
          const color =
            /Azure|Kubernetes|Deployment|Database|DataStore|Storage/.test(kind)
              ? "#88cbb9"
              : /Message|Topic|Queue|Contract/.test(kind)
                ? "#c1addd"
                : /Application|Api|Endpoint|Frontend/.test(kind)
                  ? "#9ab8e4"
                  : "#b0b9c7";
          const radius = Math.max(
            2.4 / zoom,
            overviewRadius(node.data.connections),
          );
          context.globalAlpha = 1;
          context.beginPath();
          context.arc(
            node.position.x + NODE_WIDTH / 2,
            node.position.y + NODE_HEIGHT / 2,
            radius,
            0,
            Math.PI * 2,
          );
          context.fillStyle = "#1e2229";
          context.fill();
          context.lineWidth = (node.id === selectedId ? 2 : 1) / zoom;
          context.strokeStyle = node.id === selectedId ? "#91d1bd" : color;
          context.stroke();
        }
      }
      context.resetTransform();
      context.globalAlpha = 1;
      canvas.dataset.renderedRelationships = String(paths.length);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    redraw.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
      redraw.current = null;
    };
  }, [paths, nodes, selectedId, selectedRelationshipId, labels]);

  useEffect(() => {
    redraw.current?.();
  }, [transform]);

  return (
    <canvas
      ref={canvasRef}
      className="overview-edges"
      aria-hidden="true"
      data-rendered-relationships={0}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}

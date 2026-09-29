import { useMemo, useState } from "react";
import type { Project } from "../../../../shared/protocol.ts";

export type DropEdge = "before" | "after";

const storageKey = (environment: string) => `citropy.globalProjectOrder.${environment}`;

function readProjectOrder(environment: string): string[] {
  try {
    const order = JSON.parse(localStorage.getItem(storageKey(environment)) ?? "[]");
    return Array.isArray(order) ? order.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function orderProjects(projects: Project[], order: string[]): Project[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...projects].sort((a, b) => (positions.get(a.id) ?? -1) - (positions.get(b.id) ?? -1));
}

export function useProjectOrder(projectsByEnvironment: Record<string, Project[]>) {
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const orderedProjects = useMemo(() => Object.fromEntries(Object.entries(projectsByEnvironment).map(([environment, projects]) =>
    [environment, orderProjects(projects, orders[environment] ?? readProjectOrder(environment))],
  )), [projectsByEnvironment, orders]);
  const moveProject = (environment: string, source: string, target: string, edge: DropEdge) => {
    const ids = (orderedProjects[environment] ?? []).map((project) => project.id);
    if (source === target || !ids.includes(source) || !ids.includes(target)) return;
    ids.splice(ids.indexOf(source), 1);
    ids.splice(ids.indexOf(target) + (edge === "after" ? 1 : 0), 0, source);
    localStorage.setItem(storageKey(environment), JSON.stringify(ids));
    setOrders((current) => ({ ...current, [environment]: ids }));
  };
  const moveProjectBy = (environment: string, projectId: string, direction: -1 | 1) => {
    const projects = orderedProjects[environment] ?? [];
    const index = projects.findIndex((project) => project.id === projectId);
    const adjacent = projects[index + direction];
    if (index >= 0 && adjacent) moveProject(environment, projectId, adjacent.id, direction < 0 ? "before" : "after");
  };
  return { orderedProjects, moveProject, moveProjectBy };
}

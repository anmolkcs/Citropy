const skippedRoles = new Set(["InlineTextBox", "LineBreak"]);
const silentRoles = new Set(["generic", "image", "none", "StaticText", "paragraph", "group", "LabelText", "list", "listitem", "section", "Section", "RootWebArea", "WebArea"]);
const reportedStates = ["focused", "disabled", "checked", "pressed", "selected", "expanded", "required", "invalid"];

function visible(node) {
  if (node.ignored || skippedRoles.has(node.role?.value)) return false;
  return Boolean(node.name?.value?.trim() || node.value?.value) || !silentRoles.has(node.role?.value);
}

function states(node) {
  const found = [];
  for (const property of node.properties ?? []) {
    if (!reportedStates.includes(property.name)) continue;
    const value = property.value?.value;
    if (property.name === "expanded") found.push(value ? "expanded" : "collapsed");
    else if (value === true || value === "true") found.push(property.name);
    else if (value === "mixed") found.push(`${property.name}=mixed`);
  }
  return found;
}

function line(node, depth) {
  const role = node.role?.value ?? "";
  const name = node.name?.value?.trim() ? ` ${JSON.stringify(node.name.value.trim())}` : "";
  const value = node.value?.value !== undefined && node.value.value !== "" ? ` value=${JSON.stringify(node.value.value)}` : "";
  const flags = states(node);
  const id = node.ref ?? node.backendDOMNodeId;
  const ref = id ? ` [ref=${id}]` : "";
  return `${"  ".repeat(depth)}${role}${name}${value}${flags.length ? ` (${flags.join(", ")})` : ""}${ref}`;
}

export function formatTree(nodes, rootBackendId) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const hasParent = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = rootBackendId === undefined
    ? nodes.filter((node) => !hasParent.has(node.nodeId))
    : nodes.filter((node) => String(node.ref ?? node.backendDOMNodeId) === String(rootBackendId));
  const lines = [];
  const labelled = (node) => node.role?.value !== "StaticText" ? node.name?.value?.trim() : undefined;
  const walk = (node, depth, nearbyNames) => {
    const repeats = node.role?.value === "StaticText" && nearbyNames.has(node.name?.value?.trim());
    const shown = !repeats && (visible(node) || (rootBackendId !== undefined && String(node.ref ?? node.backendDOMNodeId) === String(rootBackendId)));
    if (shown) lines.push(line(node, depth));
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);
    const names = new Set(shown ? [node.name?.value?.trim()] : nearbyNames);
    for (const child of children) if (labelled(child)) names.add(labelled(child));
    for (const child of children) walk(child, shown ? depth + 1 : depth, names);
  };
  for (const root of roots) walk(root, 0, new Set());
  return lines;
}

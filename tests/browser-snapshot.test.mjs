import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTree } from "../desktop/browser-snapshot.mjs";

const node = (nodeId, role, name, childIds = [], extra = {}) => ({ nodeId, role: { value: role }, name: { value: name }, childIds, ...extra });

const nodes = [
  node("1", "RootWebArea", "Settings", ["2"], { backendDOMNodeId: 1 }),
  node("2", "generic", "", ["3", "6"], { backendDOMNodeId: 2 }),
  node("3", "navigation", "Sections", ["4", "5"], { backendDOMNodeId: 3 }),
  node("4", "button", "General", [], { backendDOMNodeId: 4, properties: [{ name: "focused", value: { value: true } }] }),
  node("5", "button", "Appearance", ["9", "10"], { backendDOMNodeId: 5, properties: [{ name: "expanded", value: { value: false } }] }),
  node("9", "InlineTextBox", "Appearance"),
  node("10", "StaticText", "Appearance", [], { backendDOMNodeId: 10 }),
  node("6", "checkbox", "Sounds", [], { backendDOMNodeId: 6, properties: [{ name: "checked", value: { value: "true" } }] }),
  node("7", "generic", "", [], { ignored: true }),
];

test("snapshots nest named elements, drop empty containers, and give refs and states", () => {
  assert.deepEqual(formatTree(nodes), [
    'RootWebArea "Settings" [ref=1]',
    '  navigation "Sections" [ref=3]',
    '    button "General" (focused) [ref=4]',
    '    button "Appearance" (collapsed) [ref=5]',
    '  checkbox "Sounds" (checked) [ref=6]',
  ]);
});

test("a scoped snapshot starts at the chosen element even when it is an unnamed container", () => {
  assert.deepEqual(formatTree(nodes, 2), [
    "generic [ref=2]",
    '  navigation "Sections" [ref=3]',
    '    button "General" (focused) [ref=4]',
    '    button "Appearance" (collapsed) [ref=5]',
    '  checkbox "Sounds" (checked) [ref=6]',
  ]);
});

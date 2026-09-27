const applied = new WeakMap<Element, string | string[]>();
const streamed = new WeakMap<Element, { joined: string; blocks: string[]; counts: number[] }>();

function markupOf(node: Node): string {
  return node instanceof Element ? node.outerHTML : `${node.nodeType}:${node.textContent ?? ""}`;
}

function parse(html: string): Node[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.childNodes];
}

export function patchHtml(root: Element, html: string): void {
  const stored = applied.get(root);
  if (stored === html) return;
  if (stored === undefined) {
    root.innerHTML = html;
    applied.set(root, html);
    return;
  }
  streamed.delete(root);
  const previous = typeof stored === "string" ? parse(stored).map(markupOf) : stored;
  const incoming = parse(html);
  const markup = incoming.map(markupOf);
  let keep = 0;
  while (keep < markup.length && keep < previous.length && keep < root.childNodes.length && markup[keep] === previous[keep]) keep++;
  while (root.childNodes.length > keep) root.lastChild!.remove();
  for (let index = keep; index < incoming.length; index++) root.appendChild(incoming[index]!);
  applied.set(root, markup);
}

export function patchBlocks(root: Element, blocks: string[]): void {
  const joined = blocks.join("");
  const state = streamed.get(root);
  const current = state && applied.get(root) === state.joined ? state : undefined;
  if (current?.joined === joined) return;
  let keep = 0;
  if (current) while (keep < blocks.length && keep < current.blocks.length && blocks[keep] === current.blocks[keep]) keep++;
  const counts = current ? current.counts.slice(0, keep) : [];
  const nodes = counts.reduce((total, count) => total + count, 0);
  while (root.childNodes.length > nodes) root.lastChild!.remove();
  for (const block of blocks.slice(keep)) {
    const incoming = parse(block);
    counts.push(incoming.length);
    root.append(...incoming);
  }
  applied.set(root, joined);
  streamed.set(root, { joined, blocks, counts });
}

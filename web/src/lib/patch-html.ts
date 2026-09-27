const applied = new WeakMap<Element, string | string[]>();
const streamed = new WeakMap<Element, { joined: string; blocks: string[]; counts: number[] }>();
const rawCodeOpen = '<pre class="raw"><code>';
const rawCodeClose = "</code></pre></figure>";

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
  let nodes = counts.reduce((total, count) => total + count, 0);
  const previous = current?.blocks[keep];
  const next = blocks[keep];
  const paragraph = root.childNodes[nodes];
  if (previous?.startsWith("<p>") && previous.endsWith("</p>\n") &&
      next?.endsWith("</p>\n") && next.startsWith(previous.slice(0, -5)) &&
      !/[<\r]/.test(next.slice(3, -5)) && !/&[^;]*$/.test(previous.slice(3, -5)) && current?.counts[keep] === 2 &&
      paragraph instanceof HTMLParagraphElement && paragraph.attributes.length === 0 &&
      paragraph.childNodes.length === 1 && paragraph.firstChild instanceof Text) {
    const suffix = parse(next.slice(previous.length - 5, -5));
    if (suffix.every(node => node instanceof Text)) {
      paragraph.firstChild.appendData(suffix.map(node => node.textContent).join(""));
      counts.push(2);
      nodes += 2;
      keep++;
    }
  } else if (previous?.startsWith('<figure class="code-block" data-lang="') &&
      previous.endsWith(rawCodeClose) && next?.endsWith(rawCodeClose) &&
      next.startsWith(previous.slice(0, -rawCodeClose.length)) && current?.counts[keep] === 1 &&
      paragraph instanceof HTMLElement && paragraph.tagName === "FIGURE" && paragraph.childNodes.length === 2 &&
      paragraph.firstElementChild?.tagName === "FIGCAPTION") {
    const start = previous.indexOf(rawCodeOpen) + rawCodeOpen.length;
    const pre = paragraph.lastElementChild;
    const code = pre?.firstElementChild;
    if (start >= rawCodeOpen.length && !/[<\r]/.test(next.slice(start, -rawCodeClose.length)) && !/&[^;]*$/.test(previous.slice(start, -rawCodeClose.length)) &&
        pre instanceof HTMLPreElement && pre.className === "raw" && pre.childNodes.length === 1 &&
        code?.tagName === "CODE" && code.attributes.length === 0 &&
        (code.childNodes.length === 0 || (code.childNodes.length === 1 && code.firstChild instanceof Text))) {
      const suffix = parse(next.slice(previous.length - rawCodeClose.length, -rawCodeClose.length));
      if (suffix.every(node => node instanceof Text)) {
        if (code.firstChild instanceof Text) code.firstChild.appendData(suffix.map(node => node.textContent).join(""));
        else code.append(...suffix);
        counts.push(1);
        nodes++;
        keep++;
      }
    }
  }
  while (root.childNodes.length > nodes) root.lastChild!.remove();
  for (const block of blocks.slice(keep)) {
    const incoming = parse(block);
    counts.push(incoming.length);
    root.append(...incoming);
  }
  applied.set(root, joined);
  streamed.set(root, { joined, blocks, counts });
}

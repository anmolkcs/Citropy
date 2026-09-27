import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

test("streaming Markdown patches", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await browser.close(); await server.close(); assert.deepEqual(errors, []); });
  await page.route("**/patch-fixture.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><div id=fixture></div></body></html>" }));
  await page.goto(new URL("patch-fixture.html", server.resolvedUrls.local[0]).href);

  await t.test("plain append preserves the paragraph, text selection and finished blocks", async () => {
    const result = await page.evaluate(async () => {
      const { patchBlocks } = await import("/web/src/lib/patch-html.ts");
      const root = document.querySelector("#fixture");
      patchBlocks(root, ["<p>Finished.</p>\n", "<p>Plain</p>\n"]);
      const finished = root.firstChild;
      const paragraph = root.children[1];
      const text = paragraph.firstChild;
      finished.dataset.state = "kept";
      const range = document.createRange();
      range.setStart(text, 1);
      range.setEnd(text, 4);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      const observer = new MutationObserver(() => {});
      observer.observe(root, { childList: true, characterData: true, subtree: true });
      const blocks = ["<p>Finished.</p>\n", "<p>Plain &amp; &lt; Unicode 😀 é</p>\n"];
      patchBlocks(root, blocks);
      const mutations = observer.takeRecords().map(record => record.type);
      patchBlocks(root, blocks);
      const repeated = observer.takeRecords().length;
      observer.disconnect();
      const result = {
        paragraphRetained: root.children[1] === paragraph,
        textRetained: paragraph.firstChild === text,
        finishedRetained: root.firstChild === finished && finished.dataset.state === "kept",
        text: paragraph.textContent,
        selection: getSelection().toString(),
        mutations,
        repeated,
      };
      patchBlocks(root, [blocks[0], "<p>Plain &amp; &lt; Unicode 😀 é continues</p>\n", "<p>Next</p>\n"]);
      result.finishedParagraphRetained = root.children[1] === paragraph;
      result.next = root.children[2].textContent;
      return result;
    });
    assert.deepEqual(result, {
      paragraphRetained: true, textRetained: true, finishedRetained: true,
      text: "Plain & < Unicode 😀 é", selection: "lai", mutations: ["characterData"], repeated: 0,
      finishedParagraphRetained: true, next: "Next",
    });
  });

  await t.test("reinterpretation and non-text structures match full HTML replacement", async () => {
    const mismatches = await page.evaluate(async () => {
      const { patchBlocks } = await import("/web/src/lib/patch-html.ts");
      const cases = [
        ["<p>A</p>\n", "<p>A<strong> bold</strong></p>\n"],
        ["<p>Before</p>\n", "<p>Changed</p>\n"],
        ["<p>&cop</p>\n", "<p>&copy;</p>\n"],
        ["<p>&not</p>\n", "<p>&notin;</p>\n"],
        ["<p>Line\r</p>\n", "<p>Line\r\nnext</p>\n"],
        ["<p>Text</p>\n", "<h2>Text</h2>\n"],
        ["<p>Text</p>\n", "<p>Text<br>next</p>\n"],
        ["<p><a href='https://one.invalid'>Link</a></p>\n", "<p><a href='https://two.invalid'>Link</a></p>\n"],
        ["<p><img src='/first.png' alt='First'></p>\n", "<p><img src='/next.png' alt='Next'></p>\n"],
        ["<figure><pre><code>code</code></pre></figure>", "<figure data-lang='ts'><pre><code><span>code</span> next</code></pre></figure>"],
        ["<p>Text</p>\n", "<p>Text</p>\n<ul><li>Item</li></ul>\n"],
        ["<p>Two paragraphs</p>\n<p>Next</p>\n", "<p>Two paragraphs</p>\n<p>Next changed</p>\n"],
      ];
      return cases.flatMap(([previous, next], index) => {
        const root = document.createElement("div");
        const expected = document.createElement("div");
        patchBlocks(root, [previous]);
        patchBlocks(root, [next]);
        expected.innerHTML = next;
        return root.innerHTML === expected.innerHTML ? [] : [{ index, actual: root.innerHTML, expected: expected.innerHTML }];
      });
    });
    assert.deepEqual(mismatches, []);
  });

  await t.test("open code appends preserve generated controls, selection and scroll", async () => {
    const result = await page.evaluate(async () => {
      const { patchBlocks } = await import("/web/src/lib/patch-html.ts");
      const { renderStreamingMarkdown } = await import("/web/src/lib/markdown.ts");
      const root = document.createElement("div");
      document.querySelector("#fixture").replaceChildren(root);
      const source = "Finished.\n\n```javascript\nconst value = '" + "x".repeat(500) + "';\nconst second = 2;\nconst third = 3;\nconst fourth = 4;";
      const first = await renderStreamingMarkdown(source, "dark", undefined, undefined, { images: false }, { source: "", html: [] });
      patchBlocks(root, first.blocks);
      const finished = root.firstChild;
      const figure = root.querySelector("figure");
      const button = figure.querySelector("button");
      const pre = figure.querySelector("pre");
      const code = pre.firstElementChild;
      const text = code.firstChild;
      button.dataset.copied = "";
      button.setAttribute("aria-label", "Copied");
      Object.assign(pre.style, { width: "220px", maxHeight: "36px", overflow: "auto", lineHeight: "18px" });
      pre.scrollLeft = 180;
      pre.scrollTop = 18;
      const scroll = [pre.scrollLeft, pre.scrollTop];
      const range = document.createRange();
      range.setStart(text, 6);
      range.setEnd(text, 11);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      const observer = new MutationObserver(() => {});
      observer.observe(root, { childList: true, characterData: true, subtree: true });
      const nextSource = source + "\nconst symbols = '&copy; <safe> 😀 é';";
      const next = await renderStreamingMarkdown(nextSource, "dark", undefined, undefined, { images: false }, first.finished);
      patchBlocks(root, next.blocks);
      const expected = document.createElement("div");
      expected.innerHTML = next.blocks.join("");
      const result = {
        figureRetained: root.querySelector("figure") === figure,
        buttonRetained: figure.querySelector("button") === button,
        codeRetained: pre.firstElementChild === code && code.firstChild === text,
        finishedRetained: root.firstChild === finished,
        copiedRetained: button.hasAttribute("data-copied") && button.getAttribute("aria-label") === "Copied",
        scrollRetained: pre.scrollLeft === scroll[0] && pre.scrollTop === scroll[1],
        scrolled: scroll.every(value => value > 0),
        selection: getSelection().toString(),
        matches: code.innerHTML === expected.querySelector("code").innerHTML,
        mutations: observer.takeRecords().map(record => record.type),
        unsafeElements: code.children.length,
      };
      observer.disconnect();
      const closed = await renderStreamingMarkdown(nextSource + "\n```", "dark", undefined, undefined, { images: false }, next.finished);
      patchBlocks(root, closed.blocks);
      expected.innerHTML = closed.blocks.join("");
      result.highlighted = !root.querySelector("pre").classList.contains("raw");
      result.closedMatches = root.innerHTML === expected.innerHTML;
      result.closedReplaced = root.querySelector("figure") !== figure;
      return result;
    });
    assert.deepEqual(result, {
      figureRetained: true, buttonRetained: true, codeRetained: true, finishedRetained: true,
      copiedRetained: true, scrollRetained: true, scrolled: true, selection: "value",
      matches: true, mutations: ["characterData"], unsafeElements: 0,
      highlighted: true, closedMatches: true, closedReplaced: true,
    });
  });

  await t.test("raw code empty content and fallback boundaries match full HTML replacement", async () => {
    const result = await page.evaluate(async () => {
      const { patchBlocks } = await import("/web/src/lib/patch-html.ts");
      const raw = (text, lang = "text") => `<figure class="code-block" data-lang="${lang}"><figcaption><span>${lang}</span><button class="code-copy">Copy</button></figcaption><pre class="raw"><code>${text}</code></pre></figure>`;
      const cases = [
        [raw(""), raw("&lt;safe&gt; &amp;copy; 😀"), true],
        [raw("&cop"), raw("&copy;"), false],
        [raw("&not"), raw("&notin;"), false],
        [raw("line\r"), raw("line\r\nnext"), false],
        [raw("before"), raw("replacement"), false],
        [raw("prefix"), raw("prefix next", "javascript"), false],
        [raw("prefix"), raw("prefix<span> next</span>"), false],
        [raw("prefix"), raw("prefix next").replace('class="raw"', 'class="shiki"'), false],
        [raw("prefix"), raw("prefix next").replace(">Copy<", ">Copiar<"), false],
        [raw("prefix"), raw("prefix next") + "<p>Next block</p>\n", false],
      ];
      const mismatches = [];
      for (const [index, [previous, next, retain]] of cases.entries()) {
        const root = document.createElement("div");
        const expected = document.createElement("div");
        patchBlocks(root, [previous]);
        const figure = root.firstChild;
        patchBlocks(root, [next]);
        expected.innerHTML = next;
        if (root.innerHTML !== expected.innerHTML || (root.firstChild === figure) !== retain) mismatches.push(index);
      }
      return mismatches;
    });
    assert.deepEqual(result, []);
  });

  await t.test("incremental Markdown remains exact through entities, formatting, code and completion", async () => {
    const result = await page.evaluate(async () => {
      const { patchBlocks, patchHtml } = await import("/web/src/lib/patch-html.ts");
      const { renderMarkdown, renderStreamingMarkdown } = await import("/web/src/lib/markdown.ts");
      const root = document.createElement("div");
      const expected = document.createElement("div");
      let source = "";
      let finished = { source: "", html: [] };
      const segments = ["Hello 😀", " &", "copy;", " **strong", "** and [link]", "(https://example.invalid)", "\n\nParagraph", " more", "\n\n- first", "\n- second", "\n\n```text\n", "const value = '<safe>';", "\n```", "\n\nLast paragraph", " ends."];
      const mismatches = [];
      for (const [index, segment] of segments.entries()) {
        source += segment;
        const rendered = await renderStreamingMarkdown(source, "dark", undefined, undefined, { images: false }, finished);
        finished = rendered.finished;
        patchBlocks(root, rendered.blocks);
        expected.innerHTML = rendered.blocks.join("");
        if (root.innerHTML !== expected.innerHTML) mismatches.push(index);
      }
      const final = await renderMarkdown(source, "dark", undefined, undefined, { images: false });
      patchHtml(root, final);
      expected.innerHTML = final;
      return { mismatches, finalMatches: root.innerHTML === expected.innerHTML, unsafeElements: root.querySelectorAll("safe").length };
    });
    assert.deepEqual(result, { mismatches: [], finalMatches: true, unsafeElements: 0 });
  });
});

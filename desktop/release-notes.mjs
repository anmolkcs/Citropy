function plain(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

export function parseReleaseNotes(markdown) {
  const sections = [];
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      sections.push({ title: plain(heading[1]), items: [] });
      continue;
    }
    const item = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!item) continue;
    if (!sections.length) sections.push({ title: "", items: [] });
    sections.at(-1).items.push(plain(item[1]));
  }
  return sections.filter((section) => section.items.length);
}

export async function fetchReleaseNotes(repository, version) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the Citropy ${version} release notes.`);
  return parseReleaseNotes((await response.json()).body);
}

export async function fetchReleaseHistory(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=50`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the Citropy release list.`);
  return (await response.json())
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({ version: release.tag_name.replace(/^v/, ""), sections: parseReleaseNotes(release.body) }))
    .filter((release) => release.sections.length);
}

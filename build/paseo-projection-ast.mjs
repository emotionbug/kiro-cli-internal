import { readFile } from "node:fs/promises";

export const PASEO_FORK_COMMIT = "c3bac24ccc2df8dcc67d807c805db0efa0817dff";

export async function trustedForkSource(observed) {
  const inputs = JSON.parse(await readFile(new URL("./inputs.json", import.meta.url), "utf8"));
  const source = inputs.assets.paseoFork;
  if (!source || source.commit !== PASEO_FORK_COMMIT ||
      source.repository !== "https://github.com/emotionbug/paseo.git" ||
      source.url !== `https://codeload.github.com/emotionbug/paseo/tar.gz/${PASEO_FORK_COMMIT}` ||
      !/^[a-f0-9]{64}$/.test(source.sha256))
    throw new Error("Projection requires the explicitly pinned Paseo fork archive");
  if (observed && ["repository", "commit", "url", "sha256"].some((key) => observed[key] !== source[key]))
    throw new Error("Projection manifest does not identify the trusted Paseo fork archive");
  return { repository: source.repository, commit: source.commit, url: source.url, sha256: source.sha256 };
}

// Byte splices are selected by parsed syntax nodes, never compiler line numbers.
// Unselected bytes (including delayed startup and resilience logic) are retained.
export function projectionEditor(ts, file, source, kind = ts.ScriptKind.JS) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  if (ast.parseDiagnostics.length) throw new Error(`Projection cannot parse ${file}`);
  const patches = [];
  function select(predicate) {
    const found = [];
    function visit(node) {
      if (predicate(node)) found.push(node);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return found;
  }
  function change(label, predicate, replacement, count = 1) {
    const nodes = select(predicate);
    if (nodes.length !== count)
      throw new Error(`Projection boundary ${file}: ${label}: expected ${count}, found ${nodes.length}`);
    for (const node of nodes) patches.push({
      start: replacement === "" ? node.getFullStart() : node.getStart(ast), end: node.end,
      text: typeof replacement === "function" ? replacement(node) : replacement,
    });
    return nodes;
  }
  function finish() {
    patches.sort((a, b) => b.start - a.start);
    let boundary = source.length;
    let result = source;
    for (const patch of patches) {
      if (patch.end > boundary) throw new Error(`Overlapping projection boundaries: ${file}`);
      result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
      boundary = patch.start;
    }
    if (ts.createSourceFile(file, result, ts.ScriptTarget.Latest, true, kind).parseDiagnostics.length) {
      throw new Error(`Projection produced invalid syntax: ${file}`);
    }
    return result;
  }
  return { ast, select, change, finish };
}

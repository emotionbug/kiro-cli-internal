import { createHash } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";

// Public @getpaseo/server@0.13.0 browser entrypoint from its npm package.
// This is a build-time source projection, not a live vendor-file hotpatch.
export const PASEO_BROWSER_ASSET = "dist/server/web-ui/_expo/static/js/web/index-b635bff8218cfcb57983de05f96c16ba.js";
export const PASEO_BROWSER_INPUT_SHA256 = "788d0c5e8fe47f2a7b3b24de78f1c6990fbacf250429d6eb221dac48ea44b645";
export const PASEO_BROWSER_PATCHED_SHA256 = "bef319283eae815e33b8eed46ffbd9f65d032fb72f88eb48cf474c84330f355e";
export const PASEO_BROWSER_PROJECTED_ASSET = `dist/server/web-ui/_expo/static/js/web/index-${PASEO_BROWSER_PATCHED_SHA256.slice(0, 32)}.js`;
const original = 'catch(i){return t.queue.write(i=>{const s=new Map(i);return s.set(t.agentId,[n,...i.get(t.agentId)??[]]),s}),{status:"failed",errorMessage:i instanceof Error?i.message:t.failedToSendMessage??o.i18n.t("composer.errors.failedToSend")}}},e.openComposerAttachment=';
const projected = 'catch(i){if("unknown"===i?.outcome||"DAEMON_REQUEST_TIMEOUT"===i?.code)return{status:"failed",deliveryOutcome:"unknown",errorMessage:"Delivery outcome unknown. Reconnect and inspect the conversation before sending again."};return t.queue.write(i=>{const s=new Map(i);return s.set(t.agentId,[n,...i.get(t.agentId)??[]]),s}),{status:"failed",errorMessage:i instanceof Error?i.message:t.failedToSendMessage??o.i18n.t("composer.errors.failedToSend")}}},e.openComposerAttachment=';
export const PASEO_RECONNECT_PERIOD_MS = 30000;
// Change both the displayed retry deadline and the actual timer default. The
// public SDK already retries without an attempt limit and cancels on close;
// equal base/cap delays make even its first retry wait the full 30 seconds.
const reconnectBoundaries = [
  "(this.config.reconnect?.baseDelayMs??1500)*2**this.reconnectAttempt",
  "t=this.config.reconnect?.baseDelayMs??1500,s=this.config.reconnect?.maxDelayMs??3e4",
];

export function projectPaseoQueuedMessageRecovery(bytes) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== PASEO_BROWSER_INPUT_SHA256) {
    throw new Error(`Paseo queued-message projection refused changed public input: ${actual}`);
  }
  let source = bytes.toString("utf8");
  for (const [before, after] of [
    [original, projected],
    ...reconnectBoundaries.map((before) => [before, before.replace("1500", "3e4")]),
    // An advertised private daemon is authoritative even when it needs a password.
    // Never fall through to an unrelated user's default localhost:6767 daemon.
    ["if(t){if(await this.bootstrapInitialConnectionHint(t))return}await this.bootstrapDefaultLocalhost()",
      "if(t){await this.bootstrapInitialConnectionHint(t);return}await this.bootstrapDefaultLocalhost()"],
  ]) {
    const index = source.indexOf(before);
    if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
      throw new Error("Paseo reconnect projection requires exactly one matching source boundary");
    }
    source = source.slice(0, index) + after + source.slice(index + before.length);
  }
  return Buffer.from(source);
}

// serverRoot is the @getpaseo/server package directory in a fresh staging tree.
// The projected entrypoint gets its own URL so cached original JS cannot undo the fix.
export async function applyPaseoReconnectFix(serverRoot) {
  const asset = path.join(serverRoot, PASEO_BROWSER_ASSET);
  const target = path.join(serverRoot, PASEO_BROWSER_PROJECTED_ASSET);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const patchedBytes = projectPaseoQueuedMessageRecovery(await readFile(asset));
  if (sha256(patchedBytes) !== PASEO_BROWSER_PATCHED_SHA256)
    throw new Error("Paseo queued-message projection produced unexpected bytes");
  const htmlPath = path.join(serverRoot, "dist/server/web-ui/index.html");
  const html = await readFile(htmlPath);
  const oldUrl = PASEO_BROWSER_ASSET.slice("dist/server/web-ui".length);
  const newUrl = PASEO_BROWSER_PROJECTED_ASSET.slice("dist/server/web-ui".length);
  const htmlText = html.toString("utf8");
  if (htmlText.split(oldUrl).length !== 2)
    throw new Error("Paseo browser HTML must reference exactly one original entrypoint");
  const patchedHtml = Buffer.from(htmlText.replace(oldUrl, newUrl));
  const encodings = [
    { suffix: ".gz", encoding: "gzip", compress: (bytes) => promisify(gzip)(bytes, { level: 6 }) },
    { suffix: ".br", encoding: "br", compress: (bytes) => promisify(brotliCompress)(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) },
  ];
  const outputs = [];
  for (const { suffix, encoding, compress } of encodings) {
    const originalBytes = await readFile(`${asset}${suffix}`);
    outputs.push({ path: `${target}${suffix}`, prior: `${asset}${suffix}`, encoding,
      bytes: await compress(patchedBytes), originalSha256: sha256(originalBytes) });
    let originalHtml;
    try { originalHtml = await readFile(`${htmlPath}${suffix}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (originalHtml)
      outputs.push({ path: `${htmlPath}${suffix}`, encoding, bytes: await compress(patchedHtml),
        originalSha256: sha256(originalHtml) });
  }
  await writeFile(target, patchedBytes, { flag: "wx" });
  for (const { path: file, bytes, prior } of outputs)
    await writeFile(file, bytes, prior ? { flag: "wx" } : undefined);
  await writeFile(htmlPath, patchedHtml);
  await rm(asset);
  for (const { prior } of outputs) if (prior) await rm(prior);
  return {
    projection: "paseo-0.13.0-fixed-30s-reconnect-unknown-delivery-no-replay-explicit-hint",
    reconnect: { baseDelayMs: PASEO_RECONNECT_PERIOD_MS, maxDelayMs: PASEO_RECONNECT_PERIOD_MS,
      attempts: "unlimited until closed; existing authentication/security stops retained" },
    initialConnectionHint: "Authoritative advertised daemon; no fallback probe of unrelated localhost:6767 on password or connection failure",
    originalAsset: PASEO_BROWSER_ASSET,
    asset: PASEO_BROWSER_PROJECTED_ASSET,
    originalSha256: PASEO_BROWSER_INPUT_SHA256,
    patchedSha256: sha256(patchedBytes),
    bytes: patchedBytes.length,
    html: { path: "dist/server/web-ui/index.html", originalSha256: sha256(html),
      patchedSha256: sha256(patchedHtml), cacheBustedEntrypoint: true },
    recompression: {
      runtime: process.version, zlib: process.versions.zlib, brotli: process.versions.brotli,
      settings: "gzip level 6; Brotli quality 5; generated from projected UTF-8 bytes",
      sidecars: outputs.map(({ path: file, encoding, bytes, originalSha256 }) => ({
        path: path.relative(serverRoot, file).split(path.sep).join("/"), encoding,
        originalSha256, patchedSha256: sha256(bytes), bytes: bytes.length,
      })),
    },
    retained: "All unrelated bytes/license notices; obsolete entrypoint removed; no source-map or SRI claims added",
  };
}

// This import is injected only into the bundle's owned Node processes. Bun OMP
// uses HTTP[S]_PROXY and NODE_EXTRA_CA_CERTS instead of this Node preloader.
import http from "node:http";
import https from "node:https";
import { Agent, Dispatcher, ProxyAgent as UndiciProxyAgent, setGlobalDispatcher } from "undici";
import { ProxyAgent } from "proxy-agent";
import { isLoopback } from "./proxy.mjs";

const address = process.env.OMP_INTERNAL_PROXY;
if (address) {
  const url = new URL(address);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    (url.username && (url.username !== "kiro" || !/^[a-f0-9]{64}$/.test(url.password))) ||
    (!url.username && url.password) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid owned proxy address.");
}
export function proxyForDestination(url, proxy = address) {
  return proxy && !isLoopback(new URL(url).hostname) ? proxy : "";
}
export class RoutedDispatcher extends Dispatcher {
  constructor(proxy = address) {
    super();
    this.direct = new Agent();
    const url = proxy ? new URL(proxy) : null;
    const token = url?.username
      ? "Basic " +
        Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
        ).toString("base64")
      : undefined;
    if (url) {
      url.username = "";
      url.password = "";
    }
    this.proxy = url ? new UndiciProxyAgent({ uri: url.href, token }) : null;
  }
  dispatch(options, handler) {
    return (
      this.proxy && !isLoopback(new URL(options.origin).hostname) ? this.proxy : this.direct
    ).dispatch(options, handler);
  }
  async close() {
    await Promise.all([this.direct.close(), this.proxy?.close()]);
  }
  async destroy(error) {
    await Promise.all([this.direct.destroy(error), this.proxy?.destroy(error)]);
  }
}

setGlobalDispatcher(new RoutedDispatcher());
// Includes Node http/https clients and ws when they use the default agent.
// proxy-agent selects a real direct agent for local MCP/WebSocket traffic.
const getProxyForUrl = (url) => proxyForDestination(url);
http.globalAgent = new ProxyAgent({ getProxyForUrl });
https.globalAgent = new ProxyAgent({ getProxyForUrl });

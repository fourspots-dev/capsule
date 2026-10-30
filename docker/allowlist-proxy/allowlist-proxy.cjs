"use strict";

// src/node/allowlist-proxy.ts
var import_node_http = require("node:http");
var import_node_net = require("node:net");
var import_promises = require("node:dns/promises");

// src/core/errors.ts
var AgentError = class extends Error {
  code;
  retryable;
  details;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
  toStructured() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...this.details === void 0 ? {} : { details: this.details }
    };
  }
};

// src/core/network-policy.ts
var NetworkPolicy = class {
  allowHosts;
  allowPrivateNetworks;
  allowHttp;
  constructor(options) {
    this.allowHosts = options.allowHosts.map(normalizeHost).filter(Boolean);
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
    this.allowHttp = options.allowHttp ?? false;
  }
  evaluate(rawUrl, resolvedIps = []) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AgentError("NETWORK_URL_INVALID", `Invalid URL: ${rawUrl}`);
    }
    if (url.protocol !== "https:" && !(this.allowHttp && url.protocol === "http:")) {
      return { allowed: false, host: url.hostname, reason: `Scheme ${url.protocol} is denied` };
    }
    if (url.username || url.password) {
      return { allowed: false, host: url.hostname, reason: "URL credentials are not allowed" };
    }
    const host = normalizeHost(url.hostname);
    if (!this.hostAllowed(host)) {
      return { allowed: false, host, reason: `Host ${host} is not in the allowlist` };
    }
    if (!this.allowPrivateNetworks) {
      const addresses = [...resolvedIps, ...isIpAddress(host) ? [host] : []];
      if (addresses.some(isPrivateAddress)) {
        return {
          allowed: false,
          host,
          reason: "Private, loopback and link-local addresses are denied"
        };
      }
    }
    return { allowed: true, host };
  }
  assert(rawUrl, resolvedIps = []) {
    const decision = this.evaluate(rawUrl, resolvedIps);
    if (!decision.allowed) {
      throw new AgentError("NETWORK_DENIED", decision.reason ?? "Network request denied", {
        details: { host: decision.host }
      });
    }
    return decision.host;
  }
  hostAllowed(host) {
    return this.allowHosts.some((allowed) => {
      if (allowed.startsWith("*.")) {
        const suffix = allowed.slice(1);
        return host.endsWith(suffix) && host !== suffix.slice(1);
      }
      return host === allowed;
    });
  }
};
function isPrivateAddress(value) {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) {
    return true;
  }
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  const parts = ipv4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
}
function isIpAddress(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}
function normalizeHost(host) {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

// src/node/allowlist-proxy.ts
var AllowlistProxy = class {
  constructor(options) {
    this.options = options;
    this.policy = new NetworkPolicy(options);
  }
  options;
  policy;
  server;
  async start() {
    if (this.server) {
      const address2 = this.server.address();
      if (address2 && typeof address2 !== "string") return address2.port;
    }
    const server = (0, import_node_http.createServer)(async (request, response) => {
      try {
        const target = new URL(request.url ?? "");
        const resolved = await resolveHost(target.hostname);
        this.policy.assert(target.toString(), resolved);
        const upstream = (0, import_node_http.request)(
          target,
          {
            method: request.method,
            headers: { ...request.headers, host: target.host }
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          }
        );
        upstream.on("error", (error) => {
          if (!response.headersSent) response.writeHead(502);
          response.end(error.message);
        });
        request.pipe(upstream);
      } catch (error) {
        const status = error instanceof AgentError && error.code === "NETWORK_DENIED" ? 403 : 400;
        response.writeHead(status, { "Content-Type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
    server.on("connect", async (request, clientSocket, head) => {
      try {
        const [host, portText] = splitHostPort(request.url ?? "");
        const resolved = await resolveHost(host);
        this.policy.assert(`https://${host}:${portText}/`, resolved);
        const upstream = (0, import_node_net.connect)(Number(portText), host, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => clientSocket.destroy());
      } catch (error) {
        clientSocket.end(
          `HTTP/1.1 403 Forbidden\r
Content-Type: text/plain\r
\r
${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No proxy address");
    return address.port;
  }
  async close() {
    const server = this.server;
    this.server = void 0;
    if (!server) return;
    await new Promise(
      (resolve, reject) => server.close((error) => error ? reject(error) : resolve())
    );
  }
};
async function resolveHost(host) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return [host];
  return (await (0, import_promises.lookup)(host, { all: true })).map((entry) => entry.address);
}
function splitHostPort(value) {
  const index = value.lastIndexOf(":");
  if (index < 1) throw new Error(`Invalid CONNECT target: ${value}`);
  return [value.slice(0, index).replace(/^\[|\]$/g, ""), value.slice(index + 1) || "443"];
}

// src/node/allowlist-proxy-server.ts
async function main() {
  const allowHosts = (process.env.TINYAI_ALLOW_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  if (allowHosts.length === 0) {
    throw new Error("TINYAI_ALLOW_HOSTS must contain at least one host");
  }
  const proxy = new AllowlistProxy({
    host: "0.0.0.0",
    port: Number(process.env.TINYAI_PROXY_PORT ?? 8080),
    allowHosts,
    allowPrivateNetworks: process.env.TINYAI_ALLOW_PRIVATE === "true",
    allowHttp: process.env.TINYAI_ALLOW_HTTP !== "false"
  });
  const port = await proxy.start();
  process.stdout.write(`tinyai allowlist proxy listening on ${port}
`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void proxy.close().finally(() => process.exit(0));
    });
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
});

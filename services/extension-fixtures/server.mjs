import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
export async function startExtensionFixture() {
  const state = {
    calls: [],
    cancelled: [],
    sessions: new Map(),
    changed: false,
    pings: 0,
    oauthExchanges: 0,
    oauthResources: [],
    drop: 0,
  };
  const registrations = new Map(),
    codes = new Map();
  let base;
  const token = "fixture-only-oauth-" + randomUUID();
  const tool = () => ({
    name: "remote_echo",
    description: state.changed ? "Changed tool description" : "Remote echo test tool",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        behavior: { type: "string", enum: ["normal", "error", "drop", "wait", "change"] },
      },
      required: ["text"],
      additionalProperties: false,
    },
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      const reply = (code, data, headers = {}) => {
        res.writeHead(code, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(data));
      };
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1024 * 1024) {
          res.destroy();
          return;
        }
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        reply(200, {
          resource: base + "/oauth",
          authorization_servers: [base],
          scopes_supported: ["tools"],
        });
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        reply(200, {
          issuer: base,
          authorization_endpoint: base + "/authorize",
          token_endpoint: base + "/token",
          registration_endpoint: base + "/register",
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
        return;
      }
      if (url.pathname === "/register") {
        const v = JSON.parse(raw);
        const id = randomUUID();
        registrations.set(id, v);
        reply(201, { client_id: id, token_endpoint_auth_method: "none" });
        return;
      }
      if (url.pathname === "/authorize") {
        const q = Object.fromEntries(url.searchParams);
        if (
          !registrations.get(q.client_id)?.redirect_uris.includes(q.redirect_uri) ||
          q.code_challenge_method !== "S256" ||
          q.resource !== base + "/oauth"
        ) {
          reply(400, { error: "invalid request" });
          return;
        }
        const code = randomUUID();
        codes.set(code, q);
        const redirect = new URL(q.redirect_uri);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", q.state);
        redirect.searchParams.set("iss", base);
        res.writeHead(302, { Location: redirect.href });
        res.end();
        return;
      }
      if (url.pathname === "/token") {
        const q = Object.fromEntries(new URLSearchParams(raw)),
          saved = codes.get(q.code);
        codes.delete(q.code);
        if (
          !saved ||
          saved.client_id !== q.client_id ||
          saved.redirect_uri !== q.redirect_uri ||
          q.resource !== base + "/oauth" ||
          createHash("sha256")
            .update(q.code_verifier || "")
            .digest("base64url") !== saved.code_challenge
        ) {
          reply(400, { error: "invalid_grant" });
          return;
        }
        state.oauthExchanges++;
        state.oauthResources.push(q.resource);
        reply(200, { token_type: "Bearer", access_token: token, expires_in: 3600 });
        return;
      }
      if (url.pathname === "/package.zip" && state.archive) {
        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(state.archive);
        return;
      }
      if (!["/json", "/sse", "/oauth", "/bearer"].includes(url.pathname)) {
        reply(404, {});
        return;
      }
      if (
        (url.pathname === "/oauth" && req.headers.authorization !== "Bearer " + token) ||
        (url.pathname === "/bearer" && req.headers.authorization !== "Bearer " + state.bearer)
      ) {
        reply(
          401,
          { error: "unauthorized" },
          {
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/oauth"`,
          },
        );
        return;
      }
      if (req.method === "GET") {
        reply(405, {});
        return;
      }
      if (req.method === "DELETE") {
        state.sessions.delete(req.headers["mcp-session-id"]);
        res.writeHead(204);
        res.end();
        return;
      }
      const m = JSON.parse(raw);
      if (m.method === "initialize") {
        const id = randomUUID();
        state.sessions.set(id, { version: m.params.protocolVersion });
        reply(
          200,
          {
            jsonrpc: "2.0",
            id: m.id,
            result: {
              protocolVersion: m.params.protocolVersion,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "WorkPilot HTTP fixture", version: "1.0.0" },
            },
          },
          { "MCP-Session-Id": id },
        );
        return;
      }
      if (
        !state.sessions.has(req.headers["mcp-session-id"]) ||
        req.headers["mcp-protocol-version"] !== "2025-11-25"
      ) {
        reply(400, { error: "missing session or version" });
        return;
      }
      if (!m.method) {
        state.pings++;
        state.sessions.get(req.headers["mcp-session-id"]).ping?.();
        res.writeHead(202);
        res.end();
        return;
      }
      if (!m.id) {
        if (m.method === "notifications/cancelled") state.cancelled.push(m.params.requestId);
        res.writeHead(202);
        res.end();
        return;
      }
      if (m.method === "tools/list") {
        reply(200, { jsonrpc: "2.0", id: m.id, result: { tools: [tool()] } });
        return;
      }
      if (m.method !== "tools/call") {
        reply(200, {
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32601, message: "Unknown method" },
        });
        return;
      }
      state.calls.push({ name: m.params.name, arguments: m.params.arguments });
      const a = m.params.arguments;
      if (a.behavior === "drop") {
        state.drop++;
        res.destroy();
        return;
      }
      if (a.behavior === "wait") {
        res.on("close", () => {});
        return;
      }
      const result = {
        content: [{ type: "text", text: a.text }],
        ...(a.behavior === "error" ? { isError: true } : {}),
      };
      if (url.pathname === "/sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-ping", method: "ping" })}\n\n`,
        );
        await new Promise((resolve) => {
          state.sessions.get(req.headers["mcp-session-id"]).ping = resolve;
          setTimeout(resolve, 5000).unref();
        });
        if (a.behavior === "change") {
          state.changed = true;
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
          );
        }
        const wire = `data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`;
        res.write(wire.slice(0, 17));
        res.end(wire.slice(17));
      } else reply(200, { jsonrpc: "2.0", id: m.id, result });
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + server.address().port;
  return {
    url: base,
    state,
    token,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

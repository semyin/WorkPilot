import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Counts the tested process's outgoing HTTPS connections without terminating TLS,
// changing certificates, rewriting MCP messages or affecting another process.
export async function startConnectAudit(host = "learn.microsoft.com") {
  const records = [];
  const sockets = new Set();
  let phase = "not-approved";
  let allowed = false;
  const server = createServer((_request, response) => response.writeHead(403).end());
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", track);
  server.on("connect", (request, local, head) => {
    const record = {
      at: new Date().toISOString(),
      target: request.url,
      phase,
      allowed: allowed && request.url === `${host}:443`,
      sentBytes: 0,
      receivedBytes: 0,
    };
    records.push(record);
    if (!record.allowed) {
      local.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const remote = connect({ host, port: 443 });
    track(remote);
    remote.setTimeout(45000, () => remote.destroy(new Error("Audit tunnel idle timeout")));
    remote.once("connect", () => {
      record.connectedAt = new Date().toISOString();
      local.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      local.pipe(remote);
      remote.pipe(local);
    });
    local.on("data", (chunk) => {
      record.sentBytes += chunk.length;
    });
    remote.on("data", (chunk) => {
      record.receivedBytes += chunk.length;
    });
    local.on("error", () => remote.destroy());
    remote.on("error", (error) => {
      record.error = error.code || error.message;
      local.destroy();
    });
    local.once("close", () => {
      record.closedAt = new Date().toISOString();
      remote.destroy();
    });
    remote.once("close", () => local.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    records,
    gate(nextPhase, nextAllowed) {
      phase = nextPhase;
      allowed = nextAllowed;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function readContent(engine, reference) {
  assert(reference && reference.object_id, "Expected a persisted operation output");
  let offset = 0;
  let text = "";
  while (offset < reference.bytes) {
    const response = await engine.request({
      kind: "read",
      query: { kind: "content", object_id: reference.object_id, offset, limit: 65536 },
    });
    assert.equal(response.kind, "content");
    text += response.page.text;
    assert(response.page.next_offset > offset, "Content cursor must advance");
    offset = response.page.next_offset;
  }
  return JSON.parse(text);
}

export function summarizeResult(value) {
  const result = value.mcp_result;
  assert(result && result.isError !== true, "Real MCP tool returned an error");
  assert(Array.isArray(result.content), "Real MCP tool must return content blocks");
  const texts = result.content.filter((item) => item.type === "text").map((item) => item.text);
  assert(texts.length && texts.every((text) => typeof text === "string"));
  const joined = texts.join("\n");
  const urls = [
    ...new Set(joined.match(/https:\/\/learn\.microsoft\.com\/[^\s"\\<>)]*/g) || []),
  ].map((url) => url.replace(/[.,;]+$/, ""));
  assert(urls.length > 0, "Real result must cite Microsoft Learn documentation");
  assert(joined.length > 200, "A link alone is insufficient evidence of returned document text");
  return {
    protocolVersion: value.protocol_version,
    contentBlocks: result.content.map((item) => ({
      type: item.type,
      bytes: Buffer.byteLength(JSON.stringify(item)),
      sha256: sha256(JSON.stringify(item)),
    })),
    textCharacters: joined.length,
    textSha256: sha256(joined),
    citationUrls: urls,
    rawResultBytes: Buffer.byteLength(JSON.stringify(result)),
    rawResultSha256: sha256(JSON.stringify(result)),
    scope:
      "Public document search excerpts received; body remains in the isolated task history. No article body is copied into this summary.",
  };
}

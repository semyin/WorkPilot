// An actual stdio MCP test server, launched by WorkPilot's managed process host.
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const tools = [
  {
    name: "write_note",
    description: "Write one note inside the project.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "check_boundary",
    description: "Attempt to read an unapproved sibling file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description: "Wait until cancelled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "failure",
    description: "Return a normal tool error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "secret_echo",
    description: "Echo only the explicitly supplied synthetic test credential.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  let result;
  if (m.method === "initialize")
    result = {
      protocolVersion: m.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "WorkPilot stdio fixture", version: "1.0.0" },
    };
  else if (m.method === "tools/list") result = { tools };
  else if (m.method === "tools/call") {
    const { name, arguments: a } = m.params;
    if (name === "write_note") {
      writeFileSync("extension-note.txt", a.text);
      appendFileSync("calls.txt", "write\n");
      result = { content: [{ type: "text", text: "Saved " + a.text }] };
    } else if (name === "check_boundary") {
      try {
        readFileSync(a.path);
        result = { content: [{ type: "text", text: "UNEXPECTED_ACCESS" }] };
      } catch {
        result = { content: [{ type: "text", text: "ACCESS_DENIED" }] };
      }
    } else if (name === "failure")
      result = { isError: true, content: [{ type: "text", text: "Intentional fixture failure" }] };
    else if (name === "secret_echo")
      result = { content: [{ type: "text", text: process.env.FIXTURE_TOKEN || "none" }] };
    else if (name === "wait") {
      writeFileSync("extension-wait.pid", String(process.pid));
      await new Promise(() => {});
    } else
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Unknown tool" } });
  } else if (m.method === "ping") result = {};
  else
    return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Unknown method" } });
  send({ jsonrpc: "2.0", id: m.id, result });
});

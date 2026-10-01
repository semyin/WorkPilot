// Synthetic protocol fixtures. Loopback only; accepts a made-up test key.
import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
const key = "workpilot-synthetic-key-only";
function validTestImage(body) {
  const parts = (body.input || body.messages || []).flatMap((m) =>
    Array.isArray(m.content) ? m.content : [],
  );
  const image = parts.find((p) => ["image_url", "input_image", "image"].includes(p.type));
  if (!image) return null;
  const encoded =
    image.source?.data ||
    (typeof image.image_url === "string" ? image.image_url : image.image_url?.url)?.split(",")[1];
  const bytes = Buffer.from(encoded || "", "base64");
  if (bytes.length < 20 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    return false;
  let offset = 8;
  let compressed = [];
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    if (offset + size + 12 > bytes.length) return false;
    const data = bytes.subarray(offset + 4, offset + 8 + size);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(offset + size + 8)) return false;
    if (data.subarray(0, 4).toString() === "IDAT") compressed.push(data.subarray(4));
    offset += size + 12;
  }
  return inflateSync(Buffer.concat(compressed)).length > 0;
}
const event = (value, name = "") =>
  (name ? "event: " + name + "\r\n" : "") +
  "data: " +
  (typeof value === "string" ? value : JSON.stringify(value)) +
  "\r\n\r\n";
function frames(protocol, body) {
  const tools = !!body.tools?.length;
  const malformed = body.model.includes("badargs");
  const args = malformed ? '{"message":' : '{"message":"你好 WorkPilot"}';
  const continued = JSON.stringify(body).includes("SYNTHETIC_TOOL_RESULT");
  const useTool = tools && !continued;
  const text = continued ? "工具结果已收到" : "你好，WorkPilot";
  const noUsage = body.model.includes("unknown");
  const chunks = [];
  if (protocol === "chat_completions") {
    const delta = (d, reason = null) =>
      event({
        id: "chat-fixture",
        model: body.model,
        choices: [{ index: 0, delta: d, finish_reason: reason }],
      });
    chunks.push(delta({ role: "assistant" }));
    if (useTool) {
      chunks.push(delta({ reasoning_content: "公开思考样本" }));
      chunks.push(
        delta({
          tool_calls: [
            {
              index: 0,
              id: "call-fixture",
              type: "function",
              function: { name: "workpilot_echo", arguments: "" },
              extra_content: { synthetic_signature: "opaque" },
            },
          ],
        }),
      );
      for (const part of [args.slice(0, 6), args.slice(6)])
        chunks.push(delta({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
    } else {
      for (const part of [text.slice(0, 2), text.slice(2)]) chunks.push(delta({ content: part }));
    }
    chunks.push(
      delta({}, body.model.includes("length") ? "length" : useTool ? "tool_calls" : "stop"),
    );
    if (!noUsage)
      chunks.push(
        event({
          id: "chat-fixture",
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
      );
    chunks.push(event("[DONE]"));
  } else if (protocol === "responses") {
    const send = (type, extra = {}) => event({ type, ...extra }, type);
    chunks.push(
      send("response.created", { response: { id: "resp-fixture", status: "in_progress" } }),
    );
    let output;
    if (useTool) {
      const reasoning = {
        type: "reasoning",
        id: "reason-fixture",
        summary: [],
        encrypted_content: "synthetic-opaque-reasoning",
      };
      const item = {
        type: "function_call",
        id: "fc-fixture",
        call_id: "call-fixture",
        name: "workpilot_echo",
        arguments: args,
        status: "completed",
      };
      chunks.push(send("response.output_item.added", { output_index: 0, item: reasoning }));
      chunks.push(
        send("response.output_item.added", {
          output_index: 1,
          item: { ...item, arguments: "", status: "in_progress" },
        }),
      );
      for (const part of [args.slice(0, 6), args.slice(6)])
        chunks.push(
          send("response.function_call_arguments.delta", {
            item_id: "fc-fixture",
            output_index: 1,
            delta: part,
          }),
        );
      chunks.push(
        send("response.function_call_arguments.done", {
          item_id: "fc-fixture",
          output_index: 1,
          arguments: args,
        }),
      );
      chunks.push(send("response.output_item.done", { output_index: 1, item }));
      output = [reasoning, item];
    } else {
      for (const part of [text.slice(0, 2), text.slice(2)])
        chunks.push(
          send("response.output_text.delta", { output_index: 0, content_index: 0, delta: part }),
        );
      output = [
        {
          type: "message",
          id: "msg-fixture",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ];
    }
    chunks.push(
      send(body.model.includes("length") ? "response.incomplete" : "response.completed", {
        response: {
          id: "resp-fixture",
          status: "completed",
          model: body.model,
          output,
          ...(!noUsage ? { usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } : {}),
        },
      }),
    );
  } else {
    const send = (type, extra = {}) => event({ type, ...extra }, type);
    chunks.push(
      send("message_start", {
        message: {
          id: "msg-fixture",
          model: body.model,
          role: "assistant",
          content: [],
          ...(!noUsage ? { usage: { input_tokens: 12, output_tokens: 1 } } : {}),
        },
      }),
    );
    if (useTool) {
      chunks.push(
        send("content_block_start", {
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      );
      chunks.push(
        send("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "公开思考样本" },
        }),
      );
      chunks.push(
        send("content_block_delta", {
          index: 0,
          delta: { type: "signature_delta", signature: "synthetic-signature" },
        }),
      );
      chunks.push(send("content_block_stop", { index: 0 }));
      chunks.push(
        send("content_block_start", {
          index: 1,
          content_block: {
            type: "tool_use",
            id: "call-fixture",
            name: "workpilot_echo",
            input: {},
          },
        }),
      );
      for (const part of [args.slice(0, 6), args.slice(6)])
        chunks.push(
          send("content_block_delta", {
            index: 1,
            delta: { type: "input_json_delta", partial_json: part },
          }),
        );
      chunks.push(send("content_block_stop", { index: 1 }));
    } else {
      chunks.push(
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      );
      for (const part of [text.slice(0, 2), text.slice(2)])
        chunks.push(
          send("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } }),
        );
      chunks.push(send("content_block_stop", { index: 0 }));
    }
    chunks.push(
      send("message_delta", {
        delta: {
          stop_reason: body.model.includes("length")
            ? "max_tokens"
            : useTool
              ? "tool_use"
              : "end_turn",
        },
        ...(!noUsage ? { usage: { output_tokens: 7 } } : {}),
      }),
    );
    chunks.push(send("message_stop"));
  }
  if (body.model.includes("cut")) chunks.pop();
  if (body.model.includes("cut-text")) chunks.splice(protocol === "messages" ? 3 : 2);
  if (body.model.includes("cut-tools")) chunks.splice(protocol === "messages" ? 7 : 4);
  if (body.model.includes("streamerror")) {
    chunks.splice(
      2,
      chunks.length,
      event({ type: "error", error: { message: "synthetic upstream failure " + key } }, "error"),
    );
  }
  if (body.model.includes("malformed")) chunks.splice(1, chunks.length, "data: {not-json}\n\n");
  return ["\uFEFF: synthetic stream\r\n\r\n", ...chunks];
}
export async function startFixture() {
  const records = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/stats") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(records));
        return;
      }
      let source = "";
      for await (const c of req) {
        source += c;
        if (source.length > 5 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      const body = source ? JSON.parse(source) : {};
      const imageValid = validTestImage(body);
      const protocol = req.url.endsWith("/messages")
        ? "messages"
        : req.url.endsWith("/responses")
          ? "responses"
          : "chat_completions";
      const hasResult = JSON.stringify(body).includes("SYNTHETIC_TOOL_RESULT");
      const authValid =
        req.headers.authorization === "Bearer " + key || req.headers["x-api-key"] === key;
      const all = body.input || body.messages || [];
      const record = {
        path: req.url,
        method: req.method,
        model: body.model || null,
        protocol,
        authValid,
        versionValid: protocol !== "messages" || req.headers["anthropic-version"] === "2023-06-01",
        continued: hasResult,
        correlation: !hasResult || JSON.stringify(all).includes("call-fixture"),
        opaquePreserved:
          !hasResult ||
          JSON.stringify(all).includes(
            protocol === "responses"
              ? "synthetic-opaque-reasoning"
              : protocol === "messages"
                ? "synthetic-signature"
                : "synthetic_signature",
          ),
        streaming: body.stream === true,
        imageValid,
        disconnected: false,
      };
      records.push(record);
      if (imageValid === false) {
        res
          .writeHead(422, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Invalid PNG fixture" } }));
        return;
      }
      res.on("close", () => {
        record.disconnected = true;
      });
      if (!authValid) {
        res
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Use the synthetic test key" } }));
        return;
      }
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            data: [
              "fixture-text",
              "fixture-tools",
              "fixture-slow",
              "fixture-401",
              "fixture-unknown",
            ].map((id) => ({ id })),
            has_more: false,
          }),
        );
        return;
      }
      const status = [401, 403, 429, 500, 503].find((s) => body.model.includes(String(s)));
      if (status) {
        res
          .writeHead(status, { "content-type": "application/json", "x-request-id": key })
          .end(JSON.stringify({ error: { message: "synthetic failure " + key } }));
        return;
      }
      if (body.model.includes("redirect")) {
        res.writeHead(307, { location: "/v1/redirect-target" }).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      if (body.model.includes("trickle")) {
        for (let i = 0; i < 50; i++) {
          if (res.destroyed) return;
          res.write(": heartbeat\n\n");
          await delay(40);
        }
      }
      if (body.model.includes("slow")) {
        await delay(2000);
        if (res.destroyed) return;
      }
      for (const frame of frames(protocol, body)) {
        const buffer = Buffer.from(frame);
        // Seven-byte chunks split Unicode code points, CRLF and JSON fragments.
        for (let offset = 0; offset < buffer.length; offset += 7) {
          if (res.destroyed) return;
          res.write(buffer.subarray(offset, offset + 7));
        }
        await delay(2);
      }
      res.end();
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    records,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixture();
  process.stdout.write(JSON.stringify({ url: fixture.url }) + "\n");
}

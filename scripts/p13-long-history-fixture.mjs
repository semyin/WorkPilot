import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

// Four bounded, independently cancellable local streams. No paid service or
// product fault switch is involved; the parent scenario explicitly releases them.
export async function longHistoryFixture() {
  const records = [];
  const active = new Map();
  const frame = (response, value) => response.write("data: " + JSON.stringify(value) + "\n\n");
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error("Unexpected large fixture request");
      }
      const input = JSON.parse(body);
      assert.match(input.model, /^p13-long-stream-[0-3]$/);
      assert(request.url.endsWith("/responses"));
      assert(!active.has(input.model), "A stream must never be retried automatically");
      const record = {
        model: input.model,
        startedAtMs: Date.now(),
        ended: false,
        completed: false,
        chunks: 0,
        emittedBytes: 0,
      };
      const pieces = [];
      records.push(record);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      frame(response, { type: "response.created", response: { id: input.model } });
      const emit = () => {
        if (response.destroyed || response.writableEnded) return;
        const text = `${input.model} chunk ${++record.chunks}\n`;
        pieces.push(text);
        record.emittedBytes += Buffer.byteLength(text);
        frame(response, { type: "response.output_text.delta", output_index: 0, delta: text });
      };
      emit();
      const timer = setInterval(emit, 350);
      const deadline = setTimeout(() => {
        record.fixtureDeadlineExceeded = true;
        response.destroy();
      }, 180000);
      active.set(input.model, {
        record,
        finish() {
          assert(!response.destroyed && !response.writableEnded, "Stream unexpectedly closed");
          clearInterval(timer);
          frame(response, {
            type: "response.completed",
            response: {
              id: input.model,
              model: input.model,
              status: "completed",
              output: [
                {
                  type: "message",
                  id: input.model + "-message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: pieces.join("") }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: record.chunks },
            },
          });
          record.completed = true;
          record.completedAtMs = Date.now();
          response.end();
        },
      });
      response.on("close", () => {
        clearInterval(timer);
        clearTimeout(deadline);
        record.ended = true;
        record.endedAtMs = Date.now();
        active.delete(input.model);
      });
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      if (!response.destroyed) response.end(JSON.stringify({ error: String(error) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    records,
    url: "http://127.0.0.1:" + server.address().port,
    finish(model) {
      assert(active.has(model), "Missing active fixture stream: " + model);
      active.get(model).finish();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

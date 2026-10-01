import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const protocols = new Map([
  ["/v1/chat/completions", "chat"],
  ["/v1/responses", "responses"],
  ["/v1/messages", "messages"],
]);
export function frames(protocol, scenario) {
  const tool = scenario === "tool";
  if (protocol === "chat") {
    const chunk = (delta, finish_reason = null) => ({
      id: "fixture-chat",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason }],
    });
    return [
      ["", chunk({ role: "assistant" })],
      [
        "",
        chunk(
          tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fixture",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":' },
                  },
                ],
              }
            : { content: "Work" },
        ),
      ],
      [
        "",
        chunk(
          tool
            ? { tool_calls: [{ index: 0, function: { arguments: '"sample.txt"}' } }] }
            : { content: "Pilot ✓" },
        ),
      ],
      ["", chunk({}, tool ? "tool_calls" : "stop")],
      ["", "[DONE]"],
    ];
  }
  if (protocol === "responses") {
    const item = tool
      ? {
          id: "fc_fixture",
          type: "function_call",
          call_id: "call_fixture",
          name: "read_file",
          arguments: "",
        }
      : { id: "msg_fixture", type: "message", role: "assistant", content: [] };
    const args = '{"path":"sample.txt"}';
    return [
      [
        "response.created",
        { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
      ],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item }],
      [
        tool ? "response.function_call_arguments.delta" : "response.output_text.delta",
        {
          type: tool ? "response.function_call_arguments.delta" : "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: tool ? '{"path":' : "Work",
        },
      ],
      [
        tool ? "response.function_call_arguments.delta" : "response.output_text.delta",
        {
          type: tool ? "response.function_call_arguments.delta" : "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: tool ? '"sample.txt"}' : "Pilot ✓",
        },
      ],
      [
        "response.completed",
        {
          type: "response.completed",
          response: {
            id: "resp_fixture",
            status: "completed",
            output: [
              tool
                ? { ...item, arguments: args }
                : { ...item, content: [{ type: "output_text", text: "WorkPilot ✓" }] },
            ],
          },
        },
      ],
    ];
  }
  return [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          content: [],
          model: "fixture",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? { type: "tool_use", id: "call_fixture", name: "read_file", input: {} }
          : { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: '{"path":' }
          : { type: "text_delta", text: "Work" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: '"sample.txt"}' }
          : { type: "text_delta", text: "Pilot ✓" },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

export const fixturePage =
  "<!doctype html><html><head><meta charset='utf-8'><title>WorkPilot Browser Fixture</title></head><body><h1>WorkPilot browser fixture</h1><label>Name <input id='name' aria-label='Name'></label><button id='greet'>Greet</button><p id='result'>Ready</p><a href='/download' download='workpilot-sample.csv'>Download sample</a><script>document.querySelector('#greet').onclick=()=>{document.querySelector('#result').textContent='Hello, '+document.querySelector('#name').value};</script></body></html>";

export async function startFixtureServer(port = 0) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    if (route === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ fixture: true, requests: requests.length }));
      return;
    }
    if (route === "/page") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(fixturePage);
      return;
    }
    if (route === "/download") {
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="workpilot-sample.csv"',
      });
      res.end("name,value\nWorkPilot,42\n");
      return;
    }
    const protocol = protocols.get(route);
    if (req.method !== "POST" || !protocol) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    try {
      for await (const chunk of req) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > 65536) {
          res.writeHead(413).end();
          return;
        }
      }
      JSON.parse(body);
    } catch {
      res.writeHead(400).end('{"error":"invalid_json"}');
      return;
    }
    const scenario = req.headers["x-workpilot-scenario"] || "text";
    if (!["text", "tool", "slow", "error", "rate_limit", "disconnect"].includes(scenario)) {
      res.writeHead(400).end('{"error":"invalid_scenario"}');
      return;
    }
    // Never record request bodies or authentication headers, even in fixtures.
    requests.push({ protocol, scenario });
    if (scenario === "error" || scenario === "rate_limit") {
      res.writeHead(scenario === "error" ? 500 : 429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "fixture_error", message: "Deliberate P00 fixture failure" },
        }),
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-WorkPilot-Fixture": "true",
    });
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    try {
      for (const [index, [event, value]] of frames(protocol, scenario).entries()) {
        if (scenario === "disconnect" && index === 2) {
          res.destroy();
          return;
        }
        if (controller.signal.aborted) return;
        if (event) res.write("event: " + event + "\n");
        res.write("data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n");
        await delay(scenario === "slow" ? 120 : 5, undefined, { signal: controller.signal });
      }
      res.end();
    } catch (error) {
      if (error.name !== "AbortError") res.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: "http://127.0.0.1:" + server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await startFixtureServer(Number(process.env.WORKPILOT_FIXTURE_PORT || 0));
  console.log(JSON.stringify({ fixture: true, url: fixture.url }));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await fixture.close();
    });
}

import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const frame = (data) =>
  "data: " + (typeof data === "string" ? data : JSON.stringify(data)) + "\n\n";
function history(body, protocol) {
  const items = body.input || body.messages || [];
  const results = [];
  const calls = new Set();
  let correlated = true;
  for (const item of items) {
    if (protocol === "chat_completions") {
      for (const call of item.tool_calls || []) calls.add(call.id);
      if (item.role === "tool") {
        correlated &&= calls.delete(item.tool_call_id);
        results.push(item.content);
      }
    } else if (protocol === "responses") {
      if (item.type === "function_call") calls.add(item.call_id);
      if (item.type === "function_call_output") {
        correlated &&= calls.delete(item.call_id);
        results.push(item.output);
      }
    } else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "tool_use") calls.add(part.id);
        if (part.type === "tool_result") {
          correlated &&= calls.delete(part.tool_use_id);
          results.push(part.content);
        }
      }
    }
  }
  return { results, correlated: correlated && calls.size === 0 };
}
function reply(body, results) {
  const model = body.model;
  const count = results.length;
  const all = JSON.stringify(body);
  const tool = (name, args) => ({ text: "", calls: [{ name, args }] });
  const done = (text) => ({ text, calls: [] });
  if (model === "runtime-error") return { error: 429 };
  if (model === "runtime-hold") return { ...done("慢请求完成"), delay: 5000 };
  if (model === "runtime-crash")
    return count === 0
      ? tool("sample_write", { name: "crash-once", content: "one committed effect" })
      : done("恢复完成");
  if (model === "runtime-ask")
    return count === 0
      ? tool("ask_user", { question: "请选择颜色", choices: ["蓝色", "红色"] })
      : done("采用你的选择完成");
  if (model === "runtime-plan") {
    if (count === 0 || !all.includes("Execute mode:"))
      return tool("update_plan", {
        steps: [{ id: "save", text: "保存样本文字", status: "pending" }],
      });
    if (count === 1) return tool("sample_write", { name: "plan", content: "approved sample" });
    if (count === 2)
      return tool("update_plan", { steps: [{ id: "save", text: "保存样本文字", status: "done" }] });
    return done("计划执行完成");
  }
  if (model === "runtime-guide") {
    if (count === 0 && !all.includes("GUIDE_NOW"))
      return {
        text: "",
        calls: [
          // Leave time for native UI input; the assertion concerns steering at
          // a safe boundary rather than the speed of automation clicks.
          { name: "sample_wait", args: { milliseconds: 5000 } },
          {
            name: "sample_write",
            args: { name: "obsolete", content: "must be skipped if guided" },
          },
        ],
      };
    return done(all.includes("GUIDE_NOW") ? "已按引导调整任务" : "原任务完成");
  }
  const scenarios = {
    "runtime-sum": [
      ["sample_lookup", { key: "numbers" }],
      ["sample_calculate", { operation: "sum", values: [4, 8, 12] }],
      ["sample_write", { name: "sum", content: "24" }],
    ],
    "runtime-words": [
      ["sample_lookup", { key: "words" }],
      ["sample_write", { name: "words", content: "alpha beta gamma" }],
      ["sample_read", { name: "words" }],
    ],
    "runtime-product": [
      ["sample_calculate", { operation: "product", values: [4, 8] }],
      ["sample_wait", { milliseconds: 1 }],
      ["sample_write", { name: "product", content: "32" }],
    ],
  };
  const scenario = scenarios[model] || [];
  return scenario[count]
    ? tool(...scenario[count])
    : done(model === "runtime-sum" ? "求和结果为 24，已保存在任务样本区。" : "样本任务完成");
}
function frames(protocol, body, value, count) {
  const calls = value.calls.map((call, i) => ({
    ...call,
    id: "runtime-call-" + count + "-" + i,
    item: "runtime-item-" + count + "-" + i,
  }));
  const output = [];
  if (protocol === "chat_completions") {
    const chunk = (delta, finish_reason = null) =>
      frame({
        id: "runtime-chat",
        model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      });
    if (value.text) output.push(chunk({ content: value.text }));
    calls.forEach((c, index) => {
      const args = JSON.stringify(c.args);
      output.push(
        chunk({
          tool_calls: [
            { index, id: c.id, type: "function", function: { name: c.name, arguments: "" } },
          ],
        }),
      );
      for (const part of [args.slice(0, 5), args.slice(5)])
        output.push(chunk({ tool_calls: [{ index, function: { arguments: part } }] }));
    });
    output.push(
      chunk({}, calls.length ? "tool_calls" : "stop"),
      frame({
        id: "runtime-chat",
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }),
      frame("[DONE]"),
    );
  } else if (protocol === "responses") {
    output.push(frame({ type: "response.created", response: { id: "runtime-response" } }));
    const items = [];
    if (value.text) {
      output.push(
        frame({ type: "response.output_text.delta", output_index: 0, delta: value.text }),
      );
      items.push({
        type: "message",
        id: "runtime-message",
        role: "assistant",
        content: [{ type: "output_text", text: value.text }],
        status: "completed",
      });
    }
    calls.forEach((c) => {
      const index = items.length;
      const args = JSON.stringify(c.args);
      const item = {
        type: "function_call",
        id: c.item,
        call_id: c.id,
        name: c.name,
        arguments: args,
        status: "completed",
      };
      output.push(
        frame({
          type: "response.output_item.added",
          output_index: index,
          item: { ...item, arguments: "", status: "in_progress" },
        }),
      );
      for (const part of [args.slice(0, 5), args.slice(5)])
        output.push(
          frame({
            type: "response.function_call_arguments.delta",
            output_index: index,
            item_id: c.item,
            delta: part,
          }),
        );
      items.push(item);
    });
    output.push(
      frame({
        type: "response.completed",
        response: {
          id: "runtime-response",
          model: body.model,
          status: "completed",
          output: items,
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      }),
    );
  } else {
    output.push(
      frame({
        type: "message_start",
        message: {
          id: "runtime-message",
          model: body.model,
          usage: { input_tokens: 20, output_tokens: 1 },
        },
      }),
    );
    let index = 0;
    if (value.text) {
      output.push(
        frame({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
        frame({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: value.text },
        }),
        frame({ type: "content_block_stop", index }),
      );
      index++;
    }
    for (const c of calls) {
      output.push(
        frame({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: c.id, name: c.name, input: {} },
        }),
      );
      const args = JSON.stringify(c.args);
      for (const part of [args.slice(0, 5), args.slice(5)])
        output.push(
          frame({
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: part },
          }),
        );
      output.push(frame({ type: "content_block_stop", index }));
      index++;
    }
    output.push(
      frame({
        type: "message_delta",
        delta: { stop_reason: calls.length ? "tool_use" : "end_turn" },
        usage: { output_tokens: 10 },
      }),
      frame({ type: "message_stop" }),
    );
  }
  return output;
}
export async function startExecutionFixture(customReply) {
  const records = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 5 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      const body = JSON.parse(text || "{}");
      const protocol = req.url.endsWith("/messages")
        ? "messages"
        : req.url.endsWith("/responses")
          ? "responses"
          : "chat_completions";
      const h = history(body, protocol);
      const record = {
        model: body.model,
        protocol,
        correlationValid: h.correlated,
        resultCount: h.results.length,
        ended: false,
      };
      records.push(record);
      res.on("close", () => {
        record.ended = true;
      });
      if (!h.correlated) {
        res
          .writeHead(422, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Mismatched synthetic tool history" } }));
        return;
      }
      const value = customReply?.(body, h.results) ?? reply(body, h.results);
      if (value.error) {
        res
          .writeHead(value.error, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Synthetic quota error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      if (value.delay) await delay(value.delay);
      for (const f of frames(protocol, body, value, h.results.length)) {
        if (res.destroyed) return;
        const bytes = Buffer.from(f);
        for (let i = 0; i < bytes.length; i += 13) res.write(bytes.subarray(i, i + 13));
        await delay(1);
      }
      res.end();
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    records,
    url: "http://127.0.0.1:" + server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startExecutionFixture();
  process.stdout.write(JSON.stringify({ url: server.url }) + "\n");
}

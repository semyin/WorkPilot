// Local deterministic protocol fixture. Its images are test data, never evidence of real generation.
import http from "node:http";
import { createCanvas } from "@napi-rs/canvas";
export async function startImageFixture() {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = req.headers["content-type"]?.includes("application/json")
      ? JSON.parse(raw)
      : {
          prompt: raw.toString().includes("edit-test") ? "edit-test" : "multipart",
          n: 1,
          size: "32x16",
        };
    calls.push({
      path: req.url,
      prompt: body.prompt,
      contentType: req.headers["content-type"],
      hasImage: raw.toString().includes('name="image[]"'),
      authorization: req.headers.authorization,
    });
    if (body.prompt === "error") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture quota reached" } }));
      return;
    }
    if (body.prompt === "disconnect") {
      res.destroy();
      return;
    }
    if (body.prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 5000));
    let width = 32,
      height = 16;
    if (body.prompt === "wrong-size") width = 48;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#218580";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(4, 4, 6, 6);
    const base64 =
      body.prompt === "invalid"
        ? Buffer.from("this is not an image").toString("base64")
        : canvas.toBuffer("image/png").toString("base64");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data:
          body.prompt === "empty"
            ? []
            : Array.from({ length: body.n || 1 }, () => ({
                b64_json: base64,
                revised_prompt: "fixture image; not a real image-generation service",
              })),
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      }),
    );
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

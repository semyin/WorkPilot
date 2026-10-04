// Synthetic protocol data only; never evidence of real model image quality.
import http from "node:http";
import { createCanvas } from "@napi-rs/canvas";

export async function startBailianFixture() {
  const calls = [],
    sockets = new Set(),
    timers = new Set();
  let origin;
  const server = http.createServer(async (req, res) => {
    const call = { path: req.url, method: req.method, authenticated: !!req.headers.authorization };
    calls.push(call);
    if (req.method === "POST") {
      let raw = "";
      for await (const bytes of req) raw += bytes;
      const body = JSON.parse(raw);
      call.body = body;
      if (body.prompt === "quota") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Synthetic quota error" } }));
        return;
      }
      const url =
        body.prompt === "cross-origin"
          ? "http://127.0.0.1:9/private"
          : origin + "/image/" + encodeURIComponent(body.prompt);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ url }], usage: { output_image_count: 1 } }));
      return;
    }
    const mode = decodeURIComponent(req.url.slice("/image/".length));
    if (mode === "redirect") {
      res.writeHead(302, { Location: origin + "/redirect-must-not-follow" });
      res.end();
      return;
    }
    if (mode === "oversized") {
      res.writeHead(200, { "Content-Length": 33 * 1024 * 1024 });
      res.end("small body with forbidden length");
      return;
    }
    if (mode === "corrupt") {
      res.end("not an image");
      return;
    }
    const canvas = createCanvas(mode === "wrong-size" ? 48 : 32, 16);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = mode === "edited" ? "#27834a" : "#2575ce";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const bytes = canvas.toBuffer("image/png");
    res.setHeader("Content-Type", "image/png");
    if (mode === "partial") {
      res.write(bytes.subarray(0, 8));
      res.destroy();
      return;
    }
    if (mode === "slow") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.end(bytes);
      }, 30000);
      timers.add(timer);
      res.on("close", () => {
        call.closed = true;
        clearTimeout(timer);
        timers.delete(timer);
      });
    } else res.end(bytes);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin + "/v1",
    calls,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

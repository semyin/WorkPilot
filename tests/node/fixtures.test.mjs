import test from "node:test";
import assert from "node:assert/strict";
import { startFixtureServer } from "../../services/fixtures/server.mjs";

for (const endpoint of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
  test(endpoint + " streams text and complete tool arguments", async (t) => {
    const server = await startFixtureServer();
    t.after(server.close);
    for (const scenario of ["text", "tool"]) {
      const response = await fetch(server.url + endpoint, {
        method: "POST",
        headers: { "x-workpilot-scenario": scenario },
        body: JSON.stringify({ stream: true }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const text = await response.text();
      if (scenario === "text") {
        assert.match(text, /Work/);
        assert.match(text, /Pilot ✓/);
      } else {
        assert.match(text, /read_file/);
        assert.match(text, /sample\.txt/);
      }
    }
    assert.equal(server.requests.length, 2);
  });
}
test("errors, slow stream and disconnect stay observable", async (t) => {
  const server = await startFixtureServer();
  t.after(server.close);
  const request = (scenario) =>
    fetch(server.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "x-workpilot-scenario": scenario },
      body: "{}",
    });
  assert.equal((await request("error")).status, 500);
  assert.equal((await request("rate_limit")).status, 429);
  const start = performance.now();
  const response = await request("slow");
  const first = await response.body.getReader().read();
  assert.ok(first.value.byteLength > 0);
  assert.ok(performance.now() - start < 600);
  const broken = await request("disconnect");
  await assert.rejects(broken.text());
  assert.equal(server.requests.length, 4);
});
test("browser fixture and download contain deterministic local data", async (t) => {
  const server = await startFixtureServer();
  t.after(server.close);
  assert.match(await (await fetch(server.url + "/page")).text(), /id='greet'/);
  assert.equal(await (await fetch(server.url + "/download")).text(), "name,value\nWorkPilot,42\n");
  assert.equal(
    (await fetch(server.url + "/v1/messages", { method: "POST", body: "{" })).status,
    400,
  );
});

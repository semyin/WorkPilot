import { createPrivateKey, sign, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const digest = async (path) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
export async function packageUpdate({
  source,
  output,
  privateKey,
  version,
  notes,
  databaseMin = 11,
  databaseTarget = 11,
  application = ["WorkPilot desktop and engine"],
  tools = [],
}) {
  source = resolve(source);
  output = resolve(output);
  if (!privateKey || !version || !notes)
    throw new Error("Signing key, version and release notes are required");
  const keyLocation = relative(source, resolve(privateKey));
  if (!keyLocation.startsWith("..") && !keyLocation.includes(":"))
    throw new Error("Signing keys cannot be inside the distribution input");
  const outputLocation = relative(source, output);
  if (!outputLocation.startsWith("..") && !outputLocation.includes(":"))
    throw new Error("The update output must be outside the distribution input");
  const trust = JSON.parse(
    await readFile(new URL("../resources/update/trust.json", import.meta.url), "utf8"),
  );
  const key = createPrivateKey(await readFile(privateKey));
  const { createPublicKey } = await import("node:crypto");
  const publicKey = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  if (publicKey !== trust.public_key)
    throw new Error("Private signing key does not match the pinned public key");
  const files = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name),
        stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Update inputs cannot contain links");
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) {
        const pathName = relative(source, path).replaceAll("\\", "/");
        if (
          /(^|\/)(\.env(?:\..*)?|\.local|\.secrets)(\/|$)|\.(pem|key|pfx|p12|sqlite3?|db)(-|$)/i.test(
            pathName,
          )
        )
          throw new Error("Private keys or application data cannot enter a program update");
        if (/[\u0000-\u001f:]/.test(pathName) || /(^|\/)\.\.?($|\/)/.test(pathName))
          throw new Error("Unsafe input path");
        files.push({ path: pathName, bytes: stat.size, sha256: await digest(path) });
      } else throw new Error("Unsupported update input");
    }
  }
  await walk(source);
  if (files.length > 100000 || files.reduce((n, f) => n + f.bytes, 0) > 16 * 1024 ** 3)
    throw new Error("Update exceeds capacity");
  const manifest = JSON.stringify({
    format: 1,
    version,
    platform: "windows-x86_64",
    notes,
    database_min: databaseMin,
    database_target: databaseTarget,
    application,
    tools,
    files,
  });
  const envelope = Buffer.from(
    JSON.stringify({
      key_id: trust.key_id,
      manifest,
      signature: sign(null, Buffer.from(manifest), key).toString("hex"),
    }),
  );
  if (envelope.length > 16 * 1024 ** 2) throw new Error("Update manifest exceeds capacity");
  await mkdir(dirname(output), { recursive: true });
  const writer = createWriteStream(output, { flags: "wx" });
  const header = Buffer.alloc(12);
  header.write("WPUPDT01");
  header.writeUInt32LE(envelope.length, 8);
  async function* chunks() {
    yield header;
    yield envelope;
    for (const file of files) {
      const path = join(source, file.path);
      const now = await lstat(path);
      if (
        !now.isFile() ||
        now.isSymbolicLink() ||
        now.size !== file.bytes ||
        (await digest(path)) !== file.sha256
      )
        throw new Error("Update input changed while signing");
      yield* createReadStream(path);
    }
  }
  await pipeline(chunks(), writer);
  return {
    version,
    output,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    sha256: await digest(output),
    key_id: trust.key_id,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, output, privateKey, version, notes] = process.argv.slice(2);
  console.log(
    JSON.stringify(await packageUpdate({ source, output, privateKey, version, notes }), null, 2),
  );
}

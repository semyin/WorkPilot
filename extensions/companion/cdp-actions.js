// Shared, fixed browser operations. Page data is never evaluated as source code.
export const FILE_LIMIT = 8 * 1024 * 1024;
export function allowedUrl(value) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Only HTTP(S) pages without URL credentials are supported.");
  return u.href;
}
function domProbe(args) {
  const nonce = () =>
    [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const key = "__workpilot_browser_v1";
  const page = (globalThis[key] ||= { document: nonce(), refs: new Map() });
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || "",
    type: el.getAttribute("type") || "",
    name: (
      el.getAttribute("aria-label") ||
      el.labels?.[0]?.innerText ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      el.getAttribute("alt") ||
      ""
    )
      .trim()
      .slice(0, 300),
    href: el.href || "",
    form_action: el.formAction || el.form?.action || "",
    form_method: el.formMethod || el.form?.method || "",
    checked: !!el.checked,
    disabled: !!el.disabled,
    value: el.type === "password" ? "" : String(el.value ?? "").slice(0, 500),
  });
  const visible = (el) =>
    !!el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  if (args.kind === "snapshot") {
    page.refs.clear();
    const token = nonce().slice(0, 8);
    const elements = [
      ...document.querySelectorAll(
        'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]',
      ),
    ]
      .filter(visible)
      .slice(0, 250);
    const result = [];
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i],
        reference = token + "-" + i,
        description = describe(el);
      page.refs.set(reference, { el, fingerprint: JSON.stringify(description) });
      if (
        !args.query ||
        Object.values(description)
          .filter((v) => typeof v === "string")
          .join(" ")
          .toLowerCase()
          .includes(args.query.toLowerCase())
      )
        result.push({ reference, ...description });
    }
    return {
      document: page.document,
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").slice(0, 48000),
      elements: result,
      truncated: elements.length === 250,
    };
  }
  if (args.document !== page.document) throw new Error("Page was reloaded. Read the page again.");
  if (args.kind === "document")
    return { document: page.document, url: location.href, title: document.title };
  const ref = page.refs.get(args.reference);
  if (
    !ref ||
    !ref.el.isConnected ||
    !visible(ref.el) ||
    JSON.stringify(describe(ref.el)) !== ref.fingerprint
  )
    throw new Error("The selected element changed. Read the page again before acting.");
  const el = ref.el;
  if (el.type === "password")
    throw new Error("Take over the browser to enter passwords and finish authentication.");
  if (args.kind === "validate") return describe(el);
  if (args.kind === "download") {
    if (!el.href) throw new Error("Choose an actual download link.");
    return { url: el.href };
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  if (args.kind === "click") {
    if (el.hasAttribute("download") || /\.(zip|exe|msi)(\?|$)/i.test(el.href || ""))
      throw new Error("Use Download to save this file in the authorized project.");
    el.click();
  } else if (args.kind === "fill") {
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !el.isContentEditable)
      throw new Error("Choose an editable field.");
    if (el.type === "file" || el.disabled || el.readOnly)
      throw new Error("This field cannot be filled with text.");
    el.focus();
    if (el.isContentEditable) el.textContent = args.text;
    else {
      const proto =
        el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, args.text);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (args.kind === "upload") {
    if (el.tagName !== "INPUT" || el.type !== "file")
      throw new Error("Choose a file upload field.");
    const raw = atob(args.bytes),
      bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], args.name, { type: "application/octet-stream" }));
    el.files = transfer.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else throw new Error("Unsupported element action");
  return { performed: true, element: describe(el) };
}

export class PageDriver {
  constructor(send, label) {
    this.send = send;
    this.label = label;
    this.frames = new Map();
    this.children = new Set();
    this.snapshots = new Map();
    this.generation = 0;
    this.document = null;
    this.dialog = null;
    this.closed = false;
    this.url = "about:blank";
    this.blockedDownloads = 0;
  }
  async initialize(session) {
    await this.send("Page.enable", {}, session);
    await this.send("Runtime.enable", {}, session);
    await this.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      session,
    );
    // Intercept attachment responses in controlled targets only; never change the daily browser's global download settings.
    await this.send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Response" }] },
      session,
    );
    const tree = await this.send("Page.getFrameTree", {}, session);
    const walk = (t) => {
      this.frames.set(t.frame.id, { id: t.frame.id, url: t.frame.url, session });
      if (!t.frame.parentId && !session) this.url = t.frame.url;
      for (const c of t.childFrames || []) walk(c);
    };
    if (tree.frameTree) walk(tree.frameTree);
  }
  async event(method, p, session) {
    if (this.closed) return;
    if (method === "Target.attachedToTarget" && p.targetInfo.type === "iframe") {
      this.children.add(p.sessionId);
      await this.initialize(p.sessionId).catch(() => {});
    } else if (method === "Target.detachedFromTarget") {
      for (const [id, f] of this.frames) if (f.session === p.sessionId) this.frames.delete(id);
    } else if (method === "Page.frameNavigated") {
      this.generation++;
      this.snapshots.clear();
      this.document = null;
      this.frames.set(p.frame.id, { id: p.frame.id, url: p.frame.url, session });
      if (!p.frame.parentId && !session) this.url = p.frame.url;
    } else if (method === "Page.navigatedWithinDocument") {
      this.generation++;
      this.snapshots.clear();
      this.document = null;
      if (this.frames.has(p.frameId)) this.frames.get(p.frameId).url = p.url;
      if (!session) this.url = p.url;
    } else if (method === "Page.frameDetached") this.frames.delete(p.frameId);
    else if (method === "Page.javascriptDialogOpening") {
      this.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
      this.dialogOpened?.({ performed: true, dialog: this.dialog });
    } else if (method === "Page.javascriptDialogClosed") this.dialog = null;
    else if (method === "Fetch.requestPaused") {
      const headers = p.responseHeaders || [];
      const attachment =
        p.request.url !== this.expectedDownload &&
        (headers.some(
          (h) => h.name.toLowerCase() === "content-disposition" && /attachment/i.test(h.value),
        ) ||
          headers.some(
            (h) =>
              h.name.toLowerCase() === "content-type" &&
              /application\/(octet-stream|zip|x-msdownload)/i.test(h.value),
          ));
      if (attachment) this.blockedDownloads++;
      await this.send(
        attachment ? "Fetch.failRequest" : "Fetch.continueRequest",
        attachment
          ? { requestId: p.requestId, errorReason: "Aborted" }
          : { requestId: p.requestId },
        session,
      ).catch(() => {});
    }
  }
  async probe(frame, args) {
    const context = await this.send(
      "Page.createIsolatedWorld",
      { frameId: frame.id, worldName: "WorkPilot controlled DOM", grantUniveralAccess: false },
      frame.session,
    );
    const r = await this.send(
      "Runtime.evaluate",
      {
        expression: "(" + domProbe.toString() + ")(" + JSON.stringify(args) + ")",
        contextId: context.executionContextId,
        returnByValue: true,
        userGesture: !["snapshot", "validate", "document", "download"].includes(args.kind),
        awaitPromise: true,
        timeout: 5000,
      },
      frame.session,
    );
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description?.split("\n")[0] ||
          r.exceptionDetails.text ||
          "Page operation failed",
      );
    return r.result.value;
  }
  async snapshot(query) {
    if (this.dialog)
      return {
        url: this.url,
        document: this.document,
        dialog: this.dialog,
        frames: [],
        text: "Handle the open dialog or take over the browser.",
      };
    const generation = this.generation,
      frames = [];
    this.snapshots.clear();
    for (const f of [...this.frames.values()].slice(0, 12)) {
      try {
        if (!["about:blank", "about:srcdoc"].includes(f.url)) allowedUrl(f.url);
        const r = await this.probe(f, { kind: "snapshot", query });
        for (const el of r.elements) {
          const ref = f.id + ":" + el.reference;
          this.snapshots.set(ref, { frame: f, document: r.document, reference: el.reference });
          el.reference = ref;
        }
        frames.push({ ...r, frame_id: f.id });
      } catch (e) {
        frames.push({ frame_id: f.id, url: f.url, error: String(e) });
      }
    }
    if (generation !== this.generation)
      throw new Error("Page navigated while reading; read it again.");
    this.document = crypto.randomUUID();
    this.snapshotGeneration = generation;
    return {
      document: this.document,
      url: this.url,
      frames,
      dialog: this.dialog,
      blocked_downloads: this.blockedDownloads,
      untrusted: true,
    };
  }
  async guard(action) {
    if (action.kind === "navigate") allowedUrl(action.url);
    if (this.closed) throw new Error("The tab is disconnected.");
    if (action.document !== this.document || this.snapshotGeneration !== this.generation)
      throw new Error("Page changed; read it again before acting.");
    if (this.url !== "about:blank") allowedUrl(this.url);
    const target = action.reference ? this.snapshots.get(action.reference) : null;
    if (action.reference && !target) throw new Error("Unknown or expired element reference.");
    const element = target
      ? await this.probe(target.frame, {
          kind: "validate",
          document: target.document,
          reference: target.reference,
        })
      : null;
    if (action.kind === "click" && element?.href) allowedUrl(element.href);
    if (["click", "fill", "upload"].includes(action.kind) && element?.form_action)
      allowedUrl(element.form_action);
    return {
      document: this.document,
      url: this.url,
      element,
      dialog: this.dialog,
      generation: this.generation,
    };
  }
  async perform(action) {
    if (action.kind === "snapshot") return this.snapshot(action.query);
    await this.guard(action);
    if (action.kind === "navigate") {
      const url = allowedUrl(action.url);
      const r = await this.send("Page.navigate", { url });
      if (r.errorText) throw new Error(r.errorText);
      return { navigated: true, url };
    }
    if (action.kind === "dialog") {
      if (!this.dialog) throw new Error("There is no open dialog.");
      await this.send("Page.handleJavaScriptDialog", {
        accept: action.accept,
        promptText: action.text || "",
      });
      return { handled: true };
    }
    if (action.kind === "screenshot") {
      const r = await this.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      if (r.data.length > 4 * 1024 * 1024) throw new Error("Screenshot exceeds the 3 MiB limit.");
      return { image: "data:image/png;base64," + r.data, url: this.url, document: this.document };
    }
    const target = this.snapshots.get(action.reference);
    if (action.kind === "download") {
      const link = await this.probe(target.frame, {
        kind: "download",
        document: target.document,
        reference: target.reference,
      });
      const url = allowedUrl(link.url);
      this.expectedDownload = url;
      let resource,
        bytes = [],
        length = 0;
      try {
        ({ resource } = await this.send(
          "Network.loadNetworkResource",
          {
            frameId: target.frame.id,
            url,
            options: { disableCache: true, includeCredentials: true },
          },
          target.frame.session,
        ));
        if (!resource.success || !resource.stream || resource.httpStatusCode >= 400)
          throw new Error("Download could not be read in the connected browser.");
        for (let i = 0; i < 1024; i++) {
          const p = await this.send(
            "IO.read",
            { handle: resource.stream, size: 16384 },
            target.frame.session,
          );
          const part = p.base64Encoded
            ? Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(p.data);
          length += part.length;
          if (length > FILE_LIMIT) throw new Error("Download exceeds 8 MiB.");
          bytes.push(part);
          if (p.eof) break;
          if (i === 1023) throw new Error("Download stream did not end.");
        }
      } finally {
        this.expectedDownload = null;
        if (resource?.stream)
          await this.send("IO.close", { handle: resource.stream }, target.frame.session).catch(
            () => {},
          );
      }
      let binary = "";
      for (const b of bytes)
        for (let i = 0; i < b.length; i += 16384)
          binary += String.fromCharCode(...b.subarray(i, i + 16384));
      return { bytes: btoa(binary), url, byte_length: length, status: resource.httpStatusCode };
    }
    const generation = this.generation;
    const observedDialog = new Promise((resolve) => {
      this.dialogOpened = resolve;
    });
    const work = this.probe(target.frame, {
      ...action,
      document: target.document,
      reference: target.reference,
    }).catch((error) => {
      if (this.generation !== generation) return { performed: true, navigation_observed: true };
      throw error;
    });
    try {
      return await Promise.race([work, observedDialog]);
    } finally {
      this.dialogOpened = null;
    }
  }
}

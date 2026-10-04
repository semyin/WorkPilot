// Runs inside the real application WebView. Timings end at DOM mutation, not
// physical display refresh. It observes ordinary UI; no test hooks enter the app.
export function installObservers() {
  const result = { button: [], input: [], stopFeedback: [], stopFinished: [], text: {} };
  window.p13Metrics = result;
  let click, input, stop;
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.p13Button === "sidebar") {
        click = { at: performance.now(), before: button.getAttribute("aria-pressed"), button };
      }
      if (button.dataset.p13Button === "stop") {
        stop = { at: performance.now(), feedback: false };
      }
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (event.target.matches(".execution-composer textarea") && event.target.value)
        input = performance.now();
    },
    true,
  );
  new MutationObserver(() => {
    if (click && click.button.getAttribute("aria-pressed") !== click.before) {
      result.button.push(performance.now() - click.at);
      click = undefined;
    }
    if (
      input !== undefined &&
      document.querySelector(".execution-composer button.primary")?.disabled === false
    ) {
      result.input.push(performance.now() - input);
      input = undefined;
    }
    const state = document.querySelector('[data-testid="execution-status"]')?.dataset.state;
    if (stop && state === "stopping" && !stop.feedback) {
      result.stopFeedback.push(performance.now() - stop.at);
      stop.feedback = true;
    }
    if (stop && state === "interrupted") {
      if (!stop.feedback) result.stopFeedback.push(performance.now() - stop.at);
      result.stopFinished.push(performance.now() - stop.at);
      stop = undefined;
    }
    for (const element of document.querySelectorAll(
      ".conversation-turn.assistant pre, .execution-answer:not([hidden])",
    )) {
      for (const match of element.textContent.matchAll(/P13_EVENT_\d{4}/g))
        result.text[match[0]] ??= Date.now();
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
}

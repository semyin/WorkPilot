const Motion = (() => {
  const active = new WeakMap();
  const systemPreference = matchMedia("(prefers-reduced-motion: reduce)");
  const duration = (ms = 200) =>
    systemPreference.matches ||
    document.body.classList.contains("reduce-motion")
      ? 0
      : ms;
  function cancel(element) {
    active.get(element)?.cancel();
    active.delete(element);
  }
  function play(element, frames, ms = 200) {
    cancel(element);
    if (!duration(ms) || !element.animate) return Promise.resolve();
    const animation = element.animate(frames, {
      duration: duration(ms),
      easing: "cubic-bezier(.2,.75,.25,1)",
    });
    active.set(element, animation);
    return animation.finished
      .catch(() => {})
      .then(() => {
        if (active.get(element) === animation) active.delete(element);
      });
  }
  function enter(element, distance = 5) {
    return play(
      element,
      [
        { opacity: 0.25, transform: `translateY(${distance}px)` },
        { opacity: 1, transform: "translateY(0)" },
      ],
      180,
    );
  }
  function replace(element, html, key) {
    const changed = element.dataset.viewKey !== String(key);
    element.dataset.viewKey = String(key);
    if (element.innerHTML === html) return;
    element.innerHTML = html;
    if (changed) enter(element);
  }
  function region(element, open) {
    const from = element.hidden ? 0 : element.getBoundingClientRect().height;
    const current = getComputedStyle(element);
    const fromTop = element.hidden ? "0px" : current.marginTop;
    const fromBottom = element.hidden ? "0px" : current.marginBottom;
    cancel(element);
    element.dataset.expanded = String(open);
    element.hidden = false;
    element.inert = !open;
    const to = open ? element.scrollHeight : 0;
    const natural = getComputedStyle(element);
    const toTop = open ? natural.marginTop : "0px";
    const toBottom = open ? natural.marginBottom : "0px";
    element.style.overflow = "hidden";
    if (!duration()) {
      element.hidden = !open;
      element.style.overflow = "";
      return;
    }
    const animation = element.animate(
      [
        {
          height: `${from}px`,
          opacity: open ? 0.2 : 1,
          marginTop: fromTop,
          marginBottom: fromBottom,
        },
        {
          height: `${to}px`,
          opacity: open ? 1 : 0,
          marginTop: toTop,
          marginBottom: toBottom,
        },
      ],
      { duration: duration(220), easing: "cubic-bezier(.2,.75,.25,1)" },
    );
    active.set(element, animation);
    animation.finished
      .then(() => {
        if (active.get(element) !== animation) return;
        active.delete(element);
        element.hidden = !open;
        element.style.overflow = "";
      })
      .catch(() => {});
  }
  function disclosure(details) {
    const open =
      details.dataset.expanded !== undefined
        ? details.dataset.expanded !== "true"
        : !details.open;
    const from = details.getBoundingClientRect().height;
    cancel(details);
    details.dataset.expanded = String(open);
    details.open = open;
    const to = details.getBoundingClientRect().height;
    if (!duration()) {
      details.style.overflow = "";
      return;
    }
    details.open = true;
    details.style.overflow = "hidden";
    const animation = details.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: duration(210), easing: "cubic-bezier(.2,.75,.25,1)" },
    );
    active.set(details, animation);
    animation.finished
      .then(() => {
        if (active.get(details) !== animation) return;
        active.delete(details);
        details.open = open;
        details.style.overflow = "";
      })
      .catch(() => {});
  }
  function openDialog(dialog) {
    cancel(dialog);
    delete dialog.dataset.closing;
    if (!dialog.open) dialog.showModal();
    play(dialog, [{ opacity: 0 }, { opacity: 1 }], 160);
    const content = dialog.firstElementChild;
    if (content) enter(content, 8);
  }
  function closeDialog(dialog, done) {
    if (!dialog.open) {
      done?.();
      return;
    }
    if (dialog.dataset.closing) return;
    dialog.dataset.closing = "true";
    closeMenu(false);
    if (!duration()) {
      delete dialog.dataset.closing;
      dialog.close();
      done?.();
      return;
    }
    const animation = dialog.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: duration(130),
      easing: "ease-out",
    });
    cancel(dialog);
    active.set(dialog, animation);
    animation.finished
      .then(() => {
        if (active.get(dialog) !== animation) return;
        active.delete(dialog);
        delete dialog.dataset.closing;
        dialog.close();
        done?.();
      })
      .catch(() => {});
  }
  document.addEventListener("click", (event) => {
    const summary = event.target.closest("summary");
    if (summary && summary.parentElement.tagName === "DETAILS") {
      event.preventDefault();
      disclosure(summary.parentElement);
    }
  });
  return { duration, enter, replace, region, openDialog, closeDialog };
})();

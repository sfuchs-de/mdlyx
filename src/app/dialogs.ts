// In-DOM replacements for window.confirm()/prompt(). The native dialogs are
// unusable in the desktop build — wry's WKWebView implements no JS dialog
// panels, so confirm() always returns false and prompt() always returns null —
// which silently disabled every confirm-gated flow (dirty-tab close, updater
// download/install, clear-local-data, new-document naming). These render a
// modal overlay instead, so the same code path works in the browser and the
// desktop shell, and e2e can drive them like any other DOM.

export interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (e.g. "Discard"). */
  danger?: boolean;
}

interface DialogParts {
  overlay: HTMLDivElement;
  form: HTMLFormElement;
  message: HTMLParagraphElement;
  confirm: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

function buildDialog(text: string, opts: ConfirmOptions): DialogParts {
  const overlay = document.createElement("div");
  overlay.className = "dialog-overlay";
  const form = document.createElement("form");
  form.className = "dialog";
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-modal", "true");
  form.setAttribute("aria-label", text);
  const message = document.createElement("p");
  message.className = "dialog-message";
  message.textContent = text;
  const row = document.createElement("div");
  row.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dialog-cancel";
  cancel.textContent = opts.cancelLabel ?? "Cancel";
  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.className = "dialog-confirm" + (opts.danger ? " is-danger" : "");
  confirm.textContent = opts.confirmLabel ?? "OK";
  row.append(cancel, confirm);
  form.append(message, row);
  overlay.appendChild(form);
  return { overlay, form, message, confirm, cancel };
}

// Shared open/close plumbing: mounts the overlay, wires Escape/outside-click to
// cancel, restores focus to the previously focused element, resolves exactly once.
function runDialog<T>(
  parts: DialogParts,
  focusTarget: HTMLElement,
  onSubmit: () => T,
  cancelValue: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      parts.overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      previous?.focus();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(cancelValue);
      }
    };
    parts.form.addEventListener("submit", (e) => {
      e.preventDefault();
      finish(onSubmit());
    });
    parts.cancel.addEventListener("click", () => finish(cancelValue));
    // Backdrop dismissal needs BOTH mousedown and mouseup on the backdrop — a
    // raw mousedown made a double-click on the triggering control (whose second
    // press lands on the freshly mounted overlay) flash-cancel the dialog. The
    // second press of a real double-click has detail=2; do not arm dismissal for
    // that spillover sequence even if its down and up both land on the overlay.
    let pressedBackdrop = false;
    parts.overlay.addEventListener("mousedown", (e) => {
      pressedBackdrop = e.target === parts.overlay && e.detail <= 1;
    });
    parts.overlay.addEventListener("mouseup", (e) => {
      if (pressedBackdrop && e.target === parts.overlay && e.detail <= 1) finish(cancelValue);
      pressedBackdrop = false;
    });
    // Contain the keyboard: stop keydowns from bubbling past the overlay so
    // app-level shortcuts (⌘W/⌘T/⌘S…) can't act on the UI behind the modal, and
    // keep Tab cycling inside the dialog's own controls.
    parts.overlay.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        const controls = [...parts.form.querySelectorAll<HTMLElement>("input, button")];
        if (controls.length) {
          const idx = controls.indexOf(document.activeElement as HTMLElement);
          const next = e.shiftKey
            ? controls[(idx - 1 + controls.length) % controls.length]
            : controls[(idx + 1) % controls.length];
          e.preventDefault();
          next.focus();
        }
      }
      e.stopPropagation();
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(parts.overlay);
    focusTarget.focus();
  });
}

/** Modal yes/no question. Resolves true only on explicit confirmation. */
export function confirmDialog(text: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const parts = buildDialog(text, opts);
  return runDialog(parts, parts.confirm, () => true, false);
}

/** Modal text input. Resolves the entered string, or null on cancel/Escape. */
export function promptDialog(
  text: string,
  initial = "",
  opts: ConfirmOptions = {},
): Promise<string | null> {
  const parts = buildDialog(text, { confirmLabel: "Create", ...opts });
  const input = document.createElement("input");
  input.type = "text";
  input.className = "dialog-input";
  input.value = initial;
  input.addEventListener("focus", () => input.select(), { once: true });
  parts.message.after(input);
  return runDialog<string | null>(parts, input, () => input.value, null).then((v) => {
    if (v === null) return null;
    return v;
  });
}

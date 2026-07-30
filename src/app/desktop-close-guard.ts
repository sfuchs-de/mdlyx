export interface DesktopCloseRequest {
  preventDefault(): void;
}

export interface DesktopWindowCloseControl {
  onCloseRequested(
    handler: (event: DesktopCloseRequest) => void | Promise<void>,
  ): Promise<() => void>;
  destroy(): Promise<void>;
}

/** Await recovery persistence before allowing the native WebView to disappear. */
export function installDesktopCloseGuard(
  window: DesktopWindowCloseControl,
  flushRecovery: () => Promise<void>,
  onFailure: (error: unknown) => void = () => undefined,
): Promise<() => void> {
  let closing = false;
  return window.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await flushRecovery();
      await window.destroy();
    } catch (error) {
      closing = false;
      onFailure(error);
    }
  });
}

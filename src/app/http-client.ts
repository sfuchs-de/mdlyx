export class HttpRequestError extends Error {
  constructor(
    message: string,
    public readonly code: "offline" | "timeout" | "auth" | "conflict" | "rate-limit" | "http",
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HttpRequestError";
  }
}

export interface HttpRequestOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export class HttpClient {
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly defaultTimeoutMs = 12_000,
  ) {}

  async request(
    input: RequestInfo | URL,
    init: RequestInit = {},
    options: HttpRequestOptions = {},
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const retryable = method === "GET" || method === "HEAD";
    const retries = retryable ? Math.max(0, options.retries ?? 2) : 0;
    let attempt = 0;
    while (true) {
      try {
        const response = await this.attempt(input, init, options);
        if (attempt < retries && shouldRetryStatus(response.status)) {
          await delay(retryDelay(attempt, response.headers.get("retry-after")), options.signal);
          attempt++;
          continue;
        }
        return response;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        const requestError = asRequestError(error);
        if (attempt >= retries || (requestError.code !== "offline" && requestError.code !== "timeout")) {
          throw requestError;
        }
        await delay(retryDelay(attempt), options.signal);
        attempt++;
      }
    }
  }

  private async attempt(
    input: RequestInfo | URL,
    init: RequestInit,
    options: HttpRequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs);
    const timeout = setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), timeoutMs);
    const external = options.signal ?? init.signal;
    const abort = () => controller.abort(external?.reason);
    if (external?.aborted) abort();
    else external?.addEventListener("abort", abort, { once: true });
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !external?.aborted) {
        throw new HttpRequestError("The request timed out.", "timeout", undefined, undefined, { cause: error });
      }
      if (external?.aborted) throw external.reason ?? error;
      throw new HttpRequestError("The service is offline or unreachable.", "offline", undefined, undefined, { cause: error });
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener("abort", abort);
    }
  }
}

export async function responseJson<T>(response: Response, fallback = "Request failed"): Promise<T> {
  const body = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `${fallback} (${response.status})`;
    throw responseError(response, message);
  }
  return body as T;
}

export function responseError(response: Response, message: string): HttpRequestError {
  if (response.status === 401 || response.status === 403) {
    return new HttpRequestError(message, "auth", response.status);
  }
  if (response.status === 409 || response.status === 412) {
    return new HttpRequestError(message, "conflict", response.status);
  }
  if (response.status === 429) {
    return new HttpRequestError(
      message,
      "rate-limit",
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return new HttpRequestError(message, "http", response.status);
}

function asRequestError(error: unknown): HttpRequestError {
  return error instanceof HttpRequestError
    ? error
    : new HttpRequestError("The service is offline or unreachable.", "offline", undefined, undefined, { cause: error });
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryDelay(attempt: number, retryAfter?: string | null): number {
  const requested = parseRetryAfter(retryAfter ?? null);
  if (requested !== undefined) return Math.min(10_000, requested);
  return Math.min(4_000, 250 * 2 ** attempt);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

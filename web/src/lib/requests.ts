interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  environment?: string;
}

const pending = new Map<string, PendingResponse>();

export function awaitResponse<T>(id: string, timeout = 65_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The request timed out. Refresh to check the result before retrying."));
    }, timeout);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
  });
}

export function resolveResponse(id: string, value?: unknown, error?: string): void {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timer);
  if (error) request.reject(new Error(error));
  else request.resolve(value);
}

export function trackRequest(id: string, environment: string): void {
  const request = pending.get(id);
  if (request) request.environment = environment;
}

export function rejectResponses(environment?: string): void {
  for (const [id, request] of pending) {
    if (environment && request.environment !== environment) continue;
    resolveResponse(id, undefined, "The connection to Citropy was interrupted. Check the result before retrying this action.");
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => rejectResponses());

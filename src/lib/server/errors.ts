export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request",
  ) {
    super(message);
  }
}

export class NotFound extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 404, "not_found");
  }
}

/** Turn any thrown value into a message that is safe to show (never leaks internals). */
export function publicMessage(e: unknown): string {
  if (e instanceof AppError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ENOTFOUND|connect_timeout|CONNECT_TIMEOUT|unconfigured/i.test(msg))
    return "HARU can't reach its database right now. Nothing was saved.";
  if (/duplicate key|unique constraint/i.test(msg)) return "That record already exists.";
  if (/violates check constraint/i.test(msg)) return "That value isn't allowed for this record.";
  if (/violates foreign key/i.test(msg)) return "That refers to a record that doesn't exist.";
  return "Something went wrong. Nothing was changed.";
}

export function logError(scope: string, e: unknown) {
  // Never log request bodies or secrets — only the error itself.
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[haru:${scope}] ${msg}`);
}

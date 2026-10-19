// Every probe in the stack-stop code answers { ok: true, value } or { ok: false, reason }. "unknown" is never read as "no":
// a caller that needs the answer and gets unknown keeps the stack and says why (fail closed).
export const ok = (value) => ({ ok: true, value });
export const unknown = (reason) => ({ ok: false, reason: String(reason) });
export const allOk = (results) => results.every((r) => r && r.ok === true);

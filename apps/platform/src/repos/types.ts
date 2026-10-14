export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; code?: string };

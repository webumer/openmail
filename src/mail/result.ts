export interface ToolSuccess<T> {
  ok: true;
  data: T;
  truncated: boolean;
  warnings: string[];
}

export interface ToolFailure {
  ok: false;
  error: { code: string; message: string };
  warnings: string[];
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export function ok<T>(data: T, options?: { truncated?: boolean; warnings?: string[] }): ToolSuccess<T> {
  return {
    ok: true,
    data,
    truncated: options?.truncated ?? false,
    warnings: options?.warnings ?? [],
  };
}

export function fail(code: string, message: string, warnings: string[] = []): ToolFailure {
  return { ok: false, error: { code, message }, warnings };
}

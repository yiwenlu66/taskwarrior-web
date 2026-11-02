export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, options);
  const body = await response.json().catch(() => ({ error: `Invalid response (${response.status})` }));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

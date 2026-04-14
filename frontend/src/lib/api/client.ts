export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export function getToken(): string | null {
  return localStorage.getItem("las_token");
}

export function setToken(token: string) {
  localStorage.setItem("las_token", token);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem("las_refresh_token");
}

export function setRefreshToken(token: string) {
  localStorage.setItem("las_refresh_token", token);
}

export function clearToken() {
  localStorage.removeItem("las_token");
  localStorage.removeItem("las_refresh_token");
}

// ---------------------------------------------------------------------------
// Generic fetch wrapper
// ---------------------------------------------------------------------------

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    // Try refreshing the token once
    const rt = getRefreshToken();
    if (rt) {
      try {
        const refreshRes = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          setToken(data.access_token);
          headers["Authorization"] = `Bearer ${data.access_token}`;
          const retry = await fetch(`${API_BASE}${path}`, { ...options, headers });
          if (retry.ok) {
            if (retry.status === 204) return undefined as T;
            return retry.json() as Promise<T>;
          }
        }
      } catch {
        // refresh failed, fall through to logout
      }
    }
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error("権限がありません");
    }
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

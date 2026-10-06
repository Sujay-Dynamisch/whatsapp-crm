import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

// `rpcResult` — what my_disabled_features() resolves to.
let rpcResult: { data: string[] | null; error: { message: string } | null } = {
  data: [],
  error: null,
};
const rpcCalls: string[] = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    // my_disabled_features() — migration 045's request gate.
    rpc: (fn: string) => {
      rpcCalls.push(fn);
      return Promise.resolve(rpcResult);
    },
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
  rpcResult = { data: [], error: null };
  rpcCalls.length = 0;
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — account feature entitlements (migration 045)", () => {
  const run = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
    middleware(new NextRequest(`https://app.test${path}`, init));

  it("redirects a page of a switched-off feature to the dashboard with a reason", async () => {
    mockUser = { id: "user-1" };
    rpcResult = { data: ["pipelines"], error: null };

    const res = await run("/pipelines");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/dashboard");
    expect(location.searchParams.get("feature_disabled")).toBe("pipelines");
  });

  it("answers 403 JSON for an API of a switched-off feature", async () => {
    mockUser = { id: "user-1" };
    rpcResult = { data: ["broadcasts"], error: null };

    const res = await run("/api/whatsapp/broadcast", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "feature_disabled", feature: "broadcasts" });
  });

  it("blocks dependants with their parent (scheduling under broadcasts)", async () => {
    mockUser = { id: "user-1" };
    rpcResult = { data: ["broadcasts"], error: null };

    const res = await run("/api/whatsapp/broadcast/abc/schedule", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ feature: "broadcast_scheduling" });
  });

  it("lets enabled features through untouched", async () => {
    mockUser = { id: "user-1" };
    rpcResult = { data: ["flows"], error: null };

    const res = await run("/broadcasts");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not look features up for ungated paths", async () => {
    mockUser = { id: "user-1" };
    rpcResult = { data: ["pipelines", "broadcasts"], error: null };

    const res = await run("/inbox");
    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([]);
  });

  it("does not look features up for signed-out requests (auth redirect wins)", async () => {
    rpcResult = { data: ["pipelines"], error: null };
    const res = await run("/pipelines");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(rpcCalls).toEqual([]);
  });

  it("fails open on a lookup error (database policies and workers still enforce)", async () => {
    mockUser = { id: "user-1" };
    rpcResult = { data: null, error: { message: "timeout" } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await run("/pipelines");
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("carries rotated auth cookies on the feature redirect too", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];
    rpcResult = { data: ["ai_agents"], error: null };

    const res = await run("/agents");
    expect(res.status).toBe(307);
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — button analytics gate (migration 046)", () => {
  it("redirects the Button Clicks tab and 403s its API when switched off", async () => {
    mockUser = { id: "user-1" };
    rpcResult = { data: ["button_analytics"], error: null };

    const page = await middleware(new NextRequest("https://app.test/button-clicks"));
    expect(new URL(page.headers.get("location")!).searchParams.get("feature_disabled")).toBe(
      "button_analytics",
    );
    const api = await middleware(new NextRequest("https://app.test/api/button-clicks"));
    expect(api.status).toBe(403);
  });
});

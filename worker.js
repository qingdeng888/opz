export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const targetUrl = "https://opencode.ai" + url.pathname;

      const headers = {
        "Content-Type": "application/json",
        "Authorization": "public",
        "Host": "opencode.ai",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, br",
        "User-Agent": "opencode/1.18.12 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13",
        "X-Opencode-Client": "cli"
      };

      let body = null;
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        body = await request.text();
      } else if (url.pathname === "/chat") {
        const q = url.searchParams.get("q") || "hi";
        const model = url.searchParams.get("model") || "deepseek-v4-flash-free";
        const tokens = parseInt(url.searchParams.get("tokens") || "512");
        body = JSON.stringify({ model, messages: [{ role: "user", content: q }], max_tokens: Math.min(tokens, 8192) });
      }

      const init = {
        method: (body && url.pathname !== "/chat") ? request.method : (body ? "POST" : "GET"),
        headers,
        body,
        redirect: "follow",
        cf: { cacheTtl: 0 }
      };

      const r = await fetch(targetUrl, init);
      const h = new Headers();
      h.set("Content-Type", r.headers.get("Content-Type") || "application/json");
      h.set("Access-Control-Allow-Origin", "*");
      h.set("X-Proxy-By", "zen-proxy-v2");

      return new Response(r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: h
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

import http from "node:http";
import type { AddressInfo } from "node:net";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title} description for testing purposes."></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

/** Local site used by subprocess tests: a home page, a good page, a 404 link and a very slow page. */
export async function startFixtureServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (code: number, body: string, type = "text/html; charset=utf-8") => {
      res.writeHead(code, { "Content-Type": type });
      res.end(body);
    };
    if (url === "/robots.txt") return send(200, "User-agent: *\nDisallow: /private/\n", "text/plain");
    if (url === "/")
      return send(200, page("Fixture Home", `<p>Welcome to the fixture website which sells reliable test widgets to engineers everywhere.</p>
        <a href="/good">Good</a> <a href="/missing">Broken</a> <a href="/private/x">Private</a>`));
    if (url === "/good")
      return send(200, page("Good Page", `<p>This page contains useful information about widget durability and engineering quality.</p><a href="/">Home</a>`));
    if (url === "/solo")
      return send(200, page("Solo Page", `<p>A single page without any outgoing links, used for fully successful crawls.</p>`));
    if (url === "/slow") {
      setTimeout(() => send(200, page("Slow", "<p>slow</p>")), 8000);
      return;
    }
    send(404, "<html><body>not found</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

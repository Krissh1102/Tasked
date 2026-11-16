// Local demo website for TaskForge (no external network needed).
// Run:  npm run demo:site     then start the app with TASKFORGE_UNSAFE_ALLOW_PRIVATE=1 (see README).
import http from "node:http";

const PORT = Number(process.env.DEMO_PORT || 8765);
const page = (t, body) => `<!doctype html><html><head><title>${t}</title><meta name="description" content="${t}: demo page served by the TaskForge local test site."></head><body><nav><a href="/">Home</a></nav><main><h1>${t}</h1>${body}</main></body></html>`;
const routes = {
  "/": () => page("Northwind Demo Co", `<h2>What we do</h2><p>Northwind builds dependable logistics software that helps warehouses track inventory in real time across many sites.</p><p>Our platform reduces picking errors and gives managers clear dashboards for daily operations.</p><a href="/about">About</a> <a href="/products">Products</a> <a href="/broken">Press kit</a> <a href="/private/notes">Internal</a> <a href="https://example.org/partners">Partners</a>`),
  "/about": () => page("About Northwind", `<h2>Our story</h2><p>Founded in 2012, Northwind grew from a two person team into a company serving customers in thirty countries.</p><a href="/products">Products</a>`),
  "/products": () => page("Northwind Products", `<h2>Inventory tracker</h2><p>The inventory tracker follows every pallet from receiving to shipping and alerts teams when stock runs low.</p><h2>Route planner</h2><p>The route planner builds efficient delivery routes using live traffic and vehicle capacity.</p>`),
};
http.createServer((req, res) => {
  const send = (c, b, t = "text/html; charset=utf-8") => { res.writeHead(c, { "Content-Type": t }); res.end(b); };
  const u = (req.url || "/").split("?")[0];
  if (u === "/robots.txt") return send(200, "User-agent: *\nDisallow: /private/\n", "text/plain");
  if (u === "/slow") return setTimeout(() => send(200, page("Slow page", "<p>This page answers after a long delay to demonstrate timeouts and cancellation.</p>")), 120000);
  if (routes[u]) return send(200, routes[u]());
  send(404, "<html><body>Not found</body></html>");
}).listen(PORT, "127.0.0.1", () => console.log(`Demo site on http://127.0.0.1:${PORT}  (/slow never answers in time; /broken is a 404)`));

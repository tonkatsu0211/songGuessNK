const http = require("http");

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }

  let url;
  let pathname;
  try {
    url = new URL(req.url, "http://localhost");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end("Bad Request");
  }

  // Render のヘルスチェック用
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Webページを配信中: ポート ${PORT}`);
});

module.exports = server;

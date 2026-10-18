// The stats login form: POSTs {token} to /stats/login; the server sets an HMAC cookie (the raw
// token is never in a cookie or a URL) and we reload into the page.
const form = document.getElementById("login");
const msg = document.getElementById("msg");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msg.textContent = "";
  const token = document.getElementById("token").value;
  try {
    const r = await fetch("/stats/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (r.status === 204) { location.reload(); return; }
    msg.textContent = r.status === 429 ? "Too many attempts — wait a minute." : "Wrong token.";
  } catch {
    msg.textContent = "Can't reach the server.";
  }
});

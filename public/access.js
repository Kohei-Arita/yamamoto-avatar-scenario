const form = document.getElementById("accessForm");
const input = document.getElementById("accessToken");
const message = document.getElementById("accessMessage");
const button = form.querySelector("button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  try {
    const response = await fetch("/api/access", {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: input.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "認証に失敗しました。");
    input.value = "";
    const next = new URLSearchParams(window.location.search).get("next") || "/xgate";
    const target = new URL(next, window.location.origin);
    window.location.replace(target.origin === window.location.origin ? target.href : "/xgate");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
// モジュールの読込前に通常のフォーム送信で遷移しないようにする。
button.disabled = false;

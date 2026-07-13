const form = document.querySelector("#login-form");
const errorMessage = document.querySelector("#login-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  errorMessage.textContent = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || "Přihlášení selhalo.");
    window.location.replace("/");
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

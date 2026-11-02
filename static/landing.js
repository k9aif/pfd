const $ = (id) => document.getElementById(id);

async function showSetupIfNeeded() {
  try {
    const status = await (await fetch('/api/status')).json();
    if (!status.usersConfigured) {
      $('login-form').hidden = true;
      $('setup').hidden = false;
    }
  } catch {
    // The form still works; a real error will show when signing in.
  }
}

async function signIn(e) {
  e.preventDefault();
  const error = $('login-error');
  const button = e.target.querySelector('button');
  error.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PFD': '1' },
      body: JSON.stringify({ name: $('name').value, password: $('password').value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Sign-in failed (HTTP ${res.status})`);
    location.href = '/app';
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    $('password').select();
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('login-form').addEventListener('submit', signIn);
  showSetupIfNeeded();
});

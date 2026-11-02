const $ = (id) => document.getElementById(id);

async function showDemoHint() {
  try {
    const status = await (await fetch('/api/status')).json();
    if (status.demo) {
      $('demo-hint').hidden = false;
      $('name').value = 'demo';
    }
    if (status.publicDemo) {
      $('demo-hint').querySelector('span').textContent = 'Public demo with sample numbers. Your changes stay private to your '
        + 'visit and are thrown away when you sign out or after 2 idle hours. Please do not enter real numbers: '
        + 'run your own copy for that (below).';
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

async function copyCode(e) {
  const button = e.target.closest('[data-copy]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText($(button.dataset.copy).textContent);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select and copy';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 2000);
}

document.addEventListener('DOMContentLoaded', () => {
  $('login-form').addEventListener('submit', signIn);
  document.addEventListener('click', copyCode);
  showDemoHint();
});

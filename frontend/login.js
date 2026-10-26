document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('login-form');
  const message = document.getElementById('login-message');
  const params = new URLSearchParams(window.location.search);

  function showMessage(text, type = 'error') {
    message.textContent = text;
    message.className = `auth-message visible ${type}`;
  }

  const initialMessage = params.get('message') || params.get('error');
  if (initialMessage) showMessage(initialMessage, params.get('message') ? 'success' : 'error');

  try {
    await window.auth.config;
  } catch (error) {
    showMessage(error.message || 'Authentication is not configured.');
  }

  // If already authenticated and not showing a logout message, auto-redirect to proper page
  if (!params.get('message')) {
    try {
      const state = await window.authReady;
      if (state && state.session && state.role) {
        if (state.role === 'super_admin') {
          window.location.replace('admin.html');
          return;
        } else if (state.role === 'teacher') {
          window.location.replace('examinations.html');
          return;
        } else if (state.role === 'staff') {
          window.location.replace('dashboard.html');
          return;
        }
      }
    } catch (e) {}
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    showMessage('Signing in…', 'success');

    try {
      const formData = new FormData(form);
      const email = String(formData.get('email') || '').trim();
      const password = String(formData.get('password') || '');
      const authResult = await window.auth.signIn(email, password);

      if (authResult.role === 'super_admin') {
        window.location.replace('admin.html');
      } else if (authResult.role === 'teacher') {
        window.location.replace('examinations.html');
      } else {
        window.location.replace('dashboard.html');
      }
    } catch (error) {
      showMessage(error.message || 'Unable to sign in.');
      submitButton.disabled = false;
    }
  });
});
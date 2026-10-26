(function () {
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  function loadSupabaseLibrary() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SUPABASE_CDN;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Supabase library failed to load.'));
      document.head.appendChild(s);
    });
  }

  const config = (async () => {
    const res = await fetch('/abms/api/auth/config');
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) {
      throw new Error(body.message || body.error || 'Authentication is not configured');
    }
    await loadSupabaseLibrary();
    return window.supabase.createClient(body.data.url, body.data.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  })();
  config.catch(() => { });

  function readStoredToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          const session = JSON.parse(localStorage.getItem(key));
          return (session && session.access_token) || null;
        }
      }
    } catch (e) { }
    return null;
  }

  let currentAuthState = null;

  async function resolveRole(client, userId, accessToken) {
    if (!userId) return null;
    let role = null;
    try {
      const { data: roleRow } = await client
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();
      if (roleRow && (roleRow.role === 'super_admin' || roleRow.role === 'staff' || roleRow.role === 'teacher')) {
        role = roleRow.role;
      }
    } catch (e) { }

    if (!role && accessToken) {
      try {
        const res = await fetch('/abms/api/me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const json = await res.json();
        if (json.success && json.data?.role) {
          role = json.data.role;
        }
      } catch (e) { }
    }
    return role;
  }

  window.auth = {
    config,
    session: null,
    state: null,

    getAccessToken() {
      return window.auth.session?.access_token || readStoredToken();
    },

    async signUpStaff({ full_name, email, password, notes }) {
      if (!full_name || !email || !password) throw new Error('Name, email and password are required.');
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      const client = await config;
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { full_name, notes: notes || null } }
      });
      if (error) throw new Error(error.message);

      const userId = data?.user?.id || null;

      try {
        await fetch('/abms/api/staff-applications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name,
            email,
            notes: notes || null,
            user_id: userId
          })
        });
      } catch (e) {
        console.warn('Could not post staff application:', e);
      }

      await client.auth.signOut();
    },

    async signUpTeacher({ full_name, email, password, phone, requested_classes }) {
      if (!full_name || !email || !password) throw new Error('Name, email and password are required.');
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      if (!Array.isArray(requested_classes) || requested_classes.length === 0) {
        throw new Error('Please select at least one class and subject.');
      }
      const client = await config;
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { full_name, phone: phone || null } }
      });
      if (error) throw new Error(error.message);

      const userId = data?.user?.id || null;

      const res = await fetch('/abms/api/teacher-applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name,
          email,
          phone: phone || null,
          user_id: userId,
          requested_classes
        })
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error || json.message || 'Failed to submit teacher application.');
      }

      await client.auth.signOut();
    },

    async signIn(email, password) {
      const client = await config;
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;

      const role = await resolveRole(client, data.user.id, data.session.access_token);

      if (!role) {
        let appStatus = null;
        try {
          const { data: app } = await client
            .from('staff_applications').select('status').eq('user_id', data.user.id).maybeSingle();
          appStatus = app?.status;
        } catch (e) { }

        if (!appStatus) {
          try {
            const { data: tApp } = await client
              .from('teacher_applications').select('status').eq('user_id', data.user.id).maybeSingle();
            appStatus = tApp?.status;
          } catch (e) { }
        }

        await client.auth.signOut();
        window.auth.session = null;
        window.auth.state = null;
        currentAuthState = null;

        throw new Error(appStatus === 'rejected'
          ? 'Your application was rejected.'
          : 'Your account is awaiting Super Admin approval.');
      }

      currentAuthState = { session: data.session, user: data.user, role };
      window.auth.session = data.session;
      window.auth.state = currentAuthState;
      return { ...data, role };
    },

    async signOut() {
      try {
        const client = await config;
        await client.auth.signOut();
      } catch (e) { }
      window.auth.session = null;
      window.auth.state = null;
      currentAuthState = null;
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
            localStorage.removeItem(key);
          }
        }
      } catch (e) { }
      window.location.replace('login.html?message=You%20have%20been%20logged%20out.');
    },

    async getSession() {
      const client = await config;
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    },

    async requireAuth() {
      const session = await this.getSession();
      if (!session) window.location.replace('login.html');
      return session;
    }
  };

  // Immediate promise to resolve auth and role across all pages
  window.authReady = (async function initAuth() {
    try {
      const client = await config;
      const { data, error } = await client.auth.getSession();
      const session = data?.session;
      if (error || !session?.user) {
        window.auth.session = null;
        window.auth.state = null;
        currentAuthState = null;
        return null;
      }

      const role = await resolveRole(client, session.user.id, session.access_token);
      currentAuthState = {
        session,
        user: session.user,
        role
      };
      window.auth.session = session;
      window.auth.state = currentAuthState;

      client.auth.onAuthStateChange(async (event, newSession) => {
        if (!newSession?.user) {
          window.auth.session = null;
          window.auth.state = null;
          currentAuthState = null;
          return;
        }
        window.auth.session = newSession;
        let role = currentAuthState?.role;
        if (!role || currentAuthState?.user?.id !== newSession.user.id) {
          role = await resolveRole(client, newSession.user.id, newSession.access_token);
        }
        currentAuthState = { session: newSession, user: newSession.user, role };
        window.auth.state = currentAuthState;
      });

      return currentAuthState;
    } catch (err) {
      console.warn('Auth initialization warning:', err);
      window.auth.session = null;
      window.auth.state = null;
      currentAuthState = null;
      return null;
    }
  })();
})();
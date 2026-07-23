/* ============================================================================
   NAMMA BAZAR — ROUTE GUARD

   Include AFTER supabase-client.js on any page that should not be reachable
   without the right account:

     <script src="supabase-client.js"></script>
     <script src="auth-guard.js" data-require="seller"></script>

   data-require accepts: customer | seller | delivery_partner | admin
   Omit it to require only that someone is signed in.

   ---------------------------------------------------------------------------
   THIS IS NOT THE SECURITY BOUNDARY.

   Real enforcement is Row Level Security in Postgres. A determined user can
   always edit or skip client-side JavaScript, so this guard exists to give
   the right redirect and a clear message — not to protect data. If RLS were
   ever wrong, removing this file would not be what exposed anything.

   Because of that it deliberately FAILS OPEN on unexpected errors: a network
   blip should not lock a seller out of their own dashboard when the database
   would have let them through anyway.
   ---------------------------------------------------------------------------

   Role resolution matches login.html. public.user_roles has SELECT policies
   only (no INSERT, by design — nobody can grant themselves a role from the
   browser), so 'seller' and 'delivery_partner' rows are never written. Role
   is derived from the tables that do get populated:

     admin            -> user_roles (role = 'admin')
     seller           -> store_staff
     delivery_partner -> delivery_partners
     customer         -> everyone else
============================================================================ */

(function () {
  'use strict';

  var script = document.currentScript;
  var required = script ? (script.getAttribute('data-require') || '') : '';

  if (typeof supabaseClient === 'undefined') {
    console.error('[Namma Bazar] auth-guard.js loaded before supabase-client.js — guard inactive.');
    return;
  }

  function loginUrl() {
    var here = window.location.pathname.split('/').pop() || 'index.html';
    return 'login.html?next=' + encodeURIComponent(here + window.location.search);
  }

  function block(message, redirectTo) {
    document.documentElement.style.opacity = '0';
    try { sessionStorage.setItem('nb-auth-msg', message); } catch (e) {}
    window.location.replace(redirectTo);
  }

  async function resolveRole(userId) {
    try {
      var a = await supabaseClient.from('user_roles')
        .select('role').eq('profile_id', userId).eq('role', 'admin').maybeSingle();
      if (a.data) return 'admin';
    } catch (e) { console.warn('[Namma Bazar] guard: admin check failed', e); }

    try {
      var s = await supabaseClient.from('store_staff')
        .select('store_id').eq('profile_id', userId).limit(1).maybeSingle();
      if (s.data) return 'seller';
    } catch (e) { console.warn('[Namma Bazar] guard: seller check failed', e); }

    try {
      var d = await supabaseClient.from('delivery_partners')
        .select('id').eq('profile_id', userId).maybeSingle();
      if (d.data) return 'delivery_partner';
    } catch (e) { console.warn('[Namma Bazar] guard: partner check failed', e); }

    return 'customer';
  }

  var HOME = {
    admin: 'admin-dashboard.html',
    seller: 'seller-dashboard.html',
    delivery_partner: 'delivery-dashboard.html',
    customer: 'index.html'
  };

  (async function () {
    var session;
    try {
      var res = await supabaseClient.auth.getSession();
      session = res && res.data ? res.data.session : null;
    } catch (e) {
      // Could not reach Supabase. Fail open — RLS will still refuse any data.
      console.warn('[Namma Bazar] guard: session lookup failed, allowing through', e);
      return;
    }

    if (!session) {
      block('Please sign in to continue.', loginUrl());
      return;
    }

    if (!required) return;   // signed in is all this page asked for

    var role;
    try {
      role = await resolveRole(session.user.id);
    } catch (e) {
      console.warn('[Namma Bazar] guard: role lookup failed, allowing through', e);
      return;
    }

    // Admins may view every console; nobody else crosses roles.
    if (role === required || role === 'admin') return;

    block(
      'That area is for ' + required.replace(/_/g, ' ') + ' accounts. ' +
      'You are signed in as ' + role.replace(/_/g, ' ') + '.',
      HOME[role] || 'index.html'
    );
  })();
})();

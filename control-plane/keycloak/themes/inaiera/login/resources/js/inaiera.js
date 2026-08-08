/*
 * Adds a "Forgot password?" link to the Keycloak login form.
 *
 * Keycloak's own reset flow (realm setting `resetPasswordAllowed`) emails a
 * reset link, which needs working realm SMTP. InAiEra already has a recovery
 * flow — security question challenge, then a reset that now writes the new
 * password through to Keycloak — so the link points there instead of standing
 * up a second, competing mechanism.
 *
 * Injected rather than templated: overriding login.ftl would fork a file that
 * changes between Keycloak releases, and a stale fork quietly drops new form
 * fields. A link is not worth that.
 */
(function () {
  'use strict';

  // The app origin that owns the recovery flow. Kept in one place so a
  // deployment only has to change this single line.
  var APP_ORIGIN = 'http://localhost:5173';

  /*
   * White-labelling: stamp the realm onto <html> so CSS can restyle per
   * tenant via `:root[data-realm="…"]` variable overrides — one shared theme
   * instead of a new theme directory per customer.
   *
   * Runs at parse time in <head>, before the body renders, so the tenant's
   * palette is in place for the first paint (no flash of platform colours).
   */
  function markRealm() {
    var m = window.location.pathname.match(/\/realms\/([^/]+)/);
    if (!m) return;
    // Attribute selectors are literal, so normalise once here rather than
    // relying on every stylesheet author to match Keycloak's casing.
    document.documentElement.setAttribute('data-realm', decodeURIComponent(m[1]).toLowerCase());
  }

  markRealm();

  function addForgotPasswordLink() {
    var form = document.getElementById('kc-form-login');
    if (!form) return; // not the login screen (update-password, verify-profile, …)

    // Keycloak renders its own link when resetPasswordAllowed is on; don't
    // add a second one next to it.
    if (document.querySelector('#kc-forgot-password-link, #kc-inaiera-forgot')) return;

    var link = document.createElement('a');
    link.id = 'kc-inaiera-forgot';
    link.href = APP_ORIGIN + '/forgot-password';
    link.textContent = 'Forgot password?';
    link.className = 'inaiera-forgot-link';

    var options = document.getElementById('kc-form-options');
    if (options) {
      options.appendChild(link);
    } else {
      // No options block on this screen — sit above the submit button instead.
      var buttons = document.getElementById('kc-form-buttons');
      if (buttons && buttons.parentNode) {
        buttons.parentNode.insertBefore(link, buttons);
      } else {
        form.appendChild(link);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addForgotPasswordLink);
  } else {
    addForgotPasswordLink();
  }
})();

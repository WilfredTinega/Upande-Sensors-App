/**
 * Minimal Frappe/ERPNext HTTP client for React Native.
 *
 * Auth model: password login against `/api/method/login`, then the returned
 * `sid` cookie is replayed on every subsequent call.
 *
 * Why the cookie is tracked by hand rather than left to the platform cookie
 * jar: on Android the jar lives in the WebView CookieManager, which is shared
 * process-wide and gets cleared out from under us (by a WebView, by the OS
 * reclaiming storage). Holding `sid` ourselves — and persisting it — means a
 * cold start restores the session instead of silently 403-ing.
 *
 * Note on CSRF: Frappe only enforces it once `session.data.csrf_token` exists,
 * which is generated when a *web page* asks for it (see frappe/auth.py
 * validate_csrf_token). A session created purely through /api/method/login and
 * used only for /api/method/* calls never has one, so POSTs pass. If a session
 * ever does acquire a token, POSTs start failing with CSRFTokenError — which is
 * why `call()` re-authenticates once on that specific error.
 */

/**
 * There is deliberately no default site.
 *
 * A hardcoded address means every fresh install points at one customer's
 * instance until someone changes it, and an installer who forgets is signing in
 * against the wrong farm. The app starts with no server and asks for one on
 * first launch; `''` is the honest representation of "not configured yet".
 */
export const NO_BASE_URL = '';

export class FrappeError extends Error {
  constructor(message, { status, excType, raw } = {}) {
    super(message);
    this.name = 'FrappeError';
    this.status = status;
    this.excType = excType;
    this.raw = raw;
  }

  /** The endpoint exists on this instance but the user may not use it. */
  get isPermission() {
    return this.status === 403 || this.excType === 'PermissionError';
  }

  /**
   * The session is gone — the caller should bounce to the login screen.
   *
   * Deliberately does NOT sniff the message text. Frappe emits the identical
   * "You are not permitted to access this resource. Login to access" string
   * from `is_whitelisted` both for an expired session AND for a live session
   * calling a method that simply lacks `@frappe.whitelist()`. Treating that
   * string as proof of expiry made the app replay the stored password against
   * what was really a server-side wiring mistake. When the 403 is ambiguous we
   * ask the server who we are instead — see `_sessionIsDead`.
   */
  get isAuth() {
    return (
      this.status === 401 ||
      this.excType === 'AuthenticationError' ||
      this.excType === 'SessionExpired'
    );
  }

  /**
   * A 403 that *might* mean the session died, or might mean this user simply
   * cannot call this thing. Only resolvable by asking the server.
   */
  get isAmbiguous403() {
    return this.status === 403 && !this.isMissingEndpoint;
  }

  /**
   * The method itself is missing from the deployed app — distinct from "you
   * can't call it". Pump control hits this on instances where the
   * `device_control` module hasn't been deployed yet, and the UI shows an
   * explanatory empty state rather than an error.
   */
  get isMissingEndpoint() {
    return /Failed to get method for command/i.test(this.message || '');
  }
}

/** Pull the human-readable text out of Frappe's nested `_server_messages`. */
function extractServerMessage(body) {
  if (!body || typeof body !== 'object') return null;

  const raw = body._server_messages;
  if (raw) {
    try {
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const messages = (Array.isArray(list) ? list : [list])
        .map((entry) => {
          try {
            const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry;
            return parsed?.message ?? String(entry);
          } catch {
            return String(entry);
          }
        })
        .filter(Boolean);
      if (messages.length) return stripHtml(messages.join('\n'));
    } catch {
      /* fall through to the other shapes below */
    }
  }

  if (typeof body.message === 'string') return stripHtml(body.message);

  // Some endpoints report a refusal by setting `frappe.response.http_status_code`
  // and *returning* a payload rather than throwing — `sensor_dashboard` does
  // this for site-permission failures. That arrives as a nested object with no
  // `_server_messages`, so without this branch the server's actual explanation
  // ("contact your administrator to request access") is dropped and the user is
  // shown a bare "Request failed (403)".
  if (body.message && typeof body.message === 'object') {
    const nested = body.message.error || body.message.message;
    if (typeof nested === 'string') return stripHtml(nested);
  }
  if (typeof body.error === 'string') return stripHtml(body.error);

  if (body.exc_type) return String(body.exc_type);
  return null;
}

function stripHtml(text) {
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read `sid` out of a Set-Cookie header.
 *
 * React Native collapses repeated Set-Cookie headers into one comma-joined
 * string, so this scans for the `sid=` pair anywhere in the value rather than
 * assuming it is the first cookie.
 */
function parseSid(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = /(?:^|[,;]\s*)sid=([^;,\s]+)/i.exec(setCookieHeader);
  const sid = match?.[1];
  if (!sid || sid === 'Guest') return null;
  return sid;
}

/** Frappe wants scalars flat and everything else JSON-encoded. */
function encodeParams(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return search;
}

export class FrappeClient {
  constructor({ baseUrl = NO_BASE_URL, timeout = 30000 } = {}) {
    this.baseUrl = normaliseBaseUrl(baseUrl);
    this.timeout = timeout;
    this.sid = null;
    this.credentials = null; // held in memory only, for the silent re-login path
    this.onSessionLost = null;
  }

  setBaseUrl(baseUrl) {
    const next = normaliseBaseUrl(baseUrl);
    if (next !== this.baseUrl) {
      this.baseUrl = next;
      this.sid = null;
    }
  }

  setSession(sid) {
    this.sid = sid || null;
  }

  headers(extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (this.sid) headers.Cookie = `sid=${this.sid}`;
    return headers;
  }

  async request(path, { method = 'GET', body, headers, signal } = {}) {
    // Without this, an unconfigured client would fetch a relative path and fail
    // with an opaque network error. Say what is actually wrong instead.
    if (!this.baseUrl) {
      throw new FrappeError('No server address set yet.', { status: 0 });
    }

    const controller = new AbortController();

    // Which of the two abort sources fired decides the error message, so track
    // it rather than reporting every AbortError as a timeout — a user changing
    // a filter would otherwise be told the server was slow.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);

    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort);
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', forwardAbort);
    };

    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(headers),
        body,
        signal: controller.signal,
        credentials: 'omit', // the Cookie header above is the only session carrier
      });
    } catch (err) {
      cleanup();
      if (err.name === 'AbortError') {
        if (timedOut) {
          throw new FrappeError('The server took too long to respond. Check your connection.');
        }
        // Propagate a real cancellation as an AbortError so callers can tell it
        // apart from a failure and stay silent about it.
        const aborted = new Error('Request cancelled');
        aborted.name = 'AbortError';
        throw aborted;
      }
      throw new FrappeError(`Cannot reach ${this.baseUrl}. Check the site URL and your connection.`);
    }
    cleanup();

    // A rotated sid (Frappe reissues on login and occasionally on renewal)
    // must be adopted or every following request 403s.
    const rotated = parseSid(response.headers.get('set-cookie'));
    if (rotated) this.sid = rotated;

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message =
        extractServerMessage(payload) ||
        (response.status === 404 ? 'Endpoint not found on this instance.' : `Request failed (${response.status}).`);
      throw new FrappeError(message, {
        status: response.status,
        excType: payload?.exc_type,
        raw: payload ?? text,
      });
    }

    return payload;
  }

  /**
   * Call a whitelisted method. Reads go out as GET so they stay cacheable and
   * side-effect free; writes as form-encoded POST, which is what Frappe's own
   * clients send.
   */
  async call(method, params = {}, { write = false, signal, _retried = false } = {}) {
    const encoded = encodeParams(params);
    let payload;
    try {
      payload = write
        ? await this.request(`/api/method/${method}`, {
            method: 'POST',
            body: encoded.toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal,
          })
        : await this.request(
            `/api/method/${method}${encoded.toString() ? `?${encoded.toString()}` : ''}`,
            { signal },
          );
    } catch (err) {
      if (!(err instanceof FrappeError)) throw err; // cancellations pass through

      // An unambiguous auth failure, or a CSRF token we can only clear by
      // starting a fresh session.
      let shouldRecover = err.isAuth || err.excType === 'CSRFTokenError';

      // A 403 is ambiguous: it means either "your session died" or "you may not
      // do this". Only the server can say which, so ask — rather than replaying
      // the stored password at what is really a permission boundary.
      if (!shouldRecover && err.isAmbiguous403 && !_retried) {
        shouldRecover = await this._sessionIsDead();
        if (!shouldRecover) throw err; // a genuine permission error; surface it
      }

      if (!shouldRecover) throw err;

      // One silent re-login, only when we still hold credentials. Without the
      // `_retried` guard an expired password would loop.
      if (!_retried && this.credentials) {
        try {
          await this.login(this.credentials.usr, this.credentials.pwd);
          return this.call(method, params, { write, signal, _retried: true });
        } catch {
          this.onSessionLost?.();
          throw err;
        }
      }
      this.onSessionLost?.();
      throw err;
    }

    // Whitelisted methods wrap their return value in `message`. Some (the
    // report-style ones) reply with top-level keys instead, so fall back to the
    // whole payload rather than handing the caller undefined.
    return payload && 'message' in payload ? payload.message : payload;
  }

  async login(usr, pwd) {
    this.sid = null;
    const payload = await this.request('/api/method/login', {
      method: 'POST',
      body: encodeParams({ usr, pwd }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!this.sid) {
      throw new FrappeError('Signed in, but the server did not return a session cookie.');
    }
    this.credentials = { usr, pwd };
    return {
      sid: this.sid,
      fullName: payload?.full_name || usr,
      homePage: payload?.home_page || null,
    };
  }

  async logout() {
    try {
      await this.request('/api/method/logout', { method: 'POST' });
    } catch {
      // A failed logout still ends the local session — the sid is dropped below.
    }
    this.sid = null;
    this.credentials = null;
  }

  /** Cheap liveness probe; also confirms the URL points at a Frappe site. */
  async ping() {
    const payload = await this.request('/api/method/ping');
    return payload?.message === 'pong';
  }

  async whoAmI() {
    return this.call('frappe.auth.get_logged_user');
  }

  /**
   * Ask the server whether our session is still authenticated.
   *
   * Goes through `request` rather than `call` on purpose — `call` is what
   * invokes this, and routing it back through would recurse. A network failure
   * here answers "don't know", which we treat as "not dead": re-logging in on a
   * flaky connection would boot the user for no reason.
   */
  async _sessionIsDead() {
    try {
      const payload = await this.request('/api/method/frappe.auth.get_logged_user');
      const user = payload && 'message' in payload ? payload.message : payload;
      return !user || user === 'Guest';
    } catch (err) {
      if (err instanceof FrappeError && (err.status === 401 || err.status === 403)) return true;
      return false;
    }
  }
}

export function normaliseBaseUrl(input) {
  let url = String(input || '').trim().replace(/\/+$/, '');
  // Empty stays empty — the caller is expected to send the user to the server
  // form rather than have a placeholder site substituted behind their back.
  if (!url) return NO_BASE_URL;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export const client = new FrappeClient();

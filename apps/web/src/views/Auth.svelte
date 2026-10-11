<script lang="ts">
  import '@fontsource-variable/stix-two-text';
  import ServerChoice from '../components/ServerChoice.svelte';
  import { ApiError, api, isDesktop } from '../lib/api.js';
  import { auth, enterLocalMode, login, register } from '../lib/auth.svelte.js';
  import { go, route } from '../lib/router.svelte.js';
  import { Check, Lock } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';
  import Logo from '../ui/Logo.svelte';

  type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'verify';
  let { mode }: { mode: Mode } = $props();

  let identifier = $state('');
  let username = $state('');
  let email = $state('');
  let password = $state('');
  let confirm = $state('');
  let showPw = $state(false);
  let busy = $state(false);
  let error = $state('');
  let info = $state('');
  /** Server errors that belong to one field, shown under it. */
  let fieldErr = $state<{ username?: string; email?: string; password?: string }>({});

  const token = $derived(route.query.get('token') ?? '');

  const TITLES: Record<Mode, string> = {
    login: 'Sign in',
    register: 'Create account',
    forgot: 'Reset password',
    reset: 'Choose a new password',
    verify: 'Verify email',
  };
  const LEDES: Record<Mode, string> = {
    login: 'Welcome back. Your projects and their offline copies are waiting.',
    register: 'Co-authors use your username to invite you and to see who is writing.',
    forgot: 'We will email you a link to choose a new password.',
    reset: 'Pick a password you have not used elsewhere.',
    verify: '',
  };

  // Rules checked while typing; the server stays authoritative.
  const USER_RE = /^[a-z0-9_-]{3,32}$/i;
  const userOk = $derived(USER_RE.test(username));
  const userBadChars = $derived(/[^a-z0-9_-]/i.test(username));
  const pwLong = $derived(password.length >= 12);
  const strength = $derived(password.length >= 16 ? 4 : password.length >= 12 ? 3 : password.length >= 9 ? 2 : password.length >= 6 ? 1 : 0);
  const repeatOk = $derived(confirm.length > 0 && confirm === password);
  const repeatBad = $derived(confirm.length > 0 && !password.startsWith(confirm));

  async function run(fn: () => Promise<void>) {
    error = '';
    info = '';
    fieldErr = {};
    busy = true;
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'username_unavailable') fieldErr = { username: e.message };
      else if (e instanceof ApiError && e.code === 'email_unavailable') fieldErr = { email: e.message };
      else if (e instanceof ApiError && e.code === 'weak_password') fieldErr = { password: e.message };
      else error = e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong';
    } finally {
      busy = false;
    }
  }

  // After sign-in or registration, App sends the user on (to the projects, or to the link they opened).
  const submit = (e: Event) => {
    e.preventDefault();
    return run(async () => {
      if (mode === 'login') {
        await login(identifier, password);
      } else if (mode === 'register') {
        if (password !== confirm) throw new Error('The two passwords do not match.');
        await register(username, email, password);
      } else if (mode === 'forgot') {
        const r = await api<{ message: string }>('POST', '/auth/forgot', { email });
        info = r.message;
      } else if (mode === 'reset') {
        if (password !== confirm) throw new Error('The two passwords do not match.');
        await api('POST', '/auth/reset', { token, password });
        info = 'Password updated. You can sign in now.';
        setTimeout(() => go('/login'), 1200);
      }
    });
  };

  $effect(() => {
    if (mode === 'verify' && token) {
      void run(async () => {
        await api('POST', '/auth/verify-email', { token });
        info = 'Email verified. Thank you!';
      });
    }
  });
</script>

{#snippet pwField(id: string, autocomplete: 'current-password' | 'new-password', describedBy?: string)}
  <div class="pw">
    <input
      {id}
      type={showPw ? 'text' : 'password'}
      bind:value={password}
      {autocomplete}
      required
      minlength={autocomplete === 'new-password' ? 12 : undefined}
      aria-describedby={describedBy}
      aria-invalid={fieldErr.password ? 'true' : undefined}
    />
    <button type="button" class="reveal" aria-controls={id} onclick={() => (showPw = !showPw)}>{showPw ? 'Hide' : 'Show'}</button>
  </div>
{/snippet}

{#snippet rule(ok: boolean, text: string, testid?: string)}
  <span class="rule" class:ok data-met={ok} data-testid={testid}><Icon icon={Check} size={14} />{text}</span>
{/snippet}

<div class="auth">
  <aside class="side" aria-hidden="true">
    <Logo />
    <blockquote>
      “We wrote the camera-ready version on three laptops in two time zones, and nobody emailed a .tex file.”
    </blockquote>
    <ul>
      <li><Icon icon={Check} />Unlimited projects and co-authors</li>
      <li><Icon icon={Check} />Sources stay on your devices</li>
      <li><Icon icon={Check} />Works offline, merges when you reconnect</li>
    </ul>
  </aside>

  <div class="main">
    <a class="mobile-logo" href="#/" aria-label="HiveTeX home"><Logo /></a>
    <form class="form" onsubmit={submit}>
      <h1>{TITLES[mode]}</h1>
      {#if LEDES[mode]}<p class="lede">{LEDES[mode]}</p>{/if}

      {#if isDesktop && (mode === 'login' || mode === 'register')}<ServerChoice />{/if}

      {#if error}<div class="error" role="alert">{error}</div>{/if}
      {#if info}<div class="notice" role="status">{info}</div>{/if}

      {#if mode === 'login'}
        <div class="field">
          <label for="login-id">Username or email</label>
          <input id="login-id" type="text" bind:value={identifier} autocomplete="username" required />
        </div>
        <div class="field">
          <div class="label-row"><label for="login-pw">Password</label><a href="#/forgot">Forgot password?</a></div>
          {@render pwField('login-pw', 'current-password')}
        </div>
      {:else if mode === 'register'}
        <div class="field">
          <label for="reg-user">Username</label>
          <input
            id="reg-user"
            type="text"
            bind:value={username}
            autocomplete="username"
            required
            minlength="3"
            maxlength="32"
            aria-describedby={fieldErr.username ? 'reg-user-err' : 'reg-user-hint'}
            aria-invalid={fieldErr.username ? 'true' : undefined}
          />
          {#if fieldErr.username}
            <p class="msg err" id="reg-user-err" role="alert">{fieldErr.username}. Try another username.</p>
          {:else}
            <p class="msg" id="reg-user-hint" aria-live="polite">
              {#if userBadChars}<span class="rule bad">Use only a–z, 0–9, _ and -</span>{:else}{@render rule(userOk, '3–32 characters: a–z, 0–9, _ and -', 'rule-username')}{/if}
            </p>
          {/if}
        </div>
        <div class="field">
          <label for="reg-email">Email</label>
          <input
            id="reg-email"
            type="email"
            bind:value={email}
            autocomplete="email"
            required
            aria-describedby={fieldErr.email ? 'reg-email-err' : 'reg-email-hint'}
            aria-invalid={fieldErr.email ? 'true' : undefined}
          />
          {#if fieldErr.email}<p class="msg err" id="reg-email-err" role="alert">{fieldErr.email}</p>{:else}<p class="msg" id="reg-email-hint">Used for account recovery only.</p>{/if}
        </div>
        <div class="field">
          <label for="reg-pw">Password</label>
          {@render pwField('reg-pw', 'new-password', fieldErr.password ? 'reg-pw-err' : 'reg-pw-rules')}
          <div class="meter" aria-hidden="true">{#each [1, 2, 3, 4] as i (i)}<span class:on={strength >= i}></span>{/each}</div>
          {#if fieldErr.password}
            <p class="msg err" id="reg-pw-err" role="alert">{fieldErr.password}</p>
          {:else}
            <p class="msg rules" id="reg-pw-rules" aria-live="polite">
              {@render rule(pwLong, pwLong ? 'At least 12 characters' : `At least 12 characters (${password.length} so far)`, 'rule-length')}
              <span class="rule note"><Icon icon={Lock} size={14} />Checked against leaked passwords when you submit</span>
            </p>
          {/if}
        </div>
        <div class="field">
          <label for="reg-pw2">Repeat password</label>
          <input id="reg-pw2" type={showPw ? 'text' : 'password'} bind:value={confirm} autocomplete="new-password" required aria-describedby="reg-pw2-hint" />
          <p class="msg" id="reg-pw2-hint" aria-live="polite">
            {#if repeatBad}<span class="rule bad">Does not match the password above</span>{:else if confirm}{@render rule(repeatOk, repeatOk ? 'Passwords match' : 'Keep typing…', 'rule-repeat')}{/if}
          </p>
        </div>
      {:else if mode === 'forgot'}
        <div class="field">
          <label for="forgot-email">Email</label>
          <input id="forgot-email" type="email" bind:value={email} autocomplete="email" required />
        </div>
      {:else if mode === 'reset'}
        {#if !token}<div class="error" role="alert">This reset link is incomplete. Request a new one.</div>{/if}
        <div class="field">
          <label for="reset-pw">New password</label>
          {@render pwField('reset-pw', 'new-password', 'reset-pw-rules')}
          <p class="msg" id="reset-pw-rules" aria-live="polite">{@render rule(pwLong, 'At least 12 characters')}</p>
        </div>
        <div class="field">
          <label for="reset-pw2">Repeat password</label>
          <input id="reset-pw2" type={showPw ? 'text' : 'password'} bind:value={confirm} autocomplete="new-password" required />
        </div>
      {:else if busy}
        <p class="muted">Verifying…</p>
      {/if}

      {#if mode !== 'verify'}
        <button class="primary submit" type="submit" disabled={busy}>
          {#if mode === 'login'}Sign in{:else if mode === 'register'}Create account{:else if mode === 'forgot'}Send reset link{:else}Update password{/if}
        </button>
      {/if}

      <p class="alt">
        {#if mode === 'login'}
          New to HiveTeX? <a href="#/register">Create an account</a>
        {:else if mode === 'register'}
          Already have an account? <a href="#/login">Sign in</a>
        {:else}
          <a href="#/login">Back to sign in</a>
        {/if}
      </p>
      {#if isDesktop && (mode === 'login' || mode === 'register')}
        <div class="local">
          {#if auth.local}
            <button type="button" class="link" onclick={() => go('/')} data-testid="back-to-local">Back to my local projects</button>
          {:else}
            <button type="button" class="ghost" onclick={() => { enterLocalMode(); go('/'); }} data-testid="continue-local">Continue without an account</button>
            <p class="muted small">Projects stay on this computer and nothing is sent anywhere. Sign in later to share them.</p>
          {/if}
        </div>
      {/if}
    </form>
  </div>
</div>

<style>
  .local {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 4px;
    justify-items: center;
    text-align: center;
  }
  .local .small {
    margin: 0;
    font-size: var(--text-xs);
  }
  .auth {
    min-height: 100%;
    display: grid;
    grid-template-columns: minmax(320px, 5fr) 7fr;
    background: var(--paper);
  }
  .side {
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 24px;
    padding: 40px 48px;
    background: var(--sunken);
    border-right: 1px solid var(--line);
  }
  blockquote {
    align-self: center;
    margin: 0;
    font: 400 clamp(22px, 2.4vw, 28px) / 1.3 var(--font-display);
    text-wrap: balance;
  }
  .side ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
    color: var(--muted);
  }
  .side li {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .side li :global(svg) {
    color: var(--ok);
  }
  .main {
    display: grid;
    place-items: center;
    padding: 40px 16px;
  }
  .mobile-logo {
    display: none;
    text-decoration: none;
  }
  .form {
    width: min(400px, 100%);
    display: grid;
    gap: 18px;
  }
  h1 {
    margin: 0;
    font: 600 28px/1.2 var(--font-display);
  }
  .lede {
    margin: -8px 0 0;
    color: var(--muted);
  }
  .field {
    display: grid;
    gap: 6px;
  }
  .field label {
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .label-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: var(--text-sm);
  }
  .field input {
    width: 100%;
  }
  .pw {
    position: relative;
  }
  .pw input {
    padding-right: 64px;
  }
  .reveal {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: var(--text-sm);
  }
  .msg {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  .msg.err {
    color: var(--bad);
  }
  .rule {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .rule :global(svg) {
    opacity: 0.45;
  }
  .rule.ok {
    color: var(--ok);
  }
  .rule.ok :global(svg) {
    opacity: 1;
  }
  .rule.bad {
    color: var(--bad);
  }
  .rule.note :global(svg) {
    opacity: 1;
  }
  .meter {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .meter span {
    height: 4px;
    border-radius: 2px;
    background: var(--line);
  }
  .meter span.on {
    background: var(--ok);
  }
  .submit {
    width: 100%;
    min-height: 44px;
    font-size: var(--text-lg);
    border-radius: var(--r-l);
  }
  .alt {
    margin: 0;
    text-align: center;
    color: var(--muted);
    font-size: var(--text-sm);
  }
  .error,
  .notice {
    padding: 8px 10px;
    margin: 0;
  }
  @media (max-width: 860px) {
    .auth {
      grid-template-columns: minmax(0, 1fr);
    }
    .side {
      display: none;
    }
    .main {
      place-items: start center;
      gap: 24px;
      align-content: start;
    }
    .mobile-logo {
      display: block;
    }
  }
</style>

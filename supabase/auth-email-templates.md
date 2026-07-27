# Maintain Flow Supabase Auth Email Templates

Supabase hosted confirmation and recovery emails are configured in the Supabase dashboard, not from this repository. Apply these before launching email/password signup.

## Dashboard Checklist

1. Open Supabase -> Authentication -> URL Configuration.
2. Set Site URL to `https://www.maintainflow.io`.
3. In Authentication -> Providers -> Email, enable email signup and require email confirmation. A signup must not receive an immediate application session.
4. Add redirect URLs:
   - `https://www.maintainflow.io/auth/callback`
   - `https://www.maintainflow.io/auth/confirm`
   - `https://www.maintainflow.io/reset-password`
   - `https://maintainflow-v2.vercel.app/auth/callback`
   - `https://maintainflow-v2.vercel.app/auth/confirm`
   - `https://maintainflow-v2.vercel.app/reset-password`
5. Open Authentication -> Email Templates.
6. Replace the Confirm signup and Reset password templates with the copy below.
7. Open Authentication -> SMTP Settings and configure the production sender. Do not launch email/password without a branded sender.
8. Disable click tracking and link rewriting for these two transactional templates. A token hash is still a one-time bearer secret.

Email confirmation and password recovery use Supabase's one-time `{{ .TokenHash }}` so the email may be opened in another current browser or device. The custom links below append the token hash and exact action type to the fragment of the app-supplied, allowlisted `{{ .RedirectTo }}`. Maintain Flow captures and removes that fragment before rendering, sends it only to a same-origin server action, never returns or stores the temporary provider session in the browser, and globally revokes it. Confirmation waits for a deliberate click so an email scanner cannot consume the token merely by fetching the page. Do not use `{{ .ConfirmationURL }}` for these two templates, place access/refresh tokens in an application URL, enable click tracking, add a root hash callback, or allow a wildcard redirect. Google OAuth remains browser-bound PKCE; typed invitations retain their separate restricted flow.

## Confirm Signup

Subject:

```txt
Confirm your Maintain Flow account
```

Body:

```html
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#172033">
  <p style="font-size:14px;font-weight:700;color:#2563eb;margin:0 0 24px">MAINTAIN FLOW</p>
  <h2 style="font-size:24px;line-height:1.25;margin:0 0 12px">Confirm your Maintain Flow account</h2>
  <p style="font-size:16px;line-height:1.6;margin:0 0 24px">Confirm your email to start proving that your critical customer journeys still work. You can open this link in any current browser or device.</p>
  <p style="margin:0 0 24px"><a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=email" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px">Confirm your account</a></p>
  <p style="font-size:13px;line-height:1.5;color:#64748b;margin:0">If you did not create this account, you can safely ignore this email.</p>
</div>
```

## Reset Password

Subject:

```txt
Reset your Maintain Flow password
```

Body:

```html
<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#172033">
  <p style="font-size:14px;font-weight:700;color:#2563eb;margin:0 0 24px">MAINTAIN FLOW</p>
  <h2 style="font-size:24px;line-height:1.25;margin:0 0 12px">Reset your Maintain Flow password</h2>
  <p style="font-size:16px;line-height:1.6;margin:0 0 24px">Use the secure link below in any current browser or device to choose a new password for your account.</p>
  <p style="margin:0 0 24px"><a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=recovery" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px">Reset your password</a></p>
  <p style="font-size:13px;line-height:1.5;color:#64748b;margin:0">If you did not request this reset, you can safely ignore this email.</p>
</div>
```

## Required App Env

```txt
NEXT_PUBLIC_SITE_URL=https://www.maintainflow.io
NEXT_PUBLIC_APP_URL=https://www.maintainflow.io
NEXT_PUBLIC_SUPABASE_URL=https://pikuzwxnauunvydlwhgt.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

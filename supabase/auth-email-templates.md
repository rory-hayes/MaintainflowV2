# Maintain Flow Supabase Auth Email Templates

Supabase hosted confirmation and recovery emails are configured in the Supabase dashboard, not from this repository. Apply these before launching email/password signup.

## Dashboard Checklist

1. Open Supabase -> Authentication -> URL Configuration.
2. Set Site URL to `https://www.maintainflow.io`.
3. Add redirect URLs:
   - `https://www.maintainflow.io/auth/callback`
   - `https://www.maintainflow.io/reset-password`
   - `https://maintainflow-v2.vercel.app/**`
4. Open Authentication -> Email Templates.
5. Replace the Confirm signup and Reset password templates with the copy below.
6. Open Authentication -> SMTP Settings and configure the production sender. Do not launch email/password without a branded sender.

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
  <p style="font-size:16px;line-height:1.6;margin:0 0 24px">Confirm your email to start proving that your critical customer journeys still work.</p>
  <p style="margin:0 0 24px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px">Confirm your account</a></p>
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
  <p style="font-size:16px;line-height:1.6;margin:0 0 24px">Use the secure link below to choose a new password for your account.</p>
  <p style="margin:0 0 24px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px">Reset your password</a></p>
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

# Stripe Billing

Business Evals pricing source of truth: [`docs/business-evals/PRICING_AND_ENTITLEMENTS.md`](docs/business-evals/PRICING_AND_ENTITLEMENTS.md)

Effective: 19 July 2026

## Product subscription policy

Every new workspace starts on Free without a card. Each workspace can activate one card-free 14-day Team trial. A signed-in workspace owner can upgrade to Solo, Team, or Agency through Stripe-hosted Checkout; no application, call, manually issued access, or founder action is part of the normal purchase path.

Never request or accept card or bank details by email, chat, support tickets, or Maintain Flow fields. Stripe is authoritative for payment method, subscription, invoice, tax, cancellation, and settlement state. The card-free Team trial is recorded by Maintain Flow and is not a Stripe subscription trial.

Existing Starter, Growth, Scale, and Agency+ subscriptions remain grandfathered on the price and entitlement contract they bought until the customer explicitly accepts a Business Evals migration. Do not silently move an existing subscription to a new Stripe Price.

## Public plans

| Plan | Monthly | Annual billing | Projects | Active journeys | Included runs | Evidence | Seats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Free | €0 | Not applicable | 1 | 1 | 35/month | 7 days | 1 |
| Solo | €49/month | €529.20/year | 3 | 5 | 750/month | 30 days | 2 |
| Team | €149/month | €1,609.20/year | 15 | 30 | 7,500/month | 90 days | 5 |
| Agency | €399/month | €4,309.20/year | 50 | 100 | 30,000/month | 365 days | 15 |

Annual prices are exactly 10% below twelve monthly payments. Paid plans receive email evidence, alerts, outbound webhooks, expiring live reports, and PDFs. Agency also receives white-labelled reports. Free supports one browser-only Lead form journey and must never be described as end-to-end.

## Customer flow

1. The customer signs up and creates a Free workspace.
2. The workspace can activate its one card-free 14-day Team trial without entering payment details.
3. The owner selects Solo, Team, or Agency and monthly or annual billing in Settings.
4. `POST /api/billing/checkout` authenticates the user, loads the tenant workspace server-side, validates the exact plan and interval, and atomically reserves the workspace's single active checkout generation before calling Stripe.
5. Checkout does not create or restart a trial. Stripe receives a database-derived idempotency key and a 35-minute expiry, so retries and server restarts replay the same Session. A separate five-minute recovery grace prevents a replacement while Stripe could still accept the old Session.
6. On success, Stripe returns its `{CHECKOUT_SESSION_ID}`. The authenticated return route loads the private workspace reservation, retrieves current Stripe Session and subscription state, verifies the workspace, user, plan, interval, contract, expiry, customer and reservation metadata, and only then applies an eligible entitlement. A redirect without that proof never makes a plan green.
7. Signature-verified webhooks independently sync the Stripe customer, subscription, plan, status, and billing contract to the correct workspace and finalize the same reservation idempotently.
8. The paid entitlement applies only while Stripe reports `trialing` or `active`, or when a separately recorded complimentary entitlement has an explicit reason. A new Business Evals checkout normally becomes `active`, because its trial is handled outside Stripe.
9. A subscriber opens Stripe Customer Portal from Settings to update payment details, change plan, view invoices, or cancel. No call is required.

## Application behavior

- `/api/billing/checkout` accepts authenticated `POST` requests for Solo, Team, or Agency with `monthly` or `annual` billing.
- Checkout requires a browser `Idempotency-Key`, stores only its SHA-256 hash, and uses a private RLS-protected `stripe_checkout_sessions` ledger. An agency-row lock plus a partial unique index permits only one `creating` or `open` reservation per workspace, regardless of plan, interval, tab, user, or application instance.
- Same-selection retries replay only the stored reservation fields. A competing selection must first prove and expire the old Stripe Session; after any concurrent replacement, the route re-validates the winning plan and interval and returns `409` rather than ever opening the wrong plan.
- `/api/billing/checkout/reconcile` is authenticated, workspace-scoped and server-to-server with Stripe. It never trusts plan, customer, subscription or entitlement data from the browser query string.
- `/api/billing/status` reports whether the server secret, webhook signing secret, all six distinct public monthly/annual Prices, and enabled Customer Portal configuration are present. `checkoutConfigured` remains false unless that complete production billing set is present. It does not expose secret values or prove the configured Stripe objects are correct or live.
- `/api/billing/portal` accepts an authenticated `POST`, reloads the workspace server-side, and opens Stripe Customer Portal only for its synced Stripe customer.
- `/api/billing/webhook` and the compatibility `/api/stripe/webhook` route verify the Stripe signature and reconcile Checkout, subscription, cancellation, and payment-failure events.
- Settings and limit dialogs open checkout directly. They must not route a customer to an application, sales call, or manual invoice.
- At quota, new runs are blocked instead of creating surprise overages.
- If Stripe reports `past_due`, `unpaid`, `incomplete`, `paused`, `canceled`, or `incomplete_expired`, paid capacity stops and Free limits apply until Stripe again confirms an eligible state.
- Browser users cannot update plan, Stripe linkage, subscription status, trial, or complimentary-entitlement fields directly.

## Environment variables

Keep Stripe secrets server-only. New Business Evals checkout uses only the Solo, Team, and Agency variables:

```txt
STRIPE_SECRET_KEY=<matching test or live secret/restricted key>
STRIPE_WEBHOOK_SECRET=<matching endpoint signing secret>
STRIPE_PRICE_SOLO=<monthly recurring price ID>
STRIPE_PRICE_TEAM=<monthly recurring price ID>
STRIPE_PRICE_AGENCY=<monthly recurring price ID>
STRIPE_PRICE_SOLO_ANNUAL=<annual recurring price ID>
STRIPE_PRICE_TEAM_ANNUAL=<annual recurring price ID>
STRIPE_PRICE_AGENCY_ANNUAL=<annual recurring price ID>
STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID=<bpc_... portal configuration ID>
STRIPE_CUSTOMER_PORTAL_ENABLED=true
```

If grandfathered subscriptions exist, retain their exact old Price IDs only in the explicit legacy variables:

```txt
STRIPE_LEGACY_PRICE_STARTER=
STRIPE_LEGACY_PRICE_GROWTH=
STRIPE_LEGACY_PRICE_SCALE=
STRIPE_LEGACY_PRICE_STARTER_ANNUAL=
STRIPE_LEGACY_PRICE_GROWTH_ANNUAL=
STRIPE_LEGACY_PRICE_SCALE_ANNUAL=
```

The older `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, and `STRIPE_PRICE_SCALE` names remain read-only compatibility fallbacks. Never put a new Business Evals Price in those variables.

Checkout fails closed when its exact recurring Price ID is absent. All six current monthly and annual Price IDs, the matching webhook signing secret, and the enabled Customer Portal configuration are required before billing status can report checkout as configured, because both intervals and self-serve subscription management are public. Price IDs must be distinct. The release gate requires test-mode Stripe credentials for the selected-workspace canary and live-mode credentials for the global launch, but a syntactically valid ID does not prove the configured amount; verify every amount and interval in Stripe itself.

## Customer Portal configuration

Enable subscription updates in the Stripe Customer Portal configuration used by Maintain Flow. Add every Solo, Team, and Agency monthly and annual Price to the portal product catalog. The Settings **Change plan in Stripe** action creates a `subscription_update` portal deep link for the workspace's server-side customer and subscription IDs and sends the exact `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID`; Stripe cannot render that selector if an intended destination Price is missing.

Keep payment-detail updates, invoice history, and cancellation enabled. Test and live modes need separate portal configurations and Price IDs. Never reuse a test configuration ID in live mode.

## Webhook configuration

Point the Stripe endpoint at:

```txt
https://www.maintainflow.io/api/billing/webhook
```

Subscribe to at least:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Webhook delivery can be retried and reordered. Current Stripe status, reached through a signed webhook or authenticated server reconciliation of the exact returned Session, determines paid entitlement; a browser redirect by itself never does.

## Environment separation and release boundary

Do not mix test and live keys, Price IDs, webhook secrets, customers, subscriptions, invoices, or portal links. Verify signup, same-plan retry reuse, concurrent cross-plan single-winner behavior, exact Session return reconciliation, webhook reconciliation, portal, cancellation, failed-payment, quota, and Free-fallback paths in Stripe test mode during the canary. Before global launch, replace every Stripe input with its verified live-mode counterpart and repeat a bounded live smoke test.

Deploying code or applying migrations does not authorize creating live Stripe products, changing live prices, enabling live checkout, issuing refunds, canceling subscriptions, or modifying customer records. Those production changes require an explicit operator action in the intended Stripe account. Do not call billing ready until signed test/live events prove the configured prices, webhook, Customer Portal, and tenant-scoped entitlement reconciliation.

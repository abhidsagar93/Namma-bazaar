# Namma Bazar — Architecture Addendum & Implementation Roadmap
**Incorporates your Phase 3 decisions · Final consistency pass · No code included**

---

## Part 1 — Your Decisions, Incorporated

| Decision | Schema/design impact |
|---|---|
| **Product variants from the beginning** | `products` becomes a parent entity; a new variant layer is added below it. Full detail in Part 2.1 — this is the largest structural change in this addendum. |
| **Gateway-independent payments, PayU first** | New `payment_transactions` and `refunds` tables, fully provider-agnostic. `orders.payment_status` stays a simple derived summary; every provider-specific detail lives in `payment_transactions`. Detail in Part 2.2. |
| **SMS/OTP ready, email first** | No schema change needed beyond one new table for OTP auditing/rate-limiting (`otp_verifications`), which is channel-agnostic by design so it serves email now and SMS later without modification. Detail in Part 2.3. |
| **Frontend stays exactly as-is** | Confirmed — Part A.3 of the original review (the "extract shared partials or migrate frameworks" question) is **shelved indefinitely**. Every phase below connects to the existing 6 pages as they are; no page is redesigned or rewritten. |
| **Hyperlocal delivery: radius + partner assignment + live status** | Mostly already covered by the original design (`delivery_partners`, `delivery_tracking`, `order_status_history`). One real gap found and closed: delivery **assignment** had no history table, and delivery **radius** was modeled as platform-only when your own Phase 2 spec (Store Settings, Module 9) already promises sellers a "Delivery Radius" setting. Both fixed in Part 2.4 and Part 2.5. |

---

## Part 2 — Consistency Review: What I Found, and the Fix

This is the "review one final time" pass you asked for. I checked every new decision against the 35-table design from the last review for contradictions, gaps, and places where a principle I'd already set (ledger-not-counter, deny-by-default RLS, `store_id` tenant boundary) wasn't yet applied somewhere it should be.

### 2.1 Product variants — reconciling with the frontend that already exists

**The gap:** `seller-add-product.html` is already built, and it has *one* SKU field, *one* barcode field, *one* MRP/price pair, *one* weight/dimensions set — it has no concept of "this product comes in 3 sizes." If I made every one of those fields mandatory at the variant level with no product-level fallback, the existing Add Product page would have nothing to submit.

**The fix — every product always has at least one variant, never zero:**
- `products` keeps only what's genuinely shared across variations: `store_id`, `category_id`, `brand_id`, `name`, `slug`, `description`, `short_description`, `same_day_delivery`, `cod_available`, `status`, `featured`, `tags`, `search_vector`, `avg_rating`, `review_count`.
- Everything sellable — SKU, barcode, MRP, selling price, cost price, tax, HSN, weight, dimensions, min/max order qty — moves down to a new `product_variants` table.
- **When the existing Add Product form submits, it creates exactly one product + exactly one variant** (flagged `is_default = true`), using precisely the fields already on that page. Nothing about the current page's behavior changes.
- A variant-picker UI (choose "Size," add values "S/M/L," get 3 auto-generated variant rows to fill in) is a **future, additive** piece of UI — new fields on an existing page, not a redesign of it. I'm flagging this now so it's an expected, budgeted future task rather than a surprise.

**New tables:**
- `product_options` — id, product_id (FK), name (e.g. "Size"), sort_order.
- `product_option_values` — id, option_id (FK), value (e.g. "Large"), sort_order.
- `product_variants` — id, product_id (FK), sku, barcode, mrp, selling_price, cost_price, tax_percent, hsn_code, weight_kg, length/width/height_cm, min_order_qty, max_order_qty, status, is_default (boolean), created_at.
- `product_variant_option_values` (join table) — variant_id (FK), option_value_id (FK), composite PK.

**Ripple effect — every table that pointed at `products.id` for a sellable unit now points at `product_variants.id` instead:**
- `inventory.product_id` → `inventory.variant_id` (unique FK), `store_id` stays denormalized on the row as before.
- `stock_movements.product_id` → `stock_movements.variant_id`.
- `cart_items.product_id` → `cart_items.variant_id` **+** a denormalized `product_id` kept alongside for convenient "all items across this product's variants" queries — same denormalize-for-read-speed principle already used for `inventory.store_id`.
- `order_items.product_id` → `order_items.variant_id` **+** denormalized `product_id`, and the existing `product_name_snapshot` gets a sibling `variant_label_snapshot` (e.g. `"Size: Large"`), frozen at purchase time exactly like the name already is.
- `product_images` gains an optional nullable `variant_id` — most products keep a shared image gallery at the product level (unchanged from before); a variant only gets its own images if a seller explicitly wants different photos per color/size later. Falls back to product-level images by default.
- `reviews.product_id` **stays at the product level, unchanged** — a review is about the product as a whole, not a specific variant, which matches how reviews already work everywhere in the shipped UI (product cards show one rating, not per-variant ratings).

### 2.2 Payments — confirming the ledger principle extends cleanly

**Check performed:** does a gateway-independent design contradict anything already decided? No — it's actually a direct extension of a principle Part B.1 already established ("money and inventory are ledgers, not just numbers"). I designed `payment_transactions` as an append-only log for exactly this reason, so no rework was needed to the original principles, only new tables.

**New tables:**
- `payment_transactions` — id, order_id (FK), provider (enum: `payu`, `cod`, extensible — future values like `razorpay` require no schema change, just a new enum member), provider_transaction_id, amount, currency, status (`initiated`/`authorized`/`captured`/`failed`/`refunded`), raw_response (jsonb — full gateway payload kept for audit/dispute resolution, never parsed-and-discarded), created_at, updated_at.
- `refunds` — id, order_id (FK), payment_transaction_id (FK), amount, reason, status (`pending`/`processed`/`failed`), initiated_by (FK → profiles), created_at.
- `orders.payment_status` remains a simple derived summary (`pending`/`paid`/`failed`/`refunded`), kept in sync by a trigger on `payment_transactions` insert/update — **no PayU-specific column ever touches the `orders` table itself.** This is what "gateway-independent" means concretely: swapping PayU for another provider later touches only `payment_transactions.provider` values and the Edge Function that talks to the gateway, never the `orders` schema or any RLS policy built against it.
- COD already fits this model cleanly: a COD order gets a `payment_transactions` row with `provider = 'cod'` and `status = 'captured'` at delivery time (or `pending` until then) — no separate code path needed at the schema level.

### 2.3 SMS/OTP-ready, email-first — one small addition for a UI feature that already exists

**Check performed:** `seller-login.html` already has a complete, working OTP screen (6-digit boxes, resend countdown, verify button) built against a demo/mock flow. If I don't give it a real backing table, "email first, SMS later" has nowhere to record an attempt, and there's no way to rate-limit or audit OTP abuse (a concern I already flagged generally in Part M of the original review, but hadn't attached to a concrete table).

**New table:**
- `otp_verifications` — id, profile_id (nullable — a signup OTP happens before a profile fully exists), identifier (the email or phone the code was sent to), channel (enum: `email`, `sms` — same table serves both, so flipping the priority later is a config change, not a schema change), purpose (enum: `signup`, `login`, `password_reset`), code_hash (never store the raw code), expires_at, verified_at, attempt_count, created_at.
- This directly backs the existing Forgot Password → Send OTP → Verify screen without changing anything about how that screen behaves today.

### 2.4 Delivery radius — a real inconsistency, now resolved

**The gap, found during this review:** the original architecture (Part L) put delivery radius entirely at the platform/`service_zones` level — "operations can redraw zones... without touching store data." But your own Phase 2 seller-facing spec (Store Settings, Module 9) explicitly lists **"Delivery Radius"** as something a seller configures for their own store. Those two designs contradict each other: one says radius is platform-only, the other promises the seller a control for it.

**The fix — both are right, at different layers:**
- `stores` gains `delivery_radius_km` (numeric, seller-editable, what the future Settings page will read/write) — this is the seller's *stated preference*.
- `platform_settings` (already in the schema) carries a `max_delivery_radius_km` per city or globally — an operations ceiling.
- The actual "can we deliver to this address" check at checkout time combines both: **effective radius = min(store's chosen radius, platform's allowed maximum)**. `service_zones` remains useful as a coarser, faster pre-filter for city-wide serviceability (e.g., "is this pincode in a launched city at all") before the precise radius check runs.
- Net effect: the Settings page you'll build later gets a real, honest field to write to; operations keeps a safety ceiling so no seller can promise delivery across an entire city and fail to fulfill it.

### 2.5 Delivery assignment — closing a gap against the platform's own ledger principle

**The gap:** the original schema recorded only `orders.delivery_partner_id` — the *final* assigned partner, with no memory of the assignment process itself. Every other significant state change in this system (`order_status_history`, `stock_movements`, `wallet_transactions`) is an append-only history table; delivery assignment was the one place that principle wasn't applied, which matters operationally — you can't see "this partner declined 4 orders today" or auto-reassign after a timeout without it.

**New table:**
- `delivery_assignments` — id, order_id (FK), delivery_partner_id (FK), status (`offered`/`accepted`/`rejected`/`timed_out`/`completed`/`cancelled`), offered_at, responded_at, completed_at.
- `orders.delivery_partner_id` stays as a fast, denormalized pointer to whichever assignment is currently `accepted` — cheap to read for the dashboard and tracking screens — while `delivery_assignments` holds the full offer/response trail underneath it. Same denormalize-for-reads-plus-full-history-underneath pattern used everywhere else in this schema.

### 2.6 Everything else — checked, no changes needed

I re-checked the remaining domains (Reviews, Marketing, Financial, Notifications, Admin) against all five decisions above and found no further contradictions:
- Reviews' `order_item_id → product_id` link still resolves correctly once `order_items` carries both `variant_id` and the denormalized `product_id`.
- Coupons' `min_order_amount` logic is unaffected by variants (it already operates on `orders.total_amount`, computed after variant pricing, not on product-level prices).
- The RLS matrix (Part G of the original doc) needs exactly two additions — sellers get read/write on `payment_transactions`/`refunds` scoped to their own `orders.store_id`, and delivery partners get read on their own `delivery_assignments` — no existing policy needs to change.

---

## Part 3 — Updated ER Diagram

`namma-bazar-er-diagram.mermaid` has been updated in place to include the variant layer, payments, and delivery assignments, so it now matches this addendum exactly. Re-open it to see the current version.

---

## Part 4 — Implementation Roadmap

Structured in your requested order, broken into phases small enough to review individually. **Each phase ends with something concretely checkable** — not just "tables exist," but "here's what you can now do that you couldn't before." No code is written until you approve a phase; each phase is a separate approval gate.

Legend: 🗄️ = database work · 🔐 = auth/security work · 🔌 = connects to an existing frontend page

---

### Phase 1 — Database Foundation 🗄️
**Scope:** Enable required Postgres extensions (PostGIS for geography, `pg_trgm` for fuzzy search, `pgcrypto` for encrypted columns). Create the cross-cutting tables every later phase depends on: `profiles`, `user_roles`, `cities`, `service_zones`, `platform_settings`.
**Depends on:** nothing — this is the starting point.
**You'll be able to verify:** the database has a real city/zone list (seeded with your launch city) and a working profiles table, inspectable directly in the Supabase table editor.
**Not included yet:** no auth is wired up, no frontend page is connected.

### Phase 2 — Authentication 🔐
**Scope:** Configure Supabase Auth for email/password as the primary method (per your priority), with a profile-auto-creation trigger on signup. Configure (but leave dormant) the phone/SMS OTP provider so flipping it on later is a config change, not new engineering. Build the JWT custom-claims hook that embeds `role` and owned `store_id`s into each session token — this is what makes every later RLS policy fast and simple. Create `otp_verifications` for audit/rate-limiting.
**Depends on:** Phase 1 (`profiles`).
**You'll be able to verify:** you can sign up and log in with a real email/password against the real Supabase project (via a simple test, independent of the app pages) and see a real `profiles` row appear.
**Not included yet:** `seller-login.html` isn't wired to this yet — that happens in Phase 4, once `stores`/`store_staff` exist and login has somewhere meaningful to redirect to.

### Phase 3 — Storage 🗄️
**Scope:** Create every bucket from the original blueprint (`store-logos`, `store-banners`, `store-photos`, `product-images`, `kyc-documents`, `delivery-partner-documents`, `review-images`, `avatars`, `advertisement-banners`), with public/private access configured per bucket and the signed-URL pattern set up for the two private buckets.
**Depends on:** Phase 2 (storage policies reference auth roles).
**You'll be able to verify:** a file can be uploaded to a public bucket and viewed via a plain URL; a file uploaded to `kyc-documents` is confirmed *not* viewable without a signed URL.
**Not included yet:** no page uploads through this yet.

### Phase 4 — Store Module 🗄️🔌
**Scope:** Create `stores`, `store_staff`, `store_documents`, `store_bank_details` + their RLS policies. Wire `register.html`'s 6-step wizard to real inserts (creates `auth.users` + `profiles` + `stores` + `store_staff` in one flow; uploads go to Phase 3's buckets). Wire `seller-login.html` to real `signInWithPassword` / OTP-based password reset. Add the seller-side of `delivery_radius_km` on `stores` (Part 2.4).
**Depends on:** Phases 1–3.
**You'll be able to verify:** filling out the real Registration page creates a real, inspectable store row (status `pending_review`); logging in on the real Login page authenticates against it. Store approval is a manual status flip in the table editor for now — the Admin Panel that automates this comes in Phase 11.

### Phase 5 — Products & Catalog (incl. Variants) 🗄️🔌
**Scope:** Create `categories`, `brands`, `products`, `product_options`, `product_option_values`, `product_variants`, `product_variant_option_values`, `product_images`, `inventory`, `stock_movements` + RLS. Wire `seller-add-product.html` to real inserts — per Part 2.1, this creates one product + one default variant per submission, using exactly the fields already on that page.
**Depends on:** Phase 4 (`store_id` ownership).
**You'll be able to verify:** publishing a product on the real Add Product page creates real, queryable rows, including a variant row and an inventory row, and appears correctly shaped for a future storefront to render.
**Not included yet:** the multi-variant *builder* UI (Part 2.1's future addition) — day one only exercises the single-variant path, which is all the current page supports.

### Phase 6 — Orders 🗄️🔌
**Scope:** Create `carts`, `cart_items`, `orders`, `order_items`, `order_status_history` + RLS. Wire the seller dashboard's Recent Orders table and Low Stock Alert to real queries against real data (currently mock arrays).
**Depends on:** Phase 5 (variants to add to cart/orders).
**You'll be able to verify:** a manually inserted test order flows correctly through `order_status_history` and shows up correctly in the real seller dashboard's Recent Orders table, matching the UI's existing status badges.
**Not included yet:** there's no customer-facing cart/checkout page yet in the shipped frontend — this phase makes the *backend* fully capable of receiving orders; a checkout UI is new frontend work to schedule separately (consistent with "prepare navigation only" already established for customer-side stub routes).

### Phase 7 — Customers 🗄️🔌
**Scope:** Create `customer_addresses`, `wishlists` + RLS. Wire the seller dashboard's Recent Customers cards to real queries.
**Depends on:** Phase 6.
**You'll be able to verify:** the Recent Customers section of the real dashboard reflects real order history instead of the mock array.

### Phase 8 — Payments 🗄️🔌
**Scope:** Create `payment_transactions`, `refunds` + RLS (Part 2.2). Build the PayU integration as an Edge Function (hash generation, redirect handoff, webhook signature verification) sitting behind a provider-agnostic interface, so `orders.payment_status` is always updated the same way regardless of gateway. COD path uses the same tables with `provider = 'cod'`.
**Depends on:** Phase 6 (orders must exist to pay for).
**You'll be able to verify:** a test transaction through PayU's sandbox correctly creates a `payment_transactions` row and flips `orders.payment_status` to `paid`, with the full gateway response preserved for audit.

### Phase 9 — Notifications 🗄️🔌
**Scope:** Create `notifications`, `push_tokens`, `conversations`, `messages` + RLS. Add database triggers for same-transaction events (new order → notify seller, payment received → notify seller) and a scheduled job for time-based ones (advertisement expiring). Wire the seller dashboard's notification bell, right-panel activity feed, and Messages dropdown to real Supabase Realtime subscriptions.
**Depends on:** Phases 6 and 8 (things need to happen before they can be notified about).
**You'll be able to verify:** placing a test order makes a real notification appear live in the dashboard's bell icon without a page refresh.

### Phase 10 — Delivery 🗄️
**Scope:** Create `delivery_partners`, `delivery_partner_documents`, `delivery_assignments`, `delivery_tracking` + RLS (Part 2.5). Design (not yet build a UI for) the assignment offer/accept/timeout flow and the live-location ping pattern.
**Depends on:** Phase 6 (orders to assign) and Phase 3 (document uploads).
**You'll be able to verify:** a test order can be offered to a test delivery partner, accepted, and tracked through status changes and location pings, all inspectable in the table editor. A delivery partner-facing app is future frontend work — this phase makes the backend ready for it, per your "keep the architecture ready" framing.

### Phase 11 — Admin 🗄️
**Scope:** Create `admin_actions`, `commission_rules` + RLS. Build the backend operations needed for store/document approval and dispute logging (an Admin Panel UI is a separate future frontend build, out of scope here — this phase is the backend groundwork for it, matching how Phase 2's spec already said "prepare navigation only, don't build yet" for admin/delivery-partner surfaces).
**Depends on:** Phase 4 (documents to review).
**You'll be able to verify:** flipping a store from `pending_review` to `active` via an admin action is now a logged, auditable operation instead of a silent manual edit.

---

### Additional phases — not in your explicit list, needed for full parity with the shipped UI

The seller dashboard already has UI for Reviews, Advertisement Summary, and Wallet — these weren't in your named sequence, so I've placed them last by default. Let me know if you'd like any of them reordered earlier.

### Phase 12 — Reviews 🗄️
**Scope:** `reviews`, `review_replies`, `review_reports` + RLS. One review per purchased `order_item`, enforced at the schema level (Part D.8 of the original doc).
**Depends on:** Phase 6.

### Phase 13 — Marketing (Coupons & Advertisements) 🗄️🔌
**Scope:** `coupons`, `coupon_redemptions`, `advertisements`, `ad_events` + RLS. Wires the dashboard's existing Advertisement Summary widget (Active Ads/Pending Ads/Clicks/Impressions) to real data.
**Depends on:** Phase 6 (coupons apply to orders) and Phase 3 (ad banner uploads).

### Phase 14 — Wallet & Payouts 🗄️🔌
**Scope:** `wallets`, `wallet_transactions`, `payouts` + RLS. Wires the dashboard's Revenue/Today's Sales KPI cards and the sidebar's Wallet stub to real, ledger-backed numbers.
**Depends on:** Phase 8 (payments settle into the wallet).

---

## Summary

Five decisions incorporated, two genuine inconsistencies found and resolved (delivery radius ownership, delivery assignment history), one reconciliation made explicit in writing (variants vs. the existing single-SKU Add Product form) so it can't become a surprise mid-build. Fourteen phases total, each independently approvable, each ending in something you can point at and check rather than just "tables were created."

Nothing has been built yet. Tell me which phase to start with — I'd recommend Phase 1 as written, but it's your call.

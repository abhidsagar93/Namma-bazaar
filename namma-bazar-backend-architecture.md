# Namma Bazar — Backend Architecture Blueprint
**Pre-Supabase Architecture Review · Phase 3 Planning Document**

No code is included in this document, per your instruction. Everything below is a design blueprint for review and approval before implementation begins.

---

## Part A — Review of the Existing Frontend (Phase 1 & 2)

Before designing the backend, I re-inspected all six shipped pages to make sure the schema below is grounded in what the UI actually expects, not a generic template.

### A.1 Current architecture

| Aspect | Current state | Assessment |
|---|---|---|
| **Structure** | 6 self-contained static HTML files (`index`, `stores`, `register`, `seller-login`, `seller-dashboard`, `seller-add-product`), each with inline `<style>`/`<script>` | Correct choice for this stage — no build step, easy to preview, easy to hand to any developer. Not a blocker for Supabase; `supabase-js` works fine loaded via CDN in plain HTML. |
| **Navigation flow** | Real `.html` files for built pages; a client-side hash router on `index.html` (`Router` object) catches every unbuilt route (`#/seller/orders`, `#/product/:id`, etc.) and renders a generic "Coming Soon" screen. Other pages hand off via a lightweight `Nav.go(path)` helper that redirects to `index.html#path`. | Clean, intentional pattern — genuinely useful during incremental build-out. **Once real pages exist for a route, `Nav.go` calls should be swapped for direct links**, exactly as I already did for `seller-add-product.html`. This is a navigation debt to track, not a design flaw. |
| **State management** | Per-page in-memory JS objects (`DB`, `FORM_STATE`, `SESSION`, `STATE`). Nothing persists across page loads or between pages. Cart/wishlist counts reset on refresh. | Expected and fine for a mock-data phase. **This is the biggest thing that changes with Supabase**: session state moves to `supabase.auth` (which self-persists via its own storage), and cart/wishlist/filters move from page-local variables to real queries. |
| **Component structure** | Design tokens (CSS variables), buttons, cards, badges, icon sprite are copy-pasted verbatim into every file to guarantee visual consistency without a build tool. | Deliberate tradeoff for a no-build static site. Flag for Part A.3 below — this is the one place I'd recommend a structural change, but it's a frontend concern, not a backend one, and out of scope for this review unless you want it revisited. |
| **Data shapes already in use** | Every mock object (`DB.stores`, `DB.products`, `FORM_STATE`, dashboard `DB.kpis`/`DB.orders`/`DB.customers`/`DB.lowStock`, notification objects, upload slots) already has a stable field naming convention. | This is genuinely useful — I used these exact field names as the starting vocabulary for the schema below, so the eventual data-fetching code will map almost 1:1 onto what the UI already renders. |
| **Multi-store touchpoints already designed** | Store cards carry `rating`, `distanceKm`, `open`, `verified`, `sameDay`, `freeDelivery`, `minOrder`; product cards carry `sameday`, `deal`, `mrp`/`price`; the registration form already collects `geo` (lat/lng), delivery radius intent, and business/legal fields (GST, license, Aadhaar, PAN). | The frontend was already built anticipating a real multi-tenant, geo-aware backend. Good sign — the schema below is a natural continuation, not a retrofit. |

### A.2 Navigation flow map (as built)

```
Customer surface                      Seller surface
─────────────────                     ──────────────
index.html (home)                     register.html (6-step wizard)
   │                                       │
   ├─ stores.html (browse/filter)          ▼
   │     └─ #/store/:id (stub)        seller-login.html
   │                                       │ (login / forgot / OTP / reset)
   ├─ #/product/:id (stub)                 ▼
   ├─ #/cart, #/wishlist (stub)       seller-dashboard.html ──► seller-add-product.html
   ├─ #/checkout (stub)                    │
   └─ #/track-order (stub)                 └─ sidebar stubs: Products, Categories,
                                              Inventory, Orders, Customers,
                                              Advertisements, Offers, Reviews,
                                              Analytics, Wallet, Notifications,
                                              Settings, Support (all → Coming Soon)
```

This confirms two clear frontend "surfaces" already exist (customer + seller), and the architecture below adds the two that don't yet: **admin** and **delivery partner**.

### A.3 One frontend recommendation (flagged, not actioned)

The duplicated CSS/JS across 6 files is fine at 6 files. It will not be fine at 30+ files (Product Management, Orders, Customers, Inventory, Coupons, Reviews, Settings, plus Admin and Delivery apps). **Before Phase 3 code starts**, I'd recommend deciding whether to:
- (a) keep the static-multi-page pattern and extract the shared header/sidebar/design-tokens into a tiny script-injected partial (still no build tool), or
- (b) migrate to a proper framework (Next.js/Vite+React) once Supabase is wired in, since you'll want real client-side data fetching, caching, and route guards anyway.

This doesn't block database design, so I've left it as an open question in Part C rather than deciding it for you.

---

## Part B — Backend Architecture

### B.1 Design principles

1. **Multi-tenant by `store_id`** — every seller-owned row carries `store_id`; RLS enforces the boundary, not application code.
2. **UUID primary keys everywhere** — safe to expose in URLs, no enumeration risk, no coordination needed across services, works cleanly with offline-first mobile apps later (delivery partner app).
3. **One `profiles` table, many role-detail tables** — a single identity per human, with `customers`, `store_staff`, `delivery_partners`, `admins` as detail tables. A person can theoretically hold more than one role (e.g., a store owner who also shops on the platform) without duplicate accounts.
4. **Geography is first-class** — `stores.location` and `customer_addresses.location` are geographic points from day one, because same-day delivery radius logic is core to the product, not an add-on.
5. **Money and inventory are ledgers, not just numbers** — stock and wallet balances are derived from an append-only history table, not only a mutable counter, so every change is auditable and race-condition-safe.
6. **Status changes are logged, not overwritten** — order status, product status, ad status all keep a `*_status_history` trail for the timelines already designed into the UI (Order Timeline, Recent Orders "Delivery Status").
7. **Soft delete over hard delete** — `deleted_at` on customer-facing entities (products, stores, reviews) so nothing a customer already saw disappears without a trace, and disputes/audits remain possible.

### B.2 Domain map (bounded contexts)

```
1. Identity & Access     4. Inventory          7. Marketing            10. Admin & Audit
2. Geography              5. Cart & Orders       8. Delivery
3. Catalog                6. Reviews             9. Financial & Wallet  11. Notifications & Messaging
```

---

## Part C — Complete ER Diagram

A focused diagram of the core transactional entities is provided as a separate file: **`namma-bazar-er-diagram.mermaid`** (renders as a visual diagram). It covers Identity → Stores → Catalog → Inventory → Orders → Delivery → Reviews, which is the critical path for same-day delivery. Peripheral domains (coupons, ads, wallet, notifications, audit log) are fully specified as tables in Part D but omitted from the visual diagram for legibility — their relationships are documented in prose alongside each table.

---

## Part D — Database Tables

Each table lists: purpose, columns (name / type / constraints), primary key, foreign keys, and notable indexes. Types are written in Postgres terms since Supabase is Postgres, but this is schema *design*, not DDL code.

### D.1 Identity & Access

#### `profiles`
One row per human, 1:1 extension of Supabase's built-in `auth.users`.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK**, = `auth.users.id` |
| full_name | text | not null |
| phone | text | unique, nullable (OTP-verified) |
| phone_verified_at | timestamptz | nullable |
| email_verified_at | timestamptz | nullable |
| avatar_url | text | nullable (storage path) |
| primary_role | enum(`customer`,`seller`,`delivery_partner`,`admin`) | not null, default `customer` |
| status | enum(`active`,`suspended`,`deleted`) | not null, default `active` |
| created_at / updated_at | timestamptz | not null |

*Indexes:* unique on `phone`; btree on `primary_role`.
*Note:* `primary_role` drives default UI landing, but role **grants** live in `user_roles` below so one person can hold multiple roles cleanly.

#### `user_roles`
Many-to-many: a profile can hold multiple roles (e.g., store owner who also shops as a customer).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| profile_id | uuid | **FK →** `profiles.id`, not null |
| role | enum(`customer`,`seller`,`delivery_partner`,`admin`) | not null |
| granted_at | timestamptz | not null |

*Indexes:* unique composite on `(profile_id, role)`.

#### `store_staff`
Maps a profile to a store with a permission level — supports the registration flow's single owner today, and multi-staff stores later (the sidebar already anticipates "Settings → team management" style growth).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| store_id | uuid | **FK →** `stores.id`, not null |
| profile_id | uuid | **FK →** `profiles.id`, not null |
| role | enum(`owner`,`manager`,`staff`) | not null, default `owner` |
| invited_by | uuid | **FK →** `profiles.id`, nullable |
| created_at | timestamptz | not null |

*Indexes:* unique composite `(store_id, profile_id)`; btree on `profile_id` (fast "which stores does this user manage" lookup, which is exactly what RLS policies need).

---

### D.2 Geography

#### `cities`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| name | text | not null |
| state | text | not null |
| country | text | not null, default `India` |
| is_active | boolean | not null, default `true` — controls which cities the app currently serves |
| launched_at | timestamptz | nullable |

*Indexes:* unique composite `(name, state)`.

#### `service_zones`
Delivery-radius / polygon zones per city — what actually determines same-day serviceability, matches the registration form's "Use Current Location" + delivery-radius intent.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| city_id | uuid | **FK →** `cities.id`, not null |
| name | text | not null (e.g. "Indiranagar Zone") |
| boundary | geography(Polygon) | nullable — for precise zones |
| center | geography(Point) | not null — fallback radius-based zone |
| radius_km | numeric | nullable |
| is_active | boolean | not null, default `true` |

*Indexes:* GIST spatial index on `boundary` and `center` (required for "which zone am I in" queries at scale).

---

### D.3 Stores

#### `stores`
The core seller entity — maps directly to the registration wizard's `FORM_STATE`.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| owner_profile_id | uuid | **FK →** `profiles.id`, not null |
| name | text | not null |
| slug | text | unique, not null (for clean store URLs) |
| category_id | uuid | **FK →** `categories.id`, not null |
| sub_category | text | nullable |
| business_type | enum(`individual`,`partnership`,`pvt_ltd`,`llp`,`other`) | not null |
| years_in_business | text | nullable |
| gst_number | text | nullable |
| shop_license_number | text | nullable |
| description | text | nullable |
| whatsapp_number | text | nullable |
| mobile_number | text | not null |
| email | text | not null |
| city_id | uuid | **FK →** `cities.id`, not null |
| service_zone_id | uuid | **FK →** `service_zones.id`, nullable |
| state | text | not null |
| district | text | not null |
| area | text | not null |
| full_address | text | not null |
| pincode | text | not null |
| location | geography(Point) | not null (from "Use Current Location" / map picker) |
| opening_time / closing_time | time | not null |
| weekly_holiday | text | default `None` |
| same_day_delivery | boolean | not null, default `true` |
| home_delivery | boolean | not null, default `true` |
| pickup_available | boolean | not null, default `false` |
| logo_url / cover_banner_url / shop_photo_url | text | nullable (storage paths) |
| status | enum(`pending_review`,`active`,`rejected`,`suspended`) | not null, default `pending_review` |
| verified | boolean | not null, default `false` |
| verified_at | timestamptz | nullable |
| subscription_plan | enum(`free`,`growth`,`pro`) | not null, default `free` |
| avg_rating | numeric(2,1) | not null, default `0` (denormalized, recalculated by trigger) |
| review_count | integer | not null, default `0` (denormalized) |
| created_at / updated_at / deleted_at | timestamptz | `deleted_at` nullable |

*Indexes:* unique on `slug`; GIST spatial index on `location` (powers "nearby stores" — the single most important query in the whole system); composite btree `(city_id, status, category_id)` for the Stores page filters; btree on `owner_profile_id`.

#### `store_documents`
KYC documents (Aadhaar, PAN, shop license) — deliberately separate from `stores` because these are private files with different access rules than the public store profile.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| store_id | uuid | **FK →** `stores.id`, not null |
| type | enum(`aadhaar`,`pan`,`shop_license`) | not null |
| file_url | text | not null (private storage path) |
| status | enum(`pending`,`approved`,`rejected`) | not null, default `pending` |
| reviewed_by | uuid | **FK →** `profiles.id`, nullable (admin) |
| reviewed_at | timestamptz | nullable |
| uploaded_at | timestamptz | not null |

*Indexes:* composite `(store_id, type)`.

#### `store_bank_details`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| store_id | uuid | **FK →** `stores.id`, unique, not null |
| account_holder_name | text | not null |
| account_number_encrypted | text | not null (encrypted at rest — see Security) |
| ifsc_code | text | not null |
| upi_id | text | nullable |
| verified | boolean | not null, default `false` |

---

### D.4 Catalog

#### `categories`
Self-referencing tree, matches the 17 categories already hardcoded across the frontend (Grocery, Vegetables, Fruits, Pharmacy, Electronics, Mobiles, Fashion, Furniture, Beauty, Books, Sports, Pet Supplies, Home Appliances, Bakery, Jewellery, Hardware, Stationery).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| parent_id | uuid | **FK →** `categories.id`, nullable (null = top-level) |
| name | text | not null |
| slug | text | unique, not null |
| icon | text | nullable |
| image_url / banner_url | text | nullable |
| status | enum(`active`,`inactive`) | not null, default `active` |
| sort_order | integer | not null, default `0` |

*Indexes:* btree on `parent_id`; unique on `slug`.

#### `brands`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| name | text | unique, not null |
| logo_url | text | nullable |

#### `products`
Maps directly to the Add Product form fields.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| store_id | uuid | **FK →** `stores.id`, not null |
| category_id | uuid | **FK →** `categories.id`, not null |
| sub_category | text | nullable |
| brand_id | uuid | **FK →** `brands.id`, nullable |
| name | text | not null |
| slug | text | not null |
| sku | text | not null |
| barcode | text | nullable |
| description | text | nullable |
| short_description | text | nullable (140 char, matches UI counter) |
| mrp | numeric(10,2) | not null |
| selling_price | numeric(10,2) | not null, check `selling_price <= mrp` |
| cost_price | numeric(10,2) | nullable (internal only) |
| tax_percent | numeric(4,2) | not null, default `0` |
| hsn_code | text | nullable |
| weight_kg | numeric(6,3) | nullable |
| length_cm / width_cm / height_cm | numeric(6,2) | nullable |
| min_order_qty | integer | not null, default `1` |
| max_order_qty | integer | nullable |
| same_day_delivery | boolean | not null, default `true` |
| cod_available | boolean | not null, default `true` |
| status | enum(`draft`,`active`,`inactive`,`archived`) | not null, default `draft` |
| featured | boolean | not null, default `false` |
| tags | text[] | nullable (GIN indexed) |
| search_vector | tsvector | generated, for full-text search |
| avg_rating | numeric(2,1) | denormalized, default `0` |
| review_count | integer | denormalized, default `0` |
| created_at / updated_at / deleted_at | timestamptz | `deleted_at` nullable |

*Indexes:* unique composite `(store_id, sku)`; GIN on `search_vector` (full-text search); GIN on `tags`; composite btree `(store_id, status)`; composite btree `(category_id, status, same_day_delivery)` for storefront browsing at scale.

#### `product_images`
Ordered, multi-image — matches the drag-to-reorder upload UI exactly.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| product_id | uuid | **FK →** `products.id`, not null |
| image_url | text | not null |
| sort_order | integer | not null, default `0` |
| is_primary | boolean | not null, default `false` |

*Indexes:* composite `(product_id, sort_order)`.

---

### D.5 Inventory

#### `inventory`
Current-state snapshot per product (1:1 today; modeled so it *could* become 1:many per store-location later without a breaking change).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| product_id | uuid | **FK →** `products.id`, unique, not null |
| store_id | uuid | **FK →** `stores.id`, not null (denormalized for fast RLS + queries) |
| quantity_on_hand | integer | not null, default `0` |
| quantity_reserved | integer | not null, default `0` (held by unconfirmed orders) |
| quantity_available | integer | generated as `quantity_on_hand - quantity_reserved` |
| low_stock_threshold | integer | not null, default `10` |
| updated_at | timestamptz | not null |

*Indexes:* composite `(store_id, quantity_available)` — powers the Low Stock Alert widget directly.

#### `stock_movements`
Append-only ledger — every dashboard "Update Stock" action inserts here; `inventory.quantity_on_hand` is a maintained aggregate, not the source of truth.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| product_id | uuid | **FK →** `products.id`, not null |
| change_qty | integer | not null (positive or negative) |
| reason | enum(`restock`,`sale`,`return`,`adjustment`,`damaged`) | not null |
| reference_order_id | uuid | **FK →** `orders.id`, nullable |
| created_by | uuid | **FK →** `profiles.id`, not null |
| created_at | timestamptz | not null |

*Indexes:* composite `(product_id, created_at)` for stock history lookups.

---

### D.6 Cart & Orders

#### `carts` / `cart_items`
Persisted so a customer's cart survives across sessions/devices — the one piece of state the current frontend deliberately doesn't persist.

**`carts`**: `id` (PK), `customer_id` (FK → profiles, not null), `store_id` (FK → stores, not null — carts are single-store, since checkout/delivery is per-store), `created_at`, `updated_at`.
*Indexes:* unique composite `(customer_id, store_id)`.

**`cart_items`**: `id` (PK), `cart_id` (FK → carts, not null), `product_id` (FK → products, not null), `quantity` (integer, not null), `added_at`.
*Indexes:* unique composite `(cart_id, product_id)`.

#### `orders`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| order_number | text | unique, not null (human-readable, e.g. `NB10231` — matches existing UI) |
| customer_id | uuid | **FK →** `profiles.id`, not null |
| store_id | uuid | **FK →** `stores.id`, not null |
| delivery_address_id | uuid | **FK →** `customer_addresses.id`, not null |
| delivery_partner_id | uuid | **FK →** `delivery_partners.id`, nullable |
| subtotal / tax_amount / delivery_fee / discount_amount / total_amount | numeric(10,2) | not null |
| coupon_id | uuid | **FK →** `coupons.id`, nullable |
| payment_method | enum(`cod`,`online`) | not null |
| payment_status | enum(`pending`,`paid`,`failed`,`refunded`) | not null, default `pending` |
| status | enum(`new`,`confirmed`,`packed`,`ready`,`out_for_delivery`,`delivered`,`cancelled`,`returned`) | not null, default `new` |
| same_day_delivery | boolean | not null |
| placed_at | timestamptz | not null |
| delivered_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | not null |

*Indexes:* unique on `order_number`; composite `(store_id, status)` (powers the Orders tab UI exactly); composite `(customer_id, created_at desc)`; composite `(delivery_partner_id, status)`.
*Scale note:* this is the table to range-partition by `placed_at` (monthly) once volume passes ~10M rows — see Part J.

#### `order_items`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| order_id | uuid | **FK →** `orders.id`, not null |
| product_id | uuid | **FK →** `products.id`, not null |
| product_name_snapshot | text | not null (frozen at purchase time — product may change later) |
| unit_price_snapshot | numeric(10,2) | not null |
| quantity | integer | not null |
| line_total | numeric(10,2) | not null |

*Indexes:* btree on `order_id`.

#### `order_status_history`
Backs the "Order Timeline" feature explicitly called out in Module 5.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| order_id | uuid | **FK →** `orders.id`, not null |
| status | text | not null |
| changed_by | uuid | **FK →** `profiles.id`, nullable |
| note | text | nullable |
| created_at | timestamptz | not null |

*Indexes:* composite `(order_id, created_at)`.

---

### D.7 Delivery

#### `delivery_partners`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| profile_id | uuid | **FK →** `profiles.id`, unique, not null |
| city_id | uuid | **FK →** `cities.id`, not null |
| vehicle_type | enum(`bike`,`bicycle`,`on_foot`,`van`) | not null |
| documents_status | enum(`pending`,`approved`,`rejected`) | not null, default `pending` |
| is_online | boolean | not null, default `false` |
| current_location | geography(Point) | nullable, updated frequently |
| rating | numeric(2,1) | default `0` |
| created_at | timestamptz | not null |

*Indexes:* GIST on `current_location` (needed for nearest-partner assignment); btree on `(city_id, is_online)`.

#### `delivery_partner_documents`
Same private-document pattern as `store_documents`: `id`, `delivery_partner_id` (FK), `type` (enum: `license`, `aadhaar`, `vehicle_rc`), `file_url`, `status`, `reviewed_by`, `reviewed_at`.

#### `delivery_tracking`
Append-only location pings for live tracking during an active delivery — deliberately separate from `delivery_partners.current_location` (which is just "latest") because this table is the audit trail / live map feed.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| order_id | uuid | **FK →** `orders.id`, not null |
| delivery_partner_id | uuid | **FK →** `delivery_partners.id`, not null |
| location | geography(Point) | not null |
| recorded_at | timestamptz | not null |

*Indexes:* composite `(order_id, recorded_at)`.
*Scale note:* high write volume, short retention need (delete after order completes + N days) — a strong candidate for a scheduled cleanup job, not permanent storage.

---

### D.8 Reviews

#### `reviews`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| order_item_id | uuid | **FK →** `order_items.id`, unique, not null (one review per purchased item — prevents fake reviews) |
| customer_id | uuid | **FK →** `profiles.id`, not null |
| product_id | uuid | **FK →** `products.id`, not null |
| store_id | uuid | **FK →** `stores.id`, not null |
| rating | integer | not null, check `1–5` |
| comment | text | nullable |
| status | enum(`pending`,`approved`,`rejected`,`reported`) | not null, default `pending` |
| created_at | timestamptz | not null |

*Indexes:* composite `(product_id, status)`; composite `(store_id, status)`.

#### `review_replies`
`id`, `review_id` (FK, unique — one seller reply per review), `store_id` (FK), `reply_text`, `created_at`.

#### `review_reports`
`id`, `review_id` (FK), `reported_by` (FK → profiles), `reason`, `status` (`pending`/`resolved`), `created_at`.

---

### D.9 Marketing

#### `coupons`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| store_id | uuid | **FK →** `stores.id`, nullable (null = platform-wide coupon) |
| code | text | not null |
| discount_type | enum(`percent`,`flat`) | not null |
| discount_value | numeric(10,2) | not null |
| min_order_amount | numeric(10,2) | nullable |
| usage_limit_total | integer | nullable |
| usage_limit_per_customer | integer | nullable, default `1` |
| starts_at / expires_at | timestamptz | not null |
| status | enum(`active`,`expired`,`disabled`) | not null, default `active` |

*Indexes:* unique composite `(store_id, code)`.

#### `coupon_redemptions`
`id`, `coupon_id` (FK), `order_id` (FK), `customer_id` (FK), `redeemed_at`.
*Indexes:* composite `(coupon_id, customer_id)` — enforces per-customer usage limits.

#### `advertisements`
Matches the dashboard's Advertisement Summary (Active/Pending/Clicks/Impressions).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| store_id | uuid | **FK →** `stores.id`, not null |
| title | text | not null |
| banner_image_url | text | not null |
| target_url | text | nullable |
| placement | enum(`homepage_banner`,`category_page`,`search_results`) | not null |
| status | enum(`pending_review`,`active`,`expired`,`rejected`) | not null, default `pending_review` |
| starts_at / expires_at | timestamptz | not null |
| budget_amount | numeric(10,2) | nullable |
| created_at | timestamptz | not null |

*Indexes:* composite `(status, expires_at)` (powers "Advertisement expiring" notifications).

#### `ad_events`
Append-only click/impression log, aggregated nightly into a materialized view for the dashboard cards (never queried raw at dashboard-render time).

`id`, `ad_id` (FK), `event_type` (`impression`/`click`), `occurred_at`.
*Indexes:* composite `(ad_id, event_type, occurred_at)`.

---

### D.10 Financial

#### `wallets`
`id`, `store_id` (FK, unique), `balance` (numeric(12,2), not null, default 0 — always derived from `wallet_transactions`, never written directly), `updated_at`.

#### `wallet_transactions`
Append-only ledger, matches "Payment received" notification and the KPI "Revenue" card.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| wallet_id | uuid | **FK →** `wallets.id`, not null |
| type | enum(`order_settlement`,`payout`,`refund_deduction`,`commission_fee`,`adjustment`) | not null |
| amount | numeric(12,2) | not null (signed) |
| reference_order_id | uuid | **FK →** `orders.id`, nullable |
| created_at | timestamptz | not null |

*Indexes:* composite `(wallet_id, created_at)`.

#### `payouts`
`id`, `store_id` (FK), `amount`, `status` (`pending`/`processing`/`paid`/`failed`), `bank_reference`, `requested_at`, `paid_at`.

#### `commission_rules`
`id`, `category_id` (FK, nullable = platform default), `commission_percent`, `effective_from`.

---

### D.11 Notifications & Messaging

#### `notifications`
Directly backs the 5 notification types already designed into the dashboard UI (New Order, Product Approved, Ad Expiring, New Review, Payment Received).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | **PK** |
| recipient_profile_id | uuid | **FK →** `profiles.id`, not null |
| type | enum(`new_order`,`product_approved`,`ad_expiring`,`new_review`,`payment_received`,`order_status_change`,`low_stock`, …) | not null |
| title | text | not null |
| body | text | not null |
| data | jsonb | nullable (deep-link payload, e.g. `{order_id: ...}`) |
| read_at | timestamptz | nullable |
| created_at | timestamptz | not null |

*Indexes:* composite `(recipient_profile_id, read_at, created_at desc)` — this single index serves the topbar bell dropdown, the right-panel activity feed, and the notifications page, all with the same query shape.

#### `push_tokens`
For future mobile push (FCM/APNs): `id`, `profile_id` (FK), `token`, `platform` (`ios`/`android`/`web`), `created_at`.

#### `conversations` / `messages`
Backs the topbar "Messages" icon already in the seller dashboard.

**`conversations`**: `id`, `store_id` (FK), `customer_id` (FK), `last_message_at`.
**`messages`**: `id`, `conversation_id` (FK), `sender_profile_id` (FK), `body`, `created_at`, `read_at`.
*Indexes:* composite `(conversation_id, created_at)`.

---

### D.12 Admin & Audit

#### `admin_actions`
Every privileged action (store approval, document review, dispute resolution) is logged here — required for a platform this size to be defensible/auditable.

`id`, `admin_profile_id` (FK), `action_type` (text), `target_table` (text), `target_id` (uuid), `notes` (text, nullable), `created_at`.

#### `platform_settings`
Key-value config table for platform-wide toggles (e.g., which cities are live, default commission, feature flags) — avoids hardcoding operational values.

`id`, `key` (unique), `value` (jsonb), `updated_by` (FK), `updated_at`.

---

## Part E — Relationship Summary (cardinalities)

| Relationship | Cardinality |
|---|---|
| profile → store_staff → store | 1 profile : many stores (via staff), 1 store : many staff |
| store → products | 1 : many |
| product → product_images | 1 : many |
| product → inventory | 1 : 1 |
| product → stock_movements | 1 : many |
| category → category (self) | 1 : many (tree) |
| category → products | 1 : many |
| customer (profile) → carts → cart_items → products | 1 : many : many : 1 |
| customer → orders | 1 : many |
| store → orders | 1 : many |
| order → order_items → products | 1 : many : 1 |
| order → order_status_history | 1 : many |
| order → delivery_partner | many : 1 (nullable until assigned) |
| order_item → review | 1 : 0..1 |
| store → reviews | 1 : many |
| store → coupons, advertisements | 1 : many each |
| store → wallet → wallet_transactions | 1 : 1 : many |
| profile → notifications | 1 : many |
| store ↔ customer → conversations → messages | many : many via conversations, 1 : many to messages |

---

## Part F — Indexing Strategy (summary)

| Index type | Where | Why |
|---|---|---|
| **GIST spatial** | `stores.location`, `service_zones.boundary/center`, `delivery_partners.current_location` | "Nearby stores," "which zone," and "nearest delivery partner" are the highest-frequency, highest-value queries in a hyperlocal marketplace. Without this, every one of them is a full table scan at 100K stores. |
| **GIN full-text** | `products.search_vector`, `products.tags` | Matches the existing Search UI (products/stores/categories/brands/areas). |
| **Composite btree** | `(store_id, status)` on products/orders, `(category_id, status)` on products, `(recipient_profile_id, read_at)` on notifications | Every one of these matches a real dashboard query already implied by the UI (Recent Orders filtered by store+status, notification bell). |
| **Unique composite** | `(store_id, sku)`, `(cart_id, product_id)`, `(coupon_id, customer_id)`, `(store_id, profile_id)` on staff | Enforces business rules at the database layer, not just in the UI — the UI already validates these, but the DB must be the final authority. |
| **Partial indexes** (future tuning) | e.g. `WHERE status = 'active'` on products/stores | Once tables are large, indexing only the "live" rows (not soft-deleted/draft) keeps index size and query time down for the 99% case: browsing active stores. |

---

## Part G — Row Level Security Strategy

RLS is enforced per-table; policies are expressed here as rules, not SQL.

| Table family | Public (anon) | Customer (authenticated) | Seller (store_staff) | Delivery Partner | Admin |
|---|---|---|---|---|---|
| `stores`, `products`, `categories`, `reviews` (approved) | Read-only, `status='active'` rows only | Same as public | Full read/write, **only where** `store_id` is in their `store_staff` rows | No access | Full access |
| `store_documents`, `store_bank_details` | No access | No access | Read/write own store's rows only | No access | Read + review-status write |
| `carts`, `cart_items`, `customer_addresses`, `wishlists` | No access | Read/write **only their own** (`customer_id = auth.uid()`) | No access | No access | Read for support cases |
| `orders`, `order_items` | No access | Read **their own** orders only | Read/write **only orders where** `store_id` is theirs | Read **only orders assigned to them** (`delivery_partner_id = their id`) | Full access |
| `reviews` (write) | No access | Insert only for **their own** `order_item_id`; update/delete own | Read all for own store; write only `review_replies` | No access | Full (moderation) |
| `wallets`, `wallet_transactions`, `payouts` | No access | No access | Read-only, **own store** | No access | Full access |
| `notifications` | No access | Read/update (mark read) **only their own** | Same, scoped to their profile | Same | Full access |
| `delivery_partner_documents`, delivery earnings (future) | No access | No access | No access | Read/write **own only** | Full |
| `admin_actions`, `platform_settings` | No access | No access | No access | No access | Full access only |

**Implementation approach (described, not coded):**
- A `role` and `store_ids` claim gets embedded into each user's JWT via a Postgres auth hook at login/token-refresh time, so RLS policies can check claims directly instead of running a subquery against `store_staff` on every request — this matters a lot at 100K-store scale.
- Public storefront browsing (anon key) only ever touches a narrow set of tables/columns through **security-definer views** (e.g., a `public_stores` view exposing only non-sensitive columns), so the base tables never need an "anon can read some columns" policy, which is easy to get subtly wrong.
- Every policy is written as **deny-by-default**: RLS is enabled on every table with no default-allow policy; each allowed access pattern is an explicit, named policy.

---

## Part H — Storage Bucket Structure

| Bucket | Access | Path convention | Notes |
|---|---|---|---|
| `store-logos` | Public read | `{store_id}/logo.{ext}` | |
| `store-banners` | Public read | `{store_id}/cover.{ext}` | |
| `store-photos` | Public read | `{store_id}/shop/{uuid}.{ext}` | |
| `product-images` | Public read | `{store_id}/{product_id}/{uuid}.{ext}` | Matches the drag-drop multi-upload UI; `sort_order` lives in `product_images` table, not the filename. |
| `review-images` | Public read | `{review_id}/{uuid}.{ext}` | (future: photo reviews) |
| `avatars` | Public read | `{profile_id}.{ext}` | |
| `kyc-documents` | **Private**, signed URL only | `{store_id}/{doc_type}.{ext}` | Aadhaar/PAN/shop license — owner + admin only, matches `store_documents` table. |
| `delivery-partner-documents` | **Private**, signed URL only | `{delivery_partner_id}/{doc_type}.{ext}` | |
| `advertisement-banners` | Public read | `{ad_id}/{uuid}.{ext}` | |

**Rule of thumb applied throughout:** if the frontend already renders it as a public `<img>` (store cards, product cards, featured stores) → public bucket. If it's a compliance document that only ever needs to be *reviewed*, not *browsed* → private bucket + signed URL, matching the "Aadhaar / PAN / Shop License" upload slots that are visually distinct from the logo/banner/photo slots in the Add Product and Registration UIs.

---

## Part I — Authentication Flow

### I.1 Identity model
- Single Supabase Auth user pool for everyone (customers, sellers, delivery partners, admins) — one login system, `user_roles` determines what they can do, not which system they log into.
- **Email + password** and **mobile OTP** both map onto the same `profiles` row (a person can add a mobile number after signing up with email, or vice versa) — this matches the registration form, which already collects both email and mobile.

### I.2 Seller flow (maps to the pages already built)
1. `register.html` → creates the `auth.users` row + `profiles` row + `stores` row (status `pending_review`) + `store_staff` row (role `owner`) in one logical transaction.
2. Documents uploaded to `kyc-documents` (private) → rows created in `store_documents` (status `pending`).
3. Admin reviews in the (future) Admin Panel → `stores.status` becomes `active`, `stores.verified = true`, triggers a `product_approved`-style notification (reusing the same notification pattern) — matches the "It will be reviewed by the Namma Bazar team" copy already on the success screen.
4. `seller-login.html` → password login **or** the existing OTP flow (Forgot Password → Send OTP → Verify → New Password), which maps directly onto Supabase Auth's OTP + password-recovery primitives.
5. On success, JWT carries the `seller` role claim + the list of `store_id`s from `store_staff` → dashboard reads are scoped automatically by RLS, no manual filtering needed in the frontend.

### I.3 Customer flow
- Guest browsing is fully supported (anon key, public read policies) — matches today's frontend, which lets you browse stores/products without logging in.
- Login only required at cart→checkout boundary. On login, a guest's in-memory cart (if any) gets merged into their persisted `cart_items` row.

### I.4 Delivery partner flow
- Same registration pattern as sellers (KYC documents, admin approval) but against `delivery_partners` instead of `stores`.

### I.5 Admin flow
- Admin accounts are **not self-registered** — created directly by an existing admin or via a protected internal process, never through a public signup form.

---

## Part J — File Upload Architecture

- **Direct-to-storage uploads**: the browser uploads straight to Supabase Storage using a short-lived signed upload URL, not proxied through application code — this matches the existing drag-and-drop/FileReader-preview pattern in the Add Product and Registration pages, which already do client-side preview before "upload."
- **Naming**: UUID-based filenames (never the original filename) to avoid collisions and avoid leaking customer-supplied filenames.
- **Validation**: file type and size limits enforced both client-side (already partially done — dropzone copy says "up to 5MB") and server-side via storage bucket policies, since client-side checks are only a UX nicety, not a security boundary.
- **Image variants**: rather than generating multiple resolutions at upload time, use on-the-fly image transforms (width/quality query params) at read time, so storage stays simple (one original per image) and rendering stays fast across card/thumbnail/full-size contexts.
- **Reordering**: already modeled correctly — `product_images.sort_order` is data, not filename convention, so the existing drag-to-reorder UI needs no redesign to connect.

---

## Part K — Notification Architecture

- **Single `notifications` table**, fed two ways:
  1. **Database triggers** for same-transaction events (e.g., an `order_status_history` insert fires a trigger that inserts a matching `notifications` row for the store owner — guarantees the notification can never be "lost" independent of the event it describes).
  2. **Scheduled jobs** for time-based events with no natural trigger moment (e.g., "Advertisement expiring in 2 days" — a nightly job scans `advertisements` for `expires_at` within 48 hours and inserts notifications, avoiding duplicates via a `notified_at` flag).
- **Realtime delivery**: the dashboard's notification bell and right-panel activity feed subscribe to Supabase Realtime on `notifications` filtered by `recipient_profile_id`, so new notifications appear live without polling — a direct upgrade path from the current static mock list.
- **Push (future)**: `push_tokens` table is ready to receive FCM/APNs tokens whenever a native or PWA wrapper is built; the same `notifications` insert can fan out to push via an Edge Function trigger without changing the core table.

---

## Part L — Multi-Store & Multi-City Architecture

- **Tenant boundary = `store_id`.** Every seller-facing table either has `store_id` directly or reaches it through one hop (e.g., `order_items` → `orders.store_id`). This is what makes RLS tractable at 100,000 stores — the policy logic is always "does this row's store belong to me," never a complex join.
- **City boundary = `city_id` on `stores` and `cities.is_active`.** Launching a new city is a data operation (insert a city, insert its service zones, flip `is_active`), not a schema or code change — matches the product's stated ambition of "Multiple cities."
- **Delivery radius** is enforced at the `service_zones` level, not hardcoded per store, so operations can redraw zones (denser zones downtown, wider zones in suburbs) without touching store or product data.
- **Cross-store customer identity is preserved**: a customer has exactly one `profiles` row and one `orders` history regardless of how many different stores/cities they order from — `carts` are the only store-scoped customer entity (correctly so, since checkout/delivery is inherently single-store).

---

## Part M — Security Considerations

| Concern | Approach |
|---|---|
| **PII & compliance docs** | Aadhaar/PAN numbers and uploaded document files live in private storage + RLS-protected tables, never in a publicly readable table or bucket. Bank account numbers stored encrypted at the column level (`account_number_encrypted`), not plaintext. |
| **RLS as the real boundary** | Frontend validation (already well-built — required fields, regex checks) is a UX layer, not the security layer. Every table above is deny-by-default RLS; the frontend cannot be trusted to enforce tenant isolation on its own. |
| **JWT claims over runtime joins** | Role and store-ownership claims embedded in the JWT (refreshed on `store_staff` changes) instead of every policy running a live subquery — both a performance and an attack-surface reduction (fewer moving parts per request). |
| **Rate limiting & abuse** | OTP send/verify, coupon redemption, and review submission are the three highest-abuse-risk actions in this schema; all three need application-level or Edge Function rate limiting in addition to DB constraints (e.g., `usage_limit_per_customer` on coupons is a ceiling, not a throttle). |
| **Audit trail** | `admin_actions`, `order_status_history`, `stock_movements`, and `wallet_transactions` are all append-only by design — nothing financially or operationally significant is a plain mutable column with no history. |
| **Secrets** | Payment gateway keys, SMS/OTP provider keys, and the Supabase service role key are server-side/Edge-Function-only, never shipped to the static frontend — the current frontend's `TODO(supabase)` comments are all client-safe operations (anon-key reads/writes under RLS); anything privileged becomes an Edge Function when implemented. |

---

## Part N — Performance & Scalability Plan (100K stores / 1M products / 1M customers)

| Technique | Applied to | Why |
|---|---|---|
| **Spatial + composite indexing** | Covered in Part F | Prevents the two most common queries (nearby stores, store's active products) from degrading as data grows. |
| **Denormalized aggregates** | `stores.avg_rating/review_count`, `products.avg_rating/review_count`, `inventory.quantity_available` | Avoids computing `AVG()`/`COUNT()` over potentially millions of rows on every storefront page render; maintained by triggers on write, read as a plain column. |
| **Materialized views** | Seller dashboard KPIs (Total Products, Total Orders, Revenue, Today's Sales), Advertisement Summary (Clicks/Impressions) | These are exactly the numbers the dashboard already shows as "animated counters" — computing them live per page-load across a large `orders`/`ad_events` table doesn't scale; a view refreshed every few minutes does, and the UI already treats them as near-real-time, not live-to-the-second. |
| **Table partitioning (future trigger point)** | `orders`, `order_status_history`, `delivery_tracking`, `ad_events`, `wallet_transactions` | Range-partition by month once any of these approach ~10M rows. Not needed on day one — flagged here so it's a planned migration, not a fire drill. |
| **Keyset (cursor) pagination** | Product listings, order lists, notification feeds | Offset pagination (`LIMIT/OFFSET`) gets slower as the offset grows; the Stores page's existing "Load More" pattern already behaves like cursor pagination conceptually, so the backend contract matches the frontend's existing UX. |
| **Read-heavy caching** | Category tree, active cities/zones, platform settings | These change rarely and are read on almost every page — strong candidates for edge/CDN caching or a short-TTL in-memory cache, independent of the main database. |
| **Connection pooling** | All serverless/edge access paths | Supabase's pooler (transaction mode) is required once concurrent connections from a 100K-store platform exceed direct Postgres connection limits — an infrastructure setting, not a schema change, but worth deciding early. |
| **Storage, not database, for large binary data** | All images/documents | Already the plan (Part H) — keeps the database itself lean and fast, which matters for every query above. |

---

## Part O — Open Questions for You (before implementation begins)

1. **Frontend architecture**: keep the current static multi-page pattern (extract shared partials) or migrate to a framework once Supabase is wired in? (Part A.3) This affects how state management and routing evolve, but not the schema above.
2. **Product variants** (size/color): not in the current Add Product form, and not included in the schema above. Confirm this is genuinely out of scope for launch, or should `products` be split into `products` + `product_variants` now while it's cheap to do?
3. **Payment gateway**: Razorpay/Stripe/other? Determines the exact shape of a future `payment_transactions` table (not detailed above since no gateway was specified).
4. **SMS/OTP provider**: Supabase's built-in phone auth, or a dedicated India SMS gateway (MSG91/Twilio) wired through an Edge Function? Affects the OTP flow in Part I.2/I.3 but not the schema.
5. **Admin Panel & Delivery Partner app**: confirmed as future builds (Modules explicitly listed as "prepare navigation only, don't build yet" in earlier phases) — this blueprint's schema already supports both without changes, just confirming sequencing.

---

## Summary

This blueprint defines **12 domains, ~35 tables**, all keyed by UUID, tenant-isolated by `store_id` + RLS, geo-aware from day one via PostGIS points, with append-only ledgers for anything financial or status-related, and a clear path to partitioning and materialized views before scale becomes a problem rather than after. Every table traces back to a field, form, or UI component that already exists in the shipped Phase 1/2 frontend — nothing here is speculative beyond what the product already promises same-day delivery, multi-city, seller KYC, and a real-time dashboard.

No implementation has begun. Once you approve this architecture (or send back changes), the recommended build order is:
**Identity/Geography → Stores/Catalog → Cart/Orders → Delivery → Reviews/Marketing/Financial → Notifications/Admin** — each phase independently testable against the pages that already exist.

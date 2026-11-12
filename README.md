# FreshLink

FreshLink coordinates surplus food recovery between food donors, community recipients and redistribution hubs. It is a separate MSE Product Suite application and Supabase schema; it does not share a repository or tables with Civic Systems, Hospital Flow, or TickerLoom.

## Working workflow

- Sign in or create an account with Supabase Auth.
- Create a donor, recipient or hub organization, or join a trusted organization with its 10-character team code.
- Donor and hub members publish a food offer with quantity, category, handling/storage, pickup service area and an explicit expiry cutoff.
- Signed-in recipient/hub organizations browse time-sensitive offers. The match score is transparent and uses remaining time, textual service-area similarity and storage handling category; it is a triage heuristic, not route distance or a food-safety determination.
- A recipient organization can place one active claim on each offer. The database locks the offer during the claim so simultaneous requests cannot reserve the same offer.
- Donor members accept or decline a request. Accepted offers can be marked collected. Every transition creates an append-only handoff event.

## Data and safety boundaries

- FreshLink stores organization records, aggregate food quantities, pickup regions, offer notes, claim messages, statuses and handoff events.
- Do not enter patient, recipient-beneficiary, government-ID, payment-card, or other sensitive personal information. Avoid personal phone numbers and exact home addresses in notes.
- Anonymous database access is revoked. All exposed tables use Row Level Security; offer discovery requires an authenticated user, and private organization/claim records are scoped to members of participating organizations.
- Food-safety checks, expiry decisions, legal compliance, cold-chain assurance, route optimization, and beneficiary eligibility remain the responsibility of participating organizations. FreshLink does not certify food or guarantee a match.
- Team codes are bearer credentials: share them only with trusted colleagues. There is no email invitation, admin role management, org removal, dispute workflow, or code rotation in this release.

## Local setup

1. Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_SUPABASE_URL` plus `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. Apply `supabase/migrations/20261112150000_freshlink_exchange.sql` to the dedicated MSE Product Suite Supabase project.
3. Expose the `freshlink` schema and its five tables plus the RPC functions in Supabase Data API settings; keep automatic table exposure disabled.
4. Add the local and deployed app origins to Supabase Auth redirect URLs.
5. Run `npm install`, `npm run lint`, `npm run build`, and `npm run dev`.

No service-role key is needed by the browser app. Never place a Supabase secret/service-role key in a `NEXT_PUBLIC_` variable.

## Current limitations

- One active request can reserve an entire offer; partial-quantity claims are not supported.
- Matching is based on text fields and expiry urgency, not geospatial distance, dietary rules, or a validated spoilage model.
- There is no live notification delivery; participants see updates after refresh/reload.
- Real deployment needs an end-to-end test with two verified accounts from separate organizations before operational use.

-- Index product foreign keys for joins and parent-row updates/deletes.
create index if not exists "mse_fk_food_claims_1" on "freshlink"."food_claims" ("created_by");
create index if not exists "mse_fk_food_claims_2" on "freshlink"."food_claims" ("donor_org_id");
create index if not exists "mse_fk_food_offers_1" on "freshlink"."food_offers" ("created_by");
create index if not exists "mse_fk_handoff_events_1" on "freshlink"."handoff_events" ("actor_org_id");
create index if not exists "mse_fk_handoff_events_2" on "freshlink"."handoff_events" ("created_by");
create index if not exists "mse_fk_organization_members_1" on "freshlink"."organization_members" ("user_id");
create index if not exists "mse_fk_organizations_1" on "freshlink"."organizations" ("created_by");


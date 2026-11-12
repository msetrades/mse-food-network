create schema freshlink;
revoke all on schema freshlink from public, anon, authenticated;
grant usage on schema freshlink to authenticated;

create table freshlink.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 120),
  kind text not null check (kind in ('donor', 'recipient', 'hub')),
  region text not null check (length(btrim(region)) between 2 and 120),
  join_code text not null unique check (join_code ~ '^[A-F0-9]{10}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, kind)
);

create table freshlink.organization_members (
  organization_id uuid not null references freshlink.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table freshlink.food_offers (
  id uuid primary key default gen_random_uuid(),
  donor_org_id uuid not null references freshlink.organizations(id) on delete restrict,
  title text not null check (length(btrim(title)) between 3 and 120),
  category text not null check (category in ('Produce', 'Bakery', 'Dairy', 'Prepared meals', 'Grains & pantry', 'Other')),
  quantity numeric(12,2) not null check (quantity > 0 and quantity <= 100000),
  unit text not null check (unit in ('kg', 'crates', 'portions', 'cartons', 'bags', 'items')),
  expires_at timestamptz not null check (expires_at > created_at),
  pickup_region text not null check (length(btrim(pickup_region)) between 2 and 120),
  storage text not null check (length(btrim(storage)) between 2 and 80),
  notes text not null default '' check (length(notes) <= 400),
  status text not null default 'available' check (status in ('available', 'reserved', 'collected', 'expired', 'withdrawn')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table freshlink.food_claims (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references freshlink.food_offers(id) on delete restrict,
  donor_org_id uuid not null references freshlink.organizations(id) on delete restrict,
  recipient_org_id uuid not null references freshlink.organizations(id) on delete restrict,
  status text not null default 'requested' check (status in ('requested', 'accepted', 'declined', 'cancelled', 'collected')),
  message text not null default '' check (length(message) <= 300),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (donor_org_id <> recipient_org_id)
);

create unique index food_claims_one_open_per_offer_idx on freshlink.food_claims(offer_id)
  where status in ('requested', 'accepted');
create index food_offers_available_expiry_idx on freshlink.food_offers(expires_at, category)
  where status = 'available';
create index food_offers_donor_recent_idx on freshlink.food_offers(donor_org_id, created_at desc);
create index food_claims_recipient_recent_idx on freshlink.food_claims(recipient_org_id, created_at desc);

create table freshlink.handoff_events (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references freshlink.food_claims(id) on delete restrict,
  event_type text not null check (event_type in ('requested', 'accepted', 'declined', 'cancelled', 'collected')),
  actor_org_id uuid not null references freshlink.organizations(id) on delete restrict,
  note text not null default '' check (length(note) <= 300),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index handoff_events_claim_recent_idx on freshlink.handoff_events(claim_id, created_at desc);

create function freshlink.is_org_member(p_org_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, freshlink, auth
as $$
  select exists (
    select 1 from freshlink.organization_members m
    where m.organization_id = p_org_id and m.user_id = auth.uid()
  );
$$;

create function freshlink.create_organization(p_name text, p_kind text, p_region text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, freshlink, auth
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'Sign in before creating an organization.'; end if;
  if p_kind not in ('donor', 'recipient', 'hub') then raise exception 'Choose a supported organization role.'; end if;
  if length(btrim(coalesce(p_name, ''))) not between 2 and 120 then raise exception 'Organization name must be 2 to 120 characters.'; end if;
  if length(btrim(coalesce(p_region, ''))) not between 2 and 120 then raise exception 'Service area must be 2 to 120 characters.'; end if;

  insert into freshlink.organizations(name, kind, region, join_code, created_by)
  values (btrim(p_name), p_kind, btrim(p_region), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), v_user)
  returning id into v_id;
  insert into freshlink.organization_members(organization_id, user_id, role) values (v_id, v_user, 'owner');
  return v_id;
end;
$$;

create function freshlink.join_organization(p_join_code text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, freshlink, auth
as $$
declare
  v_user uuid := auth.uid();
  v_org_id uuid;
begin
  if v_user is null then raise exception 'Sign in before joining an organization.'; end if;
  select id into v_org_id from freshlink.organizations where join_code = upper(btrim(coalesce(p_join_code, '')));
  if v_org_id is null then raise exception 'That team code was not found.'; end if;
  insert into freshlink.organization_members(organization_id, user_id, role)
  values (v_org_id, v_user, 'member') on conflict do nothing;
  return v_org_id;
end;
$$;

create function freshlink.claim_offer(p_offer_id uuid, p_recipient_org_id uuid, p_message text default '')
returns uuid
language plpgsql security definer
set search_path = pg_catalog, freshlink, auth
as $$
declare
  v_user uuid := auth.uid();
  v_offer freshlink.food_offers%rowtype;
  v_claim_id uuid;
begin
  if v_user is null then raise exception 'Sign in before requesting an offer.'; end if;
  select * into v_offer from freshlink.food_offers where id = p_offer_id for update;
  if not found or v_offer.status <> 'available' or v_offer.expires_at <= now() then
    raise exception 'This offer is no longer available.';
  end if;
  if not exists (
    select 1 from freshlink.organization_members m
    join freshlink.organizations o on o.id = m.organization_id
    where m.organization_id = p_recipient_org_id and m.user_id = v_user and o.kind in ('recipient', 'hub')
  ) then raise exception 'You must belong to that recipient or hub organization.'; end if;
  if p_recipient_org_id = v_offer.donor_org_id then raise exception 'An organization cannot claim its own offer.'; end if;
  if length(coalesce(p_message, '')) > 300 then raise exception 'Request message must be 300 characters or fewer.'; end if;

  insert into freshlink.food_claims(offer_id, donor_org_id, recipient_org_id, message, created_by)
  values (v_offer.id, v_offer.donor_org_id, p_recipient_org_id, btrim(coalesce(p_message, '')), v_user)
  returning id into v_claim_id;
  update freshlink.food_offers set status = 'reserved' where id = v_offer.id;
  insert into freshlink.handoff_events(claim_id, event_type, actor_org_id, note, created_by)
  values (v_claim_id, 'requested', p_recipient_org_id, btrim(coalesce(p_message, '')), v_user);
  return v_claim_id;
end;
$$;

create function freshlink.transition_claim(p_claim_id uuid, p_action text, p_note text default '')
returns text
language plpgsql security definer
set search_path = pg_catalog, freshlink, auth
as $$
declare
  v_user uuid := auth.uid();
  v_claim freshlink.food_claims%rowtype;
  v_offer freshlink.food_offers%rowtype;
  v_actor_org uuid;
  v_next_status text;
begin
  if v_user is null then raise exception 'Sign in before updating a handoff.'; end if;
  if p_action not in ('accept', 'decline', 'cancel', 'collected') then raise exception 'Unsupported handoff action.'; end if;
  select * into v_claim from freshlink.food_claims where id = p_claim_id for update;
  if not found then raise exception 'Handoff request not found.'; end if;
  select * into v_offer from freshlink.food_offers where id = v_claim.offer_id for update;

  if p_action in ('accept', 'decline', 'collected') then
    if not freshlink.is_org_member(v_claim.donor_org_id) then raise exception 'Only the donating organization can perform this action.'; end if;
    v_actor_org := v_claim.donor_org_id;
  else
    if not freshlink.is_org_member(v_claim.recipient_org_id) then raise exception 'Only the requesting organization can cancel this request.'; end if;
    v_actor_org := v_claim.recipient_org_id;
  end if;

  if p_action = 'accept' and v_claim.status = 'requested' then v_next_status := 'accepted';
  elsif p_action = 'decline' and v_claim.status = 'requested' then v_next_status := 'declined';
  elsif p_action = 'cancel' and v_claim.status = 'requested' then v_next_status := 'cancelled';
  elsif p_action = 'collected' and v_claim.status = 'accepted' then v_next_status := 'collected';
  else raise exception 'This request has already moved past that step.';
  end if;

  if length(coalesce(p_note, '')) > 300 then raise exception 'Handoff note must be 300 characters or fewer.'; end if;
  update freshlink.food_claims set status = v_next_status where id = v_claim.id;
  if v_next_status in ('declined', 'cancelled') then
    update freshlink.food_offers set status = case when expires_at > now() then 'available' else 'expired' end where id = v_offer.id;
  elsif v_next_status = 'collected' then
    update freshlink.food_offers set status = 'collected' where id = v_offer.id;
  end if;
  insert into freshlink.handoff_events(claim_id, event_type, actor_org_id, note, created_by)
  values (v_claim.id, v_next_status, v_actor_org, btrim(coalesce(p_note, '')), v_user);
  return v_next_status;
end;
$$;

alter table freshlink.organizations enable row level security;
alter table freshlink.organization_members enable row level security;
alter table freshlink.food_offers enable row level security;
alter table freshlink.food_claims enable row level security;
alter table freshlink.handoff_events enable row level security;

create policy "members read their organizations" on freshlink.organizations
  for select to authenticated using (freshlink.is_org_member(id));
create policy "members read their team roster" on freshlink.organization_members
  for select to authenticated using (user_id = (select auth.uid()) or freshlink.is_org_member(organization_id));
create policy "members read exchange offers" on freshlink.food_offers
  for select to authenticated using (
    (status = 'available' and expires_at > now())
    or freshlink.is_org_member(donor_org_id)
    or exists (
      select 1 from freshlink.food_claims c
      where c.offer_id = id and freshlink.is_org_member(c.recipient_org_id)
    )
  );
create policy "donor members publish offers" on freshlink.food_offers
  for insert to authenticated with check (
    created_by = (select auth.uid()) and status = 'available'
    and exists (
      select 1 from freshlink.organizations o
      where o.id = donor_org_id and o.kind in ('donor', 'hub')
        and freshlink.is_org_member(o.id)
    )
  );
create policy "participants read claims" on freshlink.food_claims
  for select to authenticated using (
    freshlink.is_org_member(donor_org_id) or freshlink.is_org_member(recipient_org_id)
  );
create policy "participants read handoff history" on freshlink.handoff_events
  for select to authenticated using (
    exists (
      select 1 from freshlink.food_claims c
      where c.id = claim_id
        and (freshlink.is_org_member(c.donor_org_id) or freshlink.is_org_member(c.recipient_org_id))
    )
  );

revoke all on all tables in schema freshlink from public, anon;
grant select on freshlink.organizations, freshlink.organization_members, freshlink.food_offers,
  freshlink.food_claims, freshlink.handoff_events to authenticated;
grant insert on freshlink.food_offers to authenticated;
revoke all on function freshlink.is_org_member(uuid) from public, anon;
grant execute on function freshlink.is_org_member(uuid) to authenticated;
revoke all on function freshlink.create_organization(text, text, text) from public, anon;
grant execute on function freshlink.create_organization(text, text, text) to authenticated;
revoke all on function freshlink.join_organization(text) from public, anon;
grant execute on function freshlink.join_organization(text) to authenticated;
revoke all on function freshlink.claim_offer(uuid, uuid, text) from public, anon;
grant execute on function freshlink.claim_offer(uuid, uuid, text) to authenticated;
revoke all on function freshlink.transition_claim(uuid, text, text) from public, anon;
grant execute on function freshlink.transition_claim(uuid, text, text) to authenticated;

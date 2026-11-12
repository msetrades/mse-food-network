"use client";

import { FormEvent, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

type OrgKind = "donor" | "recipient" | "hub";
type Organization = { id: string; name: string; kind: OrgKind; region: string; join_code: string };
type Membership = { organization_id: string; role: string; organization: Organization };
type Offer = {
  id: string;
  donor_org_id: string;
  title: string;
  category: string;
  quantity: number;
  unit: string;
  expires_at: string;
  pickup_region: string;
  storage: string;
  notes: string;
  status: "available" | "reserved" | "collected" | "expired" | "withdrawn";
  created_at: string;
};
type Claim = {
  id: string;
  offer_id: string;
  donor_org_id: string;
  recipient_org_id: string;
  status: "requested" | "accepted" | "declined" | "cancelled" | "collected";
  message: string;
  created_at: string;
};
type HandoffEvent = { id: string; claim_id: string; event_type: string; note: string; created_at: string };

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient() : null;

const categories = ["Produce", "Bakery", "Dairy", "Prepared meals", "Grains & pantry", "Other"];
const units = ["kg", "crates", "portions", "cartons", "bags", "items"];
const dateValue = (hours: number) => {
  const date = new Date(Date.now() + hours * 60 * 60 * 1000);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function hoursLeft(value: string, now: number) {
  return Math.max(0, Math.ceil((new Date(value).getTime() - now) / 3_600_000));
}

function matchScore(offer: Offer, region: string, now: number) {
  const expiry = hoursLeft(offer.expires_at, now);
  const urgency = expiry <= 12 ? 42 : expiry <= 24 ? 33 : expiry <= 48 ? 24 : 12;
  const local = offer.pickup_region.trim().toLowerCase() === region.trim().toLowerCase();
  const proximity = local ? 38 : offer.pickup_region.trim().toLowerCase().split(/[ ,/-]+/).some((word) => word.length > 2 && region.toLowerCase().includes(word)) ? 22 : 8;
  const handling = offer.storage.toLowerCase().includes("ambient") || offer.storage.toLowerCase().includes("dry") ? 20 : 12;
  return { score: Math.min(100, urgency + proximity + handling), local, urgency };
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [now, setNow] = useState(0);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeOrgId, setActiveOrgId] = useState("");
  const [offers, setOffers] = useState<Offer[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [events, setEvents] = useState<HandoffEvent[]>([]);
  const [filter, setFilter] = useState("All food");
  const [query, setQuery] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [showOrgForm, setShowOrgForm] = useState(false);
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgKind, setOrgKind] = useState<OrgKind>("donor");
  const [orgRegion, setOrgRegion] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [offerTitle, setOfferTitle] = useState("");
  const [offerCategory, setOfferCategory] = useState(categories[0]);
  const [offerQuantity, setOfferQuantity] = useState("");
  const [offerUnit, setOfferUnit] = useState(units[0]);
  const [offerExpiry, setOfferExpiry] = useState(dateValue(24));
  const [offerStorage, setOfferStorage] = useState("Ambient / dry");
  const [offerNotes, setOfferNotes] = useState("");
  const [claimMessage, setClaimMessage] = useState("");
  const [claimingOffer, setClaimingOffer] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const activeMembership = memberships.find((membership) => membership.organization_id === activeOrgId);
  const activeOrg = activeMembership?.organization;
  const myOrgIds = new Set(memberships.map((membership) => membership.organization_id));
  const myClaims = claims.filter((claim) => myOrgIds.has(claim.donor_org_id) || myOrgIds.has(claim.recipient_org_id));
  const myDonorOffers = offers.filter((offer) => myOrgIds.has(offer.donor_org_id));

  async function refreshWorkspace(userId: string, preserveOrg = true) {
    if (!supabase) return;
    const { data: memberRows, error: memberError } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", userId);
    if (memberError) throw memberError;

    const ids = (memberRows ?? []).map((row) => row.organization_id as string);
    const orgResponse = ids.length
      ? await supabase.from("organizations").select("id, name, kind, region, join_code").in("id", ids)
      : { data: [], error: null };
    if (orgResponse.error) throw orgResponse.error;
    const orgMap = new Map((orgResponse.data ?? []).map((org) => [org.id, org as Organization]));
    const nextMemberships = (memberRows ?? []).flatMap((row) => {
      const organization = orgMap.get(row.organization_id as string);
      return organization ? [{ organization_id: row.organization_id as string, role: row.role as string, organization }] : [];
    });
    setMemberships(nextMemberships);
    const stillAvailable = nextMemberships.some((membership) => membership.organization_id === activeOrgId);
    const nextOrgId = preserveOrg && stillAvailable ? activeOrgId : nextMemberships[0]?.organization_id ?? "";
    setActiveOrgId(nextOrgId);

    const [offerResponse, claimResponse] = await Promise.all([
      supabase.from("food_offers").select("*").order("expires_at", { ascending: true }),
      supabase.from("food_claims").select("*").order("created_at", { ascending: false }),
    ]);
    if (offerResponse.error) throw offerResponse.error;
    if (claimResponse.error) throw claimResponse.error;
    const nextOffers = (offerResponse.data ?? []) as Offer[];
    const nextClaims = (claimResponse.data ?? []) as Claim[];
    setOffers(nextOffers);
    setClaims(nextClaims);

    const claimIds = nextClaims.map((claim) => claim.id);
    const eventResponse = claimIds.length
      ? await supabase.from("handoff_events").select("id, claim_id, event_type, note, created_at").in("claim_id", claimIds).order("created_at", { ascending: false }).limit(120)
      : { data: [], error: null };
    if (eventResponse.error) throw eventResponse.error;
    setEvents((eventResponse.data ?? []) as HandoffEvent[]);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => setNow(Date.now()), 0);
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { window.clearTimeout(timeout); window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!supabase) {
      return;
    }
    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setError(sessionError.message);
      setSession(data.session);
      if (data.session?.user) refreshWorkspace(data.session.user.id).catch((loadError: Error) => setError(loadError.message));
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setError("");
      if (nextSession?.user) refreshWorkspace(nextSession.user.id).catch((loadError: Error) => setError(loadError.message));
      else {
        setMemberships([]);
        setOffers([]);
        setClaims([]);
        setEvents([]);
        setActiveOrgId("");
      }
    });
    return () => subscription.unsubscribe();
    // The initial session owns this subscription; workspace refresh is triggered by auth changes and actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleOffers = offers
    .filter((offer) => offer.status === "available" && new Date(offer.expires_at).getTime() > now)
    .filter((offer) => filter === "All food" || offer.category === filter)
    .filter((offer) => !query || `${offer.title} ${offer.category} ${offer.pickup_region} ${offer.storage}`.toLowerCase().includes(query.toLowerCase()))
    .map((offer) => ({ offer, ...matchScore(offer, activeOrg?.region ?? "", now) }))
    .sort((a, b) => b.score - a.score || a.offer.expires_at.localeCompare(b.offer.expires_at));

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (authMode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (signUpError) throw signUpError;
        if (!data.session) setNotice("Check your email to confirm your account, then sign in here.");
        else setNotice("Your account is ready. Create or join an organization to begin.");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We could not complete that request.");
    } finally { setBusy(false); }
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !session?.user) return;
    setBusy(true); setError("");
    try {
      const { data, error: createError } = await supabase.rpc("create_organization", {
        p_name: orgName.trim(), p_kind: orgKind, p_region: orgRegion.trim(),
      });
      if (createError) throw createError;
      await refreshWorkspace(session.user.id, false);
      setActiveOrgId(data as string);
      setOrgName(""); setOrgRegion(""); setShowOrgForm(false);
      setNotice("Organization created. Share its team code with trusted colleagues.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create organization."); }
    finally { setBusy(false); }
  }

  async function joinOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !session?.user) return;
    setBusy(true); setError("");
    try {
      const { data, error: joinError } = await supabase.rpc("join_organization", { p_join_code: joinCode.trim().toUpperCase() });
      if (joinError) throw joinError;
      await refreshWorkspace(session.user.id, false);
      setActiveOrgId(data as string); setJoinCode(""); setShowJoinForm(false);
      setNotice("You joined the organization.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "That team code could not be used."); }
    finally { setBusy(false); }
  }

  async function createOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !session?.user || !activeOrg) return;
    setBusy(true); setError("");
    try {
      const { error: insertError } = await supabase.from("food_offers").insert({
        donor_org_id: activeOrg.id, created_by: session.user.id, title: offerTitle.trim(), category: offerCategory,
        quantity: Number(offerQuantity), unit: offerUnit, expires_at: new Date(offerExpiry).toISOString(),
        pickup_region: activeOrg.region, storage: offerStorage, notes: offerNotes.trim(),
      });
      if (insertError) throw insertError;
      await refreshWorkspace(session.user.id);
      setOfferTitle(""); setOfferQuantity(""); setOfferNotes(""); setShowOfferForm(false);
      setNotice("Surplus offer published to verified, signed-in organizations.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not publish the offer."); }
    finally { setBusy(false); }
  }

  async function requestOffer(offer: Offer) {
    if (!supabase || !session?.user || !activeOrg) return;
    setBusy(true); setError("");
    try {
      const { error: claimError } = await supabase.rpc("claim_offer", {
        p_offer_id: offer.id, p_recipient_org_id: activeOrg.id, p_message: claimMessage.trim(),
      });
      if (claimError) throw claimError;
      setClaimingOffer(""); setClaimMessage("");
      await refreshWorkspace(session.user.id);
      setNotice("Request sent. The donating organization can now confirm the handoff.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not request this offer."); }
    finally { setBusy(false); }
  }

  async function transitionClaim(claim: Claim, action: "accept" | "decline" | "cancel" | "collected") {
    if (!supabase || !session?.user) return;
    setBusy(true); setError("");
    try {
      const { error: transitionError } = await supabase.rpc("transition_claim", { p_claim_id: claim.id, p_action: action, p_note: "" });
      if (transitionError) throw transitionError;
      await refreshWorkspace(session.user.id);
      setNotice(action === "collected" ? "Collection recorded in the handoff history." : `Request ${action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled"}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the handoff."); }
    finally { setBusy(false); }
  }

  async function signOut() { await supabase?.auth.signOut(); }

  async function copyJoinCode() {
    if (!activeOrg?.join_code) return;
    try {
      await navigator.clipboard.writeText(activeOrg.join_code);
      setNotice("Team code copied. Share it only with trusted colleagues.");
    } catch {
      setNotice(`Team code: ${activeOrg.join_code}. Share it only with trusted colleagues.`);
    }
  }

  if (!authReady) return <main className="loading-screen"><span className="pulse-mark" />Loading your private FreshLink workspace…</main>;

  if (!session) return (
    <main className="auth-page">
      <div className="auth-aside">
        <a className="brand" href="#top"><span className="brand-mark">F</span><span>FreshLink<small>Surplus to shared tables.</small></span></a>
        <div className="auth-story">
          <p className="eyebrow">FOOD RESCUE, COORDINATED</p>
          <h1>Move good food<br /><em>before time runs out.</em></h1>
          <p>Connect food businesses, community kitchens and local hubs with an accountable, shelf-life-aware exchange.</p>
          <div className="story-stat"><strong>One clear chain</strong><span>Offer → match → claim → confirmed handoff</span></div>
          <div className="story-stat"><strong>Private by design</strong><span>Only signed-in organizations can access the exchange.</span></div>
        </div>
        <span className="auth-footnote">Built for practical food recovery. Not a public listing board.</span>
      </div>
      <section className="auth-main" id="top">
        <div className="auth-mobile-brand"><a className="brand" href="#top"><span className="brand-mark">F</span><span>FreshLink<small>Surplus to shared tables.</small></span></a></div>
        <form className="auth-card" onSubmit={handleAuth}>
          <p className="eyebrow">{authMode === "signin" ? "YOUR NETWORK, READY" : "START A LOCAL NETWORK"}</p>
          <h2>{authMode === "signin" ? "Welcome back." : "Make recovery easier."}</h2>
          <p className="muted">{authMode === "signin" ? "Sign in to coordinate surplus, requests and handoffs." : "Create an account, then start or join an organization."}</p>
          <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@organization.org" /></label>
          <label>Password<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>
          {(error || (!supabase ? "Supabase is not configured for this deployment yet." : "")) && <p className="message error" role="alert">{error || "Supabase is not configured for this deployment yet."}</p>}{notice && <p className="message success" role="status">{notice}</p>}
          <button className="button primary full" disabled={busy}>{busy ? "Working…" : authMode === "signin" ? "Sign in" : "Create account"}</button>
          <p className="auth-switch">{authMode === "signin" ? "New to FreshLink?" : "Already have an account?"} <button type="button" className="text-button" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setError(""); setNotice(""); }}>{authMode === "signin" ? "Create an account" : "Sign in"}</button></p>
          <p className="privacy-note">Use aggregate food quantities and pickup areas only. Do not enter personal or sensitive recipient information.</p>
        </form>
      </section>
    </main>
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#overview"><span className="brand-mark">F</span><span>FreshLink<small>Surplus to shared tables.</small></span></a>
        <div className="topbar-center"><span className="live-dot" />RECOVERY NETWORK <span className="topbar-divider" /> PRIVATE WORKSPACE</div>
        <div className="topbar-user"><span className="avatar">{session.user.email?.slice(0, 1).toUpperCase()}</span><span className="user-email">{session.user.email}</span><button className="button quiet small" onClick={signOut}>Sign out</button></div>
      </header>
      <div className="workspace-layout">
        <aside className="sidebar">
          <div className="sidebar-label">YOUR ORGANIZATION</div>
          {activeOrg ? <div className="org-select-wrap"><select aria-label="Active organization" value={activeOrgId} onChange={(event) => setActiveOrgId(event.target.value)}>{memberships.map((membership) => <option key={membership.organization_id} value={membership.organization_id}>{membership.organization.name}</option>)}</select><span className="org-kind">{activeOrg.kind.replace("_", " ")} · {activeOrg.region}</span></div> : <div className="empty-org"><strong>Start your network</strong><span>Create an organization or join one with a team code.</span></div>}
          <button className="sidebar-action" onClick={() => { setShowOrgForm(true); setShowJoinForm(false); }}>＋ Create organization</button>
          <button className="sidebar-action" onClick={() => { setShowJoinForm(true); setShowOrgForm(false); }}>↗ Join with code</button>
          <div className="side-rule" />
          <a className="side-link active" href="#overview"><span>◫</span> Exchange overview</a>
          <a className="side-link" href="#offers"><span>◇</span> Surplus offers <b>{visibleOffers.length}</b></a>
          <a className="side-link" href="#handoffs"><span>↗</span> My handoffs <b>{myClaims.filter((claim) => claim.status === "requested" || claim.status === "accepted").length}</b></a>
          <a className="side-link" href="#donations"><span>▤</span> My contributions</a>
          <div className="sidebar-bottom"><span className="integrity-mark">✓</span><span><strong>Traceable, not transactional</strong><small>Every accepted exchange keeps a simple event history.</small></span></div>
        </aside>

        <section className="main-content" id="overview">
          <div className="page-heading"><div><p className="eyebrow">FOOD RECOVERY / NETWORK VIEW</p><h1>Make the next handoff count.</h1><p>FreshLink ranks available food by time sensitivity and your organization’s service area.</p></div><div className="heading-actions"><button className="button quiet" onClick={() => refreshWorkspace(session.user.id).catch((cause: Error) => setError(cause.message))}>↻ Refresh</button><button className="button primary" disabled={!activeOrg || activeOrg.kind === "recipient"} onClick={() => setShowOfferForm(true)}>＋ Share surplus</button></div></div>

          {(error || notice) && <div className={`global-message ${error ? "error" : "success"}`} role={error ? "alert" : "status"}><span>{error || notice}</span><button onClick={() => { setError(""); setNotice(""); }} aria-label="Dismiss message">×</button></div>}

          {(showOrgForm || showJoinForm) && <section className="form-panel" aria-label={showOrgForm ? "Create an organization" : "Join an organization"}><div className="panel-heading"><div><p className="eyebrow">{showOrgForm ? "SET UP A TRUSTED TEAM" : "CONNECT YOUR TEAM"}</p><h2>{showOrgForm ? "Create your organization" : "Join with a team code"}</h2></div><button className="icon-button" onClick={() => { setShowOrgForm(false); setShowJoinForm(false); }} aria-label="Close">×</button></div>{showOrgForm ? <form className="form-grid" onSubmit={createOrganization}><label>Organization name<input required minLength={2} maxLength={120} value={orgName} onChange={(event) => setOrgName(event.target.value)} placeholder="e.g. Northside Community Kitchen" /></label><label>Organization role<select value={orgKind} onChange={(event) => setOrgKind(event.target.value as OrgKind)}><option value="donor">Food donor</option><option value="recipient">Community recipient</option><option value="hub">Redistribution hub</option></select></label><label className="span-two">Primary service area<input required maxLength={120} value={orgRegion} onChange={(event) => setOrgRegion(event.target.value)} placeholder="Town, district or service area" /></label><div className="span-two form-footer"><span>Organization records are private to members; offer regions are shared with signed-in network members.</span><button className="button primary" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button></div></form> : <form className="form-grid" onSubmit={joinOrganization}><label className="span-two">Team code<input required maxLength={16} value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="Enter the code shared by your team" /></label><div className="span-two form-footer"><span>Only join codes shared with you by a trusted organization should be used.</span><button className="button primary" disabled={busy}>{busy ? "Joining…" : "Join organization"}</button></div></form>}</section>}

          {showOfferForm && <section className="form-panel" aria-label="Share surplus food"><div className="panel-heading"><div><p className="eyebrow">DONATE / CREATE AN OFFER</p><h2>Share surplus with a clear pickup window.</h2></div><button className="icon-button" onClick={() => setShowOfferForm(false)} aria-label="Close">×</button></div><form className="form-grid" onSubmit={createOffer}><label>Offer name<input required minLength={3} maxLength={120} value={offerTitle} onChange={(event) => setOfferTitle(event.target.value)} placeholder="e.g. Mixed ripe tomatoes" /></label><label>Food category<select value={offerCategory} onChange={(event) => setOfferCategory(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>Quantity<input type="number" min="0.1" max="100000" step="0.1" required value={offerQuantity} onChange={(event) => setOfferQuantity(event.target.value)} placeholder="0" /></label><label>Unit<select value={offerUnit} onChange={(event) => setOfferUnit(event.target.value)}>{units.map((unit) => <option key={unit}>{unit}</option>)}</select></label><label>Available until<input type="datetime-local" min={dateValue(0)} required value={offerExpiry} onChange={(event) => setOfferExpiry(event.target.value)} /></label><label>Storage / handling<select value={offerStorage} onChange={(event) => setOfferStorage(event.target.value)}><option>Ambient / dry</option><option>Refrigerated (0–5°C)</option><option>Frozen (−18°C)</option><option>Keep cool / shaded</option><option>Use promptly</option></select></label><label className="span-two">Pickup notes <span className="optional">(no private phone numbers or exact home addresses)</span><textarea rows={2} maxLength={400} value={offerNotes} onChange={(event) => setOfferNotes(event.target.value)} placeholder="Pickup access, packing, or safe-handling notes" /></label><div className="span-two form-footer"><span>Pickup area: <strong>{activeOrg?.region}</strong>. Your organization name and offer are visible to signed-in members.</span><button className="button primary" disabled={busy}>{busy ? "Publishing…" : "Publish surplus offer"}</button></div></form></section>}

          {!activeOrg && !showOrgForm && !showJoinForm && <section className="empty-workspace"><span className="empty-icon">◫</span><p className="eyebrow">FIRST, YOUR TRUSTED NETWORK</p><h2>Start with the organizations you know.</h2><p>Create a donor, recipient or redistribution-hub organization. You can then share a team code to invite trusted colleagues.</p><div><button className="button primary" onClick={() => setShowOrgForm(true)}>Create organization</button><button className="button quiet" onClick={() => setShowJoinForm(true)}>Join a team</button></div></section>}

          {activeOrg && <>
            <div className="team-code-bar"><span><strong>{activeOrg.name}</strong> · Invite trusted teammates with your private organization code.</span><button className="button quiet small" onClick={copyJoinCode}>Team code&nbsp; <strong>{activeOrg.join_code}</strong> &nbsp;Copy</button></div>
            <div className="metric-grid"><article className="metric-card featured"><div className="metric-top"><span>AVAILABLE NEAR YOUR NETWORK</span><span className="metric-symbol">↗</span></div><strong>{visibleOffers.length.toString().padStart(2, "0")}</strong><small>offers currently in your exchange</small><div className="metric-accent"><span style={{ width: `${Math.min(100, visibleOffers.length * 12)}%` }} /></div></article><article className="metric-card"><div className="metric-top"><span>ACTIVE HANDOFFS</span><span className="metric-symbol">⌁</span></div><strong>{myClaims.filter((claim) => claim.status === "requested" || claim.status === "accepted").length.toString().padStart(2, "0")}</strong><small>requested or confirmed</small><div className="metric-foot">From {myClaims.length} recorded requests</div></article><article className="metric-card"><div className="metric-top"><span>YOUR CONTRIBUTIONS</span><span className="metric-symbol">◇</span></div><strong>{myDonorOffers.length.toString().padStart(2, "0")}</strong><small>offers shared by your teams</small><div className="metric-foot">No estimated impact claims</div></article><article className="metric-card"><div className="metric-top"><span>TEAM CONNECTIONS</span><span className="metric-symbol">＋</span></div><strong>{memberships.length.toString().padStart(2, "0")}</strong><small>organizations you belong to</small><button className="metric-link" onClick={() => { setShowJoinForm(true); setShowOrgForm(false); }}>Join another team ↗</button></article></div>

            <div className="section-heading" id="offers"><div><p className="eyebrow">LIVE EXCHANGE / PRIORITIZED</p><h2>Offers worth acting on.</h2><p>Urgency, shared service area and handling window inform the match score; it is a sorting aid, not a safety certification.</p></div><span className="data-badge"><span className="live-dot" /> LIVE DATA</span></div>
            <div className="filter-bar"><div className="search-box"><span>⌕</span><input aria-label="Search offers" placeholder="Search food, location or handling…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="filter-chips"><button className={filter === "All food" ? "chip selected" : "chip"} onClick={() => setFilter("All food")}>All food</button>{categories.map((category) => <button key={category} className={filter === category ? "chip selected" : "chip"} onClick={() => setFilter(category)}>{category}</button>)}</div></div>
            <div className="offer-list">{visibleOffers.length ? visibleOffers.map(({ offer, score, local, urgency }) => {
              const owner = myOrgIds.has(offer.donor_org_id);
              const openClaim = claimingOffer === offer.id;
              return <article className="offer-card" key={offer.id}><div className="offer-visual"><span className={`food-glyph glyph-${categories.indexOf(offer.category) % 5}`}>{offer.category === "Produce" ? "✳" : offer.category === "Bakery" ? "⌁" : offer.category === "Dairy" ? "◉" : offer.category === "Prepared meals" ? "▧" : "◫"}</span><span className="category-label">{offer.category.toUpperCase()}</span></div><div className="offer-info"><div className="offer-title-row"><h3>{offer.title}</h3><span className={urgency >= 33 ? "urgency high" : "urgency"}>{urgency >= 33 ? "TIME-SENSITIVE" : "AVAILABLE"}</span></div><div className="offer-metadata"><span>◈ {offer.quantity} {offer.unit}</span><span>⌖ {offer.pickup_region}</span><span>◷ Until {formatTime(offer.expires_at)}</span></div><div className="offer-details"><span className="storage-pill">{offer.storage}</span>{local && <span className="local-pill">Same service area</span>}<span>{offer.notes || "Coordinate pickup details after request."}</span></div>{openClaim && <form className="claim-form" onSubmit={(event) => { event.preventDefault(); requestOffer(offer); }}><label>Message to the donor <span className="optional">(avoid personal contact details)</span><textarea rows={2} maxLength={300} value={claimMessage} onChange={(event) => setClaimMessage(event.target.value)} placeholder="Share your planned collection window or handling needs" /></label><div><button type="button" className="button quiet small" onClick={() => setClaimingOffer("")}>Cancel</button><button className="button primary small" disabled={busy}>{busy ? "Sending…" : "Confirm request"}</button></div></form>}</div><div className="offer-score"><span>MATCH</span><strong>{score}</strong><div className="score-track"><i style={{ width: `${score}%` }} /></div>{owner ? <span className="owner-label">YOUR OFFER</span> : activeOrg.kind === "donor" ? <span className="owner-label">RECIPIENT TEAM NEEDED</span> : <button className="button primary small" onClick={() => { setClaimingOffer(openClaim ? "" : offer.id); setClaimMessage(""); }}>Request pickup</button>}</div></article>;
            }) : <div className="empty-list"><span>◇</span><h3>No matching surplus at the moment.</h3><p>Try a different category or search area, or invite local partners to share their offers.</p><button className="button quiet small" onClick={() => { setFilter("All food"); setQuery(""); }}>Clear filters</button></div>}</div>

            <div className="lower-grid"><section className="panel" id="handoffs"><div className="panel-heading"><div><p className="eyebrow">COORDINATION QUEUE</p><h2>Handoffs in progress</h2></div><span className="panel-count">{myClaims.filter((claim) => claim.status === "requested" || claim.status === "accepted").length} OPEN</span></div>{myClaims.filter((claim) => claim.status === "requested" || claim.status === "accepted").length === 0 ? <div className="panel-empty">No active requests. Once someone requests an offer, both organizations will see the next action here.</div> : myClaims.filter((claim) => claim.status === "requested" || claim.status === "accepted").map((claim) => { const offer = offers.find((item) => item.id === claim.offer_id); const donorSide = myOrgIds.has(claim.donor_org_id); return <article className="claim-row" key={claim.id}><div className="claim-icon">{claim.status === "accepted" ? "✓" : "↗"}</div><div className="claim-copy"><strong>{offer?.title ?? "Food offer"}</strong><span>{claim.status === "requested" ? "Pickup request · " : "Pickup confirmed · "}{formatTime(claim.created_at)}</span>{claim.message && <small>“{claim.message}”</small>}</div><div className="claim-actions">{claim.status === "requested" && donorSide && <><button className="button primary small" disabled={busy} onClick={() => transitionClaim(claim, "accept")}>Accept</button><button className="button quiet small" disabled={busy} onClick={() => transitionClaim(claim, "decline")}>Decline</button></>}{claim.status === "requested" && !donorSide && <button className="button quiet small" disabled={busy} onClick={() => transitionClaim(claim, "cancel")}>Cancel request</button>}{claim.status === "accepted" && donorSide && <button className="button primary small" disabled={busy} onClick={() => transitionClaim(claim, "collected")}>Confirm collection</button>}<span className={`status-pill ${claim.status}`}>{claim.status}</span></div></article>; })}</section>
              <section className="panel" id="donations"><div className="panel-heading"><div><p className="eyebrow">YOUR NETWORK / HISTORY</p><h2>Recent trace</h2></div><span className="panel-count">{events.length} EVENTS</span></div>{events.length === 0 ? <div className="panel-empty">Actions are recorded here as organizations request, confirm and complete handoffs.</div> : <div className="event-list">{events.slice(0, 5).map((event) => <div className="event-row" key={event.id}><span className="event-dot" /><div><strong>{event.event_type.replaceAll("_", " ")}</strong><small>{event.note || "Status recorded by an organization member."}</small></div><time>{formatTime(event.created_at)}</time></div>)}</div>}</section></div>
          </>}
          <footer className="app-footer"><span>FRESHLINK / FOOD RECOVERY COORDINATION</span><span>Built for a safer, shorter path from surplus to community.</span><a href="https://github.com/msetrades/mse-food-network" target="_blank" rel="noreferrer">Product & data notes ↗</a></footer>
        </section>
        <aside className="right-rail"><div className="rail-card signal-card"><p className="eyebrow">RECOVERY SIGNAL</p><div className="signal-illustration"><span className="signal-ring ring-one" /><span className="signal-ring ring-two" /><span className="signal-center">F</span><span className="signal-node node-a">◇</span><span className="signal-node node-b">✳</span><span className="signal-node node-c">↗</span></div><h3>Local food has a short clock.</h3><p>FreshLink keeps the request and pickup steps visible while the safe-use window is still open.</p><div className="signal-scale"><span>OFFER</span><i /><span>HANDOFF</span></div></div><div className="rail-card guide-card"><p className="eyebrow">HOW IT FLOWS</p><div className="guide-step"><span>01</span><div><strong>Share</strong><small>Post quantity, storage and an honest cutoff time.</small></div></div><div className="guide-step"><span>02</span><div><strong>Match</strong><small>Find nearby offers by urgency and service area.</small></div></div><div className="guide-step"><span>03</span><div><strong>Confirm</strong><small>Agree the request and record the actual handoff.</small></div></div></div><div className="rail-note"><span>!</span><p><strong>Food-safety note</strong><br />FreshLink helps coordinate logistics. Donors and recipients remain responsible for local food-safety rules and checking food before distribution.</p></div></aside>
      </div>
    </main>
  );
}

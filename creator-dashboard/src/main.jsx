import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/dm-mono/400.css";
import { dashboardRequest, formatMoney, orderStatusLabel, productStatusLabel } from "./data.js";
import "../../packages/brand/tokens.css";
import hatchMarkUrl from "../../packages/brand/hatch-mark.svg";
import "./styles.css";

const NAVIGATION = ["Home", "Products", "Orders", "Payouts"];
const PROFILE_KEY = "hatch.account.profile";

function storedProfile() {
  try {
    return JSON.parse(sessionStorage.getItem(PROFILE_KEY) || "null");
  } catch {
    return null;
  }
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("hatch.creator.session"));
  const [profile, setProfile] = useState(storedProfile);
  const [active, setActive] = useState("Home");
  const [overview, setOverview] = useState(null);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(token));
  const [publishing, setPublishing] = useState(false);

  async function loadDashboard(activeToken = token) {
    const [nextProfile, nextOverview, nextAgents] = await Promise.all([
      dashboardRequest("/v1/creator/me", { token: activeToken }),
      dashboardRequest("/v1/creator/overview", { token: activeToken }),
      dashboardRequest("/v1/creator/agents", { token: activeToken })
    ]);
    setProfile(nextProfile);
    setOverview(nextOverview);
    setAgents(nextAgents);
  }

  useEffect(() => {
    if (!token) return;
    if (profile?.role === "user") return;
    setLoading(true);
    const load = async () => {
      const currentProfile = profile ?? await dashboardRequest("/v1/auth/me", { token });
      setProfile(currentProfile);
      if (currentProfile.role === "user") return;
      await loadDashboard(token);
    };
    load().then(() => setError("")).catch((nextError) => {
      if (nextError.status === 401 || nextError.status === 403) {
        sessionStorage.removeItem("hatch.creator.session");
        setToken(null);
      }
      setError(nextError.message);
    }).finally(() => setLoading(false));
  }, [token, profile?.role]);

  async function login(credentials) {
    setLoading(true);
    setError("");
    try {
      const result = await dashboardRequest("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(credentials),
        token: ""
      });
      sessionStorage.setItem("hatch.creator.session", result.token);
      sessionStorage.setItem(PROFILE_KEY, JSON.stringify(result.profile));
      setToken(result.token);
      setProfile(result.profile);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }

  async function publish(product) {
    setPublishing(true);
    setError("");
    try {
      await dashboardRequest(`/v1/creator/products/${encodeURIComponent(product.product_id)}/publish`, {
        method: "POST",
        token
      });
      await loadDashboard(token);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setPublishing(false);
    }
  }

  async function logout() {
    try {
      await dashboardRequest("/v1/auth/logout", { method: "POST", token });
    } finally {
      sessionStorage.removeItem("hatch.creator.session");
      sessionStorage.removeItem(PROFILE_KEY);
      setToken(null);
      setProfile(null);
      setOverview(null);
      setAgents([]);
    }
  }

  if (!token) return <Login onSubmit={login} loading={loading} error={error} />;
  if (profile?.role === "user") return <UserPortal token={token} profile={profile} onLogout={logout} />;
  if (loading || !profile || !overview) return <Loading />;

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <button className="wordmark hatch-wordmark" onClick={() => setActive("Home")}><img className="hatch-mark" src={hatchMarkUrl} alt="" />Hatch.</button>
        <nav aria-label="Creator dashboard">
          {NAVIGATION.map((item) => (
            <button key={item} className={active === item ? "active" : ""} onClick={() => setActive(item)}>
              {item}
            </button>
          ))}
        </nav>
        <div className="creator-card">
          <div className="avatar">{profile.initials}</div>
          <div><strong>{profile.display_name}</strong><span>{profile.handle}</span></div>
          <button className="sign-out" onClick={logout} aria-label="Sign out">↗</button>
        </div>
      </aside>
      <main className="dashboard-main">
        {error ? <div className="notice" role="alert">{error}</div> : null}
        {active === "Home" ? <Home profile={profile} overview={overview} agents={agents} onPublish={publish} publishing={publishing} /> : null}
        {active === "Products" ? <Products products={overview.products} agents={agents} onPublish={publish} publishing={publishing} /> : null}
        {active === "Orders" ? <Orders orders={overview.recent_orders} /> : null}
        {active === "Payouts" ? <Payouts metrics={overview.metrics} /> : null}
      </main>
    </div>
  );
}

function Login({ onSubmit, loading, error }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="wordmark hatch-wordmark light"><img className="hatch-mark" src={hatchMarkUrl} alt="" />Hatch.</div>
        <div><span className="eyebrow">For expert creators</span><h1>Your method.<br /><em>A product that works.</em></h1><p>Publish Agent products under your own name, then follow their sales and delivery in one place.</p></div>
      </section>
      <section className="login-panel">
        <form onSubmit={(event) => { event.preventDefault(); onSubmit({ email, password }); }}>
          <span className="eyebrow">Account sign in</span><h2>Welcome back</h2>
          <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" /></label>
          <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" /></label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}

function Loading() {
  return <div className="loading-page"><span className="loading-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><span className="hatch-wordmark">Hatch.</span></span><p>Opening your workspace…</p></div>;
}

function Home({ profile, overview, agents, onPublish, publishing }) {
  const product = overview.products[0];
  const hasRevenue = overview.metrics.gross_minor > 0;
  return (
    <>
      <header className="page-heading home-heading">
        <span className="eyebrow">Good afternoon</span>
        <h1>{profile.display_name.split(" ")[0]}, your product is {homeStatusPhrase(product.status)}.</h1>
        <p>{homeStatusDescription(product)}</p>
      </header>
      <section className="home-grid">
        <ProductCard product={product} onPublish={onPublish} publishing={publishing} featured />
        <article className="earnings-card">
          <span className="eyebrow">Your earnings</span>
          <strong>{formatMoney(overview.metrics.creator_share_minor)}</strong>
          <p>{hasRevenue ? `${overview.metrics.successful_deliveries} completed delivery` : "Revenue appears here after buyers receive their work."}</p>
          <div className="earnings-split"><span>Gross sales</span><b>{formatMoney(overview.metrics.gross_minor)}</b></div>
        </article>
      </section>
      <AgentList agents={agents} />
      {hasRevenue ? <RecentOrders orders={overview.recent_orders} /> : null}
    </>
  );
}

function Products({ products, agents, onPublish, publishing }) {
  return (
    <section>
      <header className="page-heading"><span className="eyebrow">Your products</span><h1>Products your audience can use.</h1><p>Each product is published under your name and priced by you.</p></header>
      <div className="product-list">{products.map((product) => <ProductCard key={product.product_id} product={product} onPublish={onPublish} publishing={publishing} />)}</div>
      <AgentList agents={agents} />
    </section>
  );
}

function AgentList({ agents }) {
  return <section className="agent-list"><div className="section-title"><div><span className="eyebrow">Published agents</span><h2>Products your audience can use</h2></div></div>{agents.length ? <div className="agent-grid">{agents.map((agent) => <article className="agent-tile" key={`${agent.creator_id}:${agent.agent_id}`}><span className="status-chip published">Published</span><h3>{agent.product_name}</h3><p>{agent.product_description || "Creator Agent"}</p><small>{agent.agent_id}</small></article>)}</div> : <EmptyState title="No agents published yet" body="Publish an Agent Corpus to make it available under your name." />}</section>;
}

function UserPortal({ token, profile, onLogout }) {
  const [catalog, setCatalog] = useState([]);
  const [library, setLibrary] = useState([]);
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [purchasing, setPurchasing] = useState("");
  useEffect(() => {
    Promise.all([
      dashboardRequest("/v1/catalog/agents", { token }),
      dashboardRequest("/v1/user/agents", { token }),
      dashboardRequest("/v1/user/orders", { token })
    ]).then(([nextCatalog, nextLibrary, nextOrders]) => {
      setCatalog(nextCatalog);
      setLibrary(nextLibrary.creator_agents || []);
      setOrders(nextOrders.orders || []);
    }).catch((nextError) => setError(nextError.message));
  }, [token]);
  async function purchase(agent) {
    const key = `${agent.creator_id}:${agent.agent_id}`;
    setPurchasing(key);
    setError("");
    try {
      await dashboardRequest("/v1/user/checkout", {
        method: "POST",
        token,
        body: JSON.stringify({ creator_id: agent.creator_id, product_id: agent.product_id })
      });
      const [nextLibrary, nextOrders] = await Promise.all([
        dashboardRequest("/v1/user/agents", { token }),
        dashboardRequest("/v1/user/orders", { token })
      ]);
      setLibrary(nextLibrary.creator_agents || []);
      setOrders(nextOrders.orders || []);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setPurchasing("");
    }
  }
  const libraryKeys = new Set(library.map((agent) => `${agent.creator_id}:${agent.agent_id}`));
  return <div className="dashboard-shell"><aside className="sidebar"><button className="wordmark hatch-wordmark"><img className="hatch-mark" src={hatchMarkUrl} alt="" />Hatch.</button><nav><button className="active">Explore</button><button>My agents</button></nav><div className="creator-card"><div className="avatar">{profile.initials}</div><div><strong>{profile.display_name}</strong><span>{profile.handle}</span></div><button className="sign-out" onClick={onLogout}>↗</button></div></aside><main className="dashboard-main"><header className="page-heading"><span className="eyebrow">Creator Agents</span><h1>Methods you can use.</h1><p>Choose an Agent built around a Creator’s way of working.</p></header>{error ? <div className="notice">{error}</div> : null}<section className="agent-grid">{catalog.map((agent) => { const key = `${agent.creator_id}:${agent.agent_id}`; const available = libraryKeys.has(key); return <article className="agent-tile" key={key}><span className="eyebrow">{agent.creator_name}</span><h2>{agent.product_name}</h2><p>{agent.product_description || "A Creator Agent"}</p><div className="agent-offer"><span>Free for now</span><button className="secondary" disabled={available || purchasing === key} onClick={() => purchase(agent)}>{available ? "Available" : purchasing === key ? "Completing…" : "Purchase"}</button></div></article>; })}</section><section className="agent-list"><div className="section-title"><div><span className="eyebrow">Your library</span><h2>Agents you can use</h2></div></div><div className="agent-grid">{library.map((agent) => <article className="agent-tile" key={agent.entitlement_id}><span className="status-chip published">Available</span><h3>{agent.product?.name}</h3><p>{agent.product?.description}</p></article>)}</div></section>{orders.length ? <section className="orders-card buyer-orders"><div className="section-title"><div><span className="eyebrow">Order history</span><h2>Your purchases</h2></div></div><div className="order-list">{orders.map((order) => <div className="order-row" key={order.order_id}><div><strong>{order.product_name || "Agent product"}</strong><span>{new Date(order.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div><div><strong>Free</strong><span className={`order-status ${order.status}`}>{order.status === "refunded" ? "Refunded" : "Paid"}</span></div></div>)}</div></section> : null}</main></div>;
}

function ProductCard({ product, onPublish, publishing, featured = false }) {
  const readyToPublish = product.status === "ready_to_publish";
  const published = product.status === "published";
  return (
    <article className={`product-card ${featured ? "featured" : ""}`}>
      <div className="product-topline"><span className={`status-chip ${product.status}`}>{productStatusLabel(product.status)}</span><span>v{product.version}</span></div>
      <h2>{product.name}</h2>
      <p>{product.promise}</p>
      <div className="product-price"><strong>{formatMoney(product.price_minor, product.currency)}</strong><span>{pricingModelLabel(product.pricing_model)}</span></div>
      <button className={readyToPublish ? "primary inline" : "secondary"} disabled={!readyToPublish || publishing || published} onClick={() => onPublish(product)}>
        {publishing && readyToPublish ? "Publishing…" : readyToPublish ? "Publish product" : published ? "Live" : "Preparing product"}
        <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function RecentOrders({ orders }) {
  return <article className="orders-card"><div className="section-title"><div><span className="eyebrow">Recent sales</span><h2>Orders</h2></div></div><OrderRows orders={orders} compact /></article>;
}

function Orders({ orders }) {
  return <section><header className="page-heading"><span className="eyebrow">Orders</span><h1>Sales and delivery.</h1><p>Revenue becomes available after the buyer receives their work.</p></header>{orders.length ? <article className="orders-card"><OrderRows orders={orders} /></article> : <EmptyState title="No orders yet" body="Orders appear after your first product is published and purchased." />}</section>;
}

function OrderRows({ orders, compact }) {
  return <div className="order-list">{orders.map((order) => <div className="order-row" key={order.order_id}><div><strong>{order.buyer_display_name}</strong><span>{compact ? order.product_name ?? "Agent product" : new Date(order.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div><div><strong>{formatMoney(order.gross_minor, order.currency)}</strong><span className={`order-status ${order.status}`}>{orderStatusLabel(order.status)}</span></div></div>)}</div>;
}

function Payouts({ metrics }) {
  return <section><header className="page-heading"><span className="eyebrow">Payouts</span><h1>Your share of every sale.</h1><p>Hatch earns only when your products earn.</p></header><article className="payout-card"><span className="eyebrow">Available balance</span><strong>{formatMoney(metrics.creator_share_minor)}</strong><p>You keep 90% of completed delivery revenue.</p><div className="payout-facts"><div><span>Gross sales</span><b>{formatMoney(metrics.gross_minor)}</b></div><div><span>Hatch share</span><b>{formatMoney(metrics.hatch_share_minor)}</b></div></div><button disabled>Connect payouts</button><small>Payout setup is not connected in this preview.</small></article></section>;
}

function EmptyState({ title, body }) {
  return <article className="empty-state"><span>○</span><h2>{title}</h2><p>{body}</p></article>;
}

function homeStatusPhrase(status) {
  if (status === "published") return "live";
  if (status === "ready_to_publish") return "ready to publish";
  return "being prepared";
}

function homeStatusDescription(product) {
  if (product.status === "published") return "Your audience can now buy it directly from you.";
  if (product.status === "ready_to_publish") return "Your release is ready. Publish it whenever you are ready to share it.";
  return "Hatch is turning your source material into a product your audience can use.";
}

function pricingModelLabel(model) {
  if (model === "per_delivery") return "per delivery";
  if (model === "subscription") return "subscription";
  return "creator-set price";
}

createRoot(document.getElementById("root")).render(<App />);

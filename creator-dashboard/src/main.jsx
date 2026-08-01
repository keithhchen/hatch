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

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("hatch.creator.session"));
  const [profile, setProfile] = useState(null);
  const [active, setActive] = useState("Home");
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(token));
  const [publishing, setPublishing] = useState(false);

  async function loadDashboard(activeToken = token) {
    const [nextProfile, nextOverview] = await Promise.all([
      dashboardRequest("/v1/creator/me", { token: activeToken }),
      dashboardRequest("/v1/creator/overview", { token: activeToken })
    ]);
    setProfile(nextProfile);
    setOverview(nextOverview);
  }

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    loadDashboard(token).then(() => setError("")).catch((nextError) => {
      if (nextError.status === 401 || nextError.status === 403) {
        sessionStorage.removeItem("hatch.creator.session");
        setToken(null);
      }
      setError(nextError.message);
    }).finally(() => setLoading(false));
  }, [token]);

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
      setToken(result.token);
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
      setToken(null);
      setProfile(null);
      setOverview(null);
    }
  }

  if (!token) return <Login onSubmit={login} loading={loading} error={error} />;
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
        {active === "Home" ? <Home profile={profile} overview={overview} onPublish={publish} publishing={publishing} /> : null}
        {active === "Products" ? <Products products={overview.products} onPublish={publish} publishing={publishing} /> : null}
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
          <span className="eyebrow">Creator sign in</span><h2>Welcome back</h2>
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

function Home({ profile, overview, onPublish, publishing }) {
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
      {hasRevenue ? <RecentOrders orders={overview.recent_orders} /> : null}
    </>
  );
}

function Products({ products, onPublish, publishing }) {
  return (
    <section>
      <header className="page-heading"><span className="eyebrow">Your products</span><h1>Products your audience can use.</h1><p>Each product is published under your name and priced by you.</p></header>
      <div className="product-list">{products.map((product) => <ProductCard key={product.product_id} product={product} onPublish={onPublish} publishing={publishing} />)}</div>
    </section>
  );
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

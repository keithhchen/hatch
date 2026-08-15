import React, { useState } from "react";
import { Archive, Ellipsis, Eye, Pencil, Plus, Search, Settings, Trash2 } from "lucide-react";
import {
  Accordion,
  AvatarGroup,
  Breadcrumbs,
  Button,
  Checkbox,
  Combobox,
  CommandMenu,
  ConfirmDialog,
  DataTable,
  DatePicker,
  Dialog,
  DialogContent,
  DialogTrigger,
  Drawer,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FileUploader,
  FormField,
  IconButton,
  InlineAlert,
  Input,
  List,
  NavigationItem,
  Pagination,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  RadioGroup,
  SearchInput,
  SegmentedControl,
  Select,
  Sheet,
  Sidebar,
  Skeleton,
  Spinner,
  StatusTag,
  Switch,
  Tabs,
  Textarea,
  Tooltip,
  UnavailableState,
  toast
} from "@hatch/ui";
import {
  AutosaveStatus,
  CandidateReviewPanel,
  CheckoutSummary,
  OrderEntitlementSummary,
  PublishConfirmation,
  ReleaseCard
} from "@hatch/ui/product";

export default {
  title: "Hatch/Atmospheric Paper",
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"]
};

const options = [
  { value: "draft", label: "Draft" },
  { value: "progress", label: "In progress" },
  { value: "ready", label: "Ready to publish" }
];

export function ActionsAndForms() {
  const [search, setSearch] = useState("");
  const [choice, setChoice] = useState("draft");
  const [enabled, setEnabled] = useState(true);
  const [date, setDate] = useState();
  return <>
    <section className="hui-story-section"><h1>Actions and forms</h1><div className="hui-story-grid">
      <div className="hui-story-stack"><div className="hui-story-row"><Button>New release</Button><Button variant="secondary">Buyer view</Button><Button variant="ghost">Cancel</Button><Button variant="danger">Withdraw</Button></div><div className="hui-story-row"><Button loading>Saving</Button><Button disabled>Unavailable</Button><IconButton label="Search"><Search aria-hidden="true" /></IconButton><Tooltip content="Product settings"><IconButton label="Settings"><Settings aria-hidden="true" /></IconButton></Tooltip></div></div>
      <div className="hui-story-stack"><FormField label="Product name" hint="Shown on the public storefront"><Input placeholder="A field guide…" /></FormField><FormField label="Promise" error="Make the outcome more specific"><Textarea defaultValue="Help people recover their creative rhythm." /></FormField></div>
      <div className="hui-story-stack"><SearchInput value={search} onChange={(event) => setSearch(event.target.value)} onClear={() => setSearch("")} placeholder="Search releases…" /><Select value={choice} onValueChange={setChoice} options={options} label="Release status" /><Combobox value={choice} onValueChange={setChoice} options={options} label="Release status" /><DatePicker value={date} onChange={setDate} /></div>
      <div className="hui-story-stack"><Checkbox defaultChecked label="Include examples" description="Examples appear in the immutable release." /><RadioGroup defaultValue="free" label="Access type" options={[{ value: "free", label: "Free access" }, { value: "paid", label: "Paid access", description: "Available after Commerce is configured." }]} /><Switch checked={enabled} onCheckedChange={setEnabled} label="Public storefront" description="Visible only after publish succeeds." /></div>
    </div></section>
    <section className="hui-story-section"><h2>Files</h2><FileUploader accept=".pdf,.md,.txt" multiple onFiles={(files) => toast.success(`${files.length} file${files.length === 1 ? "" : "s"} selected`)} label="Add source material" hint="PDF, Markdown, or text. Upload is passed to the real product callback." /></section>
  </>;
}

export function MenusAndOverlays() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  return <section className="hui-story-section"><h1>Menus and overlays</h1><div className="hui-story-row">
    <DropdownMenu trigger={<IconButton label="More actions"><Ellipsis aria-hidden="true" /></IconButton>} items={[{ label: "Edit", icon: <Pencil aria-hidden="true" /> }, { label: "Preview", icon: <Eye aria-hidden="true" />, shortcut: "⌘P" }, { type: "separator" }, { label: "Archive", icon: <Archive aria-hidden="true" /> }, { label: "Delete", icon: <Trash2 aria-hidden="true" />, destructive: true }]} />
    <Popover><PopoverTrigger asChild><Button variant="secondary">Open popover</Button></PopoverTrigger><PopoverContent align="start">A focused, lightweight surface for nearby controls.</PopoverContent></Popover>
    <Dialog><DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger><DialogContent title="What are you making?" description="Describe the idea, material, or unfinished thought." footer={<><Button variant="secondary">Cancel</Button><Button>Begin shaping</Button></>}><Textarea placeholder="Start with the idea…" /></DialogContent></Dialog>
    <ConfirmDialog trigger={<Button variant="danger">Delete release</Button>} title="Delete this draft?" description="Published releases and existing access are never deleted by this action." destructive confirmLabel="Delete draft" onConfirm={() => toast.success("Confirmation callback fired")} />
    <Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open drawer</Button>
    <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Candidate review" description="Inspect the evidence without losing your place." footer={<Button onClick={() => setDrawerOpen(false)}>Done</Button>}><Skeleton lines={3} /></Drawer>
    <Button variant="secondary" onClick={() => setSheetOpen(true)}>Open sheet</Button>
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Release history" description="Open a focused side task without leaving the product." footer={<Button onClick={() => setSheetOpen(false)}>Done</Button>}><Skeleton lines={3} /></Sheet>
    <Button variant="secondary" onClick={() => setCommandOpen(true)}>Command menu</Button>
    <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} groups={[{ label: "Create", items: [{ label: "New release", value: "new", icon: <Plus aria-hidden="true" />, shortcut: "⌘N" }] }, { label: "Navigate", items: [{ label: "Search products", value: "search", icon: <Search aria-hidden="true" /> }] }]} />
  </div></section>;
}

export function NavigationAndData() {
  const [tab, setTab] = useState("overview");
  const [page, setPage] = useState(2);
  const rows = [{ id: "1", product: "Creative recovery", status: "Delivered", total: "$0.00" }, { id: "2", product: "Sunday reset", status: "Processing", total: "$12.00" }];
  return <>
    <section className="hui-story-section"><h1>Navigation and disclosure</h1><Breadcrumbs items={[{ label: "Studio", href: "/studio" }, { label: "Products", href: "/studio/products" }, { label: "Creative recovery" }]} /><div className="hui-story-grid" style={{ marginTop: 18 }}><div className="hui-story-stack"><Tabs value={tab} onValueChange={setTab} ariaLabel="Product sections" items={[{ value: "overview", label: "Overview", content: "Product overview" }, { value: "test", label: "Test & improve", content: "Evaluation evidence" }, { value: "versions", label: "Versions", content: "Immutable releases" }]} /><SegmentedControl defaultValue="creator" ariaLabel="View" items={[{ value: "creator", label: "Creator" }, { value: "buyer", label: "Buyer" }]} /></div><Sidebar brand={<strong>Hatch</strong>} primary={<><NavigationItem active>Studio</NavigationItem><NavigationItem count={2}>Products</NavigationItem><NavigationItem>Orders</NavigationItem></>} secondary={<NavigationItem>Settings</NavigationItem>} account={<AvatarGroup people={[{ name: "Keith Chen" }]} />} /><Accordion defaultValue="sources" items={[{ value: "sources", title: "Authorized sources", content: "Only explicitly authorized material is used for this release." }, { value: "delivery", title: "Delivery behavior", content: "Each entitlement remains pinned to its original release." }]} /></div></section>
    <section className="hui-story-section"><h2>Tables, lists, and pagination</h2><DataTable columns={[{ key: "product", header: "Product" }, { key: "status", header: "Status", render: (row) => <StatusTag tone={row.status === "Delivered" ? "success" : "progress"}>{row.status}</StatusTag> }, { key: "total", header: "Total", align: "end" }]} rows={rows} caption="Recent orders" /><List items={rows} renderItem={(row) => <div className="hui-story-row"><strong>{row.product}</strong><span>{row.status}</span></div>} /><Pagination page={page} pageCount={8} onPageChange={setPage} /></section>
  </>;
}

export function FeedbackStates() {
  return <section className="hui-story-section"><h1>Feedback and states</h1><div className="hui-story-grid"><div className="hui-story-stack"><div className="hui-story-row"><StatusTag>Draft</StatusTag><StatusTag tone="progress" dot>Saving</StatusTag><StatusTag tone="success">Published</StatusTag><StatusTag tone="warning">Needs attention</StatusTag><StatusTag tone="error">Failed</StatusTag></div><InlineAlert title="Source saved">The private draft is stored on the authenticated server.</InlineAlert><InlineAlert tone="success">Release materialization completed.</InlineAlert><InlineAlert tone="warning">One evaluation gate needs review.</InlineAlert><InlineAlert tone="error">The request failed; no success state was shown.</InlineAlert></div><div className="hui-story-stack"><Spinner /><Skeleton lines={3} /><Progress value={68} label="Distillation" /><Button variant="secondary" onClick={() => toast.success("Saved on the server")}>Show toast</Button></div></div><div className="hui-story-grid" style={{ marginTop: 18 }}><EmptyState title="No releases yet" body="Create one narrow, useful product first." action={{ label: "Start in Factory" }} /><ErrorState title="We couldn’t load this product" body="The server returned an error; retry when the connection is available." action={{ label: "Retry" }} /><UnavailableState title="Payout setup unavailable" body="Provider configuration has not been completed." /></div></section>;
}

export function BackgroundOffIdentityLab() {
  const [tab, setTab] = useState("work");
  const [enabled, setEnabled] = useState(true);
  return <section className="hui-story-section hui-material-lab">
    <h1>Background-off identity lab</h1>
    <div className="hui-story-grid">
      <div className="hui-story-stack">
        <div className="hui-story-row"><Button>Publish release</Button><Button variant="secondary">Buyer view</Button><IconButton label="More actions"><Ellipsis aria-hidden="true" /></IconButton></div>
        <FormField label="Release name" hint="Visible to people with access"><Input defaultValue="A field guide to creative recovery" /></FormField>
        <Switch checked={enabled} onCheckedChange={setEnabled} label="Public storefront" description="Visible only after publish succeeds." />
      </div>
      <div className="hui-story-stack">
        <Tabs value={tab} onValueChange={setTab} ariaLabel="Workspace" items={[{ value: "work", label: "Work", content: "Shape the release." }, { value: "evidence", label: "Evidence", content: "Review the behavior." }, { value: "versions", label: "Versions", content: "Inspect immutable releases." }]} />
        <div className="hui-story-row"><StatusTag>Draft</StatusTag><StatusTag tone="progress" dot>In progress</StatusTag><StatusTag tone="success">Published</StatusTag></div>
        <InlineAlert title="Source saved">The private draft is stored on the authenticated server.</InlineAlert>
        <InlineAlert tone="warning">One evaluation gate needs review.</InlineAlert>
      </div>
    </div>
  </section>;
}

export function ProductPatterns() {
  const [checked, setChecked] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  return <>
    <section className="hui-story-section"><h1>Hatch product patterns</h1><div className="hui-story-grid"><ReleaseCard release={{ id: "release", name: "A field guide to creative recovery", promise: "A practical method for returning to creative work without forcing momentum.", status: "published", version: 3, digest: "sha256:7e2…" }} onOpen={() => {}} /><OrderEntitlementSummary order={{ id: "order", order_number: "H-24018", product_name: "A field guide to creative recovery", status: "completed", delivery_status: "delivered", total_minor: 0, currency: "USD", created_at: new Date().toISOString() }} entitlement={{ status: "active", release_id: "release-v3" }} onOpenReceipt={() => {}} onManageAccess={() => {}} /><CheckoutSummary product={{ name: "The Sunday reset", currency: "USD" }} lineItems={[{ label: "Permanent access", detail: "Pinned to the delivered release", amount_minor: 1200 }]} totals={{ subtotal_minor: 1200, tax_minor: 0, total_minor: 1200, currency: "USD" }} action={{ label: "Complete order", onClick: () => {} }} legal="Access is created only after Commerce confirms the order." /></div></section>
    <section className="hui-story-section"><h2>Review, save, and publish</h2><div className="hui-story-stack"><div className="hui-story-row"><AutosaveStatus state="saved" savedAt={new Date()} /><AutosaveStatus state="saving" /><AutosaveStatus state="error" detail="Server unavailable" onRetry={() => {}} /></div><CandidateReviewPanel candidate={{ name: "Creative recovery", version: 3, status: "review_ready", digest: "sha256:7e2…" }} gates={[{ id: "scope", name: "Scope fidelity", passed: true, detail: "The candidate stays within the authorized method." }, { id: "delivery", name: "Delivery contract", passed: true, detail: "The output matches the promised artifact." }]} acknowledgements={[{ id: "reviewed", label: "I reviewed the behavior evidence", description: "Approval is fixed to this exact digest.", checked }]} onAcknowledgementChange={(_, value) => setChecked(value)} onApprove={() => setPublishOpen(true)} onReject={() => {}} /><Button onClick={() => setPublishOpen(true)}>Review publish</Button><PublishConfirmation open={publishOpen} onOpenChange={setPublishOpen} product={{ name: "Creative recovery" }} release={{ label: "Release v3", digest: "sha256:7e2…" }} checks={[{ label: "Candidate approved", ready: checked }, { label: "Storefront previewed", ready: true }, { label: "Materialization ready", ready: true }]} onConfirm={() => setPublishOpen(false)} /></div></section>
  </>;
}

export function OriginActionsAndForms() {
  return <ActionsAndForms />;
}
OriginActionsAndForms.parameters = { hatchTheme: "origin" };

export function OriginMenusAndOverlays() {
  return <MenusAndOverlays />;
}
OriginMenusAndOverlays.parameters = { hatchTheme: "origin" };

export function OriginFeedbackStates() {
  return <FeedbackStates />;
}
OriginFeedbackStates.parameters = { hatchTheme: "origin" };

export function OriginBackgroundOffLab() {
  return <BackgroundOffIdentityLab />;
}
OriginBackgroundOffLab.parameters = { hatchTheme: "origin", hatchCanvas: "neutral" };

export function OriginProductPatterns() {
  return <ProductPatterns />;
}
OriginProductPatterns.parameters = { hatchTheme: "origin" };

export function OriginStudio() {
  return <main className="hui-origin-studio">
    <aside className="hui-origin-studio__sidebar">
      <strong className="hui-origin-studio__mark">h</strong>
      <nav aria-label="Creator studio"><NavigationItem active>Studio</NavigationItem><NavigationItem>Library</NavigationItem><NavigationItem>Orders</NavigationItem></nav>
      <div className="hui-origin-studio__account"><span>KC</span><strong>Keith</strong></div>
    </aside>
    <section className="hui-origin-studio__main">
      <header><span className="hui-semantic-label">CREATOR STUDIO</span><div><Button variant="secondary">Buyer view</Button><Button>New release</Button></div></header>
      <div className="hui-origin-studio__content">
        <h1>Make what only<br />you could make.</h1>
        <p>Your ideas, shaped into something people can use.</p>
        <div className="hui-origin-studio__releases">
          <ReleaseCard release={{ name: "A field guide to creative recovery", status: "in_progress", version: 3, promise: "A practical method for returning to creative work." }} onOpen={() => {}} />
          <ReleaseCard className="is-cool" release={{ name: "The Sunday reset", status: "published", version: 1, promise: "A quiet system for beginning the week with intention." }} onOpen={() => {}} />
        </div>
        <button className="hui-origin-studio__start" type="button"><Plus aria-hidden="true" /><span>Start something new</span></button>
      </div>
    </section>
  </main>;
}
OriginStudio.parameters = { hatchTheme: "origin", hatchCanvas: "neutral" };

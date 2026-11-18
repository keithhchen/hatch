"""Verify the hatch-agent-box image inside a real BoxLite Cloud box, then test per-conversation persistence.

  BOXLITE_REST_URL=https://api.boxlite.ai agentsecrets exec --profile hatch --provider boxlite -- \
    python verify.py [--image IMAGE] [--out DIR] [--only tools|persist]
"""
import argparse, asyncio, os, secrets, sys, time
import boxlite

NET = boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode="enabled", allow_net=[]))
SITE = "https://www.aoneng.com/indexen.html"
RESULTS: list[tuple[str, bool, float, str]] = []


def runtime():
    return boxlite.Boxlite.rest(boxlite.BoxliteRestOptions.from_env())


def box_for(rt, image, **kw):
    return boxlite.SimpleBox(image=image, cpus=2, memory_mib=2048, runtime=rt, network=NET, auto_remove=False, **kw)


async def sh(box, script, timeout=240):
    return await box.exec("bash", "-c", script, timeout=timeout)


async def check(box, name, script, ok=lambda r: r.exit_code == 0, timeout=240):
    t = time.time()
    try:
        r = await sh(box, script, timeout)
        good, detail = ok(r), (r.stdout + r.stderr).strip()
    except Exception as e:  # noqa: BLE001
        good, detail = False, f"EXC {e!r}"
    dt = time.time() - t
    RESULTS.append((name, good, dt, detail))
    print(f"[{'PASS' if good else 'FAIL'}] {name} {dt:.1f}s\n    {detail[-300:].replace(chr(10), chr(10) + '    ')}", flush=True)


PW_SHOT = f"""
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    for name, w, h in (("desktop", 1440, 900), ("mobile", 390, 844)):
        pg = b.new_page(viewport={{"width": w, "height": h}})
        pg.goto("{SITE}", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(4000)
        pg.screenshot(path=f"/home/agent/{{name}}.png")
        print(name, pg.title())
    pg = b.new_page()
    pg.set_content("<html><body style='font-family:sans-serif'><h1>你好，世界</h1><p>中文 PDF 测试 ✅</p></body></html>")
    pg.pdf(path="/home/agent/cn.pdf")
    b.close()
"""
BS4 = f"""
import httpx, json, extruct
from bs4 import BeautifulSoup
html = httpx.get("{SITE}", follow_redirects=True, timeout=60, headers={{"User-Agent": "Mozilla/5.0"}}).text
s = BeautifulSoup(html, "lxml")
print("title:", s.title.string.strip() if s.title else None)
print("meta description:", (s.find("meta", attrs={{"name": "description"}}) or {{}}).get("content"))
print("h1:", [h.get_text(strip=True) for h in s.find_all("h1")][:3])
d = extruct.extract(html, syntaxes=["json-ld"])
print("json-ld:", len(d["json-ld"]), json.dumps(d["json-ld"])[:150])
assert s.title
"""
IMPORTS = "import httpx, requests, bs4, lxml, extruct, numpy, pandas, jinja2, PIL, playwright; print('ok')"


async def tools(image, out):
    rt = runtime()
    t0 = time.time()
    box = box_for(rt, image, name=f"hatch-verify-{secrets.token_hex(4)}")
    try:
        await box.start()
        print(f"box start: {time.time() - t0:.1f}s image={image}", flush=True)
        RESULTS.append(("box start (cold)", True, time.time() - t0, ""))
        c = lambda n, s, **k: check(box, n, s, **k)  # noqa: E731
        await c("whoami/id", "whoami; id; echo HOME=$HOME; echo $PATH", ok=lambda r: r.stdout.startswith("agent"))
        await c("sudo -n true", "sudo -n true")
        await c("apt install cowsay", "sudo apt-get update -qq && sudo apt-get install -y -qq cowsay >/dev/null && /usr/games/cowsay hi")
        await c("pip install --user", "pip install --user -q pyfiglet && python3 -c 'import pyfiglet;print(pyfiglet.figlet_format(\"ok\"))'")
        await c("uv pip install", "uv venv -q /tmp/uvv && uv pip install -q --python /tmp/uvv/bin/python cowsay && /tmp/uvv/bin/python -c 'import cowsay;print(cowsay.__name__)'")
        await c("npm install -g", "npm install -g cowsay >/dev/null 2>&1; cowsay hi | head -3")
        await c("node/npm -v", "node -v && npm -v", ok=lambda r: r.stdout.startswith("v22"))
        await c("CLI versions", "set -e; for c in curl wget openssl dig whois git jq rg unzip zip pandoc pdftoppm qpdf convert uv python3 pip lighthouse; do printf '%s: ' $c; "
                "($c --version 2>&1 || $c -V 2>&1 || $c -v 2>&1) | head -1; done; xz --version | head -1; gcc --version | head -1; make --version | head -1; fc-list | grep -ci noto")
        await c("python imports", f"python3 -c \"{IMPORTS}\"", ok=lambda r: "ok" in r.stdout)
        await c("curl expired.badssl.com", "curl -sS -o /dev/null -w 'ssl_verify=%{ssl_verify_result}\\n' https://expired.badssl.com; true",
                ok=lambda r: "ssl_verify=0" not in r.stdout and "ssl_verify=" in r.stdout)
        await c("openssl juduvalve cert", "echo | openssl s_client -connect www.juduvalve.com:443 -servername www.juduvalve.com 2>/dev/null | openssl x509 -noout -enddate",
                ok=lambda r: "notAfter" in r.stdout)
        await c("dig MX aoneng.com", "dig +short MX aoneng.com", ok=lambda r: bool(r.stdout.strip()))
        await c("whois aoneng.com", "whois aoneng.com | head -5", ok=lambda r: bool(r.stdout.strip()))
        await c("bs4 + extruct aoneng", f"python3 - <<'EOF'\n{BS4}\nEOF")
        await c("playwright screenshots + pdf", f"python3 - <<'EOF'\n{PW_SHOT}\nEOF", timeout=300,
                ok=lambda r: r.exit_code == 0 and "desktop" in r.stdout)
        os.makedirs(out, exist_ok=True)
        for f in ("desktop.png", "mobile.png", "cn.pdf"):
            try:
                await box.copy_out(f"/home/agent/{f}", os.path.join(out, f))
            except Exception as e:  # noqa: BLE001
                print("copy_out failed", f, e)
        await c("pdftoppm cn.pdf", "pdftoppm -png -r 60 cn.pdf cnpage && ls -la cnpage*; pdftotext cn.pdf - | head -3")
        try:
            await box.copy_out("/home/agent/cnpage-1.png", os.path.join(out, "cn_pdf_page.png"))
        except Exception as e:  # noqa: BLE001
            print("copy_out pdf page failed", e)
        await c("lighthouse example.com",
                "lighthouse https://example.com --quiet --chrome-flags='--headless=new --no-sandbox' --output=json --only-categories=performance "
                "| jq '.categories.performance.score'", timeout=300, ok=lambda r: r.stdout.strip().replace('.', '', 1).isdigit())
        await c("pandoc md->html", "printf '# Hi\\n\\n- a\\n- b\\n' | pandoc -f markdown -t html", ok=lambda r: "<h1" in r.stdout)
        await c("imagemagick convert", "convert -size 100x100 xc:red /tmp/r.png && identify /tmp/r.png", ok=lambda r: "PNG 100x100" in r.stdout)
    finally:
        if box._box is not None:
            await rt.remove(box.id, force=True)
            print("removed", box.id)


async def persist(image):
    # one box per (product, buyer user), reused across all that buyer's conversations with the product
    name = f"hatch-p-55e7725f-u-test1234-{secrets.token_hex(4)}"
    opts = dict(name=name, reuse_existing=True)
    rt = runtime()
    bid = None
    try:
        t = time.time(); b = box_for(rt, image, **opts); await b.start(); bid = b.id
        rec("cold create+start", time.time() - t, f"created={b.created}")
        t = time.time()
        r = await sh(b, "echo state-$RANDOM > ~/note.txt; pip install --user -q pyfiglet; sudo apt-get update -qq && sudo apt-get install -y -qq cowsay >/dev/null; cat ~/note.txt")
        note = r.stdout.strip(); rec("write file + pip + apt", time.time() - t, f"{note} exit={r.exit_code} {r.stderr[-150:]}")
        t = time.time(); await b.stop(); rec("stop", time.time() - t, "")
        await rt.close() if hasattr(rt, "close") else None
        # new runtime connection, re-acquire by name
        rt2 = runtime()
        t = time.time(); b2 = box_for(rt2, image, **opts); await b2.start()
        rec("resume by name (get_or_create)", time.time() - t, f"created={b2.created} same_id={b2.id == bid}")
        r = await sh(b2, "cat ~/note.txt; python3 -c 'import pyfiglet;print(\"pyfiglet ok\")'; ls /usr/games/cowsay; uptime -s")
        print("after stop/start:", r.stdout.strip(), r.stderr[-200:], "| expected note:", note, flush=True)
        # idle auto-stop
        for opt in ("auto_stop",):
            await b2.stop()
        rt2_ = rt2
        t = time.time(); b3 = box_for(rt2_, image, name=name, reuse_existing=True, auto_stop=20); await b3.start()
        await sh(b3, "echo hi")
        print("auto_stop=20 requested; waiting 60s for idle stop", flush=True)
        await asyncio.sleep(60)
        info = await rt2_.get_info(bid)
        print("info after idle:", info.state if hasattr(info, "state") else info, flush=True)
        t = time.time(); b4 = box_for(rt2_, image, name=name, reuse_existing=True); await b4.start()
        r = await sh(b4, "cat ~/note.txt")
        rec("resume after idle", time.time() - t, r.stdout.strip())
    finally:
        try:
            await (runtime()).remove(bid, force=True) if bid else None
            print("removed", bid)
        except Exception as e:  # noqa: BLE001
            print("remove failed", e)


async def name_limits(image):
    """Which box names does BoxLite accept? Full-UUID names must fit (or be hashed)."""
    import uuid
    rt = runtime()
    full = f"hatch-p-{uuid.uuid4()}-u-{uuid.uuid4()}"
    for label, n in (("full uuids", full), ("128 chars", "hatch-" + "a" * 122), ("underscore+dot", "hatch_x.y-" + secrets.token_hex(3)), ("colon", "hatch-p:u-" + secrets.token_hex(3))):
        bid = None
        try:
            b = box_for(rt, image, name=n, reuse_existing=True); await b.start(); bid = b.id
            print(f"[INFO] name '{label}' len={len(n)} accepted", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[INFO] name '{label}' len={len(n)} REJECTED: {str(e)[:200]}", flush=True)
        finally:
            if bid:
                await rt.remove(bid, force=True)


def rec(name, dt, detail):
    RESULTS.append((name, True, dt, detail)); print(f"[INFO] {name} {dt:.1f}s {detail}", flush=True)


async def list_leftovers():
    rt = runtime()
    infos = await rt.list_info()
    left = [i for i in infos if str(getattr(i, "name", "")).startswith("hatch-")]
    print("leftover hatch-* boxes:", [(i.id, i.name) for i in left], "| total boxes:", len(infos))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="docker.io/keithchen/hatch-agent-box:latest")
    ap.add_argument("--out", default="verify-out")
    ap.add_argument("--only", choices=["tools", "persist"])
    a = ap.parse_args()
    if a.only != "persist":
        await tools(a.image, a.out)
    if a.only != "tools":
        await persist(a.image)
    if a.only != "tools":
        await name_limits(a.image)
    await list_leftovers()
    print("\n| check | result | s |\n|---|---|---|")
    for n, ok, dt, _ in RESULTS:
        print(f"| {n} | {'pass' if ok else 'FAIL'} | {dt:.1f} |")
    sys.exit(0 if all(ok for _, ok, _, _ in RESULTS) else 1)


asyncio.run(main())

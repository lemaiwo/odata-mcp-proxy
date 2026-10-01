"""Generate the architecture diagrams in this folder (SAP BTP solution diagram style).

Run: python3 docs/architecture/generate.py
"""
import html
from pathlib import Path

OUT = Path(__file__).resolve().parent

# SAP BTP solution diagram palette (Horizon)
BTP_STROKE, BTP_FILL = "#0070F2", "#EBF8FF"
NON_STROKE, NON_FILL = "#475E75", "#F5F6F7"
TEXT, TEXT2 = "#1D2D3E", "#556B82"
LINE = "#475E75"
AUTH = "#5D36FF"
FONT = "'72', '72full', 'Helvetica Neue', Arial, sans-serif"

W = 1500


def esc(s):
    return html.escape(s, quote=True)


class Svg:
    def __init__(self, title, subtitle, height):
        self.parts = []
        self.H = height
        self.title, self.subtitle = title, subtitle

    def add(self, s):
        self.parts.append(s)

    def area(self, x, y, w, h, label, sap=True, sub=False):
        stroke, fill = (BTP_STROKE, BTP_FILL) if sap else (NON_STROKE, NON_FILL)
        if sub:
            fill = "#FFFFFF" if sap else "#FFFFFF"
        dash = ' stroke-dasharray="6 4"' if sub else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" '
                 f'stroke="{stroke}" stroke-width="{1 if sub else 1.5}"{dash}/>')
        lx = x + 16
        if sap and not sub:
            # SAP logo-like badge
            self.add(f'<g transform="translate({x+16},{y+14})">'
                     f'<path d="M0 0 H44 L30 20 H0 Z" fill="#0070F2"/>'
                     f'<text x="5" y="14.5" font-size="11" font-weight="700" fill="#fff">SAP</text></g>')
            lx = x + 70
        self.add(f'<text x="{lx}" y="{y+29}" font-size="{15 if not sub else 13}" font-weight="700" '
                 f'fill="{stroke if sub else TEXT}">{esc(label)}</text>')

    def box(self, x, y, w, h, title, lines=(), sap=True, icon=None):
        stroke = BTP_STROKE if sap else NON_STROKE
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="#FFFFFF" '
                 f'stroke="{stroke}" stroke-width="1"/>')
        tx = x + 14
        if icon:
            self.icon(icon, x + 12, y + 12, stroke)
            tx = x + 50
        self.add(f'<text x="{tx}" y="{y+31}" font-size="14" font-weight="700" fill="{TEXT}">{esc(title)}</text>')
        for i, line in enumerate(lines):
            self.add(f'<text x="{x+14}" y="{y+58+i*18}" font-size="12" fill="{TEXT2}">{esc(line)}</text>')

    def icon(self, kind, x, y, color):
        g = {
            "user": f'<circle cx="14" cy="10" r="5" fill="none" stroke="{color}" stroke-width="1.8"/>'
                    f'<path d="M4 25 C4 17 24 17 24 25" fill="none" stroke="{color}" stroke-width="1.8"/>',
            "app": f'<rect x="3" y="4" width="22" height="20" rx="3" fill="none" stroke="{color}" stroke-width="1.8"/>'
                   f'<path d="M3 10 H25" stroke="{color}" stroke-width="1.8"/>'
                   f'<path d="M9 15 L7 17 L9 19 M19 15 L21 17 L19 19" fill="none" stroke="{color}" stroke-width="1.6"/>',
            "shield": f'<path d="M14 3 L24 7 V14 C24 20 19 24 14 26 C9 24 4 20 4 14 V7 Z" fill="none" stroke="{color}" stroke-width="1.8"/>'
                      f'<path d="M9.5 14.5 L13 18 L19 11" fill="none" stroke="{color}" stroke-width="1.8"/>',
            "id": f'<rect x="3" y="6" width="22" height="16" rx="3" fill="none" stroke="{color}" stroke-width="1.8"/>'
                  f'<circle cx="10" cy="13" r="3" fill="none" stroke="{color}" stroke-width="1.6"/>'
                  f'<path d="M15 12 H22 M15 16 H20" stroke="{color}" stroke-width="1.6"/>',
            "dest": f'<circle cx="14" cy="14" r="10" fill="none" stroke="{color}" stroke-width="1.8"/>'
                    f'<path d="M14 4 V24 M4 14 H24" stroke="{color}" stroke-width="1.4"/>'
                    f'<ellipse cx="14" cy="14" rx="4.5" ry="10" fill="none" stroke="{color}" stroke-width="1.4"/>',
            "plug": f'<path d="M9 4 V10 M19 4 V10" stroke="{color}" stroke-width="1.8"/>'
                    f'<path d="M6 10 H22 V15 C22 19 18 21 14 21 C10 21 6 19 6 15 Z" fill="none" stroke="{color}" stroke-width="1.8"/>'
                    f'<path d="M14 21 V26" stroke="{color}" stroke-width="1.8"/>',
            "api": f'<path d="M8 6 C4 6 5 14 2 14 C5 14 4 22 8 22 M20 6 C24 6 23 14 26 14 C23 14 24 22 20 22" fill="none" stroke="{color}" stroke-width="1.8"/>'
                   f'<circle cx="11" cy="14" r="1.6" fill="{color}"/><circle cx="17" cy="14" r="1.6" fill="{color}"/>',
            "erp": f'<ellipse cx="14" cy="7" rx="10" ry="3.5" fill="none" stroke="{color}" stroke-width="1.8"/>'
                   f'<path d="M4 7 V21 C4 23 9 24.5 14 24.5 C19 24.5 24 23 24 21 V7" fill="none" stroke="{color}" stroke-width="1.8"/>'
                   f'<path d="M4 14 C4 16 9 17.5 14 17.5 C19 17.5 24 16 24 14" fill="none" stroke="{color}" stroke-width="1.6"/>',
            "key": f'<circle cx="9" cy="14" r="5" fill="none" stroke="{color}" stroke-width="1.8"/>'
                   f'<path d="M14 14 H25 M21 14 V19 M25 14 V18" stroke="{color}" stroke-width="1.8"/>',
            "proxy": f'<path d="M3 9 H19 M15 5 L19 9 L15 13 M25 19 H9 M13 15 L9 19 L13 23" fill="none" stroke="{color}" stroke-width="1.8"/>',
        }[kind]
        self.add(f'<g transform="translate({x},{y})">{g}</g>')

    def line(self, pts, kind="data", arrow_end=True, arrow_start=False):
        color = LINE if kind == "data" else AUTH
        dash = ' stroke-dasharray="7 5"' if kind == "auth" else ""
        d = "M" + " L".join(f"{x} {y}" for x, y in pts)
        me = f' marker-end="url(#arr-{kind})"' if arrow_end else ""
        ms = f' marker-start="url(#arrs-{kind})"' if arrow_start else ""
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.6"{dash}{me}{ms}/>')

    def step(self, n, x, y):
        self.add(f'<circle cx="{x}" cy="{y}" r="11" fill="{TEXT}"/>'
                 f'<text x="{x}" y="{y+4.5}" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">{n}</text>')

    def label(self, x, y, text, anchor="start", color=TEXT2, bold=False):
        w = ' font-weight="700"' if bold else ""
        self.add(f'<text x="{x}" y="{y}" font-size="11.5" fill="{color}" text-anchor="{anchor}"{w}>{esc(text)}</text>')

    def legend_and_steps(self, y, steps, btp=True):
        self.add(f'<line x1="30" y1="{y}" x2="{W-30}" y2="{y}" stroke="#D5DADD"/>')
        # legend
        lx, ly = 30, y + 30
        self.add(f'<text x="{lx}" y="{ly}" font-size="13" font-weight="700" fill="{TEXT}">Legend</text>')
        items = [("rect", BTP_STROKE, BTP_FILL, "SAP BTP")] if btp else []
        items += [
            ("rect", NON_STROKE, NON_FILL, "Non-SAP / customer"),
            ("line", LINE, None, "API call / data flow"),
            ("dash", AUTH, None, "Authentication / token flow"),
        ]
        for i, (k, s, f, t) in enumerate(items):
            yy = ly + 22 + i * 24
            if k == "rect":
                self.add(f'<rect x="{lx}" y="{yy-11}" width="30" height="16" rx="4" fill="{f}" stroke="{s}" stroke-width="1.5"/>')
            else:
                dash = ' stroke-dasharray="7 5"' if k == "dash" else ""
                self.add(f'<line x1="{lx}" y1="{yy-3}" x2="{lx+30}" y2="{yy-3}" stroke="{s}" stroke-width="1.6"{dash}/>')
            self.add(f'<text x="{lx+40}" y="{yy+1}" font-size="12" fill="{TEXT}">{esc(t)}</text>')
        # steps
        sx = 290
        self.add(f'<text x="{sx}" y="{ly}" font-size="13" font-weight="700" fill="{TEXT}">Flow</text>')
        col_w = 590
        per_col = (len(steps) + 1) // 2
        for i, s in enumerate(steps):
            cx = sx + (i // per_col) * col_w
            cy = ly + 22 + (i % per_col) * 24
            self.step(i + 1, cx + 11, cy - 4)
            self.add(f'<text x="{cx+30}" y="{cy+1}" font-size="12" fill="{TEXT}">{esc(s)}</text>')

    def render(self):
        defs = "".join(
            f'<marker id="arr-{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
            f'<path d="M0 0 L10 5 L0 10 Z" fill="{c}"/></marker>'
            f'<marker id="arrs-{k}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto">'
            f'<path d="M10 0 L0 5 L10 10 Z" fill="{c}"/></marker>'
            for k, c in (("data", LINE), ("auth", AUTH))
        )
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{self.H}" viewBox="0 0 {W} {self.H}" '
                f'font-family="{FONT}">'
                f'<title>{esc(self.title)}</title><defs>{defs}</defs>'
                f'<rect width="{W}" height="{self.H}" fill="#FFFFFF"/>'
                f'<text x="30" y="44" font-size="22" font-weight="700" fill="{TEXT}">{esc(self.title)}</text>'
                f'<text x="30" y="68" font-size="13" fill="{TEXT2}">{esc(self.subtitle)}</text>')
        return head + "".join(self.parts) + "</svg>\n"


# ─────────────────────────────── Diagram 1: on SAP BTP ───────────────────────────────
d = Svg("OData MCP Proxy — deployed on SAP BTP",
        "Cloud Foundry app with XSUAA login, Destination Service and Cloud Connector for on-premise systems", 960)

d.area(30, 110, 250, 230, "AI clients", sap=False)
d.box(50, 160, 210, 150, "MCP client", ["Claude, Copilot Studio,", "MCP Inspector, …", "Streamable HTTP + OAuth"], sap=False, icon="user")

d.area(30, 540, 250, 190, "Corporate identity provider", sap=False)
d.box(50, 590, 210, 110, "Corporate IdP", ["Entra ID, Okta, ADFS, …", "(federated via SAML/OIDC)"], sap=False, icon="id")

d.area(320, 90, 800, 700, "SAP BTP")
d.area(345, 130, 755, 390, "Subaccount · Cloud Foundry runtime", sub=True)
d.box(375, 165, 260, 210, "odata-mcp-proxy", ["Node.js application", "/mcp  Streamable HTTP", "/oauth/*  OAuth proxy", "Tool registry → ODataClient", "SAP Cloud SDK"], icon="app")
d.box(375, 415, 260, 85, "Authorization & Trust Mgmt", ["XSUAA · role collections", "MCP Viewer / Editor / Admin"], icon="shield")
d.box(720, 165, 360, 80, "Destination service", ["Target URLs, credentials, user token exchange"], icon="dest")
d.box(720, 265, 360, 80, "Connectivity service", ["Proxy to on-premise via Cloud Connector"], icon="plug")

d.box(375, 585, 260, 110, "SAP Cloud Identity Services", ["Identity Authentication (IAS)", "Federates corporate IdP"], icon="id")

d.area(690, 545, 410, 225, "Integration subaccount", sub=True)
d.box(715, 585, 360, 75, "SAP Integration Suite", ["Cloud Integration OData API (/api/v1)"], icon="api")
d.box(715, 675, 360, 75, "SAP BTP Core Services APIs", ["Accounts, entitlements, … (REST)"], icon="api")

d.area(1160, 225, 310, 345, "On-premise network", sap=False)
d.box(1185, 265, 260, 80, "SAP Cloud Connector", ["Secure tunnel, principal propagation"], sap=False, icon="plug")
d.box(1185, 425, 260, 120, "SAP S/4HANA / ABAP", ["OData services", "Logged-on as the propagated", "business user"], sap=False, icon="erp")

# 1 MCP request
d.line([(260, 235), (375, 235)])
d.step(1, 318, 235)
# 2 login chain
d.line([(505, 375), (505, 415)], kind="auth", arrow_start=True)
d.line([(505, 500), (505, 585)], kind="auth", arrow_start=True)
d.line([(260, 640), (375, 640)], kind="auth", arrow_start=True)
d.step(2, 505, 545)
d.label(515, 392, "OAuth login (proxied)")
d.label(515, 406, "JWT validation")
d.label(318, 628, "trust", anchor="middle")
# 3 destination lookup
d.line([(635, 205), (720, 205)])
d.step(3, 678, 205)
# 4 calls to BTP APIs
d.line([(635, 355), (665, 355), (665, 712), (715, 712)])
d.line([(665, 622), (715, 622)])
d.step(4, 665, 470)
# 5 on-premise
d.line([(635, 305), (720, 305)])
d.line([(1080, 305), (1185, 305)], arrow_start=True)
d.line([(1315, 345), (1315, 425)])
d.step(5, 1132, 305)
d.label(1325, 390, "RFC / HTTP")

d.legend_and_steps(815, [
    "MCP client calls /mcp with an XSUAA bearer token (Streamable HTTP)",
    "Login is proxied to XSUAA → IAS → corporate IdP; tokens validated by XSUAA",
    "SAP Cloud SDK resolves the destination, exchanging the user token if configured",
    "Cloud targets are called directly: OAuth2 client credentials or user token exchange",
    "On-premise targets go through Connectivity + Cloud Connector with principal propagation",
])
open(OUT / "btp-deployment.svg", "w").write(d.render())

# ─────────────────────────────── Diagram 2: on-premise ───────────────────────────────
o = Svg("OData MCP Proxy — self-hosted (on-premise)",
        "Node.js server in the customer network, SSO via any OpenID Connect provider, user propagated to SAP", 900)

o.area(30, 110, 250, 230, "AI clients", sap=False)
o.box(50, 160, 210, 150, "MCP client", ["Claude, Copilot Studio,", "MCP Inspector, …", "Streamable HTTP + OAuth"], sap=False, icon="user")

o.area(30, 540, 250, 190, "OpenID Connect provider", sap=False)
o.box(50, 590, 210, 110, "Any OIDC IdP", ["Entra ID, Okta, Keycloak,", "SAP IAS, Auth0, …"], sap=False, icon="id")

o.area(320, 90, 800, 650, "Customer data center / private network", sap=False)
o.box(350, 180, 200, 110, "Reverse proxy", ["HTTPS / TLS termination", "nginx, IIS, Caddy, …"], sap=False, icon="proxy")
o.box(600, 165, 260, 225, "odata-mcp-proxy", ["Node.js server (systemd, Docker)", "/mcp  Streamable HTTP", "/oauth/*  OAuth proxy", "OIDC JWT validation (JWKS)", "Per-user token cache", "SAML assertion signing"], sap=False, icon="app")
o.box(600, 445, 200, 90, "Secret store", ["SAML signing key,", "client secrets"], sap=False, icon="key")
o.box(890, 455, 205, 160, "SAP S/4HANA / ABAP", ["OAuth 2.0 server (SOAUTH2)", "SAML2 trusted provider", "OData services", "Runs as the business user"], sap=False, icon="erp")

o.area(1150, 110, 330, 440, "SAP BTP")
o.area(1168, 150, 294, 380, "Integration subaccount", sub=True)
o.box(1185, 192, 262, 75, "Authorization & Trust Mgmt", ["XSUAA token endpoint"], icon="shield")
o.box(1185, 290, 262, 75, "SAP Integration Suite", ["Cloud Integration OData API"], icon="api")
o.box(1185, 398, 262, 75, "SAP BTP Core Services APIs", ["Accounts, entitlements, …"], icon="api")

# 1 MCP request through reverse proxy
o.line([(260, 235), (350, 235)])
o.line([(550, 235), (600, 235)])
o.step(1, 305, 235)
# 2 OIDC login proxied + JWKS validation
o.line([(600, 360), (575, 360), (575, 645), (260, 645)], kind="auth")
o.step(2, 575, 500)
o.label(420, 633, "OIDC login (proxied) · JWKS", anchor="middle")
# 3 SAML bearer token request (sign with key, exchange at SAP)
o.line([(700, 390), (700, 445)], kind="auth", arrow_start=True)
o.line([(820, 390), (820, 500), (890, 500)], kind="auth")
o.step(3, 820, 440)
# 4 OData as the user
o.line([(845, 390), (845, 575), (890, 575)])
o.step(4, 845, 530)
# 5 BTP: token + API
o.line([(860, 215), (1185, 215)], kind="auth")
o.line([(860, 325), (1185, 325)])
o.line([(1135, 325), (1135, 435), (1185, 435)])
o.step(5, 1010, 215)
o.step(6, 1010, 325)
o.label(1010, 200, "client credentials · jwt-bearer · token exchange", anchor="middle")
o.label(1000, 345, "OData / REST calls", anchor="middle")

o.legend_and_steps(770, [
    "MCP client calls /mcp over HTTPS with a bearer token from the corporate IdP",
    "Login is proxied to the OIDC provider; tokens are validated against its JWKS",
    "saml-bearer: proxy signs a SAML assertion for the user, SAP returns a user token",
    "OData request to S/4HANA / ABAP runs as the signed-in business user",
    "BTP targets: token from XSUAA (technical user, jwt-bearer or token exchange)",
    "Cloud Integration and BTP APIs are called directly over the internet",
])
open(OUT / "on-premise-deployment.svg", "w").write(o.render())
print("ok")

# ─────────────────────────── Diagram 3: fully on-premise, no BTP ───────────────────────────
n = Svg("OData MCP Proxy — fully on-premise, without SAP BTP",
        "Node.js server, any OpenID Connect provider and SAP systems that trust the proxy directly", 900)

n.area(30, 110, 250, 230, "AI clients", sap=False)
n.box(50, 160, 210, 150, "MCP client", ["Claude, Copilot Studio,", "MCP Inspector, …", "Streamable HTTP + OAuth"], sap=False, icon="user")
n.area(30, 540, 250, 190, "OpenID Connect provider", sap=False)
n.box(50, 590, 210, 110, "Any OIDC IdP", ["Entra ID, Okta, Keycloak,", "SAP IAS, Auth0, …"], sap=False, icon="id")

n.area(320, 90, 1150, 650, "Customer data center / private network", sap=False)
n.box(350, 180, 200, 110, "Reverse proxy", ["HTTPS / TLS termination", "nginx, IIS, Caddy, …"], sap=False, icon="proxy")
n.box(600, 165, 260, 225, "odata-mcp-proxy", ["Node.js server (systemd, Docker)", "/mcp  Streamable HTTP", "/oauth/*  OAuth proxy", "OIDC JWT validation (JWKS)", "Per-user token cache", "SAML assertion signing"], sap=False, icon="app")
n.box(600, 445, 200, 90, "Secret store", ["SAML signing key,", "client secrets"], sap=False, icon="key")

n.area(955, 135, 490, 435, "SAP landscape", sap=False, sub=True)
n.box(985, 180, 430, 165, "SAP S/4HANA", ["OAuth 2.0 server (SOAUTH2)", "SAML2 trusted provider: the proxy", "User mapping by e-mail or user ID", "OData services run as the business user"], sap=False, icon="erp")
n.box(985, 400, 430, 130, "Other SAP ABAP systems", ["SAP ECC, BW/4HANA, Gateway hub, …", "Same trust set-up, one destination each"], sap=False, icon="erp")
n.box(985, 600, 460, 110, "Per-destination configuration", ["{PREFIX}_AUTH_TYPE = saml-bearer  (per user)", "or client-credentials (technical user)"], sap=False, icon="key")

n.line([(260, 235), (350, 235)])
n.line([(550, 235), (600, 235)])
n.step(1, 305, 235)
n.line([(600, 360), (575, 360), (575, 645), (260, 645)], kind="auth")
n.step(2, 575, 500)
n.label(420, 633, "OIDC login (proxied) · JWKS", anchor="middle")
n.line([(700, 390), (700, 445)], kind="auth", arrow_start=True)
n.line([(860, 230), (985, 230)], kind="auth")
n.step(3, 922, 230)
n.label(912, 214, "SAML bearer", anchor="middle")
n.line([(860, 310), (985, 310)])
n.step(4, 922, 310)
n.label(912, 294, "OData", anchor="middle")
n.line([(860, 370), (905, 370), (905, 465), (985, 465)])
n.step(5, 905, 418)

n.legend_and_steps(770, [
    "MCP client calls /mcp over HTTPS with a bearer token from the corporate IdP",
    "Login is proxied to the OIDC provider; tokens are validated against its JWKS",
    "Proxy signs a SAML assertion for the user; SAP's OAuth server returns a user token",
    "OData request to S/4HANA runs as the signed-in business user",
    "Each further ABAP system is its own destination with its own trust and AUTH_TYPE",
], btp=False)
open(OUT / "on-premise-no-btp.svg", "w").write(n.render())

// The brand library on the web: what the team will put on posters (the logo, colours, fonts, the brand guide, pictures) and a
// place to drop a better file. "Here's my logo" works here as it does in Discord: the file is checked by its bytes, looked at,
// filed, and the owner is told plainly what was kept.
import { useState } from "react";
import { api, type BrandAssetDto } from "../api";
import { useAsync } from "../state/app";
import { Icon } from "./Icon";

const KIND: Record<string, string> = { logo: "Logo", colour: "Colour", font: "Font", "font-file": "Font file", palette: "Colours", guide: "Brand guide", "product-photo": "Product photo", "past-design": "Past design", "font-sample": "Font sample", other: "Other" };

export function BrandLibrary({ tenant }: { tenant: string }) {
  const [version, setVersion] = useState(0);
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lib = useAsync(() => api.brand(tenant).catch(() => null), [tenant, version]);
  const upload = async (f: File) => {
    setBusy(true);
    setSaid(undefined);
    try {
      const r = await api.brandUpload(tenant, f);
      setSaid(r.message);
      setVersion((v) => v + 1);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : "That file didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const assets: BrandAssetDto[] = lib.data?.assets ?? [];
  const colours = assets.filter((a) => a.kind === "colour" && a.value);
  const files = assets.filter((a) => a.kind !== "colour");
  return (
    <section className="brand-lib" aria-label="Your brand files">
      <h2 className="brand-lib-title"><Icon name="sparkle" size={16} /> Your brand files</h2>
      <p className="brand-lib-lede">{lib.data?.logo ? "Your logo goes on every poster." : "No logo file yet: posters show your name in your brand font until you add one."}</p>
      {colours.length > 0 && <p className="brand-lib-colours">{colours.map((c) => <span key={c.id} className="swatch" title={c.value ?? ""} style={{ background: c.value ?? undefined }} />)}</p>}
      <ul className="brand-lib-files">
        {files.slice(0, 12).map((a) => (
          <li key={a.id}>
            {a.url && a.mime?.startsWith("image/") ? <img src={a.url} alt={a.name} loading="lazy" /> : <span className="brand-lib-icon"><Icon name="pen" size={18} /></span>}
            <span><b>{KIND[a.kind] ?? a.kind}</b>{a.family ? ` · ${a.family}` : ""}{a.needsBetter ? " · a better file would help" : ""}</span>
          </li>
        ))}
      </ul>
      <label className="btn btn-sm btn-gold brand-lib-drop">
        {busy ? "Checking…" : "Add a logo, font, guide or picture"}
        <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,application/pdf,.ttf,.otf" hidden disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      </label>
      {said && <p className="brand-lib-said" role="status">{said}</p>}
    </section>
  );
}

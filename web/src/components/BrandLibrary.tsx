// The brand library on the web: what the team will put on posters (the logo, colours, fonts, the brand guide, pictures) and a
// place to drop a better file. "Here's my logo" works here as it does in Discord: the file is checked by its bytes, looked at,
// filed, and the owner is told plainly what was kept.
import { useState } from "react";
import { api, type BrandAssetDto } from "../api";
import { useAsync } from "../state/app";
import { Icon } from "./Icon";
import { Reveal } from "./Reveal";
import "./brand-library.css";

const KIND: Record<string, string> = { logo: "Logo", colour: "Colour", font: "Font", "font-file": "Font file", palette: "Colours", guide: "Brand guide", "product-photo": "Product photo", "past-design": "Past design", "font-sample": "Font sample", other: "Other" };

/** `open`: the files are shown as they are (the Library's Brand tab), not behind "See your files". */
export function BrandLibrary({ tenant, open = false }: { tenant: string; open?: boolean }) {
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
      <div className="brand-lib-row">
        <h2 className="brand-lib-title"><Icon name="sparkle" size={16} /> Brand files</h2>
        <span className="brand-lib-lede" title={lib.data?.logo ? "Your logo goes on every poster." : "Until you add a logo, posters show your name in your brand font."}>
          {lib.data?.logo ? "Logo on every poster" : "No logo yet"}{files.length ? ` · ${files.length} ${files.length === 1 ? "file" : "files"}` : ""}
        </span>
        {colours.length > 0 && <span className="brand-lib-colours">{colours.map((c) => <span key={c.id} className="swatch" title={c.value ?? ""} style={{ background: c.value ?? undefined }} />)}</span>}
      <label className="btn btn-sm btn-ghost brand-lib-drop" aria-label="Add a logo, font, guide or picture" title="A logo, font, guide or picture">
        <Icon name="plus" size={14} /> {busy ? "Checking…" : "Add"}
        <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,application/pdf,.ttf,.otf" hidden disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      </label>
      </div>
      {files.length > 0 && (open ? fileList(files, 60) : <Reveal label="See your files">{fileList(files, 12)}</Reveal>)}
      {open && !lib.loading && files.length === 0 && <p className="brand-lib-empty">Add your logo and the team puts it on every poster.</p>}
      {said && <p className="brand-lib-said" role="status">{said}</p>}
    </section>
  );
}

function fileList(files: BrandAssetDto[], max: number) {
  return (
    <ul className="brand-lib-files">
      {files.slice(0, max).map((a) => (
        <li key={a.id}>
          {a.url && a.mime?.startsWith("image/") ? <img src={a.url} alt={a.name} loading="lazy" /> : <span className="brand-lib-icon"><Icon name="pen" size={18} /></span>}
          <span><b>{KIND[a.kind] ?? a.kind}</b>{a.family ? ` · ${a.family}` : ""}{a.needsBetter ? " · a better file would help" : ""}</span>
        </li>
      ))}
    </ul>
  );
}

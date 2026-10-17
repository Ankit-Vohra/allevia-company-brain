// The chat's photo attach: a paperclip in the message box. It opens a small popover to add a photo (JPEG, PNG or WebP, location
// removed on the server) and the one Studio setting, "Blur people's faces". The photo then waits above the box as a small chip
// until the owner sends it with what they want ("make this a premium ad", "a Diwali post"); Chat sends both together and Miss
// Influencer makes it into a post as a turn in the conversation (runStore.start with a photo, POST /api/:t/chat/photo).
import { useEffect, useRef, useState } from "react";
import { api, getMode, getPublicMode } from "../../api";
import { photoProblem, PHOTO_TYPES } from "../../lib/library";
import { Icon } from "../Icon";
import "./photo.css";

export function PhotoAttach({ tenantId, onPhoto, disabled }: { tenantId: string; onPhoto: (f: File) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [blur, setBlur] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const live = getMode() === "live" && !getPublicMode();

  useEffect(() => {
    if (!open) return;
    let on = true;
    api.studioSettings(tenantId).then((s) => { if (on) setBlur(s.blurFaces); }).catch(() => { if (on) setBlur(null); });
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { on = false; document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, tenantId]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    const why = photoProblem(f);
    setProblem(why);
    if (why) return;
    onPhoto(f);
    setOpen(false);
  };
  const toggleBlur = async (on: boolean) => {
    setSaving(true);
    try { setBlur((await api.studioSetSettings(tenantId, { blurFaces: on })).blurFaces); } catch (e) { setProblem((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="ph-attach" ref={box}>
      <button
        type="button" className="btn btn-quiet btn-icon ph-attach-btn" aria-label="Attach a photo" aria-haspopup="dialog" aria-expanded={open}
        disabled={disabled} title={live ? "Attach a photo" : "Works in the live app"} onClick={() => { setProblem(null); setOpen((o) => !o); }}
      >
        <Icon name="attach" size={18} />
      </button>
      {open && (
        <div className="ph-pop" role="dialog" aria-label="Attach a photo">
          <button type="button" className="ph-pop-add" disabled={!live} onClick={() => input.current?.click()}>
            <Icon name="image" size={18} />
            <span><b>Add a photo</b><small>{live ? "JPEG, PNG or WebP · location removed" : "Works in the live app"}</small></span>
          </button>
          <label className="ph-pop-toggle">
            <input type="checkbox" checked={!!blur} disabled={blur === null || saving || !live} onChange={(e) => void toggleBlur(e.target.checked)} />
            <span>Blur people's faces</span>
          </label>
          {problem && <p className="ph-pop-problem" role="alert">{problem}</p>}
        </div>
      )}
      <input ref={input} type="file" accept={PHOTO_TYPES.join(",")} hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}

/** The attached photo, waiting above the message box: a small picture and a way to take it off. */
export function PhotoChip({ photo, onRemove }: { photo: File; onRemove: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(photo);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  return (
    <div className="ph-chip">
      {src && <img src={src} alt="The photo you attached" />}
      <span className="ph-chip-name">{photo.name || "Your photo"}</span>
      <button type="button" className="btn btn-quiet btn-icon btn-sm" aria-label="Remove the photo" onClick={onRemove}><Icon name="close" size={14} /></button>
    </div>
  );
}

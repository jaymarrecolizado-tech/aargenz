// Local galleries for reusable header/footer images (Phase 7.5): uploads are
// remembered so they can be re-picked instead of re-uploaded every report.

export const HEADER_GALLERY_KEY = "aar-header-gallery";
export const FOOTER_GALLERY_KEY = "aar-footer-gallery";

export const loadGallery = (key) => {
  try {
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(list)) return list.filter(x => typeof x === "string");
  } catch { /* ignore corrupted storage */ }
  return [];
};

// Adds a data URL to the front of the gallery (deduped, capped) and returns
// the updated list. Data URLs are big; keep only a few presets.
export const addToGallery = (key, dataUrl, max = 3) => {
  const list = [dataUrl, ...loadGallery(key).filter(x => x !== dataUrl)].slice(0, max);
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage full — keep in-memory */ }
  return list;
};

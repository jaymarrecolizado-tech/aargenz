// Photo collage layouts shared by the report preview and the PDF/RTF exports.
// A report holds at most MAX_PHOTOS documentation photos.

export const MAX_PHOTOS = 10;

export const COLLAGE_LAYOUTS = [
  { id: "classic", label: "Classic (2 columns)" },
  { id: "highlight", label: "Highlight (large lead photo)" },
  { id: "compact", label: "Compact (3 columns)" },
  { id: "mosaic", label: "Mosaic (mixed sizes)" }
];

// Container style for a given layout (used inline in both React and the
// generated PDF markup).
export const collageGridStyle = (layout) => ({
  display: "grid",
  gridTemplateColumns: layout === "compact" ? "repeat(3, 1fr)" : "repeat(2, 1fr)",
  gap: "1mm",
  border: "1.5px solid #0000cc",
  padding: "1mm"
});

// Per-slot style. `index` is the photo's position; layouts may promote
// certain positions to span the full width.
export const collageSlotStyle = (layout, index) => {
  switch (layout) {
    case "highlight":
      return index === 0
        ? { height: "85mm", gridColumn: "1 / -1" }
        : { height: "52mm" };
    case "compact":
      return { height: "36mm" };
    case "mosaic":
      return index % 4 === 0
        ? { height: "75mm", gridColumn: "1 / -1" }
        : { height: "48mm" };
    case "classic":
    default:
      return { height: "55mm" };
  }
};

export const loadSavedLayout = () => {
  try {
    const saved = localStorage.getItem("aar-photo-layout");
    if (saved && COLLAGE_LAYOUTS.some(l => l.id === saved)) return saved;
  } catch { /* ignore */ }
  return "classic";
};

export const saveLayout = (layout) => {
  try { localStorage.setItem("aar-photo-layout", layout); } catch { /* ignore */ }
};

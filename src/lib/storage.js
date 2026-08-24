// localStorage persistence for the AAR app.

export const loadSavedState = () => {
  try {
    const saved = JSON.parse(localStorage.getItem("aar-state") || "null");
    if (saved && typeof saved === "object") return saved;
  } catch { /* ignore corrupted storage */ }
  return null;
};

export const saveState = (state) => {
  try { localStorage.setItem("aar-state", JSON.stringify(state)); } catch { /* storage full – ignore */ }
};

export const clearState = () => {
  try { localStorage.removeItem("aar-state"); } catch { /* ignore */ }
};

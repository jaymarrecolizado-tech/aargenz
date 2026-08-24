// Client-side image compression for photo uploads (keeps report sizes small).

export const compressImage = (file, maxDim = 1280, quality = 0.85) => new Promise((resolve) => {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(reader.result);
    img.src = reader.result;
  };
  reader.onerror = () => resolve(null);
  reader.readAsDataURL(file);
});

// Prepares a header/footer logo for upload: downscaled like photos but kept
// as PNG so transparency survives. SVGs pass through untouched.
export const prepareLogoImage = (file, maxDim = 1600) => new Promise((resolve) => {
  if (/^image\/svg/i.test(file.type)) {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(typeof reader.result === "string" ? reader.result : null);
    img.src = reader.result;
  };
  reader.onerror = () => resolve(null);
  reader.readAsDataURL(file);
});

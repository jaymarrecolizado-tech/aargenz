import React, { useState, useRef, useEffect } from "react";
import ChatPanel from "./components/ChatPanel.jsx";
import ReportPreview from "./components/ReportPreview.jsx";
import ProviderPicker from "./components/ProviderPicker.jsx";
import TemplatePicker from "./components/TemplatePicker.jsx";
import LoginPanel from "./components/LoginPanel.jsx";
import MyReports from "./components/MyReports.jsx";
import AdminPanel from "./components/AdminPanel.jsx";
import ChangePassword from "./components/ChangePassword.jsx";
import { printReport, exportRtf } from "./components/PdfRenderer.jsx";
import { extractJson, normalizeReport, validateReportSchema, validateRawLlmJson, extractProgress, isCompleteProgress, mergeProgress } from "./lib/report.js";
import { streamChat, loadAiOverrides, AI_DEFAULTS } from "./lib/aiClient.js";
import { loadSavedState, saveState, clearState } from "./lib/storage.js";
import { compressImage } from "./lib/images.js";
import { MAX_PHOTOS, loadSavedLayout, saveLayout } from "./lib/collage.js";
import { loadGallery, addToGallery, HEADER_GALLERY_KEY, FOOTER_GALLERY_KEY } from "./lib/presets.js";
import { api } from "./lib/api.js";
import {
  fetchTemplates, getTemplate, getBuiltinTemplate,
  buildSystemPrompt, loadSavedTemplateId, saveTemplateId
} from "./lib/templates.js";

// Per-project header/footer overrides (user's own picks), persisted in the
// browser. Keyed by template id so each project keeps its own header/footer:
//   { [templateId]: { header?: string, footer?: string } }
// A string is a data-URL (or "" for explicitly no image); a missing key means
// "use the admin-set project default".
const BRANDING_KEY = "aar-branding-overrides";

const loadBrandingOverrides = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(BRANDING_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
};

// value: data-URL string, "" (explicit blank), or null (remove → use project default)
const saveBrandingOverride = (templateId, kind, value) => {
  const all = loadBrandingOverrides();
  const cur = { ...(all[templateId] || {}) };
  if (value === null) delete cur[kind];
  else cur[kind] = value;
  if (Object.keys(cur).length) all[templateId] = cur;
  else delete all[templateId];
  try { localStorage.setItem(BRANDING_KEY, JSON.stringify(all)); } catch { /* storage full */ }
};

const SAVED_STATE = loadSavedState();

// Immutably sets a value at a dotted path, cloning objects and arrays along
// the way. Example: setDeep(report, ["facilitators", "0", "name"], "Ana").
const setDeep = (root, keys, value) => {
  const [k, ...rest] = keys;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(k)] = rest.length ? setDeep(root[Number(k)] ?? {}, rest, value) : value;
    return copy;
  }
  return { ...root, [k]: rest.length ? setDeep(root?.[k] ?? {}, rest, value) : value };
};

// Hides the model's ```json progress blocks (Phase 7.3) from chat display.
const stripFences = (t) => String(t || "").replace(/```(?:json)?[\s\S]*?```/gi, "").trim();

// Id of the template's server-issued control-number field, or null when the
// template doesn't use automatic numbering (plan 3.2).
const controlNoFieldId = (tpl) =>
  (tpl?.fields || []).find(f => f && f.auto === "controlNumber")?.id || null;

// True when a stored field value carries any real content (recurses into
// arrays/objects so blank scaffolding like {name:"",position:""} is empty).
const hasContent = (v) => {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.some(hasContent);
  if (typeof v === "object") return Object.values(v).some(hasContent);
  return String(v).trim() !== "";
};

export default function App() {
  const [tab, setTab] = useState("chat");
  // undefined = still checking the session; null = logged out; object = user.
  const [user, setUser] = useState(undefined);
  const [reportId, setReportId] = useState(null); // server-side draft id
  const [syncState, setSyncState] = useState("idle"); // idle | saving | saved | error
  const [templates, setTemplates] = useState(null);
  const [templateId, setTemplateId] = useState(SAVED_STATE?.templateId || loadSavedTemplateId() || "aar-elgu");
  // Active template: server registry once loaded, bundled default before that.
  const template = getTemplate(templates || [getBuiltinTemplate("aar-elgu")], templateId);
  const initialMessage = template.initialMessage || { role: "assistant", content: "Hello! Let's start — what is the **title of the activity**?" };
  const [messages, setMessages] = useState(SAVED_STATE?.messages?.length ? SAVED_STATE.messages : [initialMessage]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState(null);
  const [reportData, setReportData] = useState(SAVED_STATE?.reportData ? normalizeReport(SAVED_STATE.reportData, template) : null);
  const [photos, setPhotos] = useState([]);
  const [photoLayout, setPhotoLayout] = useState(SAVED_STATE?.photoLayout || loadSavedLayout());
  const [headerImgData, setHeaderImgData] = useState("");
  const [footerImgData, setFooterImgData] = useState("");
  const [aiOverrides, setAiOverrides] = useState(loadAiOverrides());
  // Phase 7.4: artifact-style live preview next to the chat.
  const [splitView, setSplitView] = useState(() => {
    try { return localStorage.getItem("aar-split-view") !== "off"; } catch { return true; }
  });
  // Phase 6: light/dark theme (persisted per browser). The report preview is
  // deliberately left as white "paper" in both themes — it mirrors the print.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("aar-theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
  });
  const toggleTheme = () => setTheme(prev => {
    const next = prev === "dark" ? "light" : "dark";
    try { localStorage.setItem("aar-theme", next); } catch { /* ignore */ }
    return next;
  });
  // Phase 6 bulk generation: how many reports were completed this session —
  // shown next to the New Report button so encoders can chain activities.
  const [sessionDone, setSessionDone] = useState(0);
  // P0: self-service password change modal.
  const [showPassword, setShowPassword] = useState(false);
  const [headerGallery, setHeaderGallery] = useState(() => loadGallery(HEADER_GALLERY_KEY));
  const [footerGallery, setFooterGallery] = useState(() => loadGallery(FOOTER_GALLERY_KEY));
  const fileRef = useRef(null);
  const headerRef = useRef(null);
  const footerRef = useRef(null);
  // Top-level field ids the user filled by hand in the preview (not via chat).
  // Drives two behaviors: the system prompt's ALREADY PROVIDED list keeps the
  // assistant from re-asking, and completion merges keep hand edits from being
  // wiped when the model emits its final report JSON.
  const manualEditsRef = useRef(new Set());
  // True when the photo set changed locally and hasn't been pushed to the
  // server yet (plan 2.6 keeps photos out of the normal autosave payload).
  const photosDirtyRef = useRef(false);
  const markManualEdit = (path) => { manualEditsRef.current.add(String(path).split(".")[0]); };
  const resetManualEdits = () => { manualEditsRef.current = new Set(); };

  // Chat system prompt, rebuilt whenever the report changes so the assistant
  // always sees what is already filled in the live preview.
  const systemPrompt = buildSystemPrompt(template, reportData);

  // Applies a template's branding (Phase 8.4): the admin-set project default
  // (headerLogo/footerLogo) unless the user picked their own header/footer for
  // this project (persisted override), which then wins.
  const applyBranding = (tpl) => {
    const ov = ((tpl && loadBrandingOverrides()[tpl.id]) || {});
    setHeaderImgData(ov.header !== undefined ? ov.header : (tpl?.headerLogo || ""));
    setFooterImgData(ov.footer !== undefined ? ov.footer : (tpl?.footerLogo || ""));
  };

  // Load the server-side template registry on mount.
  useEffect(() => {
    fetchTemplates().then(list => {
      setTemplates(list);
      if (!list.some(t => t.id === templateId)) setTemplateId(getTemplate(list).id);
      applyBranding(getTemplate(list, templateId));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve the logged-in user from the session cookie on mount.
  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  // Persist the conversation and report locally so a refresh doesn't lose work.
  useEffect(() => {
    saveState({ messages, reportData, templateId, photoLayout });
  }, [messages, reportData, templateId, photoLayout]);

  // A short human-readable title for the saved draft.
  const draftTitle = () => (
    reportData?.titleOfActivity ||
    reportData?.activityTitle ||
    reportData?.title ||
    messages.find(m => m.role === "user")?.content?.slice(0, 80) ||
    "Untitled report"
  );

  // ---- Autosave retry (plan 2.8) ------------------------------------------
  // A failed save used to be dropped after setting "Offline" in the header. On
  // flaky office Wi-Fi that meant a user could close the tab believing their
  // work was safe. Failures are now queued and retried with backoff, an
  // immediate retry happens when the browser comes back online, and the tab
  // warns before closing while anything is unsaved.
  const pendingSaveRef = useRef(null);   // { reportId, payload }
  const pendingPhotosRef = useRef(null); // { reportId, photos } — synced separately (2.6)
  const retryTimerRef = useRef(null);
  const retryDelayRef = useRef(0);

  const hasPendingSave = () => !!(pendingSaveRef.current || pendingPhotosRef.current);

  // Only claim "saved" once *both* queues are empty. The report and its photos
  // sync over separate requests, so a successful report save must not clear the
  // indicator while a photo upload is still outstanding or has failed.
  const settleSyncState = () => {
    if (hasPendingSave()) return;
    retryDelayRef.current = 0;
    setSyncState("saved");
  };

  const scheduleRetry = () => {
    retryDelayRef.current = Math.min(retryDelayRef.current ? retryDelayRef.current * 2 : 2000, 60000);
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(flushPendingSave, retryDelayRef.current);
  };

  async function flushPendingSave() {
    const pending = pendingSaveRef.current;
    const pendingPhotos = pendingPhotosRef.current;
    if ((!pending && !pendingPhotos) || !user) return;
    try {
      setSyncState("saving");
      if (pending) {
        if (pending.reportId) {
          await api.updateReport(pending.reportId, pending.payload);
        } else {
          const created = await api.createReport(pending.payload);
          if (created?.id) setReportId(created.id);
        }
        pendingSaveRef.current = null;
      }
      if (pendingPhotos) {
        await api.savePhotos(pendingPhotos.reportId, pendingPhotos.photos);
        pendingPhotosRef.current = null;
      }
      settleSyncState();
    } catch (e) {
      console.error("Draft sync retry failed:", e);
      setSyncState("error");
      scheduleRetry();
    }
  }

  useEffect(() => {
    const onOnline = () => {
      if (!hasPendingSave()) return;
      retryDelayRef.current = 0;
      clearTimeout(retryTimerRef.current);
      flushPendingSave();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => () => clearTimeout(retryTimerRef.current), []);

  // Warn before closing the tab while a save is in flight or has failed.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (syncState === "saving" || syncState === "error" || hasPendingSave()) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [syncState]);

  // Server-side autosave (Phase 3.3): debounced create/update of a draft
  // holding the conversation and report data. Photos are deliberately NOT in
  // this payload any more (plan 2.6) — they sync separately below, so a 2 MB
  // photo set no longer rides along with every save.
  useEffect(() => {
    if (!user) return;
    const hasContent = messages.length > 1 || !!reportData;
    if (!hasContent) return;
    const t = setTimeout(async () => {
      setSyncState("saving");
      const payload = {
        templateId: template.id,
        title: draftTitle(),
        status: reportData ? "final" : "draft",
        conversation: messages,
        report: reportData
      };
      try {
        if (reportId) {
          await api.updateReport(reportId, payload);
        } else {
          const created = await api.createReport(payload);
          if (created?.id) {
            setReportId(created.id);
            // The control number is issued by the server (plan 3.2) so two
            // encoders can never collide on one. Surface it in the preview
            // straight away instead of waiting for a reload.
            const cnId = controlNoFieldId(template);
            if (created.controlNo && cnId) {
              setReportData(prev => (prev ? { ...prev, [cnId]: created.controlNo } : prev));
            }
          }
        }
        pendingSaveRef.current = null;
        clearTimeout(retryTimerRef.current);
        settleSyncState();
      } catch (e) {
        console.error("Draft sync failed:", e);
        // Queue the payload instead of dropping the work, and retry with backoff.
        pendingSaveRef.current = { reportId, payload };
        setSyncState("error");
        scheduleRetry();
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, messages, reportData, reportId, template.id]);

  // Photo sync (plan 2.6): only fires when the photo set actually changed, and
  // only once the report row exists to attach them to. A failure used to be
  // logged and forgotten, so the user could close the tab believing their
  // photos were safe; it now queues and retries like the report save.
  useEffect(() => {
    if (!user || !reportId || !photosDirtyRef.current) return;
    const t = setTimeout(async () => {
      try {
        await api.savePhotos(reportId, photos);
        photosDirtyRef.current = false;
        pendingPhotosRef.current = null;
        settleSyncState();
      } catch (e) {
        console.error("Photo sync failed:", e);
        pendingPhotosRef.current = { reportId, photos };
        setSyncState("error");
        scheduleRetry();
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, reportId, photos]);

  const handleOpenSaved = (full) => {
    const tpl = getTemplate(templates || [getBuiltinTemplate("aar-elgu")], full.template_id);
    saveTemplateId(tpl.id);
    setTemplateId(tpl.id);
    applyBranding(tpl);
    resetManualEdits();
    setMessages(full.conversation?.length ? full.conversation : [tpl.initialMessage || initialMessage]);
    setReportData(full.report ? normalizeReport(full.report, tpl) : null);
    setReportId(full.id);
    setTab(full.report ? "preview" : "chat");
    // Photos come from their own endpoint (plan 2.6) so opening a report no
    // longer drags megabytes through the report payload. Clearing the dirty
    // flag first stops the sync effect from echoing them straight back.
    photosDirtyRef.current = false;
    setPhotos([]);
    api.getPhotos(full.id)
      .then(res => setPhotos(
        (res?.photos || []).map(p => (typeof p === "string" ? p : p.dataUrl)).filter(Boolean)
      ))
      .catch(() => { /* report still opens without its photos */ });
  };

  const handleLogout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    clearState();
    setUser(null);
    resetManualEdits();
    setMessages([initialMessage]);
    setReportData(null);
    setPhotos([]);
    photosDirtyRef.current = false; // don't push stale photos to the next report
    setReportId(null);
    setTab("chat");
  };

  const handleSelectTemplate = (id) => {
    if (id === templateId) return;
    saveTemplateId(id);
    setTemplateId(id);
    // Start a fresh conversation (and a fresh server draft) when switching projects.
    const next = getTemplate(templates || [getBuiltinTemplate("aar-elgu")], id);
    applyBranding(next);
    clearState();
    resetManualEdits();
    setMessages([next.initialMessage || initialMessage]);
    setReportData(null);
    setPhotos([]);
    photosDirtyRef.current = false; // don't push stale photos to the next report
    setReportId(null);
    setSyncState("idle");
    setTab("chat");
  };

  // Phase 6 bulk generation: a finished report is already autosaved server-side,
  // so starting the next activity only needs a reassuring confirm instead of a
  // scary "this clears everything" one.
  const handleReset = () => {
    const finished = !!reportData && syncState === "saved";
    const msg = finished
      ? `Start activity #${sessionDone + 1}? ✓ "${draftTitle()}" is saved in My Reports.`
      : "Start a new report? This clears the current conversation and report.";
    if (!window.confirm(msg)) return;
    applyBranding(template);
    clearState();
    resetManualEdits();
    setMessages([initialMessage]);
    setReportData(null);
    setPhotos([]);
    photosDirtyRef.current = false; // don't push stale photos to the next report
    setReportId(null);
    setSyncState("idle");
    setTab("chat");
  };

  const updateAiOverrides = (patch) => {
    setAiOverrides(prev => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem("aar-ai-config", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const handleHeaderUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => {
        const src = ev.target.result || "";
        setHeaderImgData(src);
        saveBrandingOverride(template.id, "header", src);
        if (src) setHeaderGallery(addToGallery(HEADER_GALLERY_KEY, src));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFooterUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => {
        const src = ev.target.result || "";
        setFooterImgData(src);
        saveBrandingOverride(template.id, "footer", src);
        if (src) setFooterGallery(addToGallery(FOOTER_GALLERY_KEY, src));
      };
      reader.readAsDataURL(file);
    }
  };

  // User picks a header/footer from the gallery dropdown. "__default" restores
  // the admin-set project image; "__none" explicitly blanks the area.
  const pickHeaderFromGallery = (value) => {
    if (value === "__default") resetHeaderToProject();
    else if (value === "__none") { saveBrandingOverride(template.id, "header", ""); setHeaderImgData(""); }
    else if (value) { saveBrandingOverride(template.id, "header", value); setHeaderImgData(value); }
  };
  const pickFooterFromGallery = (value) => {
    if (value === "__default") resetFooterToProject();
    else if (value === "__none") { saveBrandingOverride(template.id, "footer", ""); setFooterImgData(""); }
    else if (value) { saveBrandingOverride(template.id, "footer", value); setFooterImgData(value); }
  };

  // Reverts a user override so the admin-set project logo is used again.
  const resetHeaderToProject = () => { saveBrandingOverride(template.id, "header", null); applyBranding(template); };
  const resetFooterToProject = () => { saveBrandingOverride(template.id, "footer", null); applyBranding(template); };

  // True when the currently shown image is the user's own pick, not the
  // admin-set project default (so we can show a "↺ reset" control).
  const headerIsCustom = headerImgData && headerImgData !== (template?.headerLogo || "");
  const footerIsCustom = footerImgData && footerImgData !== (template?.footerLogo || "");

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setStreamingText("");

    try {
      const text = await streamChat([
        { role: "system", content: systemPrompt },
        ...newMessages.map(m => ({ role: m.role, content: m.content }))
      ], (partial) => setStreamingText(stripFences(partial)), { ...aiOverrides, templateId: template.id });

      // Phase 7.3: every reply carries a cumulative progress JSON block.
      // Complete block → final report (validated); partial → live preview only.
      const progress = extractProgress(text) || extractJson(text);
      const complete = isCompleteProgress(progress, template);

      if (complete) {
        // Phase 5.1: validate the RAW model JSON first (before normalizeReport
        // can repair it), then a structural backstop on the normalized data.
        const rawErrors = validateRawLlmJson(progress, template);
        if (!rawErrors.length) {
          const normalized = normalizeReport(progress, template);
          const errors = validateReportSchema(normalized, template);
          if (!errors.length) {
            // The model's JSON never contains preview-only/manual fields, and
            // hand edits in the preview may be newer than the chat transcript —
            // so re-apply manual-field values plus anything the user edited by
            // hand before storing the final data.
            setReportData(prev => {
              const preserved = {};
              for (const f of template.fields || []) {
                if (f.manual && hasContent(prev?.[f.id])) preserved[f.id] = prev[f.id];
              }
              for (const id of manualEditsRef.current) {
                if (hasContent(prev?.[id])) preserved[id] = prev[id];
              }
              return Object.keys(preserved).length
                ? normalizeReport(mergeProgress(normalized, preserved), template)
                : normalized;
            });
            setMessages(prev => [...prev, {
              role: "assistant",
              content: stripFences(text) + "\n\n✅ **Report data collected!** Click the **Preview Report** tab to see your formatted AAR. Don't forget to upload photos!"
            }]);
            setSessionDone(n => n + 1);
            setTab("preview");
            setLoading(false);
            setStreamingText(null);
            return;
          }
          warnInChat(errors);
          setLoading(false);
          setStreamingText(null);
          return;
        }
        warnInChat(rawErrors);
        setLoading(false);
        setStreamingText(null);
        return;
      }

      if (progress && Object.keys(progress).length) {
        // Partial data — update the live preview, keep chatting.
        setReportData(prev => normalizeReport(mergeProgress(prev || {}, progress), template));
      }
      const shown = stripFences(text);
      setMessages(prev => [...prev, { role: "assistant", content: shown || "No response" }]);
    } catch (e) {
      console.error("API Error:", e);
      setMessages(prev => [...prev, { role: "assistant", content: "❌ Error: " + e.message }]);
    }
    setLoading(false);
    setStreamingText(null);
  };

  // Surfaces validation problems as an assistant chat message (Phase 5.1).
  const warnInChat = (errors) => {
    setMessages(prev => [...prev, {
      role: "assistant",
      content:
        "⚠️ I collected your answers but the generated report data failed validation:\n\n" +
        errors.map(e => `- ${e}`).join("\n") +
        "\n\nPlease review your answers above and tell me what to fix."
    }]);
  };

  const handlePhotos = async (e) => {
    const files = Array.from(e.target.files);
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      window.alert(`A report can hold at most ${MAX_PHOTOS} photos.`);
      e.target.value = "";
      return;
    }
    if (files.length > room) {
      window.alert(`Only ${room} more photo${room === 1 ? "" : "s"} allowed (max ${MAX_PHOTOS}). The extra ${files.length - room} will be skipped.`);
    }
    let added = 0;
    for (const f of files.slice(0, room)) {
      const dataUrl = await compressImage(f);
      if (dataUrl) {
        added++;
        setPhotos(prev => (prev.length < MAX_PHOTOS ? [...prev, dataUrl] : prev));
      }
    }
    if (added) photosDirtyRef.current = true; // triggers the separate photo sync
  };

  const changePhotoLayout = (layout) => {
    saveLayout(layout);
    setPhotoLayout(layout);
  };

  // Exports the current report as a sharegpt-format training example
  // (system prompt + conversation + final JSON), ready for fine-tuning.
  const handleDownloadDataset = () => {
    if (!reportData) return;
    const msgs = [
      { role: "system", content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];
    // Replace the trailing "report collected" note with the model's JSON.
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && /Report data collected/.test(last.content)) msgs.pop();
    msgs.push({ role: "assistant", content: JSON.stringify(reportData) });

    const blob = new Blob([JSON.stringify({ messages: msgs }) + "\n"], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aar-dataset-${Date.now()}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const updateReportData = (field, value) => {
    // Supports dotted paths into nested objects and arrays, e.g.
    // "preparedBy.name", "facilitators.0.office", "beneficiaries.ngas.male".
    markManualEdit(field);
    setReportData(prev => setDeep(prev ?? {}, field.split("."), value));
  };

  const addFacilitator = () => {
    markManualEdit("facilitators");
    setReportData(prev => ({
      ...(prev || {}),
      facilitators: [...(prev?.facilitators || []), { name: "", office: "", gender: "" }]
    }));
  };

  const removeFacilitator = (index) => {
    markManualEdit("facilitators");
    setReportData(prev => ({
      ...(prev || {}),
      facilitators: (prev?.facilitators || []).filter((_, i) => i !== index)
    }));
  };

  const removePhoto = (index) => {
    photosDirtyRef.current = true;
    setPhotos(prev => prev.filter((_, i) => i !== index));
  };

  if (user === undefined) {
    return (
      <div style={{minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'Segoe UI', system-ui, sans-serif", color:"#666"}}>
        Checking session…
      </div>
    );
  }
  if (!user) {
    return <LoginPanel onAuth={(u) => { setUser(u); setTab("chat"); }}/>;
  }

  return (
    <div
      className="app-shell"
      data-theme={theme}
      style={{
      minHeight:"100vh",
      display:"flex", flexDirection:"column", position:"relative"
    }}>
      <div className="hdr">
        <div>
          <div className="brand-name"><span className="hl">DICT</span> <span className="hl2">R2</span>&nbsp;AAR Generator</div>
          <div className="brand-sub">AI-Powered Accomplishment Activity Report</div>
        </div>
        <div className="header-actions" style={{marginLeft:"auto", display:"flex", gap:"6px", alignItems:"center", flexWrap:"wrap"}}>
          {[["chat","Chat"],["preview","Preview"],["reports","My Reports"], ...(user.role === "admin" ? [["admin","Admin"]] : [])].map(([t,label]) => (
            <button key={t} onClick={() => setTab(t)} className={"tab" + (tab===t ? " active" : "")}>
              {label}
            </button>
          ))}
          <span className="hdr-sep" />
          <button onClick={handleReset} title="Finish this activity and start the next one (bulk generation)" className={"hbtn" + (sessionDone > 0 ? " go" : "")}>
            {sessionDone > 0 ? `Next Activity (${sessionDone} done)` : "New Report"}
          </button>
          {sessionDone > 0 && (
            <span className="chip" title="Reports completed in this browser session (all autosaved)">
              {sessionDone} done
            </span>
          )}
          <button onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="hbtn">
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button onClick={() => { const next = !splitView; setSplitView(next); try { localStorage.setItem("aar-split-view", next ? "on" : "off"); } catch { /* ignore */ } }} title="Show live preview while chatting" className={"hbtn" + (splitView ? " on" : "")}>
            Split View
          </button>
          {reportData && tab==="preview" && (
            <>
              <button onClick={() => fileRef.current?.click()} className="hbtn">
                Upload Photos
              </button>
              <button onClick={() => { api.auditEvent("export.pdf"); printReport({ data: reportData, photos, headerImgData, footerImgData, template, photoLayout }); }} className="hbtn primary">
                Export PDF
              </button>
              <button onClick={() => { api.auditEvent("export.rtf"); exportRtf(reportData, photos, template); }} className="hbtn">
                Export RTF
              </button>
              <button onClick={handleDownloadDataset} className="hbtn" title="Download this report as a fine-tuning example (sharegpt JSONL)">
                Dataset
              </button>
            </>
          )}
          <TemplatePicker templates={templates} templateId={template.id} onChange={handleSelectTemplate}/>
          {user?.role === "admin" && <ProviderPicker aiOverrides={aiOverrides} defaults={AI_DEFAULTS} onChange={updateAiOverrides}/>}
          <span className="hdr-sep" />
          <button onClick={() => headerRef.current?.click()} className={"hbtn small" + (headerImgData ? " ok" : "")} title="Upload your own header for this project">
            {headerImgData ? "Header ✓" : "Header"}
          </button>
          {headerIsCustom && (
            <button onClick={resetHeaderToProject} title="Reset to this project's default header (set by admin)" className="hbtn small">↺</button>
          )}
          <select title="Header options" value="" onChange={e => { if (e.target.value) pickHeaderFromGallery(e.target.value); }} className="hselect">
            <option value="">Header ▾</option>
            <option value="__default">Project header (admin)</option>
            <option value="__none">No header</option>
            {headerGallery.map((src, i) => <option key={i} value={src}>{`Preset ${i + 1}`}</option>)}
          </select>
          <button onClick={() => footerRef.current?.click()} className={"hbtn small" + (footerImgData ? " ok" : "")} title="Pick your own footer for this project">
            {footerImgData ? "Footer ✓" : "Footer"}
          </button>
          {footerIsCustom && (
            <button onClick={resetFooterToProject} title="Reset to this project's default footer (set by admin)" className="hbtn small">↺</button>
          )}
          <select
            title="Footer — project default or your own"
            value=""
            onChange={e => { if (e.target.value) pickFooterFromGallery(e.target.value); }}
            className="hselect"
          >
            <option value="">Footer ▾</option>
            <option value="__default">Project footer (admin)</option>
            <option value="__none">No footer</option>
            {footerGallery.map((src, i) => <option key={i} value={src}>{`Preset ${i + 1}`}</option>)}
          </select>
          <span className="hdr-sep" />
          <span title={syncState === "error" ? "Could not reach the server — your work is still saved in this browser" : "Draft sync status"} style={{
            fontSize:"11px", color: syncState === "error" ? "#ff9e9e" : "rgba(255,255,255,0.55)", minWidth:"52px"
          }}>
            {syncState === "saving" ? "Saving…" : syncState === "saved" ? "Saved" : syncState === "error" ? "Offline" : ""}
          </span>
          <span className="chip">
            {user.username} <span style={{opacity:0.6}}>({user.role})</span>
          </span>
          <button onClick={() => setShowPassword(true)} className="hbtn small" title="Change your own password">
            Password
          </button>
          <button onClick={handleLogout} className="hbtn small">
            Sign out
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" multiple accept="image/*" style={{display:"none"}} onChange={handlePhotos}/>
      <input ref={headerRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleHeaderUpload}/>
      <input ref={footerRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleFooterUpload}/>

      <div className="page-pad" style={{flex:1, overflow:"auto", padding:"24px", display:"flex", justifyContent:"center"}}>
        {tab === "chat" ? (
          <div className="split-wrap" style={{display:"flex", gap:"16px", width:"100%", maxWidth:"1500px"}}>
            <div className="split-chat" style={{flex: splitView ? "1 1 480px" : "0 0 auto", minWidth:"320px", maxWidth: splitView ? undefined : "680px", width: splitView ? undefined : "100%"}}>
              <ChatPanel
                messages={messages}
                loading={loading}
                streamingText={streamingText}
                input={input}
                setInput={setInput}
                onSend={sendMessage}
              />
            </div>
            {splitView && (
              <div className="split-preview" style={{flex:"1 1 520px", minWidth:"380px", maxHeight:"calc(100vh - 140px)", overflowY:"auto"}}>
                {reportData ? (
                  <div className="paper">
                    <div className="live-banner">
                      LIVE PREVIEW — fills in as you answer
                    </div>
                    <ReportPreview
                      data={reportData}
                      photos={photos}
                      onUpdate={updateReportData}
                      onAddFacilitator={addFacilitator}
                      onRemoveFacilitator={removeFacilitator}
                      onRemovePhoto={removePhoto}
                      headerImg={headerImgData}
                      footerImg={footerImgData}
                      template={template}
                      photoLayout={photoLayout}
                      onLayoutChange={changePhotoLayout}
                    />
                  </div>
                ) : (
                  <div className="placeholder" style={{
                    height:"calc(100vh - 160px)"
                  }}>
                    <div style={{fontWeight:"600", marginBottom:"6px"}}>Live preview</div>
                    <div style={{fontSize:"13px", maxWidth:"280px"}}>
                      As the AI confirms your answers, the report builds up here in real time.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : tab === "reports" ? (
          <MyReports user={user} onOpen={(full) => { handleOpenSaved(full); }}/>
        ) : tab === "admin" ? (
          <AdminPanel templates={templates || [getBuiltinTemplate("aar-elgu")]} onPersonnelSaved={() => fetchTemplates().then(setTemplates)} user={user}/>
        ) : (
          <div style={{width:"100%", maxWidth:"850px"}}>
            {reportData ? (
              <div className="paper">
                <ReportPreview
                  data={reportData}
                  photos={photos}
                  onUpdate={updateReportData}
                  onAddFacilitator={addFacilitator}
                  onRemoveFacilitator={removeFacilitator}
                  onRemovePhoto={removePhoto}
                  headerImg={headerImgData}
                  footerImg={footerImgData}
                  template={template}
                  photoLayout={photoLayout}
                  onLayoutChange={changePhotoLayout}
                />
              </div>
            ) : (
              <div style={{textAlign:"center", padding:"80px 24px", color:"var(--muted)"}}>
                <div style={{fontSize:"20px", fontWeight:"600", color:"var(--text)", marginBottom:"8px"}}>No report yet</div>
                <div>Complete the chat conversation to generate your report.</div>
                <button onClick={() => setTab("chat")} className="btn primary" style={{marginTop:"20px"}}>Go to Chat →</button>
              </div>
            )}
          </div>
        )}
      </div>

      {showPassword && <ChangePassword onClose={() => setShowPassword(false)}/>}

      <style>{`
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #cfd5de; border-radius: 4px; }

        /* ================= Design tokens (premium / minimal) ================ */
        .app-shell {
          --bg: #f5f6f8;
          --surface: #ffffff;
          --border: #e4e7ec;
          --border-strong: #d0d5dd;
          --text: #1a2233;
          --muted: #667085;
          --accent: #0033cc;
          --accent-hover: #002aa6;
          --accent-soft: #eef2ff;
          --header: #111a2e;
          font-family: -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;
          background: var(--bg);
          color: var(--text);
          -webkit-font-smoothing: antialiased;
        }
        .app-shell[data-theme="dark"] {
          --bg: #0d1117;
          --surface: #151b27;
          --border: #29303f;
          --border-strong: #39415a;
          --text: #e6e9f0;
          --muted: #98a2b3;
          --accent: #6b95ff;
          --accent-hover: #8badff;
          --accent-soft: rgba(107,149,255,0.12);
          --header: #0a0e18;
        }
        .app-shell[data-theme="dark"] ::-webkit-scrollbar-thumb { background: #39415a; }

        /* ---- Header ---- */
        .hdr {
          background: var(--header);
          border-bottom: 1px solid rgba(255,255,255,0.07);
          padding: 12px 28px;
          display: flex; align-items: center; gap: 24px;
        }
        .brand-name { color:#fff; font-size:16px; font-weight:700; letter-spacing:-0.2px; white-space:nowrap; }
        .brand-name .hl { color:#8ab4ff; }
        .brand-name .hl2 { color:#ffb35c; }
        .brand-sub { color:rgba(255,255,255,0.5); font-size:11px; margin-top:2px; letter-spacing:0.2px; }
        .hdr-sep { width:1px; height:20px; background:rgba(255,255,255,0.14); margin:0 4px; }

        /* Header buttons — flat outline style, no glass */
        .tab, .hbtn {
          padding: 7px 14px; border-radius: 7px;
          border: 1px solid transparent; background: transparent;
          color: rgba(255,255,255,0.75); font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background .15s, color .15s, border-color .15s;
        }
        .tab:hover, .hbtn:hover { background: rgba(255,255,255,0.08); color:#fff; }
        .tab.active { background:#fff; color:#141a26; }
        .hbtn { border-color: rgba(255,255,255,0.25); }
        .hbtn.on { background:#fff; border-color:#fff; color:#141a26; }
        .hbtn.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
        .hbtn.primary:hover { background:#1d4ed8; }
        .hbtn.go { background:#15803d; border-color:#15803d; color:#fff; }
        .hbtn.go:hover { background:#166534; }
        .hbtn.ok { border-color:#15803d; color:#86efac; }
        .hbtn.small { padding: 5px 10px; font-size: 11px; }
        .hselect {
          font-size: 11px; padding: 6px 8px; border-radius: 7px;
          border: 1px solid rgba(255,255,255,0.25); background: transparent;
          color: #fff; cursor: pointer; outline: none;
        }
        .hselect option { color:#141a26; }
        .chip {
          font-size: 11px; color: rgba(255,255,255,0.85);
          border: 1px solid rgba(255,255,255,0.22);
          padding: 6px 10px; border-radius: 7px; white-space: nowrap;
        }

        /* ---- Surfaces ---- */
        .panel {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 1px 2px rgba(16,24,40,0.05);
        }
        /* The generated report stays white "paper" in both themes */
        .paper { background:#fff; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
        .live-banner {
          background: var(--accent-soft); color: var(--accent);
          font-size: 11px; font-weight: 700; letter-spacing: 0.3px;
          padding: 6px 14px; position: sticky; top: 0; z-index: 2;
          border-bottom: 1px solid var(--border);
        }
        .placeholder {
          border: 1px dashed var(--border-strong); border-radius: 10px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          color: var(--muted); text-align: center; padding: 24px;
        }

        /* ---- Buttons & inputs on surfaces ---- */
        .btn {
          padding: 9px 18px; border-radius: 7px; border: 1px solid transparent;
          cursor: pointer; font-size: 13px; font-weight: 600; transition: background .15s;
        }
        .btn.primary { background: var(--accent); color: #fff; }
        .btn.primary:hover { background: var(--accent-hover); }
        .mini-btn {
          padding: 5px 12px; border-radius: 6px; cursor: pointer;
          border: 1px solid var(--border-strong); background: var(--surface);
          color: var(--text); font-size: 12px; font-weight: 600;
          transition: border-color .15s, color .15s;
        }
        .mini-btn:hover { border-color: var(--accent); color: var(--accent); }
        .mini-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
        .mini-btn.primary:hover { background: var(--accent-hover); color:#fff; }
        .mini-btn.danger { border-color: #f1b3b3; color: #c62a2a; background: var(--surface); }
        .mini-btn.danger:hover { border-color: #c62a2a; }
        .seg {
          padding: 6px 14px; border-radius: 7px; cursor: pointer;
          border: 1px solid var(--border); background: transparent;
          color: var(--muted); font-size: 12px; font-weight: 600;
          transition: all .15s;
        }
        .seg.active { background: var(--accent); border-color: var(--accent); color: #fff; }
        .err-box { background:#fdecea; color:#b71c1c; border-radius:8px; padding:8px 12px; font-size:12px; margin-bottom:12px; }
        [data-theme="dark"] .err-box { background:#3a1a1e; color:#ff9e9e; }
        .ok-box { background:#e8f5e9; color:#1b5e20; border-radius:8px; padding:8px 12px; font-size:12px; margin-bottom:12px; }
        [data-theme="dark"] .ok-box { background:#12301c; color:#86efac; }

        /* ---- Chat ---- */
        .chat-tip {
          background: var(--accent-soft); color: var(--accent);
          border: 1px solid var(--border); border-radius: 8px;
          padding: 10px 14px; margin-bottom: 16px; font-size: 12px;
        }
        .msg-row { display:flex; margin-bottom:12px; justify-content:flex-start; }
        .msg-row.user { justify-content:flex-end; }
        .avatar {
          width:30px; height:30px; border-radius:8px; background:var(--accent);
          display:flex; align-items:center; justify-content:center; color:#fff;
          font-size:10px; font-weight:700; flex-shrink:0; margin-right:8px; margin-top:2px;
        }
        .bubble-ai, .bubble-user {
          max-width:72%; padding:10px 14px; font-size:14px; line-height:1.6;
          word-break:break-word;
        }
        .bubble-ai { background:var(--surface); border:1px solid var(--border); color:var(--text); border-radius:10px; }
        .bubble-user { background:var(--accent); color:#fff; border-radius:10px; }
        [data-theme="dark"] .bubble-user { color:#fff; }
        .typing {
          background:var(--surface); border:1px solid var(--border); border-radius:10px;
          padding:12px 16px; display:flex; gap:4px; align-items:center;
        }
        .typing .dot { width:6px; height:6px; border-radius:50%; background:var(--muted); animation:bounce 1s infinite; }
        .chat-input {
          flex:1; padding:11px 16px; border-radius:8px;
          border:1px solid var(--border-strong); background:var(--surface); color:var(--text);
          outline:none; font-size:14px; transition:border-color .15s;
        }
        .chat-input:focus { border-color:var(--accent); }
        .send-btn {
          padding:11px 22px; border-radius:8px; border:none; cursor:pointer;
          background:var(--accent); color:#fff; font-weight:600; font-size:14px;
        }
        .send-btn:hover:not(:disabled) { background:var(--accent-hover); }
        .send-btn:disabled { opacity:0.5; cursor:default; }

        /* ---- Mobile layout ----------------------------------------------- */
        @media (max-width: 900px) {
          .hdr { flex-wrap:wrap; padding:10px 14px; gap:10px; }
          .header-actions { margin-left:0 !important; width:100%; }
          .page-pad { padding:12px !important; }
          .split-wrap { flex-direction:column !important; }
          .split-chat, .split-preview {
            flex:1 1 auto !important; min-width:0 !important;
            max-width:100% !important; width:100% !important;
          }
          .split-preview { max-height:none !important; }
          .chat-root { height:auto !important; min-height:55vh; max-width:100% !important; }
        }
      `}</style>
    </div>
  );
}

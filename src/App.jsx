import React, { useState, useRef, useEffect } from "react";
import ChatPanel from "./components/ChatPanel.jsx";
import ReportPreview from "./components/ReportPreview.jsx";
import ProviderPicker from "./components/ProviderPicker.jsx";
import TemplatePicker from "./components/TemplatePicker.jsx";
import LoginPanel from "./components/LoginPanel.jsx";
import MyReports from "./components/MyReports.jsx";
import AdminPanel from "./components/AdminPanel.jsx";
import { printReport, exportRtf } from "./components/PdfRenderer.jsx";
import { extractJson, normalizeReport, validateReportSchema, validateRawLlmJson, extractProgress, isCompleteProgress, mergeProgress } from "./lib/report.js";
import { streamChat, loadAiOverrides, AI_DEFAULTS } from "./lib/aiClient.js";
import { loadSavedState, saveState, clearState } from "./lib/storage.js";
import { compressImage } from "./lib/images.js";
import { MAX_PHOTOS, loadSavedLayout, saveLayout } from "./lib/collage.js";
import { loadGallery, addToGallery, HEADER_GALLERY_KEY, FOOTER_GALLERY_KEY } from "./lib/presets.js";
import { HEADER_IMG, FOOTER_IMG } from "./lib/assets.js";
import { api } from "./lib/api.js";
import {
  fetchTemplates, getTemplate, getBuiltinTemplate,
  buildSystemPrompt, loadSavedTemplateId, saveTemplateId
} from "./lib/templates.js";

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
  const systemPrompt = buildSystemPrompt(template);
  const initialMessage = template.initialMessage || { role: "assistant", content: "Hello! Let's start — what is the **title of the activity**?" };
  const [messages, setMessages] = useState(SAVED_STATE?.messages?.length ? SAVED_STATE.messages : [initialMessage]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState(null);
  const [reportData, setReportData] = useState(SAVED_STATE?.reportData ? normalizeReport(SAVED_STATE.reportData, template) : null);
  const [photos, setPhotos] = useState([]);
  const [photoLayout, setPhotoLayout] = useState(SAVED_STATE?.photoLayout || loadSavedLayout());
  const [headerImgData, setHeaderImgData] = useState(HEADER_IMG);
  const [footerImgData, setFooterImgData] = useState(FOOTER_IMG);
  const [aiOverrides, setAiOverrides] = useState(loadAiOverrides());
  // Phase 7.4: artifact-style live preview next to the chat.
  const [splitView, setSplitView] = useState(() => {
    try { return localStorage.getItem("aar-split-view") !== "off"; } catch { return true; }
  });
  const [headerGallery, setHeaderGallery] = useState(() => loadGallery(HEADER_GALLERY_KEY));
  const [footerGallery, setFooterGallery] = useState(() => loadGallery(FOOTER_GALLERY_KEY));
  const fileRef = useRef(null);
  const headerRef = useRef(null);
  const footerRef = useRef(null);

  // Applies a template's default header/footer branding (Phase 8.4). Manual
  // picks in the top bar win until the template changes again.
  const applyBranding = (tpl) => {
    setHeaderImgData(tpl?.headerLogo || HEADER_IMG);
    setFooterImgData(tpl?.footerLogo || FOOTER_IMG);
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

  // Server-side autosave (Phase 3.3): debounced create/update of a draft
  // holding the conversation, report data and photos.
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
        report: reportData,
        photos
      };
      try {
        if (reportId) {
          await api.updateReport(reportId, payload);
        } else {
          const created = await api.createReport(payload);
          if (created?.id) setReportId(created.id);
        }
        setSyncState("saved");
      } catch (e) {
        console.error("Draft sync failed:", e);
        setSyncState("error");
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, messages, reportData, photos, reportId, template.id]);

  const handleOpenSaved = (full) => {
    const tpl = getTemplate(templates || [getBuiltinTemplate("aar-elgu")], full.template_id);
    saveTemplateId(tpl.id);
    setTemplateId(tpl.id);
    applyBranding(tpl);
    setMessages(full.conversation?.length ? full.conversation : [tpl.initialMessage || initialMessage]);
    setReportData(full.report ? normalizeReport(full.report, tpl) : null);
    setPhotos(Array.isArray(full.photos) ? full.photos : []);
    setReportId(full.id);
    setTab(full.report ? "preview" : "chat");
  };

  const handleLogout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    clearState();
    setUser(null);
    setMessages([initialMessage]);
    setReportData(null);
    setPhotos([]);
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
    setMessages([next.initialMessage || initialMessage]);
    setReportData(null);
    setPhotos([]);
    setReportId(null);
    setSyncState("idle");
    setTab("chat");
  };

  const handleReset = () => {
    if (!window.confirm("Start a new report? This clears the current conversation and report.")) return;
    applyBranding(template);
    clearState();
    setMessages([initialMessage]);
    setReportData(null);
    setPhotos([]);
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
        setHeaderImgData(ev.target.result);
        if (ev.target.result) setHeaderGallery(addToGallery(HEADER_GALLERY_KEY, ev.target.result));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFooterUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => {
        setFooterImgData(ev.target.result);
        if (ev.target.result) setFooterGallery(addToGallery(FOOTER_GALLERY_KEY, ev.target.result));
      };
      reader.readAsDataURL(file);
    }
  };

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
            setReportData(normalized);
            setMessages(prev => [...prev, {
              role: "assistant",
              content: stripFences(text) + "\n\n✅ **Report data collected!** Click the **Preview Report** tab to see your formatted AAR. Don't forget to upload photos!"
            }]);
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
    for (const f of files.slice(0, room)) {
      const dataUrl = await compressImage(f);
      if (dataUrl) setPhotos(prev => (prev.length < MAX_PHOTOS ? [...prev, dataUrl] : prev));
    }
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
    setReportData(prev => setDeep(prev ?? {}, field.split("."), value));
  };

  const addFacilitator = () => {
    setReportData(prev => ({
      ...(prev || {}),
      facilitators: [...(prev?.facilitators || []), { name: "", office: "", gender: "" }]
    }));
  };

  const removeFacilitator = (index) => {
    setReportData(prev => ({
      ...(prev || {}),
      facilitators: (prev?.facilitators || []).filter((_, i) => i !== index)
    }));
  };

  const removePhoto = (index) => {
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
    <div style={{
      fontFamily:"'Segoe UI', system-ui, sans-serif",
      minHeight:"100vh",
      background:"linear-gradient(135deg, #f0f4ff 0%, #e8f0fe 50%, #f5f0ff 100%)",
      display:"flex", flexDirection:"column"
    }}>
      <div style={{background:"linear-gradient(135deg,#0011aa,#0033cc)", padding:"14px 24px", display:"flex", alignItems:"center", gap:"16px", boxShadow:"0 2px 16px rgba(0,0,150,0.3)"}}>
        <div>
          <div style={{color:"#fff", fontSize:"18px", fontWeight:"900", letterSpacing:"-0.5px"}}>
            <span style={{color:"#66aaff"}}>e</span>LGU <span style={{color:"#ffaa33"}}>e</span><span style={{color:"#66ff88"}}>GOV</span><span style={{color:"#ff6666", fontSize:"12px"}}>PH</span>
            <span style={{color:"rgba(255,255,255,0.6)", fontSize:"13px", fontWeight:"400", marginLeft:"10px"}}>AAR Generator</span>
          </div>
          <div style={{color:"rgba(255,255,255,0.6)", fontSize:"11px", marginTop:"1px"}}>AI-Powered Accomplishment Activity Report</div>
        </div>
        <div style={{marginLeft:"auto", display:"flex", gap:"8px", alignItems:"center"}}>
          {[["chat","💬 Chat"],["preview","📄 Preview Report"],["reports","🗂️ My Reports"], ...(user.role === "admin" ? [["admin","⚙️ Admin"]] : [])].map(([t,label]) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding:"7px 16px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600",
              background: tab===t ? "#fff" : "rgba(255,255,255,0.15)",
              color: tab===t ? "#0033cc" : "#fff", transition:"all .2s"
            }}>
              {label}
            </button>
          ))}
          <button onClick={handleReset} style={{padding:"7px 16px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600", background:"rgba(255,255,255,0.15)", color:"#fff"}}>
            🔄 New Report
          </button>
          <button onClick={() => { const next = !splitView; setSplitView(next); try { localStorage.setItem("aar-split-view", next ? "on" : "off"); } catch { /* ignore */ } }} title="Show live preview while chatting" style={{
            padding:"7px 16px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600",
            background: splitView ? "#fff" : "rgba(255,255,255,0.15)",
            color: splitView ? "#0033cc" : "#fff"
          }}>
            🪟 Split
          </button>
          {reportData && tab==="preview" && (
            <>
              <button onClick={() => fileRef.current?.click()} style={{padding:"7px 16px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600", background:"rgba(255,255,255,0.15)", color:"#fff"}}>
                📷 Upload Photos
              </button>
              <button onClick={() => printReport({ data: reportData, photos, headerImgData, footerImgData, template, photoLayout })} style={{padding:"7px 16px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600", background:"#ff6600", color:"#fff"}}>
                Export PDF
              </button>
              <button onClick={() => exportRtf(reportData, photos, template)} style={{padding:"7px 16px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600", background:"#7a5af8", color:"#fff"}}>
                📄 Export RTF
              </button>
              <button onClick={handleDownloadDataset} style={{padding:"7px 16px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"12px", fontWeight:"600", background:"rgba(255,255,255,0.15)", color:"#fff"}} title="Download this report as a fine-tuning example (sharegpt JSONL)">
                📥 Dataset
              </button>
            </>
          )}
          <TemplatePicker templates={templates} templateId={template.id} onChange={handleSelectTemplate}/>
          <ProviderPicker aiOverrides={aiOverrides} defaults={AI_DEFAULTS} onChange={updateAiOverrides}/>
          <button onClick={() => headerRef.current?.click()} style={{padding:"5px 12px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"11px", background:headerImgData?"#4CAF50":"rgba(255,255,255,0.15)", color:"#fff", marginLeft:"8px"}}>
            {headerImgData?"✓ Header":"📄 Header"}
          </button>
          {headerGallery.length > 0 && (
            <select title="Pick a saved header" value="" onChange={e => e.target.value && setHeaderImgData(e.target.value)}
              style={{fontSize:"11px", padding:"4px 6px", borderRadius:"12px", border:"none", cursor:"pointer"}}>
              <option value="">Header ▾</option>
              {headerGallery.map((src, i) => <option key={i} value={src}>{`Preset ${i + 1}`}</option>)}
            </select>
          )}
          <button onClick={() => footerRef.current?.click()} style={{padding:"5px 12px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"11px", background:footerImgData?"#4CAF50":"rgba(255,255,255,0.15)", color:"#fff", marginLeft:"4px"}}>
            {footerImgData?"✓ Footer":"📄 Footer"}
          </button>
          {footerGallery.length > 0 && (
            <select title="Pick a saved footer" value="" onChange={e => e.target.value && setFooterImgData(e.target.value)}
              style={{fontSize:"11px", padding:"4px 6px", borderRadius:"12px", border:"none", cursor:"pointer"}}>
              <option value="">Footer ▾</option>
              {footerGallery.map((src, i) => <option key={i} value={src}>{`Preset ${i + 1}`}</option>)}
            </select>
          )}
          <span title={syncState === "error" ? "Could not reach the server — your work is still saved in this browser" : "Draft sync status"} style={{
            fontSize:"11px", color: syncState === "error" ? "#ff9999" : "rgba(255,255,255,0.6)", marginLeft:"6px", minWidth:"52px"
          }}>
            {syncState === "saving" ? "💾 Saving…" : syncState === "saved" ? "✓ Saved" : syncState === "error" ? "⚠ Offline" : ""}
          </span>
          <span style={{fontSize:"11px", color:"#fff", background:"rgba(255,255,255,0.15)", padding:"5px 12px", borderRadius:"20px"}}>
            {user.username} <span style={{opacity:0.7}}>({user.role})</span>
          </span>
          <button onClick={handleLogout} style={{padding:"5px 12px", borderRadius:"20px", border:"none", cursor:"pointer", fontSize:"11px", background:"rgba(255,255,255,0.15)", color:"#fff"}}>
            Sign out
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" multiple accept="image/*" style={{display:"none"}} onChange={handlePhotos}/>
      <input ref={headerRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleHeaderUpload}/>
      <input ref={footerRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleFooterUpload}/>

      <div style={{flex:1, overflow:"auto", padding:"24px", display:"flex", justifyContent:"center"}}>
        {tab === "chat" ? (
          <div style={{display:"flex", gap:"16px", width:"100%", maxWidth:"1500px"}}>
            <div style={{flex: splitView ? "1 1 480px" : "0 0 auto", minWidth:"320px", maxWidth: splitView ? undefined : "680px", width: splitView ? undefined : "100%"}}>
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
              <div style={{flex:"1 1 520px", minWidth:"380px", maxHeight:"calc(100vh - 140px)", overflowY:"auto"}}>
                {reportData ? (
                  <div style={{background:"#fff", borderRadius:"12px", overflow:"hidden", boxShadow:"0 4px 24px rgba(0,0,100,0.15)"}}>
                    <div style={{background:"#e8f0fe", color:"#0033cc", fontSize:"11px", fontWeight:"700", padding:"6px 14px", position:"sticky", top:0, zIndex:2}}>
                      🔴 LIVE PREVIEW — fills in as you answer
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
                  <div style={{
                    height:"calc(100vh - 160px)", border:"2px dashed #b8c8f0", borderRadius:"12px",
                    display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                    color:"#8899bb", textAlign:"center", padding:"24px"
                  }}>
                    <div style={{fontSize:"44px", marginBottom:"12px"}}>📄</div>
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
          <AdminPanel templates={templates || [getBuiltinTemplate("aar-elgu")]} onPersonnelSaved={() => fetchTemplates().then(setTemplates)}/>
        ) : (
          <div style={{width:"100%", maxWidth:"850px"}}>
            {reportData ? (
              <div style={{background:"#fff", borderRadius:"12px", overflow:"hidden", boxShadow:"0 4px 24px rgba(0,0,100,0.15)"}}>
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
              <div style={{textAlign:"center", padding:"80px 24px", color:"#666"}}>
                <div style={{fontSize:"48px", marginBottom:"16px"}}>📋</div>
                <div style={{fontSize:"20px", fontWeight:"600", color:"#333", marginBottom:"8px"}}>No report yet</div>
                <div>Complete the chat conversation to generate your report.</div>
                <button onClick={() => setTab("chat")} style={{marginTop:"20px", padding:"10px 24px", borderRadius:"20px", border:"none", background:"#0033cc", color:"#fff", fontWeight:"600", cursor:"pointer"}}>Go to Chat →</button>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #c0ccff; border-radius: 3px; }
      `}</style>
    </div>
  );
}

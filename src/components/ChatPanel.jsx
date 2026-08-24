import React from "react";

// Renders **bold** markdown and newlines in assistant/user messages.
const renderMarkdown = (text) =>
  String(text ?? "").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>");

const Message = ({ content, isUser }) => (
  <div style={{
    display:"flex", justifyContent: isUser ? "flex-end" : "flex-start",
    marginBottom:"12px"
  }}>
    {!isUser && (
      <div style={{width:"32px", height:"32px", borderRadius:"50%", background:"linear-gradient(135deg,#0033cc,#0099ff)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:"11px", fontWeight:"bold", flexShrink:0, marginRight:"8px", marginTop:"4px"}}>AI</div>
    )}
    <div style={{
      maxWidth:"72%", padding:"10px 14px", borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
      background: isUser ? "linear-gradient(135deg,#0033cc,#0055ff)" : "#f0f4ff",
      color: isUser ? "#fff" : "#1a1a2e",
      fontSize:"14px", lineHeight:"1.6", boxShadow:"0 2px 8px rgba(0,0,50,0.1)"
    }}
      dangerouslySetInnerHTML={{__html: renderMarkdown(content)}}
    />
  </div>
);

export default function ChatPanel({ messages, loading, streamingText, input, setInput, onSend }) {
  const chatRef = React.useRef(null);

  React.useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, streamingText]);

  return (
    <div style={{width:"100%", maxWidth:"680px", display:"flex", flexDirection:"column", height:"calc(100vh - 140px)"}}>
      <div style={{background:"rgba(0,51,204,0.08)", borderRadius:"12px", padding:"10px 16px", marginBottom:"16px", fontSize:"12px", color:"#0033cc", border:"1px solid rgba(0,51,204,0.15)"}}>
        💡 Answer each question to build your AAR. The AI will collect all required info and generate your formal report automatically.
      </div>
      <div ref={chatRef} style={{flex:1, overflowY:"auto", paddingRight:"4px"}}>
        {messages.map((msg, i) => <Message key={i} content={msg.content} isUser={msg.role === "user"}/>)}
        {loading && (
          <div style={{display:"flex", marginBottom:"12px"}}>
            <div style={{width:"32px", height:"32px", borderRadius:"50%", background:"linear-gradient(135deg,#0033cc,#0099ff)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:"11px", fontWeight:"bold", flexShrink:0, marginRight:"8px"}}>AI</div>
            {streamingText ? (
              <div style={{maxWidth:"72%", padding:"10px 14px", borderRadius:"18px 18px 18px 4px", background:"#f0f4ff", color:"#1a1a2e", fontSize:"14px", lineHeight:"1.6", boxShadow:"0 2px 8px rgba(0,0,50,0.1)", whiteSpace:"pre-wrap", wordBreak:"break-word"}}
                dangerouslySetInnerHTML={{__html: renderMarkdown(streamingText)}}
              />
            ) : (
              <div style={{background:"#f0f4ff", padding:"12px 16px", borderRadius:"18px 18px 18px 4px", display:"flex", gap:"4px", alignItems:"center"}}>
                {[0,1,2].map(i => <div key={i} style={{width:"7px", height:"7px", borderRadius:"50%", background:"#0033cc", animation:"bounce 1s infinite", animationDelay:`${i*0.15}s`}}/>)}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{display:"flex", gap:"10px", marginTop:"16px"}}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key==="Enter" && !e.shiftKey && onSend()}
          placeholder="Type your answer..."
          style={{flex:1, padding:"12px 18px", borderRadius:"24px", border:"2px solid #c0ccff", outline:"none", fontSize:"14px", background:"#fff", transition:"border .2s"}}
          onFocus={e => e.target.style.border="2px solid #0033cc"}
          onBlur={e => e.target.style.border="2px solid #c0ccff"}
        />
        <button onClick={onSend} disabled={loading} style={{
          padding:"12px 24px", borderRadius:"24px", border:"none", cursor:"pointer",
          background: loading ? "#aaa" : "linear-gradient(135deg,#0033cc,#0055ff)",
          color:"#fff", fontWeight:"700", fontSize:"14px", transition:"all .2s"
        }}>Send</button>
      </div>
    </div>
  );
}

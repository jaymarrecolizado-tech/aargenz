import React from "react";

// Renders **bold** markdown and newlines in assistant/user messages.
const renderMarkdown = (text) =>
  String(text ?? "").replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>");

const Message = ({ content, isUser }) => (
  <div className={"msg-row" + (isUser ? " user" : "")}>
    {!isUser && <div className="avatar">AI</div>}
    <div
      className={isUser ? "bubble-user" : "bubble-ai"}
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
    <div className="chat-root" style={{width:"100%", maxWidth:"680px", display:"flex", flexDirection:"column", height:"calc(100vh - 140px)"}}>
      <div className="chat-tip">
        Answer each question to build your AAR. The AI collects the required info and generates your formal report automatically.
      </div>
      <div ref={chatRef} style={{flex:1, overflowY:"auto", paddingRight:"4px"}}>
        {messages.map((msg, i) => <Message key={i} content={msg.content} isUser={msg.role === "user"}/>)}
        {loading && (
          <div className="msg-row">
            <div className="avatar">AI</div>
            {streamingText ? (
              <div className="bubble-ai" style={{whiteSpace:"pre-wrap"}}
                dangerouslySetInnerHTML={{__html: renderMarkdown(streamingText)}}
              /> 
            ) : (
              <div className="typing">
                {[0,1,2].map(i => <div key={i} className="dot" style={{animationDelay:`${i*0.15}s`}}/>)}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{display:"flex", gap:"10px", marginTop:"16px"}}>
        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key==="Enter" && !e.shiftKey && onSend()}
          placeholder="Type your answer..."
        />
        <button onClick={onSend} disabled={loading} className="send-btn">
          Send
        </button>
      </div>
    </div>
  );
}

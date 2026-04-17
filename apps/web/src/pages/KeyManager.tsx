import { useState, useEffect, useCallback, useRef } from "react";
import {
  listAllKeys, generateTestKey, generateSoftwareKey, importXpub,
  updateKeyStatus, deleteKey, revealMnemonic, secureTestKey,
  markBackedUp, exportKeyring, importKeyringJson, renameKey,
  DEFAULT_PERSONAS, type LocalKey, type Network,
} from "../lib/keystore";
import { useToast } from "../components/toast";

const C = {
  bg:"#07070F",surface:"#0F0F1A",raised:"#141422",border:"#1E1E30",
  gold:"#C9A84C",goldDim:"#8B6914",text:"#E8E4D8",muted:"#5A5570",
  sub:"#9994A8",red:"#E05C5C",green:"#52C47A",blue:"#4A90D9",orange:"#E09050",
};
const inp: React.CSSProperties = {
  width:"100%",padding:"11px 13px",background:"#161622",
  border:"1px solid #1E1E30",borderRadius:8,color:C.text,
  fontSize:14,fontFamily:"DM Sans,sans-serif",boxSizing:"border-box",
};
const monoInp: React.CSSProperties={...inp,fontFamily:"IBM Plex Mono,monospace",fontSize:12};
const lbl: React.CSSProperties={fontSize:11,fontWeight:600,letterSpacing:"0.08em",color:C.muted,textTransform:"uppercase",marginBottom:5,display:"block"};
const goldBtn: React.CSSProperties={padding:"10px 20px",background:C.gold,border:"none",borderRadius:8,color:C.bg,fontWeight:700,fontSize:14,fontFamily:"DM Sans,sans-serif",cursor:"pointer"};
const ghostBtn: React.CSSProperties={padding:"9px 16px",background:"none",border:"1px solid #1E1E30",borderRadius:8,color:C.sub,fontSize:13,fontFamily:"DM Sans,sans-serif",cursor:"pointer"};
const dangerBtn: React.CSSProperties={...ghostBtn,color:C.red,borderColor:"#3A1A1A"};

function WordGrid({words}:{words:string[]}){
  const [vis,setVis]=useState(false);
  return (
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:6}}>
        <button style={{...ghostBtn,fontSize:12,padding:"4px 10px"}} onClick={()=>setVis(v=>!v)}>
          {vis?"Hide":"Reveal words"}
        </button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:5}}>
        {words.map((w,i)=>(
          <div key={i} style={{background:"#0A0A14",border:"1px solid #1E1E30",borderRadius:6,padding:"6px 10px",display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:10,color:C.muted,minWidth:16,flexShrink:0}}>{i+1}</span>
            <span style={{fontSize:12,fontFamily:"IBM Plex Mono,monospace",color:vis?C.text:"transparent",textShadow:vis?"none":"0 0 8px #5A5570",userSelect:vis?"text":"none"}}>{w}</span>
          </div>
        ))}
      </div>
      {vis&&<button style={{...ghostBtn,width:"100%",marginTop:10,fontSize:12}} onClick={()=>navigator.clipboard.writeText(words.join(" "))}>Copy all 24 words</button>}
    </div>
  );
}

function PersonaPicker({value,onChange}:{value:string;onChange:(v:string)=>void}){
  const [custom,setCustom]=useState("");
  const [show,setShow]=useState(false);
  const extras=value&&!DEFAULT_PERSONAS.includes(value)?[value]:[];
  const all=[...DEFAULT_PERSONAS,...extras];
  return (
    <div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:6}}>
        {all.map(p=>(
          <button key={p} onClick={()=>{onChange(p);setShow(false);}} style={{...ghostBtn,padding:"5px 12px",fontSize:12,borderColor:value===p?C.gold:"#1E1E30",color:value===p?C.gold:C.sub,background:value===p?"#C9A84C18":"transparent"}}>{p}</button>
        ))}
        <button onClick={()=>setShow(s=>!s)} style={{...ghostBtn,padding:"5px 12px",fontSize:12}}>+ Custom</button>
      </div>
      {show&&<div style={{display:"flex",gap:8}}><input style={{...inp,flex:1}} placeholder="Custom persona" value={custom} onChange={e=>setCustom(e.target.value)}/><button style={ghostBtn} onClick={()=>{if(custom.trim()){onChange(custom.trim());setShow(false);}}}>Set</button></div>}
    </div>
  );
}

function Modal({title,onClose,children,wide}:{title:string;onClose:()=>void;children:React.ReactNode;wide?:boolean}){
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:16}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.surface,border:"1px solid "+C.border,borderRadius:16,padding:"28px 32px",width:"100%",maxWidth:wide?660:520,maxHeight:"92vh",overflowY:"auto",fontFamily:"DM Sans,sans-serif"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <h2 style={{fontSize:20,fontWeight:600,color:C.text,fontFamily:"Playfair Display,serif",margin:0}}>{title}</h2>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer"}}>x</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function QuickModal({onDone,onClose}:{onClose:()=>void;onDone:(key:LocalKey,mnemonic:string)=>void}){
  const [label,setLabel]=useState("");
  const [persona,setPersona]=useState(DEFAULT_PERSONAS[0]);
  const [network,setNetwork]=useState<Network>("testnet");
  function submit(e:React.FormEvent){
    e.preventDefault();
    const {key,mnemonic}=generateTestKey({label:label.trim()||persona,network,persona});
    onDone(key,mnemonic);
  }
  return (
    <Modal title="Quick test key" onClose={onClose}>
      <div style={{padding:"10px 14px",background:"#0A1A14",border:"1px solid #52C47A44",borderRadius:8,marginBottom:18}}>
        <p style={{fontSize:13,color:C.green,margin:0}}>No password needed. Mnemonic stored in browser. Testnet only.</p>
      </div>
      <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={lbl}>Label</label><input style={inp} value={label} onChange={e=>setLabel(e.target.value)} placeholder={persona}/></div>
        <div><label style={lbl}>Persona</label><PersonaPicker value={persona} onChange={setPersona}/></div>
        <div><label style={lbl}>Network</label><select style={inp} value={network} onChange={e=>setNetwork(e.target.value as Network)}><option value="testnet">Testnet</option><option value="mainnet">Mainnet</option></select></div>
        <div style={{display:"flex",gap:10}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={{...goldBtn,background:C.green}}>Generate instantly</button></div>
      </form>
    </Modal>
  );
}

function TestKeyCreated({keyData,mnemonic,onClose}:{keyData:LocalKey;mnemonic:string;onClose:()=>void}){
  return (
    <Modal title="Key created" onClose={onClose} wide>
      <div style={{padding:"10px 14px",background:"#0A1A14",border:"1px solid #52C47A44",borderRadius:8,marginBottom:16}}>
        <p style={{fontSize:13,color:C.green,margin:0}}><strong>{keyData.label}</strong> created for <strong>{keyData.persona}</strong>. Recovery phrase below - tap "Reveal words" to see it.</p>
      </div>
      <WordGrid words={mnemonic.split(" ")}/>
      <div style={{display:"flex",gap:10,marginTop:16}}>
        <button style={{...ghostBtn,flex:1}} onClick={onClose}>Done - back up later</button>
        <button style={{...goldBtn,flex:1}} onClick={onClose}>Continue</button>
      </div>
    </Modal>
  );
}

function SecureModal({onDone,onClose}:{onClose:()=>void;onDone:(key:LocalKey,mnemonic:string)=>void}){
  const [label,setLabel]=useState("");
  const [persona,setPersona]=useState(DEFAULT_PERSONAS[0]);
  const [network,setNetwork]=useState<Network>("testnet");
  const [password,setPassword]=useState("");
  const [confirm,setConfirm]=useState("");
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState<string|null>(null);
  async function submit(e:React.FormEvent){
    e.preventDefault();
    if(password!==confirm){setErr("Passwords do not match");return;}
    if(password.length<8){setErr("Password must be at least 8 characters");return;}
    setBusy(true);setErr(null);
    try{const {key,mnemonic}=await generateSoftwareKey({label:label.trim()||persona,network,password,persona});onDone(key,mnemonic);}
    catch(e){setErr(e instanceof Error?e.message:"Failed");}
    finally{setBusy(false);}
  }
  return (
    <Modal title="Secure key" onClose={onClose}>
      <p style={{fontSize:13,color:C.muted,marginBottom:20,lineHeight:1.5}}>Mnemonic encrypted with your password. Use for real funds.</p>
      <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={lbl}>Label</label><input style={inp} value={label} onChange={e=>setLabel(e.target.value)} placeholder={persona}/></div>
        <div><label style={lbl}>Persona</label><PersonaPicker value={persona} onChange={setPersona}/></div>
        <div><label style={lbl}>Network</label><select style={inp} value={network} onChange={e=>setNetwork(e.target.value as Network)}><option value="testnet">Testnet</option><option value="mainnet">Mainnet</option></select></div>
        <div><label style={lbl}>Encryption password</label><input style={inp} type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={8} placeholder="Min 8 characters"/></div>
        <div><label style={lbl}>Confirm password</label><input style={inp} type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} required/></div>
        {err&&<p style={{color:C.red,fontSize:13,margin:0}}>{err}</p>}
        <div style={{display:"flex",gap:10}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={{...goldBtn,opacity:busy?0.6:1}} disabled={busy}>{busy?"Generating...":"Generate"}</button></div>
      </form>
    </Modal>
  );
}

function BackupFlow({keyData,mnemonic,onDone}:{keyData:LocalKey;mnemonic:string;onDone:()=>void}){
  const words=mnemonic.split(" ");
  const [step,setStep]=useState<"show"|"verify">("show");
  const [confirmed,setConfirmed]=useState(false);
  const [positions]=useState<number[]>(()=>{const p:number[]=[];while(p.length<4){const n=Math.floor(Math.random()*24);if(!p.includes(n))p.push(n);}return p.sort((a,b)=>a-b);});
  const [answers,setAnswers]=useState<Record<number,string>>({});
  const [err,setErr]=useState<string|null>(null);
  function verify(){
    const wrong=positions.filter(p=>answers[p]?.trim().toLowerCase()!==words[p]);
    if(wrong.length){setErr("Wrong: "+wrong.map(p=>"#"+(p+1)).join(", "));return;}
    markBackedUp(keyData.keyId);onDone();
  }
  if(step==="show")return(
    <Modal title="Write down your recovery phrase" onClose={()=>{}} wide>
      <div style={{padding:"10px 14px",background:"#1A0A0A",border:"1px solid #3A1A1A",borderRadius:8,marginBottom:16}}><p style={{fontSize:13,color:C.red,margin:0}}>Write all 24 words on paper in order. Never store digitally or share.</p></div>
      <WordGrid words={words}/>
      <label style={{display:"flex",gap:10,alignItems:"center",cursor:"pointer",marginTop:16,padding:12,background:C.raised,borderRadius:8}}>
        <input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>
        <span style={{fontSize:13,color:C.sub}}>I have written all 24 words in order.</span>
      </label>
      <button style={{...goldBtn,width:"100%",marginTop:12,opacity:confirmed?1:0.4}} disabled={!confirmed} onClick={()=>setStep("verify")}>Verify backup</button>
    </Modal>
  );
  return(
    <Modal title="Verify backup" onClose={()=>{}}>
      <p style={{fontSize:13,color:C.muted,marginBottom:20}}>Enter the words at the positions below.</p>
      {positions.map(pos=>(
        <div key={pos} style={{marginBottom:12}}><label style={lbl}>Word #{pos+1}</label><input style={inp} value={answers[pos]??""} autoComplete="off" autoCorrect="off" spellCheck={false} onChange={e=>setAnswers(p=>({...p,[pos]:e.target.value}))}/></div>
      ))}
      {err&&<p style={{color:C.red,fontSize:13}}>{err}</p>}
      <button style={{...goldBtn,width:"100%",marginTop:8}} onClick={verify}>Confirm</button>
    </Modal>
  );
}

function RevealModal({keyData,onClose,onBackedUp}:{keyData:LocalKey;onClose:()=>void;onBackedUp:()=>void}){
  const [pw,setPw]=useState("");
  const isTest=!!keyData.testMnemonic;
  const [mnemonic,setMn]=useState<string|null>(isTest?keyData.testMnemonic!:null);
  const [err,setErr]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [doBackup,setDoBackup]=useState(false);
  async function unlock(e:React.FormEvent){e.preventDefault();setBusy(true);setErr(null);try{setMn(await revealMnemonic(keyData.keyId,pw));}catch(e){setErr(e instanceof Error?e.message:"Failed");}finally{setBusy(false);}}
  if(doBackup&&mnemonic)return<BackupFlow keyData={keyData} mnemonic={mnemonic} onDone={()=>{onBackedUp();onClose();}}/>;
  return(
    <Modal title="Recovery phrase" onClose={onClose} wide>
      {!mnemonic&&!isTest?(
        <form onSubmit={unlock} style={{display:"flex",flexDirection:"column",gap:14}}>
          <p style={{fontSize:13,color:C.muted}}>Enter password for <strong style={{color:C.text}}>{keyData.label}</strong>.</p>
          <div><label style={lbl}>Password</label><input style={inp} type="password" value={pw} onChange={e=>setPw(e.target.value)} required autoFocus/></div>
          {err&&<p style={{color:C.red,fontSize:13}}>{err}</p>}
          <div style={{display:"flex",gap:10}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={{...goldBtn,opacity:busy?0.6:1}} disabled={busy}>{busy?"Decrypting...":"Reveal"}</button></div>
        </form>
      ):(
        <>
          {isTest?<div style={{padding:"10px 14px",background:"#0A1400",border:"1px solid #52C47A44",borderRadius:8,marginBottom:14}}><p style={{fontSize:12,color:C.green,margin:0}}>Test key - no password needed.</p></div>
                 :<div style={{padding:"10px 14px",background:"#1A0A0A",border:"1px solid #3A1A1A",borderRadius:8,marginBottom:14}}><p style={{fontSize:12,color:C.red,margin:0}}>Keep this private. Close when done.</p></div>}
          <WordGrid words={mnemonic!.split(" ")}/>
          <div style={{display:"flex",gap:10,marginTop:16}}>
            <button style={{...ghostBtn,flex:1}} onClick={onClose}>Close</button>
            {!keyData.backedUp&&<button style={{...goldBtn,flex:1}} onClick={()=>setDoBackup(true)}>Verify backup</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

function SecureUpgradeModal({keyData,onDone,onClose}:{keyData:LocalKey;onDone:()=>void;onClose:()=>void}){
  const [pw,setPw]=useState("");const[confirm,setConfirm]=useState("");const[busy,setBusy]=useState(false);const[err,setErr]=useState<string|null>(null);
  async function submit(e:React.FormEvent){e.preventDefault();if(pw!==confirm){setErr("Passwords do not match");return;}if(pw.length<8){setErr("Min 8 characters");return;}setBusy(true);setErr(null);try{await secureTestKey(keyData.keyId,pw);onDone();}catch(e){setErr(e instanceof Error?e.message:"Failed");}finally{setBusy(false);}}
  return(
    <Modal title="Add password to key" onClose={onClose}>
      <p style={{fontSize:13,color:C.muted,marginBottom:18,lineHeight:1.5}}>Encrypt <strong style={{color:C.text}}>{keyData.label}</strong> with a password. The plaintext mnemonic will be deleted from storage.</p>
      <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={lbl}>Password</label><input style={inp} type="password" value={pw} onChange={e=>setPw(e.target.value)} required minLength={8} autoFocus/></div>
        <div><label style={lbl}>Confirm</label><input style={inp} type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} required/></div>
        {err&&<p style={{color:C.red,fontSize:13}}>{err}</p>}
        <div style={{display:"flex",gap:10}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={{...goldBtn,opacity:busy?0.6:1}} disabled={busy}>{busy?"Encrypting...":"Add password"}</button></div>
      </form>
    </Modal>
  );
}

function ImportModal({onDone,onClose}:{onDone:()=>void;onClose:()=>void}){
  const [label,setLabel]=useState("");const[persona,setPersona]=useState(DEFAULT_PERSONAS[0]);const[network,setNetwork]=useState<Network>("testnet");const[xpub,setXpub]=useState("");const[path,setPath]=useState("m/48'/1'/0'/2'");const[err,setErr]=useState<string|null>(null);
  function handleNetwork(n:Network){setNetwork(n);setPath("m/48'/"+(n==="mainnet"?"0":"1")+"'/0'/2'");}
  function submit(e:React.FormEvent){e.preventDefault();setErr(null);try{importXpub({label:label.trim()||persona,persona,network,xpub:xpub.trim(),derivationPath:path.trim()});onDone();}catch(e){setErr(e instanceof Error?e.message:"Import failed");}}
  return(
    <Modal title="Import xpub" onClose={onClose}>
      <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={lbl}>Label</label><input style={inp} value={label} onChange={e=>setLabel(e.target.value)} placeholder={persona}/></div>
        <div><label style={lbl}>Persona</label><PersonaPicker value={persona} onChange={setPersona}/></div>
        <div><label style={lbl}>Network</label><select style={inp} value={network} onChange={e=>handleNetwork(e.target.value as Network)}><option value="testnet">Testnet</option><option value="mainnet">Mainnet</option></select></div>
        <div><label style={lbl}>xpub / tpub</label><textarea style={{...monoInp,resize:"vertical"}} rows={3} value={xpub} onChange={e=>setXpub(e.target.value)} required placeholder="xpub6... or tpub..."/></div>
        <div><label style={lbl}>Derivation path</label><input style={monoInp} value={path} onChange={e=>setPath(e.target.value)}/></div>
        {err&&<p style={{color:C.red,fontSize:13}}>{err}</p>}
        <div style={{display:"flex",gap:10}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={goldBtn}>Import</button></div>
      </form>
    </Modal>
  );
}

function EditModal({keyData,onDone,onClose}:{keyData:LocalKey;onDone:()=>void;onClose:()=>void}){
  const [label,setLabel]=useState(keyData.label);
  const [persona,setPersona]=useState(keyData.persona);
  function submit(e:React.FormEvent){e.preventDefault();renameKey(keyData.keyId,label.trim()||keyData.label,persona);onDone();}
  return(
    <Modal title="Edit key" onClose={onClose}>
      <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:14}}>
        <div><label style={lbl}>Label</label><input style={inp} value={label} onChange={e=>setLabel(e.target.value)} required autoFocus/></div>
        <div><label style={lbl}>Persona</label><PersonaPicker value={persona} onChange={setPersona}/></div>
        <div style={{display:"flex",gap:10}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={goldBtn}>Save</button></div>
      </form>
    </Modal>
  );
}

function DetailModal({k,onClose,onReveal,onSecure,onArchive,onDelete,onEdit}:{k:LocalKey;onClose:()=>void;onReveal:()=>void;onSecure:()=>void;onArchive:()=>void;onDelete:()=>void;onEdit:()=>void}){
  const [copied,setCopied]=useState<string|null>(null);
  function copy(text:string,id:string){navigator.clipboard.writeText(text);setCopied(id);setTimeout(()=>setCopied(null),1500);}
  const keyType=k.testMnemonic?"Test key (plaintext - no password)":k.origin==="imported_xpub"?"Imported xpub":"Secure key (encrypted)";
  return(
    <Modal title={k.label} onClose={onClose} wide>
      <div style={{background:"#0A0A14",borderRadius:10,overflow:"hidden",marginBottom:14}}>
        {[["Persona",k.persona],["Type",keyType],["Network",k.network.toUpperCase()],["Fingerprint",k.fingerprint],["Path",k.derivationPath],["Backed up",k.backedUp?"Yes":"No"],["Status",k.status],["Created",new Date(k.createdAt).toLocaleDateString()]].map(([label,value])=>(
          <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 14px",borderBottom:"1px solid "+C.border}}>
            <span style={{fontSize:12,color:C.muted}}>{label}</span>
            <span style={{fontSize:13,color:C.text,fontFamily:["Fingerprint","Path"].includes(label as string)?"IBM Plex Mono,monospace":"inherit"}}>{value}</span>
          </div>
        ))}
      </div>
      <div style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
          <span style={lbl}>Extended public key (xpub)</span>
          <button style={{...ghostBtn,padding:"3px 9px",fontSize:11}} onClick={()=>copy(k.xpub,"xpub")}>{copied==="xpub"?"Copied":"Copy"}</button>
        </div>
        <div style={{background:"#0A0A14",borderRadius:8,padding:"10px 12px",fontFamily:"IBM Plex Mono,monospace",fontSize:11,color:C.sub,wordBreak:"break-all",lineHeight:1.6}}>{k.xpub}</div>
      </div>
      {k.pubkey&&(
        <div style={{marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
            <span style={lbl}>Public key (hex)</span>
            <button style={{...ghostBtn,padding:"3px 9px",fontSize:11}} onClick={()=>copy(k.pubkey,"pub")}>{copied==="pub"?"Copied":"Copy"}</button>
          </div>
          <div style={{background:"#0A0A14",borderRadius:8,padding:"10px 12px",fontFamily:"IBM Plex Mono,monospace",fontSize:11,color:C.sub,wordBreak:"break-all"}}>{k.pubkey}</div>
        </div>
      )}
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button style={{...ghostBtn,fontSize:13}} onClick={onEdit}>Edit</button>
        {k.origin==="software"&&<button style={{...ghostBtn,fontSize:13}} onClick={onReveal}>{k.testMnemonic?"View recovery phrase":"View / backup"}</button>}
        {k.testMnemonic&&<button style={{...ghostBtn,fontSize:13,color:C.gold,borderColor:C.goldDim}} onClick={onSecure}>Add password</button>}
        {k.status==="active"&&<button style={{...ghostBtn,fontSize:13}} onClick={onArchive}>Archive</button>}
        {k.status==="archived"&&<button style={{...ghostBtn,fontSize:13}} onClick={()=>{updateKeyStatus(k.keyId,"active");onClose();}}>Restore</button>}
        <button style={{...dangerBtn,fontSize:13,marginLeft:"auto"}} onClick={onDelete}>Delete</button>
      </div>
    </Modal>
  );
}

type ModalState=
  |{type:"quick"}|{type:"secure"}|{type:"import"}
  |{type:"test-created";key:LocalKey;mnemonic:string}
  |{type:"backup";key:LocalKey;mnemonic:string}
  |{type:"reveal";key:LocalKey}|{type:"detail";key:LocalKey}
  |{type:"upgrade";key:LocalKey}|{type:"edit";key:LocalKey};

export default function KeyManager(){
  const toast=useToast();
  const [keys,setKeys]=useState<LocalKey[]>([]);
  const [modal,setModal]=useState<ModalState|null>(null);
  const [filter,setFilter]=useState<"active"|"archived"|"all">("active");
  const [search,setSearch]=useState("");
  const fileRef=useRef<HTMLInputElement>(null);

  const reload=useCallback(()=>setKeys(listAllKeys()),[]);
  useEffect(()=>{reload();},[reload]);

  const personas=["all",...Array.from(new Set(keys.map(k=>k.persona)))];
  const [personaFilter,setPersonaFilter]=useState("all");

  const visible=keys.filter(k=>{
    if(filter==="active"&&k.status!=="active")return false;
    if(filter==="archived"&&k.status==="active")return false;
    if(personaFilter!=="all"&&k.persona!==personaFilter)return false;
    if(search&&!k.label.toLowerCase().includes(search.toLowerCase())&&!k.fingerprint.includes(search.toLowerCase()))return false;
    return true;
  });

  const palette=["#C9A84C","#4A90D9","#52C47A","#B06AE0","#E06A6A","#6AB8E0"];
  const personaColors:Record<string,string>={};
  Array.from(new Set(keys.map(k=>k.persona))).forEach((p,i)=>{personaColors[p]=palette[i%palette.length];});

  function handleArchive(keyId:string){if(!confirm("Archive this key?"))return;updateKeyStatus(keyId,"archived");reload();setModal(null);}
  function handleDelete(keyId:string){if(!confirm("Permanently delete? This cannot be undone."))return;deleteKey(keyId);reload();setModal(null);}

  function doExport(){
    const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(new Blob([exportKeyring()],{type:"application/json"})),download:"dynastytrust-keyring-"+Date.now()+".json"});
    a.click();URL.revokeObjectURL(a.href);
  }

  function doImport(e:React.ChangeEvent<HTMLInputElement>){
    const file=e.target.files?.[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{const n=importKeyringJson(ev.target?.result as string);reload();toast.success("Imported "+n+" key(s)");}
      catch(err){toast.error("Import failed: "+(err instanceof Error?err.message:"Unknown error"));}
    };
    reader.readAsText(file);
    e.target.value="";
  }

  const activeCount=keys.filter(k=>k.status==="active").length;
  const archivedCount=keys.filter(k=>k.status==="archived").length;

  return(
    <div style={{fontFamily:"DM Sans,sans-serif"}}>
      {/* Top toolbar */}
      <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <button style={{...goldBtn,background:C.green,fontSize:14}} onClick={()=>setModal({type:"quick"})}>+ Quick key</button>
        <button style={{...ghostBtn,borderColor:C.goldDim,color:C.gold}} onClick={()=>setModal({type:"secure"})}>+ Secure key</button>
        <button style={ghostBtn} onClick={()=>setModal({type:"import"})}>Import xpub</button>
        <div style={{marginLeft:"auto",display:"flex",gap:8}}>
          <button style={ghostBtn} onClick={doExport}>Export JSON</button>
          <button style={ghostBtn} onClick={()=>fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={doImport}/>
        </div>
      </div>

      {/* Search + filters */}
      <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
        <input style={{...inp,flex:1,minWidth:160,padding:"8px 12px"}} placeholder="Search by name or fingerprint..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <div style={{display:"flex",gap:4}}>
          {(["active","archived","all"] as const).map(f=>(
            <button key={f} onClick={()=>setFilter(f)} style={{...ghostBtn,padding:"6px 12px",fontSize:12,borderColor:filter===f?C.gold:"#1E1E30",color:filter===f?C.gold:C.sub}}>
              {f==="active"?"Active ("+activeCount+")":f==="archived"?"Archived ("+archivedCount+")":"All"}
            </button>
          ))}
        </div>
      </div>

      {/* Persona filter pills */}
      {personas.length>2&&(
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
          {personas.map(p=>(
            <button key={p} onClick={()=>setPersonaFilter(p)} style={{...ghostBtn,padding:"4px 11px",fontSize:12,borderColor:personaFilter===p?(p==="all"?C.gold:personaColors[p]??C.gold):"#1E1E30",color:personaFilter===p?(p==="all"?C.gold:personaColors[p]??C.gold):C.sub}}>
              {p==="all"?"All personas":p}
            </button>
          ))}
        </div>
      )}

      {/* Empty */}
      {visible.length===0&&(
        <div style={{textAlign:"center",padding:"56px 24px",background:C.surface,borderRadius:14,border:"1px solid "+C.border}}>
          <p style={{fontSize:18,fontWeight:600,color:C.text,marginBottom:8}}>{search?"No keys match your search":"No keys yet"}</p>
          <p style={{color:C.muted,fontSize:14,marginBottom:24,maxWidth:320,margin:"0 auto 24px"}}>
            {search?"Try a different search term.":"Generate test keys for each persona, then compile a vault."}
          </p>
          {!search&&<button style={{...goldBtn,background:C.green}} onClick={()=>setModal({type:"quick"})}>Generate first key</button>}
        </div>
      )}

      {/* Key list - grouped by persona */}
      {Array.from(new Set(visible.map(k=>k.persona))).map(persona=>(
        <div key={persona} style={{marginBottom:22}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:13,fontWeight:600,color:personaColors[persona]??C.gold}}>{persona}</span>
            <span style={{fontSize:11,color:C.muted}}>{visible.filter(k=>k.persona===persona).length} key(s)</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            {visible.filter(k=>k.persona===persona).map(key=>(
              <div key={key.keyId} style={{display:"flex",alignItems:"center",gap:14,background:C.surface,border:"1px solid "+C.border,borderRadius:12,padding:"13px 16px",cursor:"pointer"}} onClick={()=>setModal({type:"detail",key})}>
                <div style={{width:38,height:38,borderRadius:9,flexShrink:0,background:key.testMnemonic?"#52C47A14":"#4A90D914",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>
                  {key.origin==="software"?(key.testMnemonic?"T":"S"):"H"}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3,flexWrap:"wrap"}}>
                    <span style={{fontSize:15,fontWeight:600,color:C.text}}>{key.label}</span>
                    {key.testMnemonic&&<span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:4,background:"#52C47A22",color:C.green}}>TEST</span>}
                    {key.status==="archived"&&<span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:4,background:"#5A557022",color:C.muted}}>ARCHIVED</span>}
                    {!key.backedUp&&key.origin==="software"&&<span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:4,background:"#E0905022",color:C.orange}}>NOT BACKED UP</span>}
                  </div>
                  <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,fontFamily:"IBM Plex Mono,monospace",color:C.muted}}>{key.fingerprint}</span>
                    <span style={{fontSize:11,color:key.network==="mainnet"?C.gold:C.green}}>{key.network.toUpperCase()}</span>
                    <span style={{fontSize:11,color:C.muted}}>{key.derivationPath}</span>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                  <button style={{...ghostBtn,fontSize:12,padding:"5px 10px"}} onClick={()=>setModal({type:"edit",key})}>Edit</button>
                  {key.origin==="software"&&<button style={{...ghostBtn,fontSize:12,padding:"5px 10px"}} onClick={()=>setModal({type:"reveal",key})}>{key.testMnemonic?"Phrase":"Backup"}</button>}
                  <button style={{...dangerBtn,fontSize:12,padding:"5px 10px"}} onClick={()=>handleDelete(key.keyId)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Modals */}
      {modal?.type==="quick"&&<QuickModal onClose={()=>setModal(null)} onDone={(key,mnemonic)=>{reload();setModal({type:"test-created",key,mnemonic});}}/>}
      {modal?.type==="secure"&&<SecureModal onClose={()=>setModal(null)} onDone={(key,mnemonic)=>{reload();setModal({type:"backup",key,mnemonic});}}/>}
      {modal?.type==="import"&&<ImportModal onClose={()=>setModal(null)} onDone={()=>{reload();setModal(null);}}/>}
      {modal?.type==="test-created"&&<TestKeyCreated keyData={modal.key} mnemonic={modal.mnemonic} onClose={()=>setModal(null)}/>}
      {modal?.type==="backup"&&<BackupFlow keyData={modal.key} mnemonic={modal.mnemonic} onDone={()=>{reload();setModal(null);}}/>}
      {modal?.type==="reveal"&&<RevealModal keyData={modal.key} onClose={()=>{reload();setModal(null);}} onBackedUp={()=>reload()}/>}
      {modal?.type==="edit"&&<EditModal keyData={modal.key} onClose={()=>setModal(null)} onDone={()=>{reload();setModal(null);}}/>}
      {modal?.type==="detail"&&<DetailModal k={modal.key} onClose={()=>setModal(null)} onReveal={()=>setModal({type:"reveal",key:modal.key})} onSecure={()=>setModal({type:"upgrade",key:modal.key})} onArchive={()=>handleArchive(modal.key.keyId)} onDelete={()=>handleDelete(modal.key.keyId)} onEdit={()=>setModal({type:"edit",key:modal.key})}/>}
      {modal?.type==="upgrade"&&<SecureUpgradeModal keyData={modal.key} onClose={()=>setModal(null)} onDone={()=>{reload();setModal(null);}}/>}
    </div>
  );
}

import { useEffect, useState, useCallback } from "react";
import { api, type Vault, type BalanceResult } from "../lib/api";
import { useToast } from "../components/toast";

interface Props { onSelectVault: (v: Vault) => void; }

const C = {
  bg:"#07070F",surface:"#0F0F1A",border:"#1E1E30",gold:"#C9A84C",
  text:"#E8E4D8",muted:"#5A5570",sub:"#9994A8",red:"#E05C5C",green:"#52C47A",
};
const inp: React.CSSProperties={width:"100%",padding:"10px 12px",background:"#161622",border:"1px solid #1E1E30",borderRadius:8,color:C.text,fontSize:14,fontFamily:"DM Sans,sans-serif",boxSizing:"border-box"};
const monoInp: React.CSSProperties={...inp,fontFamily:"IBM Plex Mono,monospace",fontSize:12};
const lbl: React.CSSProperties={fontSize:11,fontWeight:600,letterSpacing:"0.08em",color:C.muted,textTransform:"uppercase",marginBottom:4,display:"block"};
const goldBtn: React.CSSProperties={padding:"9px 18px",background:C.gold,border:"none",borderRadius:8,color:C.bg,fontWeight:700,fontSize:13,fontFamily:"DM Sans,sans-serif",cursor:"pointer"};
const ghostBtn: React.CSSProperties={padding:"8px 14px",background:"none",border:"1px solid #1E1E30",borderRadius:8,color:C.sub,fontSize:13,fontFamily:"DM Sans,sans-serif",cursor:"pointer"};
const ta: React.CSSProperties={...monoInp,resize:"vertical"};

function satsToBtc(sats:number){return(sats/1e8).toFixed(8).replace(/\.?0+$/,"")||"0";}
function blocksToLabel(blocks:number){if(!blocks)return"--";const days=Math.round(blocks*10/60/24);if(days<30)return"~"+days+"d";if(days<365)return"~"+Math.round(days/30)+"mo";return"~"+(days/365).toFixed(1)+"yr";}

export default function Dashboard({onSelectVault}:Props){
  const toast=useToast();
  const [vaults,setVaults]=useState<Vault[]>([]);
  const [balances,setBalances]=useState<Record<string,BalanceResult>>({});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [showCreate,setShowCreate]=useState(false);
  const [showArchived,setShowArchived]=useState(false);
  const [search,setSearch]=useState("");
  const [renaming,setRenaming]=useState<Vault|null>(null);

  const load=useCallback(async()=>{
    try{
      setError(null);
      const {vaults}=await api.vaults.list(showArchived);
      setVaults(vaults);
      for(const v of vaults){api.balance(v.address,v.network).then(b=>setBalances(prev=>({...prev,[v.id]:b}))).catch(()=>{});}
    }catch(err){setError(err instanceof Error?err.message:"Failed to load");}
    finally{setLoading(false);}
  },[showArchived]);

  useEffect(()=>{void load();},[load]);

  async function archive(v:Vault,e:React.MouseEvent){
    e.stopPropagation();
    if(!confirm("Archive "+v.name+"?"))return;
    try{await api.vaults.archive(v.id);void load();}catch(err){toast.error(err instanceof Error?err.message:"Failed to archive vault");}
  }

  async function unarchive(v:Vault,e:React.MouseEvent){
    e.stopPropagation();
    try{await (api.vaults as unknown as {unarchive:(id:string)=>Promise<unknown>}).unarchive?.(v.id);}
    catch{}
    void load();
  }

  const visible=vaults.filter(v=>!search||v.name.toLowerCase().includes(search.toLowerCase())||v.address.includes(search));

  return(
    <div style={{fontFamily:"DM Sans,sans-serif"}}>
      <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <input style={{...inp,flex:1,minWidth:180,padding:"8px 12px"}} placeholder="Search vaults..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <button style={{...ghostBtn,fontSize:12}} onClick={()=>setShowArchived(s=>!s)}>
          {showArchived?"Hide archived":"Show archived"}
        </button>
        <button style={goldBtn} onClick={()=>setShowCreate(true)}>+ Add vault</button>
      </div>

      {loading&&<p style={{color:C.muted,fontSize:14}}>Loading...</p>}
      {error&&<p style={{color:C.red,fontSize:14}}>{error}</p>}

      {!loading&&visible.length===0&&(
        <div style={{textAlign:"center",padding:"64px 24px",background:C.surface,borderRadius:14,border:"1px solid "+C.border}}>
          <p style={{fontSize:18,fontWeight:600,color:C.text,marginBottom:8}}>{search?"No vaults match":"No vaults yet"}</p>
          <p style={{color:C.muted,fontSize:14,marginBottom:24,maxWidth:360,margin:"0 auto 24px"}}>Use the Policy Builder tab to compile your first vault.</p>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
        {visible.map(v=>{
          const bal=balances[v.id];
          return(
            <div key={v.id} style={{background:C.surface,border:"1px solid "+C.border,borderRadius:14,padding:20,cursor:"pointer",position:"relative",opacity:v.archived?0.6:1}} onClick={()=>onSelectVault(v)}>
              {v.archived&&<div style={{position:"absolute",top:12,right:12,fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:4,background:"#5A557022",color:C.muted}}>ARCHIVED</div>}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                <div>
                  <div style={{fontSize:16,fontWeight:600,color:C.text,marginBottom:3}}>{v.name}</div>
                  <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",padding:"3px 8px",borderRadius:4,background:v.network==="bitcoin"?"#2A1F0A":"#0A1F14",color:v.network==="bitcoin"?C.gold:C.green}}>
                    {v.network==="bitcoin"?"MAINNET":"TESTNET"}
                  </span>
                </div>
              </div>
              <div style={{fontSize:26,fontWeight:700,color:C.text,fontFamily:"Playfair Display,serif",marginBottom:2}}>
                {bal?satsToBtc(bal.total_sats):"--"}<span style={{fontSize:13,color:C.muted}}> BTC</span>
              </div>
              {bal?.usd_value!=null&&<div style={{fontSize:14,color:C.sub,marginBottom:8}}>${bal.usd_value.toLocaleString("en-US",{maximumFractionDigits:0})}</div>}
              <div style={{fontFamily:"IBM Plex Mono,monospace",fontSize:11,color:C.muted,marginBottom:12}}>{v.address.slice(0,14)}...{v.address.slice(-8)}</div>
              <div style={{display:"flex",gap:10,flexWrap:"wrap",borderTop:"1px solid #1A1A28",paddingTop:12}}>
                <span style={{fontSize:11,color:C.muted}}>{v.founder_quorum}/{v.founder_keys.length} founders</span>
                <span style={{fontSize:11,color:C.muted}}>{v.heir_quorum}/{v.heir_keys.length} heirs</span>
                <span style={{fontSize:11,color:C.muted}}>Recovery {blocksToLabel(v.recovery_after)}</span>
              </div>
              <div style={{display:"flex",gap:8,marginTop:12}} onClick={e=>e.stopPropagation()}>
                <button style={{...ghostBtn,fontSize:12,padding:"5px 10px"}} onClick={()=>setRenaming(v)}>Rename</button>
                {v.archived
                  ? <button style={{...ghostBtn,fontSize:12,padding:"5px 10px"}} onClick={e=>void unarchive(v,e)}>Restore</button>
                  : <button style={{...ghostBtn,fontSize:12,padding:"5px 10px",color:C.red,borderColor:"#3A1A1A"}} onClick={e=>void archive(v,e)}>Archive</button>
                }
              </div>
            </div>
          );
        })}
      </div>

      {showCreate&&<CreateVaultModal onClose={()=>setShowCreate(false)} onCreated={(v)=>{setShowCreate(false);void load();onSelectVault(v);}}/>}
      {renaming&&<RenameModal vault={renaming} onClose={()=>setRenaming(null)} onDone={()=>{setRenaming(null);void load();}}/>}
    </div>
  );
}

function RenameModal({vault,onClose,onDone}:{vault:Vault;onClose:()=>void;onDone:()=>void}){
  const toast=useToast();
  const [name,setName]=useState(vault.name);
  const [busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){
    e.preventDefault();setBusy(true);
    try{await api.vaults.rename(vault.id,name.trim());onDone();}
    catch(err){toast.error(err instanceof Error?err.message:"Failed to rename vault");}
    finally{setBusy(false);}
  }
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:16}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.surface,border:"1px solid "+C.border,borderRadius:16,padding:"28px 32px",width:"100%",maxWidth:400}}>
        <h2 style={{fontSize:18,fontWeight:600,color:C.text,fontFamily:"Playfair Display,serif",marginBottom:20}}>Rename vault</h2>
        <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:14}}>
          <div><label style={lbl}>Name</label><input style={inp} value={name} onChange={e=>setName(e.target.value)} required autoFocus/></div>
          <div style={{display:"flex",gap:10}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={{...goldBtn,opacity:busy?0.6:1}} disabled={busy}>{busy?"Saving...":"Save"}</button></div>
        </form>
      </div>
    </div>
  );
}

function CreateVaultModal({onClose,onCreated}:{onClose:()=>void;onCreated:(v:Vault)=>void}){
  const [name,setName]=useState("My Vault");const[network,setNetwork]=useState<"testnet"|"bitcoin">("testnet");const[address,setAddress]=useState("");const[descriptor,setDescriptor]=useState("");const[policy,setPolicy]=useState("");const[founderKeys,setFK]=useState("");const[heirKeys,setHK]=useState("");const[founderQ,setFQ]=useState(2);const[heirQ,setHQ]=useState(1);const[recovery,setRecovery]=useState(26000);const[inherit,setInherit]=useState(52560);const[busy,setBusy]=useState(false);const[error,setError]=useState<string|null>(null);
  async function submit(e:React.FormEvent){
    e.preventDefault();setBusy(true);setError(null);
    try{
      const {vault}=await api.vaults.create({name,network,address,descriptor,miniscript_policy:policy,founder_quorum:founderQ,heir_quorum:heirQ,recovery_after:recovery,inheritance_after:inherit,founder_keys:founderKeys.split("\n").map(k=>k.trim()).filter(Boolean),heir_keys:heirKeys.split("\n").map(k=>k.trim()).filter(Boolean)});
      onCreated(vault);
    }catch(err){setError(err instanceof Error?err.message:"Failed");}
    finally{setBusy(false);}
  }
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,padding:16}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:C.surface,border:"1px solid "+C.border,borderRadius:16,padding:"28px 32px",width:"100%",maxWidth:680,maxHeight:"90vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h2 style={{fontSize:20,fontWeight:600,color:C.text,fontFamily:"Playfair Display,serif",margin:0}}>Add vault manually</h2>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,fontSize:18,cursor:"pointer"}}>x</button>
        </div>
        <p style={{fontSize:13,color:C.muted,marginBottom:20,lineHeight:1.5}}>Paste in a pre-compiled vault. Use Policy Builder to compile one automatically.</p>
        <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:12}}>
          <div style={{display:"flex",gap:12}}>
            <div style={{flex:2}}><label style={lbl}>Name</label><input style={inp} value={name} onChange={e=>setName(e.target.value)} required/></div>
            <div style={{flex:1}}><label style={lbl}>Network</label><select style={inp} value={network} onChange={e=>setNetwork(e.target.value as "testnet"|"bitcoin")}><option value="testnet">Testnet</option><option value="bitcoin">Mainnet</option></select></div>
          </div>
          <div><label style={lbl}>Bitcoin address</label><input style={monoInp} value={address} onChange={e=>setAddress(e.target.value)} required/></div>
          <div><label style={lbl}>Output descriptor</label><textarea style={ta} value={descriptor} onChange={e=>setDescriptor(e.target.value)} required rows={3}/></div>
          <div><label style={lbl}>Miniscript policy</label><textarea style={ta} value={policy} onChange={e=>setPolicy(e.target.value)} required rows={2}/></div>
          <div style={{display:"flex",gap:12}}>
            <div style={{flex:1}}><label style={lbl}>Founder keys (one per line)</label><textarea style={ta} value={founderKeys} onChange={e=>setFK(e.target.value)} rows={3}/></div>
            <div style={{flex:1}}><label style={lbl}>Heir keys (one per line)</label><textarea style={ta} value={heirKeys} onChange={e=>setHK(e.target.value)} rows={3}/></div>
          </div>
          <div style={{display:"flex",gap:12}}>
            <div style={{flex:1}}><label style={lbl}>Founder quorum</label><input style={inp} type="number" min={1} value={founderQ} onChange={e=>setFQ(+e.target.value)}/></div>
            <div style={{flex:1}}><label style={lbl}>Heir quorum</label><input style={inp} type="number" min={1} value={heirQ} onChange={e=>setHQ(+e.target.value)}/></div>
            <div style={{flex:1}}><label style={lbl}>Recovery (blocks)</label><input style={inp} type="number" value={recovery} onChange={e=>setRecovery(+e.target.value)}/></div>
            <div style={{flex:1}}><label style={lbl}>Inheritance (blocks)</label><input style={inp} type="number" value={inherit} onChange={e=>setInherit(+e.target.value)}/></div>
          </div>
          {error&&<p style={{color:C.red,fontSize:13}}>{error}</p>}
          <div style={{display:"flex",gap:10,marginTop:4}}><button type="button" style={ghostBtn} onClick={onClose}>Cancel</button><button type="submit" style={{...goldBtn,opacity:busy?0.6:1}} disabled={busy}>{busy?"Creating...":"Create vault"}</button></div>
        </form>
      </div>
    </div>
  );
}

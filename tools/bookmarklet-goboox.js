(async()=>{
  const K="__SUP_KEY__", U="https://dbikbgbgplosqwnovhvr.supabase.co/functions/v1/sup";
  const box=document.createElement("div");
  box.style.cssText="position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:320px;background:#0F1F1A;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35)";
  const say=t=>{box.textContent=t};
  document.body.appendChild(box);
  if(!/goboox\.com\.br$/.test(location.hostname)){say("Abra o catálogo da GoBoox (app.goboox.com.br) e toque no botão de novo.");setTimeout(()=>box.remove(),6000);return;}
  let tok=null; try{tok=JSON.parse(localStorage.getItem("auth-storage")).state.token}catch(e){}
  if(!tok){say("Entre na sua conta da GoBoox primeiro.");setTimeout(()=>box.remove(),6000);return;}
  const all=new Map(); let page=1, step=1, n=0;
  try{
    while(n++<300){
      say("Oportuniza: lendo catálogo GoBoox… "+all.size+" produtos");
      const r=await fetch(`https://api.goboox.com.br/v3/catalog/products?page=${page}&step=${step}&sort=sales_desc`,{headers:{authorization:"Bearer "+tok}});
      if(!r.ok) throw new Error("GoBoox respondeu "+r.status);
      const j=await r.json(), p=j.pagination||{};
      for(const x of j.products||[]) all.set(x.id,{sku:x.id,title:x.name,cost:x.price,stock:x.stock});
      if(p.has_next_step) step=p.next_step; else if(p.has_next_page){page=p.next_page;step=1;} else break;
      await new Promise(r=>setTimeout(r,200));
    }
    say("Oportuniza: enviando "+all.size+" custos…");
    const r=await fetch(U,{method:"POST",headers:{"content-type":"text/plain"},body:JSON.stringify({k:K,supplier:"GoBoox",items:[...all.values()]})});
    const j=await r.json();
    if(!r.ok||!j.ok) throw new Error(j.error||("erro "+r.status));
    say("✓ Oportuniza atualizado: "+j.saved+" custos da GoBoox. Abra o Financeiro e toque em Atualizar.");
  }catch(e){ say("Não deu certo: "+e.message); }
  setTimeout(()=>box.remove(),9000);
})();
